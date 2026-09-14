import type { ServerRequest } from '@hermes/shared'
import { atom, computed } from 'nanostores'

/**
 * Pending setup_mcp requests, keyed by the runtime session that raised them so
 * a background session can keep its card until the user opens that transcript.
 */
export interface McpSetupRequest {
  requestId: string
  request?: ServerRequest
  /** Catalog name (install) or mcp_servers config name (enable/authorize). */
  server: string
  action: 'authorize' | 'enable' | 'install'
  /** Agent-supplied one-liner: why this server helps right now. */
  reason: string
  sessionId: string | null
}

export interface McpSetupOutcome {
  status: 'authorized' | 'declined' | 'enabled' | 'error' | 'installed'
  server: string
  detail?: string
  /** Tool names now available (OAuth flows report them). */
  tools?: string[]
}

const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

export const $mcpSetupRequests = atom<Record<string, McpSetupRequest>>({})

export const sessionMcpSetupRequest = (sessionId: string | null) =>
  computed($mcpSetupRequests, requests => requests[keyFor(sessionId)] ?? null)

export function setMcpSetupRequest(request: McpSetupRequest): void {
  $mcpSetupRequests.set({ ...$mcpSetupRequests.get(), [keyFor(request.sessionId)]: request })
}

export function clearMcpSetupRequest(requestId?: string, sessionId?: string | null): void {
  const requests = $mcpSetupRequests.get()

  if (sessionId !== undefined) {
    const key = keyFor(sessionId)
    const current = requests[key]

    if (!current || (requestId && current.requestId !== requestId)) {
      return
    }

    const next = { ...requests }
    delete next[key]
    $mcpSetupRequests.set(next)

    return
  }

  const next: Record<string, McpSetupRequest> = {}
  let changed = false

  for (const [key, value] of Object.entries(requests)) {
    if (requestId && value.requestId !== requestId) {
      next[key] = value
    } else {
      changed = true
    }
  }

  if (changed) {
    $mcpSetupRequests.set(next)
  }
}

export const hasMcpSetupRequest = (sessionId: string | null | undefined): boolean =>
  Boolean($mcpSetupRequests.get()[keyFor(sessionId)])

export async function skipMcpSetupRequest(sessionId: string | null | undefined): Promise<boolean> {
  const request = $mcpSetupRequests.get()[keyFor(sessionId)]

  if (!request) {
    return false
  }

  clearMcpSetupRequest(request.requestId, request.sessionId)
  request.request?.respond({ value: JSON.stringify({ server: request.server, status: 'declined' }) })

  return true
}
