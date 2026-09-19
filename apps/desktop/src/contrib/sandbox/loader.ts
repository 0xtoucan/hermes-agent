/**
 * `loadSandboxedPlugin` — the remote-tier twin of `loadRuntimePlugin`
 * (contrib/runtime-loader.ts). Same inputs, same inventory contract
 * (publishPlugin + activate/deactivate handles, bundled-shadow rule), but the
 * source is never evaluated in this realm: it goes into a `SandboxRealm`
 * frame and only the capability-gated method table reaches back.
 */

import { type PluginContext } from '@/contrib/plugin'
import { $pluginRecords, pluginActive, type PluginRecord, publishPlugin } from '@/contrib/plugins-store'
import { TRANSLATIONS } from '@/i18n/catalog'
import { $runtimeLocale } from '@/i18n/runtime'
import * as sdk from '@/sdk'
import { notifyError } from '@/store/notifications'

import { resolveCapabilities } from './capabilities'
import {
  buildFrameDocument,
  collectHostFontFaces,
  collectHostStyleText,
  pluginWantsStreamdown,
  styleSheetText
} from './frame-document'
import { FN_LEAF, type GuestMessage } from './protocol'
import { type SandboxFrame, SandboxRealm } from './realm'

export interface SandboxLoadOptions {
  /** Declared `desktop_capabilities` from plugin.yaml; undefined = defaults. */
  capabilities?: readonly unknown[]
  defaultEnabled?: boolean
  file?: string
  packageName?: string
  packageOrigin?: PluginRecord['packageOrigin']
  /** Test seam: fake frame factory + no boot timeout. */
  createFrame?: (srcdoc: string, realm: SandboxRealm) => SandboxFrame
  bootTimeoutMs?: number
}

type Manifest = Extract<GuestMessage, { type: 'manifest' }>

const realms = new Map<string, SandboxRealm>()

export function unloadSandboxedPlugin(id: string): void {
  realms.get(id)?.dispose()
  realms.delete(id)
}

/** Everything under `hermes.plugin.<id>.` — the guest's storage cache seed. */
function storageSnapshot(pluginId: string): Record<string, unknown> {
  const prefix = `hermes.plugin.${pluginId}.`
  const values: Record<string, unknown> = {}

  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)

      if (key?.startsWith(prefix)) {
        try {
          values[key.slice(prefix.length)] = JSON.parse(window.localStorage.getItem(key) ?? 'null')
        } catch {
          // Unparseable leftovers are not the guest's problem.
        }
      }
    }
  } catch {
    // Restricted storage — the guest starts empty.
  }

  return values
}

/** Push `host.state` into the frame: a snapshot now, then every change,
 *  coalesced per microtask so a burst of atom writes is one message. */
function bridgeHostState(realm: SandboxRealm): void {
  const entries = Object.entries(sdk.host.state)
  const snapshot = () => Object.fromEntries(entries.map(([key, store]) => [key, store.get()]))
  let queued = false

  const flush = () => {
    queued = false
    realm.send({ type: 'state', values: snapshot() })
  }

  flush()

  for (const [, store] of entries) {
    realm.track(
      store.listen(() => {
        if (!queued) {
          queued = true
          queueMicrotask(flush)
        }
      })
    )
  }
}

/** Mirror the host's theme (class + inline tokens on <html>) into the frame. */
function bridgeTheme(realm: SandboxRealm): void {
  const root = document.documentElement
  const push = () => realm.send({ className: root.className, style: root.getAttribute('style') ?? '', type: 'theme' })

  push()

  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(push)
    observer.observe(root, { attributeFilter: ['class', 'style'], attributes: true })
    realm.track(() => observer.disconnect())
  }
}

/** The catalog namespaces the SDK's own components read. The whole catalog is
 *  ~180 KB per locale; a plugin's own strings travel with the plugin. */
const BRIDGED_CATALOG_PATHS = ['common', 'errors.genericFailure', 'ui.search', 'ui.pagination'] as const

