/**
 * HOST side of the remote-plugin sandbox: one `SandboxRealm` per plugin owns
 * the plugin's `<iframe sandbox="allow-scripts">`, routes its postMessage
 * traffic, and multiplexes every contribution the plugin renders into the
 * host layout.
 *
 * Boundary, in order of what stops what:
 *  - `sandbox="allow-scripts"` (no allow-same-origin) → opaque origin: the
 *    guest cannot touch `parent.document`, our localStorage, our cookies, or
 *    the SDK singletons; `window.parent.document` throws SecurityError.
 *  - srcdoc CSP `default-src 'none'` → no network, no remote scripts.
 *  - This class answers ONLY the methods in `methods.ts`, each behind ONE
 *    capability from `capabilities.ts`; anything else is refused with a
 *    toast naming the plugin and the capability.
 *  - `event.source === iframe.contentWindow` → no other document can speak
 *    for the plugin.
 *
 * Layout: the frame is a full-window transparent overlay (`z-40`, under the
 * app's dialogs/popovers at z-50). For every contribution the host renders a
 * placeholder (`SandboxSlot`) and streams its on-screen rect to the guest,
 * which positions that contribution's React tree over it; `clip-path` on the
 * iframe limits hit-testing to those rects so the rest of the window stays
 * clickable. One frame per plugin — not one per contribution — because a
 * plugin is one module with one state: per-contribution frames would evaluate
 * it N times and break `openWorkspace`, shared stores and `onDispose`.
 */

import { atom } from 'nanostores'

import { createPluginContext, type PluginContext } from '@/contrib/plugin'
import { notify } from '@/store/notifications'

import { CAPABILITIES, type Capability } from './capabilities'
import { methodCapability, METHODS } from './methods'
import {
  type GuestMessage,
  type HostMessage,
  isGuestMessage,
  SANDBOX_PROTOCOL,
  type SlotFill,
  type SlotRect
} from './protocol'

export interface SandboxFrame {
  element: HTMLIFrameElement
  post: (message: HostMessage & { hermes: string }) => void
  remove: () => void
  window: null | Window
}

export interface SandboxRealmOptions {
  /** Trusted key: the install folder. Scopes storage/REST/provenance. */
  pluginId: string
  /** Absolute path of the plugin's entry file; `os.revealPath` may only
   *  reveal paths inside its folder. Absent = the method is refused. */
  file?: string
  name: string
  granted: ReadonlySet<Capability>
  srcdoc: string
  /** Frame factory seam — tests inject a fake that speaks as the guest
   *  through `realm.handle`; production builds the iframe. */
  createFrame?: (srcdoc: string, realm: SandboxRealm) => SandboxFrame
  onError?: (message: string) => void
  onManifest?: (manifest: Extract<GuestMessage, { type: 'manifest' }>) => void
  onReady?: () => void
}

const CONTAINER_ID = 'hermes-plugin-sandboxes'

function sandboxContainer(): HTMLElement {
  let container = document.getElementById(CONTAINER_ID)

  if (!container) {
    container = document.createElement('div')
    container.id = CONTAINER_ID
    container.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;'
    document.body.appendChild(container)
  }

  return container
}

function createIframeFrame(srcdoc: string): SandboxFrame {
  const element = document.createElement('iframe')
  // allow-scripts ONLY. Never add allow-same-origin: it would collapse the
  // opaque origin and hand the guest the whole app.
  element.setAttribute('sandbox', 'allow-scripts')
  element.setAttribute('title', 'plugin sandbox')
  element.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;pointer-events:none;'
  hideFrame(element)
  element.srcdoc = srcdoc
  sandboxContainer().appendChild(element)

  return {
    element,
    post: message => element.contentWindow?.postMessage(message, '*'),
    remove: () => element.remove(),
    get window() {
      return element.contentWindow
    }
  }
}

/** No slot on screen: the overlay must neither paint nor take focus. `inert`
 *  keeps a guest `input.focus()` from stealing the keyboard off the composer;
 *  `visibility:hidden` + a fully-inset clip stop any paint. */
function hideFrame(element: HTMLIFrameElement): void {
  element.style.pointerEvents = 'none'
  element.style.clipPath = 'inset(100%)'
  element.style.visibility = 'hidden'
  element.setAttribute('inert', '')
}

