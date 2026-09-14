import type { ServerRequest } from '@hermes/shared'
import { atom, computed, type ReadableAtom } from 'nanostores'

import { $clarifyRequest, $clarifyRequests } from './clarify'
import { isSessionGone, isSessionGoneForBackgroundPolling, markSessionGone } from './runtime-gone'
import { $activeSessionId } from './session'
import { ambientRequestFor } from './session-gone-latch'
import { requestForOwnedSession } from './session-states'

const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

interface KeyedPrompt {
  sessionId: string | null
}

interface PromptStore<T extends KeyedPrompt> {
  $active: ReadableAtom<null | T>
  $all: ReadableAtom<Record<string, T>>
  clear: (sessionId?: string | null, requestId?: string) => void
  reset: () => void
  set: (request: T) => void
}

// One per-session prompt kind: a map keyed by session, plus an active-session
// view for the overlays. `clear` drops one session's entry (a request-id
// mismatch is a no-op so a stale cancellation can't wipe a newer prompt); with
// no session hint it drops every entry, optionally filtered by request id.
function keyedPromptStore<T extends KeyedPrompt>(): PromptStore<T> {
  const $all = atom<Record<string, T>>({})
  const idOf = (value: T): string | undefined => (value as { requestId?: string }).requestId

  return {
    $active: computed([$all, $activeSessionId], (all, activeId) => all[keyFor(activeId)] ?? null),
    $all,
    reset: () => $all.set({}),
    set: request => $all.set({ ...$all.get(), [keyFor(request.sessionId)]: request }),
    clear(sessionId, requestId) {
      const all = $all.get()

      if (sessionId !== undefined) {
        const key = keyFor(sessionId)
        const current = all[key]

        if (current && !(requestId && idOf(current) !== requestId)) {
          const next = { ...all }
          delete next[key]
          $all.set(next)
        }

        return
      }

      const next = Object.fromEntries(Object.entries(all).filter(([, value]) => requestId && idOf(value) !== requestId))

      if (Object.keys(next).length !== Object.keys(all).length) {
        $all.set(next as Record<string, T>)
      }
    }
  }
}

// Approval stays on its separate event/RPC bridge until the backend moves it
// to ServerRequest too.
export interface ApprovalRequest extends KeyedPrompt {
  allowPermanent?: boolean
  choices?: string[]
  command: string
  description: string
  requestId?: string
  smartDenied?: boolean
}

