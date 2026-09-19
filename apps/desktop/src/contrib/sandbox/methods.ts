/**
 * The SDK subset a sandboxed plugin can reach, as a TABLE: guest method name
 * -> the ONE capability it needs + the host code that runs it. `realm.ts`
 * looks a call up here, checks the capability, and refuses everything else —
 * so adding a row is the only way to widen what a sandboxed plugin can do, and
 * the row states its price.
 *
 * Host DOM access (`host.querySelector` & co.) is deliberately absent: the
 * guest runtime throws for it with a "needs an SDK hook" hint.
 */

import { createElement } from 'react'

import { hermesApi, profileScoped } from '@/api/client'
import type { PluginContext, PluginContribution } from '@/contrib/plugin'
import { admitPreviewExternalUrl } from '@/lib/preview-external'
import * as sdk from '@/sdk'
import type { NotificationInput, NotificationKind } from '@/store/notifications'

import { type Capability, gatewayMethodAllowed, gatewayMethodCapability } from './capabilities'
import { isCallbackRef, isRenderRef } from './protocol'
import type { SandboxRealm } from './realm'
import { SandboxSlot } from './slot'

export interface MethodEnv {
  ctx: PluginContext
  realm: SandboxRealm
}

export interface SandboxMethod {
  /** The ONE capability the call needs — fixed, or derived from the call's
   *  arguments (`request` charges the gateway method's own capability). */
  capability: Capability | ((args: unknown[]) => Capability)
  run: (env: MethodEnv, args: unknown[]) => Promise<unknown> | unknown
}

export const methodCapability = (method: SandboxMethod, args: unknown[]): Capability =>
  typeof method.capability === 'function' ? method.capability(args) : method.capability