/** Guest-reported intrinsic sizes are advisory: a bar chip gets at most this
 *  much of the bar; a filling slot (pane/workspace) never sizes its host. */
export const MAX_CHIP_WIDTH = 320
export const MAX_CHIP_HEIGHT = 64
/** A block (directive leaf) may grow tall, never past a screen. */
export const MAX_BLOCK_HEIGHT = 800

const clampSize = (value: unknown, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, max) : 0

const EMPTY_RECT: SlotRect = { height: 0, left: 0, top: 0, width: 0 }

/** Placeholder rect clipped by every overflow-hiding ancestor, so a chip
 *  scrolled out of a pane body does not paint over unrelated chrome. */
function visibleRect(el: HTMLElement): SlotRect {
  // A kept-alive inactive tab hides its pane with `visibility: hidden` (the
  // layout box survives so scroll state does); the box is there, the pane is
  // not on screen, and painting the guest over it would cover the ACTIVE tab.
  if (getComputedStyle(el).visibility === 'hidden') {
    return EMPTY_RECT
  }

  const box = el.getBoundingClientRect()
  let left = box.left
  let top = box.top
  let right = box.right
  let bottom = box.bottom

  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflow

    if (overflow && overflow !== 'visible') {
      const clip = node.getBoundingClientRect()
      left = Math.max(left, clip.left)
      top = Math.max(top, clip.top)
      right = Math.min(right, clip.right)
      bottom = Math.min(bottom, clip.bottom)
    }
  }

  // A placeholder with extent on ONE axis (the 1×0 chip the host has not
  // sized yet) must reach the guest so it can measure and report the chip.
  return right >= left && bottom >= top && (right > left || bottom > top)
    ? { height: bottom - top, left, top, width: right - left }
    : EMPTY_RECT
}

const isFiniteRect = (rect: unknown): rect is SlotRect =>
  typeof rect === 'object' &&
  rect !== null &&
  (['left', 'top', 'width', 'height'] as const).every(key => Number.isFinite((rect as SlotRect)[key]))

const sameRect = (a: SlotRect, b: SlotRect) =>
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height

export class SandboxRealm {
  readonly pluginId: string
  readonly file: string | undefined
  readonly name: string
  readonly granted: ReadonlySet<Capability>
  /** Intrinsic size the guest reports per slot — bars size their placeholder from it. */
  readonly $slotSizes = atom<Record<string, { height: number; width: number }>>({})

  private readonly frame: SandboxFrame
  private readonly options: SandboxRealmOptions
  private readonly onMessage: (event: MessageEvent) => void
  private ctx: null | PluginContext = null
  /** The just-deactivated context, kept for the guest's `onDispose` calls
   *  (a final `storage.set`, a goodbye toast) until it reports `deactivated`
   *  or the grace timer runs out. */
  private teardownCtx: null | PluginContext = null
  private teardownTimer: null | number = null
  private disposers: (() => void)[] = []
  private readonly refused = new Set<Capability>()
  private readonly slots = new Map<string, { el: HTMLElement; fill: SlotFill; rect: SlotRect }>()
  /** Rects of guest layers painted outside slots (dialogs, popovers). */
  private overlayRects: SlotRect[] = []
  private rafId: null | number = null
  private nextInvokeId = 1
  private readonly invocations = new Map<number, { reject: (e: Error) => void; resolve: (v: unknown) => void }>()
  private disposed = false

  /** Per-method scratch the method table may use (registrations, subscriptions…). */
  readonly registrations = new Map<string, () => void>()
  readonly eventSubs = new Map<number, () => void>()
  readonly sockets = new Map<number, () => void>()
  readonly workspaces = new Map<string, () => void>()

  constructor(options: SandboxRealmOptions) {
    this.options = options
    this.pluginId = options.pluginId
    this.file = options.file
    this.name = options.name
    this.granted = options.granted
    this.onMessage = event => this.receive(event)
    window.addEventListener('message', this.onMessage)
    this.frame = (options.createFrame ?? createIframeFrame)(options.srcdoc, this)
  }

  // ── transport ─────────────────────────────────────────────────────────────

  send(message: HostMessage): void {
    if (!this.disposed) {
      this.frame.post({ hermes: SANDBOX_PROTOCOL, ...message })
    }
  }