interface ApprovalGateway {
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

interface PendingApprovalPayload {
  allow_permanent?: boolean
  choices?: unknown
  command?: unknown
  description?: unknown
  request_id?: unknown
  smart_denied?: boolean
}

interface ServerPrompt extends KeyedPrompt {
  requestId: string
  request?: ServerRequest
}

export interface SudoRequest extends ServerPrompt {}

export interface SecretRequest extends ServerPrompt {
  envVar: string
  prompt: string
}

export interface VaultUnlockRequest extends ServerPrompt {
  backend: string
  displayName: string
}

export interface VaultSaveLoginRequest extends ServerPrompt {
  origin: string
  site: string
}

export interface VaultCodeRequest extends ServerPrompt {
  site: string
  hint: string
}

const approval = keyedPromptStore<ApprovalRequest>()
const sudo = keyedPromptStore<SudoRequest>()
const secret = keyedPromptStore<SecretRequest>()
const vaultUnlock = keyedPromptStore<VaultUnlockRequest>()
const vaultSave = keyedPromptStore<VaultSaveLoginRequest>()
const vaultCode = keyedPromptStore<VaultCodeRequest>()

// Inline approval anchors, keyed by session: a tile's inline bar mounting must
// not suppress the PRIMARY session's floating fallback (and vice versa).
const $approvalInlineAnchors = atom<Record<string, number>>({})

export const $approvalRequest = approval.$active
export const setApprovalRequest = approval.set
export const clearApprovalRequest = approval.clear

export async function receiveApprovalRequest(gateway: ApprovalGateway | null, request: ApprovalRequest): Promise<void> {
  setApprovalRequest(request)

  if (gateway && request.requestId && request.sessionId) {
    try {
      await requestForOwnedSession(request.sessionId, ambientRequestFor(gateway), 'approval.received', {
        request_id: request.requestId,
        session_id: request.sessionId
      })
    } catch (error) {
      if (isSessionGoneForBackgroundPolling(error)) {
        markSessionGone(request.sessionId)

        return
      }

      throw error
    }
  }
}

export async function replayPendingApproval(gateway: ApprovalGateway | null, sessionId: string | null): Promise<void> {
  if (!gateway || !sessionId || isSessionGone(sessionId)) {
    return
  }

  const previous = approval.$all.get()[keyFor(sessionId)]
  let rawResult: unknown

  try {
    rawResult = await requestForOwnedSession(sessionId, ambientRequestFor(gateway), 'approval.pending', {
      session_id: sessionId
    })
  } catch (error) {
    if (isSessionGoneForBackgroundPolling(error)) {
      markSessionGone(sessionId)

      return
    }

    throw error
  }

  const result =
    rawResult && typeof rawResult === 'object' ? (rawResult as { approvals?: PendingApprovalPayload[] }) : {}

  // Live requests/responses outrank a replay that was already in flight.
  if (approval.$all.get()[keyFor(sessionId)] !== previous || !Array.isArray(result.approvals)) {
    return
  }

  const pending = result.approvals[0]

  if (!pending) {
    clearApprovalRequest(sessionId, previous?.requestId)

    return
  }

  if (typeof pending.request_id !== 'string') {
    return
  }

  await receiveApprovalRequest(gateway, {
    allowPermanent: pending.allow_permanent !== false,
    choices: Array.isArray(pending.choices) ? pending.choices.filter(choice => typeof choice === 'string') : undefined,
    command: typeof pending.command === 'string' ? pending.command : '',
    description: typeof pending.description === 'string' ? pending.description : 'dangerous command',
    requestId: pending.request_id,
    sessionId,
    smartDenied: pending.smart_denied === true
  })
}

/** The prompt request for one specific session — the tile counterpart of the
 * active-session `$*Request` views (same map, fixed key). */
export const sessionApprovalRequest = (sessionId: string | null) =>
  computed(approval.$all, all => all[keyFor(sessionId)] ?? null)
export const sessionSudoRequest = (sessionId: string | null) =>
  computed(sudo.$all, all => all[keyFor(sessionId)] ?? null)
export const sessionSecretRequest = (sessionId: string | null) =>
  computed(secret.$all, all => all[keyFor(sessionId)] ?? null)

export function registerApprovalInlineAnchor(sessionId: string | null): () => void {
  const key = keyFor(sessionId)

  const bump = (delta: number) => {
    const all = $approvalInlineAnchors.get()
    const next = Math.max(0, (all[key] ?? 0) + delta)
    $approvalInlineAnchors.set({ ...all, [key]: next })
  }

  bump(1)

  return () => bump(-1)
}

/** True when session `sessionId` has an inline approval bar mounted, so its
 * floating fallback should stand down. Per-session (not global). */
export const sessionApprovalInlineVisible = (sessionId: string | null) =>
  computed($approvalInlineAnchors, anchors => (anchors[keyFor(sessionId)] ?? 0) > 0)

export const $sudoRequest = sudo.$active
export const setSudoRequest = sudo.set
export const clearSudoRequest = sudo.clear

export const $secretRequest = secret.$active
export const setSecretRequest = secret.set
export const clearSecretRequest = secret.clear

export const $vaultUnlockRequest = vaultUnlock.$active
export const setVaultUnlockRequest = vaultUnlock.set
export const clearVaultUnlockRequest = vaultUnlock.clear
export const $vaultUnlockRequests = vaultUnlock.$all
export const sessionVaultUnlockRequest = (sessionId: string | null) =>
  computed(vaultUnlock.$all, all => all[keyFor(sessionId)] ?? null)

export const $vaultSaveLoginRequest = vaultSave.$active
export const setVaultSaveLoginRequest = vaultSave.set
export const clearVaultSaveLoginRequest = vaultSave.clear
export const $vaultSaveLoginRequests = vaultSave.$all
export const sessionVaultSaveLoginRequest = (sessionId: string | null) =>
  computed(vaultSave.$all, all => all[keyFor(sessionId)] ?? null)

export const $vaultCodeRequest = vaultCode.$active
export const setVaultCodeRequest = vaultCode.set
export const clearVaultCodeRequest = vaultCode.clear
export const $vaultCodeRequests = vaultCode.$all
export const sessionVaultCodeRequest = (sessionId: string | null) =>
  computed(vaultCode.$all, all => all[keyFor(sessionId)] ?? null)

export const $activeSessionAwaitingInput = computed(
  [
    $clarifyRequest,
    $approvalRequest,
    $sudoRequest,
    $secretRequest,
    $vaultUnlockRequest,
    $vaultSaveLoginRequest,
    $vaultCodeRequest
  ],
  (clarify, approval, sudo, secret, vault, save, code) =>
    Boolean(clarify || approval || sudo || secret || vault || save || code)
)

/** True when `sessionId` is parked on a blocking prompt that typing cannot
 * answer (approval / sudo / secret). Clarify is deliberately excluded: typing
 * a real message IS an answer to a clarify ("none of these" — the composer
 * skips it and routes the words), but no message text can approve a command
 * or supply a password. Imperative read — the composer checks this on Enter,
 * not on every render. */
export const hasBlockingPromptRequest = (sessionId: string | null | undefined): boolean => {
  const key = keyFor(sessionId)

  return Boolean(
    approval.$all.get()[key] ||
    sudo.$all.get()[key] ||
    secret.$all.get()[key] ||
    vaultUnlock.$all.get()[key] ||
    vaultSave.$all.get()[key] ||
    vaultCode.$all.get()[key]
  )
}

/** Reactive twin of `hasBlockingPromptRequest`, for the composer's busy-action
 * affordance (the primary button must advertise queue, not steer, while the
 * turn is parked on a prompt Enter can't answer). */
export const sessionBlockingPrompt = (sessionId: string | null) =>
  computed(
    [approval.$all, sudo.$all, secret.$all, vaultUnlock.$all, vaultSave.$all, vaultCode.$all],
    (approvals, sudos, secrets, vaults, saves, codes) => {
      const key = keyFor(sessionId)

      return Boolean(approvals[key] || sudos[key] || secrets[key] || vaults[key] || saves[key] || codes[key])
    }
  )

/** Per-session `awaitingInput` — the tile composer's counterpart of
 * `$activeSessionAwaitingInput` (same sources, fixed session instead of the
 * active one). */
export function sessionAwaitingInput(sessionId: string | null) {
  return computed(
    [$clarifyRequests, approval.$all, sudo.$all, secret.$all, vaultUnlock.$all, vaultSave.$all, vaultCode.$all],
    (clarify, approvals, sudos, secrets, vaults, saves, codes) => {
      const key = keyFor(sessionId)

      return Boolean(
        clarify[key] || approvals[key] || sudos[key] || secrets[key] || vaults[key] || saves[key] || codes[key]
      )
    }
  )
}

// Drop in-flight prompts for `sessionId` (a turn ended) across all three kinds —
// or every parked prompt when no session is given (global reset / tests).
export function clearAllPrompts(sessionId?: string | null): void {
  if (sessionId === undefined) {
    approval.reset()
    sudo.reset()
    secret.reset()
    vaultUnlock.reset()
    vaultSave.reset()
    vaultCode.reset()
    $approvalInlineAnchors.set({})

    return
  }

  approval.clear(sessionId)
  sudo.clear(sessionId)
  secret.clear(sessionId)
  vaultUnlock.clear(sessionId)
  vaultSave.clear(sessionId)
  vaultCode.clear(sessionId)
}
