import type { ServerRequest, ServerRequestCancel } from '@hermes/shared'

import { pendingClarifyToolPayload } from '@/app/session/hooks/use-session-actions/restore-pending-clarify'
import { translateNow } from '@/i18n'
import { restorePendingClarifyToolCall, settlePendingClarifyToolCall } from '@/lib/chat-messages'
import {
  $clarifyRequests,
  clearClarifyRequest,
  normalizeChoices,
  normalizeQuestions,
  setClarifyRequest,
  warnDroppedChoices
} from '@/store/clarify'
import { $gateway } from '@/store/gateway'
import { clearMcpSetupRequest, setMcpSetupRequest } from '@/store/mcp-setup'
import { dispatchNativeNotification } from '@/store/native-notifications'
import {
  clearSecretRequest,
  clearSudoRequest,
  clearVaultCodeRequest,
  clearVaultSaveLoginRequest,
  clearVaultUnlockRequest,
  receiveApprovalRequest,
  setSecretRequest,
  setSudoRequest,
  setVaultCodeRequest,
  setVaultSaveLoginRequest,
  setVaultUnlockRequest
} from '@/store/prompts'
import { requestScrollToBottom } from '@/store/thread-scroll'

import type { GatewayEventContext, GatewayEventDeps } from './types'

interface ServerRequestContext {
  deps: GatewayEventDeps
  request: ServerRequest
}

type ServerRequestHandler = (ctx: ServerRequestContext) => boolean

