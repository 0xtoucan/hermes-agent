// The JSON boundary for backend→renderer requests. Frames arrive as parsed-but-untyped JSON and
// leave here as the named shapes the clients use; nothing past this file inspects raw wire data.
import { z } from 'zod'

import type { JsonRpcErrorPayload, JsonRpcFrame, JsonRpcTransport } from './json-rpc-channel.js'

export const SERVER_REQUEST_ID_PREFIX = 'srq-'
export const SERVER_REQUEST_CANCEL_METHOD = 'request.cancel'

/** Wire params of a backend→renderer request; `session_id` is the only field every kind carries. */
const serverRequestParamsSchema = z.object({ session_id: z.string().optional() }).catchall(z.unknown())
export type ServerRequestParams = z.infer<typeof serverRequestParamsSchema>

const stringRecordSchema = z.record(z.string(), z.string())

/** Value the renderer sends back; `value` for single-answer kinds, `answers` for a multi-question clarify. */
export interface ServerRequestResult {
  readonly value?: string
  readonly answers?: Readonly<Record<string, string>>
}

/** Body of a `clarify.progress` lock or any other progress notification tied to an open request. */
export interface ServerRequestProgress {
  readonly [key: string]: string | number | boolean | null
}

/** The backend blocks until this id receives a response. */
export interface ServerRequest {
  readonly id: string
  readonly method: string
  readonly params: ServerRequestParams
  readonly sessionId: string | null
  respond(result: ServerRequestResult): void
  fail(error: JsonRpcErrorPayload): void
  /** Progress does not settle the backend request. */
  notify(method: string, params: ServerRequestProgress): void
}

export interface ServerRequestCancel {
  readonly id: string
  readonly reason: string
  readonly sessionId: string | null
}

/** One entry of `session.events.since.open_requests`. */
export interface OpenServerRequest {
  readonly id: string
  readonly method: string
  readonly params: ServerRequestParams
  /** Per-question answers already accepted (multi-question clarify). */
  readonly partial?: Readonly<Record<string, string>>
}

/** What the renderer writes back: a response (result or error) or a progress notification. */
type OutboundReplyFrame =
  | { id: string; result: ServerRequestResult }
  | { id: string; error: JsonRpcErrorPayload }
  | { method: string; params: ServerRequestProgress & { id: string } }

/** Inbound frames sorted by shape, so callers branch on the kind, not on field probes. */
export type InboundServerFrame =
  | { kind: 'request'; id: string; method: string; params: ServerRequestParams }
  | { kind: 'cancel'; cancel: ServerRequestCancel }
  | { kind: 'other' }

const requestFrameSchema = z.object({
  id: z.string().startsWith(SERVER_REQUEST_ID_PREFIX),
  method: z.string(),
  params: serverRequestParamsSchema.catch({})
})

const cancelFrameSchema = z.object({
  method: z.literal(SERVER_REQUEST_CANCEL_METHOD),
  params: z.object({
    id: z.string(),
    reason: z.string().catch('cancelled'),
    session_id: z.string().nullable().catch(null)
  })
})

const openServerRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: serverRequestParamsSchema.catch({}),
  partial: stringRecordSchema.optional().catch(undefined)
})

/** Decode one parsed JSON-RPC frame from the backend into the server-request vocabulary. */
export function decodeInboundServerFrame(frame: JsonRpcFrame): InboundServerFrame {
  const request = requestFrameSchema.safeParse(frame)

  if (request.success) {
    return { kind: 'request', ...request.data }
  }

  const cancel = cancelFrameSchema.safeParse(frame)

  if (cancel.success) {
    const { id, reason, session_id: sessionId } = cancel.data.params

    return { kind: 'cancel', cancel: { id, reason, sessionId } }
  }

  return { kind: 'other' }
}

const openRequestsSchema = z.array(openServerRequestSchema.nullable().catch(null)).catch([])

/** Result of `session.events.since` as the replay path reads it; `open_requests` is decoded here. */
export const eventsSinceResultSchema = z.object({
  epoch: z.string().optional().catch(undefined),
  open_requests: openRequestsSchema.optional()
})
export type EventsSinceResult = z.infer<typeof eventsSinceResultSchema>

/** Decode `open_requests[]`; entries without the id/method a reply needs are dropped. */
export function decodeOpenServerRequests(raw: EventsSinceResult['open_requests']): OpenServerRequest[] {
  const out: OpenServerRequest[] = []

  for (const entry of raw ?? []) {
    if (entry) {
      const { partial, ...open } = entry
      out.push(partial && Object.keys(partial).length ? { ...open, partial } : open)
    }
  }

  return out
}

/**
 * Build the object a card answers through. `respond`/`fail` settle once; `notify` carries a
 * progress lock while the request is still open. A redelivered request (after reconnect)
 * folds `partial` into `params.answers` so the card re-arms with the locks the backend kept.
 */
export function makeServerRequest(transport: () => JsonRpcTransport | null, open: OpenServerRequest): ServerRequest {
  const params: ServerRequestParams = open.partial ? { ...open.params, answers: open.partial } : { ...open.params }
  let settled = false

  const send = (frame: OutboundReplyFrame) => {
    transport()?.send(JSON.stringify({ jsonrpc: '2.0', ...frame }))
  }

  return {
    id: open.id,
    method: open.method,
    params,
    sessionId: params.session_id ?? null,
    respond: result => {
      if (!settled) {
        settled = true
        send({ id: open.id, result })
      }
    },
    fail: error => {
      if (!settled) {
        settled = true
        send({ error, id: open.id })
      }
    },
    notify: (method, notifyParams) => {
      if (!settled) {
        send({ method, params: { id: open.id, ...notifyParams } })
      }
    }
  }
}
