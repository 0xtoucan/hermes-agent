import type { ServerRequest } from '@hermes/shared'

import { readActivePreview } from '@/app/chat/right-rail/preview-reader'
import { writeAgentTerminalChunk } from '@/app/right-sidebar/terminal/agent-terminal-stream'
import { readActiveTerminal } from '@/app/right-sidebar/terminal/buffer'
import { closeAgentTerminalByProc } from '@/app/right-sidebar/terminal/terminals'
import type { PreviewActAction } from '@/lib/preview-act/act-in-page'
import type { TourAction, TourStep } from '@/lib/tour'
import { applyDesktopLayoutPreset, revealDesktopPane } from '@/store/pane-focus'
import { recordAgentReaction } from '@/store/reactions-local'
import { setMessages } from '@/store/session'
import { $tipsEnabled, type ActiveTip, showTip } from '@/store/tips'
import { $toursEnabled } from '@/store/tours'

import type { GatewayEventContext, GatewayEventDeps } from './types'

interface DesktopBridgeRequestParams {
  action?: string
  amount?: number
  count?: number
  key?: string
  max?: number
  ref?: string
  selector?: string
  side?: TourStep['side']
  start?: number
  step_index?: number
  steps?: TourStep[]
  submit?: boolean
  surface?: 'app' | 'preview'
  text?: string
  title?: string
  to?: PreviewActAction['to']
}

function desktopBridgeRequestParams(request: ServerRequest): DesktopBridgeRequestParams {
  // SAFETY: backend request methods own this parameter shape.
  return request.params as DesktopBridgeRequestParams
}

/** The preview engine, loaded on demand so ~25KB of page-injectable source stays
 *  off the boot path.
 *
 *  In dev that lazy chunk is also a trap. The browser caches a dynamic import by
 *  URL for the life of the page, so this bridge would hand every action to
 *  whichever build of the engine loaded first, and no edit to it — or to the
 *  overlay whose source it stringifies into the page — would reach the guest
 *  until the whole window reloaded. Asking for a fresh copy is more reliable
 *  than trusting hot-update propagation to reach a module nothing statically
 *  imports; the dev server stamps the dependency URLs it has invalidated, so a
 *  fresh engine pulls a fresh overlay down with it.
 *
 *  The literal path is what a bare specifier can't be here, and it has to track
 *  this module's real location — hence the fall back to the static import, which
 *  is also the only branch production keeps, `import.meta.hot` being stripped
 *  there along with everything it guards. */
const loadPreviewEngine = () => {
  const stable = () => import('@/app/chat/right-rail/preview-act')

  if (!import.meta.hot) {
    return stable().then(mod => mod.actOnActivePreview)
  }

  return import(/* @vite-ignore */ '/src/app/chat/right-rail/preview-act.ts?hot=' + Date.now())
    .catch(stable)
    .then(mod => mod.actOnActivePreview as Awaited<ReturnType<typeof stable>>['actOnActivePreview'])
}

const pendingDesktopBridgeRequests = new Map<string, ServerRequest>()

function reattachPendingDesktopBridgeRequest(request: ServerRequest): boolean {
  if (!pendingDesktopBridgeRequests.has(request.id)) {
    return false
  }

  pendingDesktopBridgeRequests.set(request.id, request)

  return true
}

function requestResponder(request: ServerRequest): (result: unknown) => void {
  pendingDesktopBridgeRequests.set(request.id, request)

  return result => {
    const pendingRequest = pendingDesktopBridgeRequests.get(request.id)

    if (!pendingRequest) {
      return
    }

    pendingDesktopBridgeRequests.delete(request.id)
    pendingRequest.respond({ value: result ? JSON.stringify(result) : '' })
  }
}

export function cancelDesktopBridgeServerRequest(id: string): void {
  pendingDesktopBridgeRequests.delete(id)
}

export function handleDesktopBridgeServerRequest(request: ServerRequest, deps: GatewayEventDeps): boolean {
  if (reattachPendingDesktopBridgeRequest(request)) {
    return true
  }

  const params = desktopBridgeRequestParams(request)
  const isActiveRequest = request.sessionId !== null && request.sessionId === deps.activeSessionIdRef.current

  const handlers = new Map<string, () => void>([
    ['preview.act.request', () => {
      if (request.sessionId && !isActiveRequest) {
        return
      }

      const answer = requestResponder(request)

      if (isActiveRequest) {
        void loadPreviewEngine()
          .then(run =>
            run({
              amount: params.amount,
              key: params.key,
              kind: params.action ?? '',
              max: params.max,
              ref: params.ref,
              selector: params.selector,
              submit: params.submit,
              text: params.text,
              to: params.to
            })
          )
          .then(answer, error =>
            answer({ error: error instanceof Error ? error.message : String(error), success: false })
          )
      } else {
        answer({
          error: 'The in-app browser only takes actions in the session the user is looking at.',
          success: false
        })
      }
    }],
    ['preview.read.request', () => {
      const answer = requestResponder(request)

      void readActivePreview({ count: params.count, start: params.start }).then(answer, () => answer(null))
    }],
    ['terminal.read.request', () => {
      const result = readActiveTerminal({ count: params.count, start: params.start })

      request.respond({ value: result ? JSON.stringify(result) : '' })
    }],
    ['tour.request', () => {
      if (request.sessionId && !isActiveRequest) {
        return
      }

      const answer = requestResponder(request)

      if (!$toursEnabled.get()) {
        answer({ error: 'The user has turned guided tours off.', success: false })
      } else if (isActiveRequest) {
        void import('@/lib/tour')
          .then(({ runTour }) =>
            runTour(
              {
                kind: (params.action ?? 'stop') as TourAction['kind'],
                selector: params.selector,
                side: params.side,
                startAt: params.step_index,
                steps: params.steps,
                text: params.text,
                title: params.title
              },
              params.surface === 'preview' ? 'preview' : 'app'
            )
          )
          .then(answer, error =>
            answer({ error: error instanceof Error ? error.message : String(error), success: false })
          )
      } else {
        answer({
          error: 'Tours only run in the session the user is looking at.',
          success: false
        })
      }
    }],
    ['window.read.request', () => {
      const read = window.hermesDesktop?.readWindowBelow
      const answer = requestResponder(request)

      void Promise.resolve(read ? read() : null).then(answer, () => answer(null))
    }]
  ])

  const handler = handlers.get(request.method)

  if (!handler) {
    return false
  }

  handler()

  return true
}