function lockedAnswers(params: ServerRequest['params']): Record<string, string> | undefined {
  if (typeof params.answers !== 'object' || params.answers === null) {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(params.answers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function setNeedsInput(deps: GatewayEventDeps, sessionId: string | null): void {
  if (sessionId) {
    deps.updateSessionState(sessionId, state => ({ ...state, needsInput: true }))
  }
}

function inputNotification(sessionId: string | null, body: string): void {
  dispatchNativeNotification({
    body,
    kind: 'input',
    sessionId,
    title: translateNow('notifications.native.inputTitle')
  })
}

function handleClarifyServerRequest({ deps, request }: ServerRequestContext): boolean {
  const { activeSessionIdRef, sessionInterrupted, updateSessionState } = deps
  const { params, sessionId } = request

  if (sessionId && sessionInterrupted(sessionId)) {
    request.respond({ value: '' })

    return true
  }

  const question = typeof params.question === 'string' ? params.question : ''
  const rawChoices = params.choices
  const choices = normalizeChoices(rawChoices)
  const questions = normalizeQuestions(params.questions)

  if (questions.length > 0) {
    const clarify = {
      choices: null,
      lockedAnswers: lockedAnswers(params),
      multiSelect: false,
      question: '',
      questions,
      receivedAt: Date.now() / 1000,
      request,
      requestId: request.id,
      sessionId
    }

    setClarifyRequest(clarify)

    if (sessionId) {
      updateSessionState(sessionId, state => {
        const projection = restorePendingClarifyToolCall(
          state.messages,
          pendingClarifyToolPayload(clarify),
          Date.now() / 1000
        )

        return {
          ...state,
          messages: projection.messages,
          streamId: projection.streamId,
          sawAssistantPayload: true,
          awaitingResponse: false,
          needsInput: true
        }
      })

      if (sessionId === activeSessionIdRef.current) {
        requestScrollToBottom(sessionId)
      }
    }

    inputNotification(sessionId, questions.map(question => question.question).join(' · '))

    return true
  }

  if (!question) {
    return true
  }

  if (rawChoices != null && choices.length === 0) {
    warnDroppedChoices('gateway', question, rawChoices)
  }

  const clarify = {
    choices: choices.length > 0 ? choices : null,
    multiSelect: params.multi_select === true,
    question,
    receivedAt: Date.now() / 1000,
    request,
    requestId: request.id,
    sessionId
  }

  setClarifyRequest(clarify)

  if (sessionId) {
    updateSessionState(sessionId, state => {
      const projection = restorePendingClarifyToolCall(
        state.messages,
        pendingClarifyToolPayload(clarify),
        Date.now() / 1000
      )

      return {
        ...state,
        messages: projection.messages,
        streamId: projection.streamId,
        sawAssistantPayload: true,
        awaitingResponse: false,
        needsInput: true
      }
    })

    if (sessionId === activeSessionIdRef.current) {
      requestScrollToBottom(sessionId)
    }
  }

  inputNotification(sessionId, question)

  return true
}

function handleMcpSetupServerRequest({ deps, request }: ServerRequestContext): boolean {
  const { params, sessionId } = request
  const server = typeof params.server === 'string' ? params.server : ''
  const rawAction = typeof params.action === 'string' ? params.action : 'install'
  const action = rawAction === 'enable' || rawAction === 'authorize' ? rawAction : 'install'
  const reason = typeof params.reason === 'string' ? params.reason : ''

  if (!server) {
    return true
  }

  setMcpSetupRequest({ action, reason, request, requestId: request.id, server, sessionId })

  if (sessionId) {
    deps.upsertToolCall(
      sessionId,
      { args: { action, reason, server }, name: 'setup_mcp', tool_id: request.id },
      'running'
    )
  }

  setNeedsInput(deps, sessionId)
  inputNotification(sessionId, reason || server)

  return true
}

function handleSudoServerRequest({ deps, request }: ServerRequestContext): boolean {
  setSudoRequest({ request, requestId: request.id, sessionId: request.sessionId })
  setNeedsInput(deps, request.sessionId)
  inputNotification(request.sessionId, translateNow('notifications.native.inputBody'))

  return true
}

function handleSecretServerRequest({ deps, request }: ServerRequestContext): boolean {
  const envVar = typeof request.params.env_var === 'string' ? request.params.env_var : ''
  const prompt = typeof request.params.prompt === 'string' ? request.params.prompt : ''

  setSecretRequest({ envVar, prompt, request, requestId: request.id, sessionId: request.sessionId })
  setNeedsInput(deps, request.sessionId)
  inputNotification(request.sessionId, prompt || envVar || translateNow('notifications.native.inputBody'))

  return true
}

function handleVaultCodeServerRequest({ deps, request }: ServerRequestContext): boolean {
  const site = typeof request.params.site === 'string' ? request.params.site : ''
  const hint = typeof request.params.hint === 'string' ? request.params.hint : ''

  setVaultCodeRequest({ hint, request, requestId: request.id, sessionId: request.sessionId, site })
  setNeedsInput(deps, request.sessionId)
  inputNotification(request.sessionId, translateNow('prompts.vaultCodeTitle', site))

  return true
}

function handleVaultSaveLoginServerRequest({ deps, request }: ServerRequestContext): boolean {
  const origin = typeof request.params.origin === 'string' ? request.params.origin : ''
  const site = typeof request.params.site === 'string' ? request.params.site : origin

  setVaultSaveLoginRequest({ origin, request, requestId: request.id, sessionId: request.sessionId, site })
  setNeedsInput(deps, request.sessionId)
  inputNotification(request.sessionId, translateNow('prompts.vaultSaveTitle', site))

  return true
}

function handleVaultUnlockServerRequest({ deps, request }: ServerRequestContext): boolean {
  const backend = typeof request.params.backend === 'string' ? request.params.backend : ''
  const displayName = typeof request.params.display_name === 'string' ? request.params.display_name : backend

  setVaultUnlockRequest({ backend, displayName, request, requestId: request.id, sessionId: request.sessionId })
  setNeedsInput(deps, request.sessionId)
  inputNotification(request.sessionId, translateNow('prompts.vaultUnlockTitle', displayName))

  return true
}

const SERVER_REQUEST_HANDLERS: Record<string, ServerRequestHandler> = {
  'clarify.request': handleClarifyServerRequest,
  'mcp.setup.request': handleMcpSetupServerRequest,
  'secret.request': handleSecretServerRequest,
  'sudo.request': handleSudoServerRequest,
  'vault.code.request': handleVaultCodeServerRequest,
  'vault.save_login.request': handleVaultSaveLoginServerRequest,
  'vault.unlock.request': handleVaultUnlockServerRequest
}

/** Route blocking backend requests to the per-session card that owns their response. */
export function handleInputServerRequest(request: ServerRequest, deps: GatewayEventDeps): boolean {
  return SERVER_REQUEST_HANDLERS[request.method]?.({ deps, request }) ?? false
}

/** Remove a withdrawn request only when it still matches the card on that session. */
export function handleInputServerRequestCancel(cancel: ServerRequestCancel, deps: GatewayEventDeps): void {
  const clarify = $clarifyRequests.get()[cancel.sessionId ?? '']

  if (clarify?.requestId === cancel.id) {
    clearClarifyRequest(cancel.id, cancel.sessionId)

    if (cancel.sessionId) {
      deps.updateSessionState(cancel.sessionId, state => {
        const projection = settlePendingClarifyToolCall(
          state.messages,
          pendingClarifyToolPayload(clarify),
          state.busy,
          Date.now() / 1000
        )

        return {
          ...state,
          messages: projection.messages,
          needsInput: false,
          streamId: state.busy ? (projection.streamId ?? state.streamId) : null
        }
      })
    }
  }

  clearMcpSetupRequest(cancel.id, cancel.sessionId)
  clearSudoRequest(cancel.sessionId, cancel.id)
  clearSecretRequest(cancel.sessionId, cancel.id)
  clearVaultCodeRequest(cancel.sessionId, cancel.id)
  clearVaultSaveLoginRequest(cancel.sessionId, cancel.id)
  clearVaultUnlockRequest(cancel.sessionId, cancel.id)
}

/** Keep approval on its event/RPC bridge; it is not part of ServerRequest yet. */
export function handleInputRequestEvent(ctx: GatewayEventContext): boolean {
  const { deps, event, payload, sessionId } = ctx

  if (event.type !== 'approval.request') {
    return false
  }

  const command = typeof payload?.command === 'string' ? payload.command : ''
  const description = typeof payload?.description === 'string' ? payload.description : 'dangerous command'

  void receiveApprovalRequest($gateway.get(), {
    allowPermanent: payload?.allow_permanent !== false,
    choices: Array.isArray(payload?.choices) ? payload.choices.filter(choice => typeof choice === 'string') : undefined,
    command,
    description,
    requestId: typeof payload?.request_id === 'string' ? payload.request_id : undefined,
    sessionId: sessionId ?? null,
    smartDenied: payload?.smart_denied === true
  }).catch(() => undefined)

  setNeedsInput(deps, sessionId)
  dispatchNativeNotification({
    actions: [
      { id: 'approve', text: translateNow('notifications.native.approveAction') },
      { id: 'reject', text: translateNow('notifications.native.rejectAction') }
    ],
    body: command || description,
    kind: 'approval',
    sessionId,
    title: translateNow('notifications.native.approvalTitle')
  })

  return true
}