export function serializeStrings(value: unknown): unknown {
  if (typeof value === 'function') {
    return FN_LEAF
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeStrings(item)]))
  }

  return value
}

export function catalogSlice(catalog: Record<string, unknown>, paths: readonly string[] = BRIDGED_CATALOG_PATHS) {
  const out: Record<string, unknown> = {}

  for (const path of paths) {
    const keys = path.split('.')
    let source: unknown = catalog
    let target = out

    for (const [index, key] of keys.entries()) {
      source = source && typeof source === 'object' ? (source as Record<string, unknown>)[key] : undefined

      if (source === undefined) {
        break
      }

      if (index === keys.length - 1) {
        target[key] = serializeStrings(source)
      } else {
        target = (target[key] ??= {}) as Record<string, unknown>
      }
    }
  }

  return out
}

/** Active locale + the catalog slice, now and on every switch. */
function bridgeLocale(realm: SandboxRealm): void {
  const push = (locale: string) =>
    realm.send({
      locale,
      strings: catalogSlice(TRANSLATIONS[locale as keyof typeof TRANSLATIONS] as unknown as Record<string, unknown>),
      type: 'locale'
    })

  push($runtimeLocale.get())
  realm.track($runtimeLocale.listen(push))
}

const fontFiles = new Map<string, Promise<ArrayBuffer | null>>()

/** Host font files (codicon glyphs, the app's faces) as bytes: the frame's CSP
 *  forbids the fetch a copied `@font-face` would make. Fetched once per URL. */
function bridgeFonts(realm: SandboxRealm, faces = collectHostFontFaces()): void {
  for (const face of faces) {
    let pending = fontFiles.get(face.url)

    if (!pending) {
      pending = fetch(face.url)
        .then(response => (response.ok ? response.arrayBuffer() : null))
        .catch(() => null)
      fontFiles.set(face.url, pending)
    }

    void pending.then(data => {
      if (data) {
        realm.send({ data, descriptors: face.descriptors, family: face.family, type: 'font' })
      }
    })
  }
}

/** Host CSS that arrives after the frame was built — a lazily loaded page
 *  chunk whose classes a plugin pane relies on — is mirrored as it lands. */
function bridgeLateStyles(realm: SandboxRealm): void {
  if (typeof MutationObserver !== 'function') {
    return
  }

  const seen = new WeakSet<Node>(Array.from(document.styleSheets, sheet => sheet.ownerNode).filter(Boolean) as Node[])

  const flush = () => {
    let css = ''

    for (const sheet of Array.from(document.styleSheets)) {
      const owner = sheet.ownerNode

      if (owner && !seen.has(owner)) {
        seen.add(owner)
        css += styleSheetText(sheet)
      }
    }

    if (css) {
      realm.send({ css, type: 'style' })
    }
  }

  const observer = new MutationObserver(flush)
  observer.observe(document.head, { childList: true, subtree: true })
  document.addEventListener('load', flush, true)
  realm.track(() => {
    observer.disconnect()
    document.removeEventListener('load', flush, true)
  })
}

function bootstrap(realm: SandboxRealm, _ctx: PluginContext): void {
  realm.send({ type: 'storage', values: storageSnapshot(realm.pluginId) })
  bridgeLocale(realm)
  bridgeHostState(realm)
  bridgeTheme(realm)
  bridgeFonts(realm)
  bridgeLateStyles(realm)
}