export function handleDesktopBridgeEvent(ctx: GatewayEventContext): boolean {
  const { event, payload, isActiveEvent } = ctx

  if (event.type === 'agent.terminal.output') {
    writeAgentTerminalChunk(payload?.process_id ?? '', payload?.chunk ?? '')

    return true
  }

  if (event.type === 'terminal.close') {
    closeAgentTerminalByProc(payload?.process_id ?? '')

    return true
  }

  if (event.type === 'tip.show') {
    // tip tool: point the accent bubble at something and say one line about
    // it. Fire-and-forget — a tip is not a question, and blocking the turn on
    // one would stall the sentence the agent is in the middle of, so there is
    // nothing to answer and a refusal is simply a bubble that never appears.
    // Active session only: a background turn must never paint on the user's
    // screen (desktop AGENTS.md: offer, don't hijack).
    const selector = typeof payload?.selector === 'string' ? payload.selector : ''
    const text = typeof payload?.text === 'string' ? payload.text : ''

    // A tip with nothing to point at is just a notification, and the app
    // already has those. Dropping it here also stops a malformed event from
    // replacing a rotation tip with a bubble that dismisses itself a frame
    // later.
    if ($tipsEnabled.get() && isActiveEvent && selector && text) {
      showTip({
        side: (payload?.side as ActiveTip['side']) ?? 'top',
        targets: [selector],
        text,
        title: typeof payload?.title === 'string' ? payload.title : undefined
      })
    }

    return true
  }

  if (event.type === 'pane.reveal') {
    // Agent revealed a pane via the desktop-gated focus_pane tool, in
    // response to an explicit user request. Active session only — a
    // background turn must never move the user's focus (desktop AGENTS.md:
    // offer, don't hijack).
    if (isActiveEvent) {
      revealDesktopPane(payload?.pane ?? '')
    }

    return true
  }

  if (event.type === 'layout.apply') {
    // Agent applied a layout preset via the desktop-gated apply_layout
    // tool. Same contract as pane.reveal: active session only, and the
    // preset resolves against the SAME layouts registry the picker reads,
    // so core, plugin, and user presets are all addressable.
    if (isActiveEvent) {
      applyDesktopLayoutPreset(typeof payload?.preset === 'string' ? payload.preset : '')
    }

    return true
  }

  if (event.type === 'message.reaction') {
    // The agent reacted to a message via the desktop-gated
    // react_to_message tool. Already persisted — this only paints it now
    // instead of at the next resume. Fresh ChatMessage object per change:
    // the runtime repository caches normalized ThreadMessages in a WeakMap
    // keyed by ChatMessage identity.
    const reactedRowId = payload?.row_id

    if (typeof reactedRowId === 'number') {
      const nextReactions = Array.isArray(payload?.reactions) ? payload.reactions : []
      const reactedRole = payload?.role === 'assistant' ? 'assistant' : 'user'

      setMessages(messages => {
        // Preferred leg: the message already knows its durable row id
        // (rehydrated transcript, or a live row that has round-tripped).
        const byRowId = messages.find(message => message.rowId === reactedRowId)

        if (byRowId) {
          // Overlay survives the end-of-turn resume, which rebuilds from
          // in-memory history that doesn't carry this mid-turn DB write.
          recordAgentReaction(reactedRowId, nextReactions)

          return messages.map(message =>
            message.rowId === reactedRowId ? { ...message, reactions: nextReactions } : message
          )
        }

        // Live leg: the targeted message is still optimistic (no rowId —
        // it hasn't round-tripped through a resume). The agent's default
        // target is the newest message of that role, so stamp the reaction
        // AND the now-known row id onto it. Without this the event matches
        // nothing and the reaction only appears after a reload.
        const lastIndex = messages.findLastIndex(message => message.role === reactedRole && message.rowId === undefined)

        if (lastIndex === -1) {
          return messages
        }

        recordAgentReaction(reactedRowId, nextReactions)

        return messages.map((message, index) =>
          index === lastIndex ? { ...message, rowId: reactedRowId, reactions: nextReactions } : message
        )
      })
    }

    return true
  }

  return false
}
