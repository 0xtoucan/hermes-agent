import type {
  ConnectionOperationTarget,
  ConnectionRequestPayload,
  ConnectionUpdatePayload
} from '@hermes/shared/gateway-events'
import { atom } from 'nanostores'

import { patchOverlayState } from './overlayStore.js'

export interface ConnectionOperationSnapshot {
  deadlineAt: number
  opId: string
  seq: number
  targets: ConnectionOperationTarget[]
  toolCallId: null | string
}

export interface ConnectionOverlayState {
  opId: string
}

export const $connectionOperation = atom<ConnectionOperationSnapshot | null>(null)

// A settled operation can never reopen its card, and neither can one the user closed with Esc. Both
// lists are capped so a long session cannot grow them without bound; an id that falls off the end is
// far older than any frame still in flight.
const OPERATION_MEMORY = 64
const settledOperationIds: string[] = []
const dismissedOperationIds: string[] = []

function remember(opIds: string[], opId: string): void {
  if (opIds.includes(opId)) {
    return
  }

  opIds.push(opId)

  if (opIds.length > OPERATION_MEMORY) {
    opIds.shift()
  }
}

export const isSettledOperation = (opId: string): boolean => settledOperationIds.includes(opId)

export const isDismissedOperation = (opId: string): boolean => dismissedOperationIds.includes(opId)

/** The one word the transcript records per app when the operation settles. */
const outcomeWord = (target: ConnectionOperationTarget): string => {
  if (target.state === 'connected') {
    return 'connected'
  }

  return target.state === 'skipped' ? 'skipped' : 'not connected'
}

export function applyConnectionRequest(payload: ConnectionRequestPayload): void {
  if (isSettledOperation(payload.op_id) || isDismissedOperation(payload.op_id)) {
    return
  }

  const current = $connectionOperation.get()
  const older = current?.opId === payload.op_id && payload.seq <= current.seq

  // A resume replays the request with the seq the client already holds. The snapshot stays, but the
  // overlay flag is set either way: turn idle clears flow overlays, and the card has to come back.
  if (!older) {
    $connectionOperation.set({
      deadlineAt: payload.deadline_at,
      opId: payload.op_id,
      seq: payload.seq,
      targets: payload.targets,
      toolCallId: payload.tool_call_id ?? null
    })
  }

  patchOverlayState({ connection: { opId: payload.op_id } })
}

/** Returns one transcript line per app when this frame settled the operation, else nothing. */
export function applyConnectionUpdate(payload: ConnectionUpdatePayload): string[] {
  const current = $connectionOperation.get()
  const shown = current !== null && current.opId === payload.op_id

  // The settlement is read first and remembered even for an operation the client no longer shows,
  // so that card can never reopen. A card the user closed with Esc still reports how each app ended;
  // one left behind by a session switch settles silently.
  if (payload.settled) {
    remember(settledOperationIds, payload.op_id)

    if (!shown && !isDismissedOperation(payload.op_id)) {
      return []
    }

    if (shown) {
      clearConnectionOperation()
    }

    return payload.targets.map(target => `${target.name}: ${outcomeWord(target)}`)
  }

  if (!shown || !current || payload.seq <= current.seq) {
    return []
  }

  $connectionOperation.set({
    ...current,
    deadlineAt: payload.deadline_at,
    seq: payload.seq,
    targets: payload.targets
  })
  patchOverlayState({ connection: { opId: payload.op_id } })

  return []
}

export function clearConnectionOperation(): void {
  $connectionOperation.set(null)
  patchOverlayState({ connection: null })
}

/** Esc on the card: the outcome is still wanted, but this card must never come back. */
export function dismissConnectionOperation(opId: string): void {
  remember(dismissedOperationIds, opId)
  clearConnectionOperation()
}

export function resetConnectionOperationsForTests(): void {
  settledOperationIds.length = 0
  dismissedOperationIds.length = 0
  clearConnectionOperation()
}
