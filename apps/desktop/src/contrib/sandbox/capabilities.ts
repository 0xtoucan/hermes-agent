/**
 * The capability vocabulary for sandboxed (remote-tier) desktop plugins.
 * A plugin declares `desktop_capabilities:` in its plugin.yaml; absent, it
 * gets DEFAULT_CAPABILITIES. Every bridge method (sandbox/methods.ts)
 * names the ONE capability it needs; the host refuses the call — and toasts
 * the plugin + capability — when that capability was not granted.
 */

export const CAPABILITIES = {
  /** Contribute UI + data (register/registerMany), toast, haptics, read
   *  host.state, open a workspace tab, watch pane visibility. */
  ui: 'contribute UI, toast, read host state',
  /** Plugin-scoped persistence (ctx.storage). */
  storage: 'plugin-scoped storage',
  /** Listen to the gateway event stream (ctx.onEvent / host.onEvent) and open
   *  plugin-namespace WebSockets (ctx.socket). */
  events: 'gateway event stream',
  /** REST to the plugin's OWN backend namespace (`/api/plugins/<id>`). */
  rest: "REST to the plugin's own backend namespace",
  /** REST to any `/api/` route on the backend. */
  'rest:any': 'REST to any backend route',
  /** Gateway JSON-RPC (host.request), limited to GATEWAY_METHOD_CAPABILITIES. */
  'gateway:request': 'gateway RPC (allowlisted methods)',
  /** `host.request('prompt.submit')`: send a turn as the user. Visible — the
   *  prompt lands in the composer/transcript like any typed message. */
  'prompt:submit': 'submit prompts to the chat as you',
  /** `host.request('llm.oneshot')`: spend model tokens on a side request. */
  llm: 'run one-shot model requests',
  /** Read and write the composer draft (host.composer). */
  composer: 'read and edit the composer draft',
  /** Change the app route (host.navigate). */
  navigate: 'navigate the app',
  'os:clipboard': 'write the clipboard',
  'os:dialogs': 'open native file dialogs',
  'os:open-external': 'open URLs in the OS browser',
  'os:reveal-path': 'reveal paths in the file manager',
  'os:notify': 'native OS notifications'
} as const

export type Capability = keyof typeof CAPABILITIES

export const DEFAULT_CAPABILITIES: readonly Capability[] = ['ui', 'storage', 'events', 'rest']

export const isCapability = (value: unknown): value is Capability =>
  typeof value === 'string' && Object.hasOwn(CAPABILITIES, value)

/** Declared list -> granted set. Unknown names are dropped (reported by the
 *  caller), never silently widened; an absent list means the defaults. */
export function resolveCapabilities(declared: readonly unknown[] | undefined): {
  granted: ReadonlySet<Capability>
  unknown: string[]
} {
  if (!declared) {
    return { granted: new Set(DEFAULT_CAPABILITIES), unknown: [] }
  }

  const granted = new Set<Capability>()
  const unknown: string[] = []

  for (const name of declared) {
    if (isCapability(name)) {
      granted.add(name)
    } else {
      unknown.push(String(name))
    }
  }

  return { granted, unknown }
}

/** `host.request` methods a sandboxed plugin may call, each with the ONE
 *  capability that admits it. EXACT method names only — no prefix wildcards,
 *  so a new gateway method is never admitted by accident. Read-only methods
 *  ride on `gateway:request`; the two that ACT (submit a turn, spend tokens)
 *  have capabilities of their own so a manifest names them. Anything that
 *  installs, reconfigures or executes on the user's machine
 *  (`profiles.configure`, `cli.exec`, filesystem, terminal, secrets) stays
 *  host-only. Note that `session.history` returns full session transcripts:
 *  granting `gateway:request` implies READ access to every conversation the
 *  gateway holds, and a plugin manifest asking for it should be read that way. */
export const GATEWAY_METHOD_CAPABILITIES: Readonly<Record<string, Capability>> = {
  'billing.state': 'gateway:request',
  'commands.catalog': 'gateway:request',
  'cron.list': 'gateway:request',
  'free_tier.status': 'gateway:request',
  'llm.oneshot': 'llm',
  'profiles.list': 'gateway:request',
  'prompt.submit': 'prompt:submit',
  'session.history': 'gateway:request',
  'session.info': 'gateway:request',
  'session.list': 'gateway:request',
  'skills.list': 'gateway:request',
  status: 'gateway:request'
}

export const GATEWAY_METHOD_ALLOWLIST: ReadonlySet<string> = new Set(Object.keys(GATEWAY_METHOD_CAPABILITIES))

export const gatewayMethodAllowed = (method: string): boolean => Object.hasOwn(GATEWAY_METHOD_CAPABILITIES, method)

/** The capability a `host.request(method)` call needs — the method's own when
 *  allowlisted, else the generic gate (the call is then refused by name). */
export const gatewayMethodCapability = (method: string): Capability =>
  gatewayMethodAllowed(method) ? GATEWAY_METHOD_CAPABILITIES[method] : 'gateway:request'
