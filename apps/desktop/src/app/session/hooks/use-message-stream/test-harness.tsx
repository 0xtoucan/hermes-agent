import type { GatewayEvent, ServerRequest, ServerRequestCancel } from '@hermes/shared'
import { QueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, vi } from 'vitest'

const mountedHarnesses = new Set<() => void>()

afterEach(() => {
  for (const unmount of mountedHarnesses) {
    unmount()
  }
})

import { HermesGateway } from '@/api/client'
import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $gateway } from '@/store/gateway'

import { useMessageStream } from './index'

class ServerRequestGateway extends HermesGateway {
  private readonly requestHandlers = new Set<(request: ServerRequest) => void>()
  private readonly cancelHandlers = new Set<(cancel: ServerRequestCancel) => void>()

  override onServerRequest(handler: (request: ServerRequest) => void): () => void {
    this.requestHandlers.add(handler)

    return () => this.requestHandlers.delete(handler)
  }

  override onServerRequestCancel(handler: (cancel: ServerRequestCancel) => void): () => void {
    this.cancelHandlers.add(handler)

    return () => this.cancelHandlers.delete(handler)
  }

  fire(request: ServerRequest): void {
    for (const handler of this.requestHandlers) {
      handler(request)
    }
  }

  fireCancel(cancel: ServerRequestCancel): void {
    for (const handler of this.cancelHandlers) {
      handler(cancel)
    }
  }
}

export interface MessageStreamHarnessOptions extends Partial<Parameters<typeof useMessageStream>[0]> {
  /** Session-state map to mount with, for tests that seed state up front. */
  states?: Map<string, ClientSessionState>
}

export interface MessageStreamHarness {
  /** Feed a gateway event into the mounted hook. */
  handleEvent: (event: GatewayEvent) => void
  /** Feed a backend request into the hook's subscribed request channel. */
  handleServerRequest: (request: ServerRequest) => void
  /** Withdraw a backend request through the subscribed request channel. */
  handleServerRequestCancel: (cancel: ServerRequestCancel) => void
  /** Push streaming assistant text, bypassing the event envelope. For the specs
   *  about flush scheduling rather than about a particular event. */
  appendDelta: (sessionId: string, delta: string) => void
  /** The hook's session-state map, so callers can seed or inspect it directly. */
  states: Map<string, ClientSessionState>
  /** State for a session, blank before the hook has written any. */
  state: (sessionId?: string) => ClientSessionState
  /** Last state written for any session — for assertions about the write itself. */
  latest: () => ClientSessionState | null
  /** Text of the trailing text part on a session's newest message, '' when the
   *  tail is not text. What streamed deltas accumulate into. */
  text: (sessionId?: string) => string
  /** Text of the reasoning part on the newest message, '' when there is none.
   *  MoA events land there, so the moa specs read the stream through it. */
  reasoningText: () => string
}

/** Mount `useMessageStream` with inert dependencies and hand back the event sink
 *  plus the state it produces.
 *
 *  Every event test needs the same wiring — the real hook, stubbed refresh and
 *  hydrate callbacks, a session-state map it owns — and differs only in which
 *  events it sends and what it asserts. `overrides` takes any of the hook's own
 *  options for the tests that need a seeded state map, a shared query client, a
 *  named gateway profile, or a callback they can assert against. Callers still
 *  own `cleanup()`. */
export function renderMessageStream(
  sessionId: string | null,
  { states = new Map<string, ClientSessionState>(), ...overrides }: MessageStreamHarnessOptions = {}
): MessageStreamHarness {
  let dispatch: ((event: GatewayEvent) => void) | null = null
  let appendDelta: ((sessionId: string, delta: string) => void) | null = null
  let latest: ClientSessionState | null = null

  const originalGateway = $gateway.get()
  const requestHarness = new ServerRequestGateway()

  $gateway.set(requestHarness)

  function Harness() {
    const activeSessionIdRef = useRef<string | null>(sessionId)
    const sessionStateByRuntimeIdRef = useRef(states)
    const queryClientRef = useRef(new QueryClient())

    const stream = useMessageStream({
      activeSessionIdRef,
      hydrateFromStoredSession: vi.fn(async () => undefined),
      queryClient: queryClientRef.current,
      refreshHermesConfig: vi.fn(async () => undefined),
      refreshSessions: vi.fn(async () => undefined),
      sessionStateByRuntimeIdRef,
      updateSessionState: (id, updater) => {
        const next = updater(states.get(id) ?? createClientSessionState())
        states.set(id, next)
        latest = next

        return next
      },
      ...overrides
    })

    useEffect(() => {
      dispatch = stream.handleGatewayEvent
      appendDelta = stream.appendAssistantDelta
    }, [stream.appendAssistantDelta, stream.handleGatewayEvent])

    useEffect(
      () => () => {
        $gateway.set(originalGateway)
      },
      []
    )

    return null
  }

  const container = document.createElement('div')
  const root = createRoot(container)
  let unmounted = false

  flushSync(() => root.render(<Harness />))

  const unmount = () => {
    if (!unmounted) {
      flushSync(() => root.unmount())
      unmounted = true
      mountedHarnesses.delete(unmount)
    }
  }

  mountedHarnesses.add(unmount)

  const state = (id = sessionId ?? '') => states.get(id) ?? createClientSessionState()

  return {
    handleEvent: event => {
      if (!dispatch) {
        throw new Error('renderMessageStream: the hook never mounted')
      }

      dispatch(event)
    },
    handleServerRequest: request => requestHarness.fire(request),
    handleServerRequestCancel: cancel => requestHarness.fireCancel(cancel),
    appendDelta: (id, delta) => {
      if (!appendDelta) {
        throw new Error('renderMessageStream: the hook never mounted')
      }

      appendDelta(id, delta)
    },
    states,
    state,
    latest: () => latest,
    text: id => {
      const part = state(id).messages.at(-1)?.parts.at(-1)

      return part?.type === 'text' ? part.text : ''
    },
    reasoningText: () => {
      const part = latest?.messages.at(-1)?.parts.find(p => p.type === 'reasoning')

      return part?.type === 'reasoning' ? part.text : ''
    }
  }
}