  private receive(event: MessageEvent): void {
    // A detached frame has no window; `null === null` must never authenticate.
    const guest = this.frame.window

    if (!guest || event.source !== guest || !isGuestMessage(event.data)) {
      return
    }

    // The WindowProxy survives a navigation. If the frame somehow left its
    // srcdoc (main.ts denies that, this is the second lock), the sender is a
    // remote document with a real origin — never the sandbox's literal 'null'.
    // Nothing it says is the plugin's; drop the bridge for good.
    if (event.origin !== 'null') {
      this.fail(`sandbox frame left its sandbox (origin ${event.origin || '<empty>'})`)

      return
    }

    this.handle(event.data)
  }

  /** Tear the realm down over a boundary violation: toast, report, dispose. */
  private fail(message: string): void {
    console.error(`[plugins] ${this.pluginId}: ${message}`)
    notify({ kind: 'error', title: `Plugin "${this.name}" disabled`, message })
    this.options.onError?.(message)
    this.dispose()
  }

  /** Dispatch one authenticated guest message (exposed for tests). */
  handle(message: GuestMessage): void {
    switch (message.type) {
      case 'call':
        void this.dispatch(message)

        return

      case 'deactivated':
        this.endTeardown()

        return

      case 'error':
        this.options.onError?.(message.message)

        return
      case 'invoke-result': {
        const pending = this.invocations.get(message.invokeId)
        this.invocations.delete(message.invokeId)

        if (message.ok) {
          pending?.resolve(message.result)
        } else {
          pending?.reject(new Error(message.error))
        }

        return
      }

      case 'manifest':
        this.options.onManifest?.(message)

        return

      case 'overlay':
        this.overlayRects = Array.isArray(message.rects) ? message.rects.filter(isFiniteRect).slice(0, 32) : []
        this.syncHitRegion()

        return

      case 'ready':
        this.options.onReady?.()

        return
      case 'slot-size': {
        // A filling slot (pane, workspace) is sized by the host layout, never
        // by the guest; a bar chip may ask for at most a chip's worth of bar.
        const slot = this.slots.get(message.slotId)

        if (!slot || slot.fill === true) {
          return
        }

        this.$slotSizes.set({
          ...this.$slotSizes.get(),
          [message.slotId]:
            slot.fill === 'block'
              ? { height: clampSize(message.height, MAX_BLOCK_HEIGHT), width: 0 }
              : { height: clampSize(message.height, MAX_CHIP_HEIGHT), width: clampSize(message.width, MAX_CHIP_WIDTH) }
        })
      }
    }
  }

  private async dispatch(message: Extract<GuestMessage, { type: 'call' }>): Promise<void> {
    const method = METHODS[message.method]

    const reply = (ok: boolean, result?: unknown, error?: string) =>
      this.send({ callId: message.callId, error, ok, result, type: 'reply' })

    if (!method) {
      reply(false, undefined, `${message.method} is not part of the sandbox SDK`)

      return
    }

    const capability = methodCapability(method, message.args)

    if (!this.granted.has(capability)) {
      this.refuse(capability, message.method)
      reply(false, undefined, `capability "${capability}" not granted to plugin "${this.name}"`)

      return
    }

    const ctx = this.ctx ?? this.teardownCtx

    if (!ctx) {
      reply(false, undefined, 'plugin is not active')

      return
    }

    try {
      reply(true, await method.run({ ctx, realm: this }, message.args))
    } catch (error) {
      reply(false, undefined, error instanceof Error ? error.message : String(error))
    }
  }

  /** One toast per (plugin, capability) per activation — a render loop that
   *  keeps retrying must not flood the notification stack. */
  private refuse(capability: Capability, method: string): void {
    console.warn(`[plugins] ${this.pluginId}: "${method}" refused — capability "${capability}" not granted`)

    if (this.refused.has(capability)) {
      return
    }

    this.refused.add(capability)
    notify({
      kind: 'error',
      title: `Plugin "${this.name}" blocked`,
      message: `It tried to ${CAPABILITIES[capability]} ("${method}") without the "${capability}" capability. The plugin must declare it under desktop_capabilities in its plugin.yaml.`
    })
  }