const str = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${what} must be a non-empty string`)
  }

  return value
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** Rebuild guest callbacks (`{ __hermesCallback }`) as host functions that
 *  invoke them over the bridge. Depth-bounded like the guest's marshal. */
function unmarshal(realm: SandboxRealm, value: unknown, depth = 0): unknown {
  if (isCallbackRef(value)) {
    const id = value.__hermesCallback

    return (...args: unknown[]) => realm.invoke(id, args)
  }

  // A React node in the data (statusbar `label`): an inline guest slot.
  if (isRenderRef(value)) {
    return createElement(SandboxSlot, { fill: false, realm, renderId: value.__hermesRender })
  }

  if (!value || typeof value !== 'object' || depth > 6) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => unmarshal(realm, item, depth + 1))
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unmarshal(realm, item, depth + 1)]))
}

export const MAX_REQUEST_TIMEOUT_MS = 5 * 60_000

const NOTIFICATION_KINDS: readonly NotificationKind[] = ['error', 'info', 'success', 'warning']

/** Only the TEXT of a guest toast crosses the bridge. `id` could replace or
 *  dismiss the host's own toasts, `action`/`secondaryAction` would run host
 *  code, `durationMs`/`placement` let a plugin park a sticky banner anywhere. */
function guestNotification(input: Record<string, unknown>): NotificationInput {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  const kind = NOTIFICATION_KINDS.find(name => name === input.kind)

  return {
    kind,
    message: str(input.message, 'notification message'),
    title: text(input.title),
    detail: text(input.detail)
  }
}

/** A contribution's `render`, host side: every mount becomes a `SandboxSlot`
 *  placeholder with its own slot id, carrying the render props (a transcript
 *  directive's attrs, a route's params) to the guest's render function. */
const slotRender = (realm: SandboxRealm, renderId: string, fill: boolean) => (props?: unknown) =>
  createElement(SandboxSlot, { fill, props, realm, renderId })

/** Areas whose items size themselves (bars); everything else fills its zone. */
const INTRINSIC_AREA_PREFIXES = ['statusBar.', 'titleBar.', 'composer.']

const fillsArea = (area: string) => !INTRINSIC_AREA_PREFIXES.some(prefix => area.startsWith(prefix))

function register({ ctx, realm }: MethodEnv, [raw]: unknown[]): string {
  const input = record(raw)
  const id = str(input.id, 'contribution id')
  const area = str(input.area, 'contribution area')
  const { hasRender, ...fields } = unmarshal(realm, input) as Record<string, unknown> & { hasRender?: boolean }

  const contribution: PluginContribution = {
    ...(fields as PluginContribution),
    id,
    area,
    ...(hasRender ? { render: slotRender(realm, id, fillsArea(area)) } : {})
  }

  realm.registrations.get(id)?.()
  realm.registrations.set(id, ctx.register(contribution))

  return id
}

/** Lexically normalize an absolute path: forward slashes, `.`/`..` resolved,
 *  Windows drive letters lower-cased. No filesystem access — the renderer has
 *  none — so a symlink inside the folder is still "inside"; what the check
 *  denies is naming anything outside it. */
export function normalizePath(input: string): string {
  const unified = input.replace(/\\/g, '/')
  const drive = /^[a-zA-Z]:/.exec(unified)?.[0].toLowerCase() ?? ''
  const segments: string[] = []

  for (const segment of unified.slice(drive.length).split('/')) {
    if (segment === '..') {
      segments.pop()
    } else if (segment && segment !== '.') {
      segments.push(segment)
    }
  }

  return `${drive}/${segments.join('/')}`
}

const folderOf = (file: string) => normalizePath(file).replace(/\/[^/]*$/, '')

export function insideFolder(folder: string, target: string): boolean {
  const base = normalizePath(folder)
  const path = normalizePath(target)

  return path === base || path.startsWith(`${base}/`)
}

export const METHODS: Record<string, SandboxMethod> = {
  register: { capability: 'ui', run: register },
  unregister: {
    capability: 'ui',
    run: ({ realm }, [id]) => {
      realm.registrations.get(str(id, 'contribution id'))?.()
      realm.registrations.delete(id as string)
    }
  },
  notify: { capability: 'ui', run: (_env, [input]) => void sdk.host.notify(guestNotification(record(input))) },
  notifyError: {
    capability: 'ui',
    run: (_env, [message, fallback]) =>
      void sdk.host.notifyError(new Error(String(message)), String(fallback ?? message))
  },
  haptic: { capability: 'ui', run: (_env, [intent]) => void sdk.haptic(str(intent, 'haptic intent') as never) },
  paneVisibility: {
    capability: 'ui',
    run: ({ realm }, [paneId]) => {
      const id = str(paneId, 'pane id')
      realm.track(
        sdk.host
          .paneVisibility(id)
          .subscribe(visible => realm.send({ paneId: id, type: 'pane-visibility', visible: Boolean(visible) }))
      )
    }
  },
  openWorkspace: {
    capability: 'ui',
    run: ({ realm }, [id, options]) => {
      const key = str(id, 'workspace id')
      const opts = unmarshal(realm, record(options)) as Record<string, unknown>
      realm.workspaces.get(key)?.()
      realm.workspaces.set(
        key,
        realm.track(
          sdk.host.openWorkspace(`${realm.pluginId}:${key}`, {
            ...(opts as { title?: string; onClose?: () => void }),
            render: slotRender(realm, `workspace:${key}`, true)
          })
        )
      )
    }
  },
  closeWorkspace: {
    capability: 'ui',
    run: ({ realm }, [id]) => {
      realm.workspaces.get(str(id, 'workspace id'))?.()
      realm.workspaces.delete(id as string)
    }
  },
  navigate: { capability: 'navigate', run: (_env, [path]) => sdk.host.navigate(str(path, 'path')) },

  onEvent: {
    capability: 'events',
    run: ({ ctx, realm }, [subId, type]) => {
      const id = Number(subId)
      realm.eventSubs.set(
        id,
        ctx.onEvent(str(type, 'event type'), event => realm.send({ event, subId: id, type: 'event' }))
      )
    }
  },
  offEvent: {
    capability: 'events',
    run: ({ realm }, [subId]) => {
      realm.eventSubs.get(Number(subId))?.()
      realm.eventSubs.delete(Number(subId))
    }
  },

  storageSet: {
    capability: 'storage',
    run: ({ ctx }, [key, value]) => ctx.storage.set(str(key, 'storage key'), value)
  },
  storageRemove: { capability: 'storage', run: ({ ctx }, [key]) => ctx.storage.remove(str(key, 'storage key')) },

  // `ctx.socket`: the host owns the WebSocket (plugin namespace, resolved by
  // pluginSocket) and relays frames; the guest only ever sees parsed data.
  socketOpen: {
    capability: 'events',
    run: ({ ctx, realm }, [sockId, path]) => {
      const id = Number(sockId)
      realm.sockets.get(id)?.()
      realm.sockets.set(
        id,
        ctx.socket(str(path, 'socket path'), data => realm.send({ data, sockId: id, type: 'socket' }))
      )
    }
  },
  socketClose: {
    capability: 'events',
    run: ({ realm }, [sockId]) => {
      realm.sockets.get(Number(sockId))?.()
      realm.sockets.delete(Number(sockId))
    }
  },

  composerGetText: { capability: 'composer', run: () => sdk.host.composer.getText() },
  composerInsertText: {
    capability: 'composer',
    run: (_env, [text, mode]) =>
      sdk.host.composer.insertText(str(text, 'text'), (['block', 'inline', 'prefix'] as const).find(m => m === mode))
  },
  composerSetText: { capability: 'composer', run: (_env, [text]) => sdk.host.composer.setText(String(text ?? '')) },

  rest: {
    capability: 'rest',
    run: ({ ctx }, [path, opts]) => ctx.rest(str(path, 'path'), record(opts))
  },
  restAny: {
    capability: 'rest:any',
    run: (_env, [path, opts]) => {
      const target = str(path, 'path')

      if (!target.startsWith('/api/')) {
        throw new Error('restAny: path must start with /api/')
      }

      const o = record(opts)

      return hermesApi({ path: target, method: o.method as never, body: o.body, ...profileScoped() })
    }
  },
  request: {
    capability: ([method]) => gatewayMethodCapability(String(method)),
    run: (_env, [method, params, timeoutMs]) => {
      const name = str(method, 'method')

      if (!gatewayMethodAllowed(name)) {
        throw new Error(`gateway method "${name}" is not on the sandbox allowlist`)
      }

      // A plugin may lengthen ONE call's deadline (an `llm.oneshot` runs past
      // the 30s default), bounded so a frame cannot pin a request forever.
      const timeout =
        typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? Math.min(timeoutMs, MAX_REQUEST_TIMEOUT_MS)
          : undefined

      if (timeout === undefined) {
        return sdk.host.request(name, record(params))
      }

      const gateway = sdk.host.getGateway()

      if (!gateway) {
        throw new Error('Hermes gateway unavailable')
      }

      return gateway.request(name, record(params), timeout)
    }
  },

  osNotify: { capability: 'os:notify', run: ({ ctx }, [input]) => ctx.os.notify(record(input) as never) },
  // Native dialogs: the user picks, so the plugin learns exactly one path the
  // user chose to show it — a backend path it can only hand to `ctx.rest`.
  osPickOpenPath: { capability: 'os:dialogs', run: ({ ctx }, [options]) => ctx.os.pickOpenPath(record(options)) },
  osPickSavePath: { capability: 'os:dialogs', run: ({ ctx }, [options]) => ctx.os.pickSavePath(record(options)) },
  osWriteClipboard: { capability: 'os:clipboard', run: ({ ctx }, [text]) => ctx.os.writeClipboard(String(text)) },
  osOpenExternal: {
    capability: 'os:open-external',
    run: ({ ctx }, [url]) => {
      const target = str(url, 'url')

      // Same admission as a preview guest's link: the web subset only. `file:`
      // and custom schemes reach `shell.openPath` / protocol handlers in main.
      if (!admitPreviewExternalUrl(target)) {
        throw new Error('openExternal: only http(s) URLs may be opened from a sandboxed plugin')
      }

      return ctx.os.openExternal(target)
    }
  },
  osRevealPath: {
    capability: 'os:reveal-path',
    run: ({ ctx, realm }, [path]) => {
      const target = str(path, 'path')

      if (!realm.file || !insideFolder(folderOf(realm.file), target)) {
        throw new Error('revealPath: a sandboxed plugin may only reveal paths inside its own install folder')
      }

      return ctx.os.revealPath(target)
    }
  }
}