function awaitManifest(
  create: (hooks: { onError: (message: string) => void; onManifest: (manifest: Manifest) => void }) => SandboxRealm,
  timeoutMs: number
): Promise<{ manifest: Manifest; realm: SandboxRealm }> {
  return new Promise((resolve, reject) => {
    let realm: SandboxRealm | null = null
    let settled = false
    let timer = 0

    const settle = (fn: () => void) => {
      if (settled) {
        return
      }

      settled = true
      window.clearTimeout(timer)
      fn()
    }

    // A realm that never boots is still a live iframe + message listener;
    // it must go with the rejection, not wait for the next reload.
    const fail = (message: string) =>
      settle(() => {
        realm?.dispose()
        reject(new Error(message))
      })

    if (timeoutMs > 0) {
      timer = window.setTimeout(() => fail('sandbox frame did not boot in time'), timeoutMs)
    }

    realm = create({
      onError: fail,
      onManifest: manifest => settle(() => resolve({ manifest, realm: realm! }))
    })
  })
}

/** Load one remote-tier plugin into a sandbox frame. Returns its trusted id
 *  (the install folder), or null on failure — same contract as
 *  `loadRuntimePlugin`, so the disk door treats both tiers alike. */
export async function loadSandboxedPlugin(
  source: string,
  origin: string,
  options: SandboxLoadOptions = {}
): Promise<null | string> {
  const pluginId = options.packageName ?? origin
  const { granted, unknown } = resolveCapabilities(options.capabilities)

  if (unknown.length > 0) {
    console.warn(`[plugins] ${pluginId}: unknown desktop_capabilities ignored: ${unknown.join(', ')}`)
  }

  unloadSandboxedPlugin(pluginId)

  const record = {
    id: pluginId,
    name: pluginId,
    kind: 'disk' as const,
    file: options.file,
    packageName: options.packageName,
    packageOrigin: options.packageOrigin
  }

  try {
    if ($pluginRecords.get()[pluginId]?.kind === 'bundled') {
      console.info(`[plugins] ${origin} skipped — "${pluginId}" already ships bundled with the app`)
      publishPlugin({
        ...record,
        id: `${pluginId}:disk-shadowed`,
        name: `${pluginId} (stale disk copy)`,
        description: `Shadowed by the bundled "${pluginId}" plugin — this folder is no longer used and can be deleted.`,
        status: 'disabled'
      })

      return null
    }

    const srcdoc = buildFrameDocument({
      pluginId,
      pluginSource: source,
      sdkExports: Object.keys(sdk),
      streamdown: pluginWantsStreamdown(source),
      styleText: collectHostStyleText()
    })

    let named = { ...record, name: pluginId, description: undefined as string | undefined }
    let booted = false

    const { manifest, realm } = await awaitManifest(
      hooks =>
        new SandboxRealm({
          createFrame: options.createFrame,
          file: options.file,
          granted,
          name: pluginId,
          pluginId,
          srcdoc,
          onError: message => {
            console.error(`[plugins] ${pluginId} (sandbox)`, message)

            if (booted) {
              // Post-boot failure (boundary violation, guest crash): the realm
              // is gone; the inventory row must say so instead of "loaded".
              publishPlugin({ ...named, status: 'error', error: message })
            } else {
              hooks.onError(message)
            }
          },
          onManifest: hooks.onManifest
        }),
      options.bootTimeoutMs ?? 15_000
    )

    booted = true
    realms.set(pluginId, realm)

    named = { ...record, name: manifest.name ?? pluginId, description: manifest.description }
    console.info(
      `[plugins] ${pluginId} loaded in a sandboxed realm (remote tier); capabilities: ${[...granted].join(', ')}`
    )

    const activate = () => {
      realm.activate(bootstrap)
      publishPlugin({ ...named, status: 'loaded' })
    }

    publishPlugin({ ...named, status: 'disabled' }, { activate, deactivate: () => realm.deactivate() })

    if (pluginActive(pluginId, (manifest.defaultEnabled ?? true) && (options.defaultEnabled ?? true))) {
      activate()
    }

    return pluginId
  } catch (error) {
    console.error(`[plugins] sandbox load failed (${origin})`, error)
    notifyError(error, `Plugin "${origin}" failed to load`)
    unloadSandboxedPlugin(pluginId)
    publishPlugin({
      ...record,
      id: origin,
      name: origin,
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    })

    return null
  }
}