  /** Call a function the guest handed over in a data contribution. */
  invoke(callbackId: number, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const invokeId = this.nextInvokeId++
      this.invocations.set(invokeId, { reject, resolve })
      this.send({ args, callbackId, invokeId, type: 'invoke' })
    })
  }

  /** Track a disposer that runs on deactivate/dispose. */
  track(dispose: () => void): () => void {
    this.disposers.push(dispose)

    return dispose
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  activate(bootstrap: (realm: SandboxRealm, ctx: PluginContext) => void): void {
    this.deactivate()
    this.ctx = createPluginContext(this.pluginId, dispose => this.track(dispose))
    bootstrap(this, this.ctx)
    this.send({ type: 'activate' })
  }

  /** Grace for a guest's `onDispose` host calls after `deactivate`. */
  static readonly TEARDOWN_GRACE_MS = 1000

  deactivate(): void {
    this.endTeardown()

    if (this.ctx) {
      this.send({ type: 'deactivate' })
      // Host-side registrations are gone NOW (the tracked disposers below);
      // the context object itself stays answerable for the guest's own
      // disposers, which are already in flight on the other side.
      this.teardownCtx = this.ctx
      this.teardownTimer = window.setTimeout(() => this.endTeardown(), SandboxRealm.TEARDOWN_GRACE_MS)
    }

    this.disposers.splice(0).forEach(dispose => dispose())
    this.registrations.clear()
    this.eventSubs.clear()
    this.sockets.clear()
    this.workspaces.clear()
    this.refused.clear()
    this.overlayRects = []
    this.ctx = null
  }

  private endTeardown(): void {
    if (this.teardownTimer !== null) {
      window.clearTimeout(this.teardownTimer)
      this.teardownTimer = null
    }

    this.teardownCtx = null
  }

  dispose(): void {
    this.deactivate()
    this.endTeardown()
    this.disposed = true
    window.removeEventListener('message', this.onMessage)
    this.stopRectLoop()
    this.slots.clear()
    this.frame.remove()
  }

  // ── slots ─────────────────────────────────────────────────────────────────

  /** Mount a contribution's placeholder: the guest renders the contribution
   *  over this element's rect until the returned disposer runs. */
  mountSlot(slotId: string, renderId: string, el: HTMLElement, fill: SlotFill, props?: unknown): () => void {
    const rect = visibleRect(el)
    this.slots.set(slotId, { el, fill, rect })
    this.send({ fill, props, rect, renderId, slotId, type: 'slot-mount' })
    this.syncHitRegion()
    this.startRectLoop()

    return () => {
      this.slots.delete(slotId)
      this.send({ slotId, type: 'slot-unmount' })
      this.syncHitRegion()

      if (this.slots.size === 0) {
        this.stopRectLoop()
      }
    }
  }

  private startRectLoop(): void {
    if (this.rafId !== null || typeof requestAnimationFrame !== 'function') {
      return
    }

    const tick = () => {
      this.rafId = requestAnimationFrame(tick)
      let changed = false

      for (const [slotId, slot] of this.slots) {
        const rect = visibleRect(slot.el)

        if (!sameRect(rect, slot.rect)) {
          slot.rect = rect
          changed = true
          this.send({ rect, slotId, type: 'slot-rect' })
        }
      }

      if (changed) {
        this.syncHitRegion()
      }
    }

    this.rafId = requestAnimationFrame(tick)
  }

  private stopRectLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  /** Hit-test only where a slot is: clip-path clips pointer events too. A
   *  guest layer outside its slots (a Dialog over the whole window, a Popover
   *  hanging off a chip) adds its own rect for as long as it is open. */
  private syncHitRegion(): void {
    // Either axis: a 1×0 placeholder still needs the frame LAID OUT (a hidden
    // frame never runs the guest's ResizeObserver, so the chip could never
    // report the size that would give the placeholder its height).
    const rects = [...this.slots.values()]
      .map(slot => slot.rect)
      .concat(this.overlayRects)
      .filter(rect => rect.width > 0 || rect.height > 0)

    const element = this.frame.element
    const style = element.style

    if (rects.length === 0) {
      hideFrame(element)

      return
    }

    element.removeAttribute('inert')
    style.visibility = ''
    style.pointerEvents = 'auto'
    // At least 1×1 per rect: a zero-area clip reads as "off screen" to the
    // renderer, which then throttles the frame's layout — and with it the
    // measurement that would give a 1×0 placeholder its size.
    style.clipPath = `path('${rects
      .map(r => {
        const w = Math.max(1, r.width)
        const h = Math.max(1, r.height)

        return `M${r.left} ${r.top}h${w}v${h}h${-w}Z`
      })
      .join('')}')`
  }
}
