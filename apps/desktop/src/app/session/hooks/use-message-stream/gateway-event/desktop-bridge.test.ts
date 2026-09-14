import type { ServerRequest } from '@hermes/shared'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $toursEnabled } from '@/store/tours'

import { cancelDesktopBridgeServerRequest, handleDesktopBridgeServerRequest } from './desktop-bridge'
import type { GatewayEventDeps } from './types'

function gatewayDeps(activeSessionId: string | null): GatewayEventDeps {
  return {
    activeGatewayProfile: 'default',
    activeSessionIdRef: { current: activeSessionId },
    appendAssistantDelta: () => undefined,
    appendReasoningDelta: () => undefined,
    compactedTurnRef: { current: new Set() },
    completeAssistantMessage: () => undefined,
    failAssistantMessage: () => undefined,
    finalizeInterimAssistantMessage: () => undefined,
    flushQueuedDeltas: () => undefined,
    hydrateFromStoredSession: async () => undefined,
    lastCwdInfoSessionRef: { current: null },
    nativeSubagentSessionsRef: { current: new Set() },
    queryClient: new QueryClient(),
    refreshHermesConfig: async () => undefined,
    scheduleSessionsRefresh: () => undefined,
    sessionInterrupted: () => false,
    sessionStateByRuntimeIdRef: { current: new Map() },
    updateSessionState: () => {
      throw new Error('unused')
    },
    upsertToolCall: () => undefined
  }
}

let requestSequence = 0

function serverRequest(method: string, sessionId: string | null, params: ServerRequest['params'] = {}) {
  const respond = vi.fn()

  return {
    fail: vi.fn(),
    id: `srq-${++requestSequence}`,
    method,
    notify: vi.fn(),
    params,
    respond,
    sessionId
  } satisfies ServerRequest
}

describe('desktop bridge server requests', () => {
  afterEach(() => {
    $toursEnabled.set(true)
  })

  it('responds to terminal, preview, and window reads with their serialized text', async () => {
    const deps = gatewayDeps('session-a')
    const terminal = serverRequest('terminal.read.request', 'session-a', { count: 20, start: 0 })
    const preview = serverRequest('preview.read.request', 'session-a', { count: 20, start: 0 })
    const windowRead = serverRequest('window.read.request', 'session-a')

    expect(handleDesktopBridgeServerRequest(terminal, deps)).toBe(true)
    expect(handleDesktopBridgeServerRequest(preview, deps)).toBe(true)
    expect(handleDesktopBridgeServerRequest(windowRead, deps)).toBe(true)

    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(terminal.respond).toHaveBeenCalledWith({ value: '' })
    expect(preview.respond).toHaveBeenCalledWith({ value: '' })
    expect(windowRead.respond).toHaveBeenCalledWith({ value: '' })
  })

  it('returns serialized refusals for inactive preview actions and disabled tours', () => {
    const inactiveDeps = gatewayDeps(null)
    const previewAction = serverRequest('preview.act.request', null, { action: 'elements' })
    const tour = serverRequest('tour.request', null, { action: 'discover' })
    $toursEnabled.set(false)

    expect(handleDesktopBridgeServerRequest(previewAction, inactiveDeps)).toBe(true)
    expect(handleDesktopBridgeServerRequest(tour, inactiveDeps)).toBe(true)
    expect(previewAction.respond).toHaveBeenCalledWith({
      value: JSON.stringify({
        error: 'The in-app browser only takes actions in the session the user is looking at.',
        success: false
      })
    })
    expect(tour.respond).toHaveBeenCalledWith({
      value: JSON.stringify({ error: 'The user has turned guided tours off.', success: false })
    })
  })

  it('leaves scoped preview actions and tours unanswered in another session', () => {
    const deps = gatewayDeps('session-b')
    const previewAction = serverRequest('preview.act.request', 'session-a', { action: 'elements' })
    const tour = serverRequest('tour.request', 'session-a', { action: 'discover' })
    $toursEnabled.set(false)

    expect(handleDesktopBridgeServerRequest(previewAction, deps)).toBe(true)
    expect(handleDesktopBridgeServerRequest(tour, deps)).toBe(true)
    expect(previewAction.respond).not.toHaveBeenCalled()
    expect(tour.respond).not.toHaveBeenCalled()
  })

  it('does not reply when cancellation wins an in-flight preview read', async () => {
    const request = serverRequest('preview.read.request', 'session-a')

    expect(handleDesktopBridgeServerRequest(request, gatewayDeps('session-a'))).toBe(true)
    cancelDesktopBridgeServerRequest(request.id)

    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(request.respond).not.toHaveBeenCalled()
  })

  it('answers a re-delivered in-flight request through its latest transport', async () => {
    const initialRequest = serverRequest('preview.read.request', 'session-a')
    const redeliveredRequest = serverRequest('preview.read.request', 'session-a')
    redeliveredRequest.id = initialRequest.id

    expect(handleDesktopBridgeServerRequest(initialRequest, gatewayDeps('session-a'))).toBe(true)
    expect(handleDesktopBridgeServerRequest(redeliveredRequest, gatewayDeps('session-a'))).toBe(true)

    await new Promise(resolve => window.setTimeout(resolve, 0))
    expect(initialRequest.respond).not.toHaveBeenCalled()
    expect(redeliveredRequest.respond).toHaveBeenCalledWith({ value: '' })
  })

  it('does not claim unrelated server requests', () => {
    expect(handleDesktopBridgeServerRequest(serverRequest('clarify.request', 'session-a'), gatewayDeps('session-a'))).toBe(false)
  })
})
