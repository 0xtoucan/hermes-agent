/**
 * Wire types shared by the host bridge and (by convention) guest-runtime.js.
 * Every frame carries `hermes: PROTOCOL`; the host additionally checks that
 * `event.source` is the plugin's own frame window, so a message from any
 * other document (another plugin, an artifact preview) is dropped unread.
 */

export const SANDBOX_PROTOCOL = 'hermes-plugin-sandbox'

export interface SlotRect {
  height: number
  left: number
  top: number
  width: number
}

/** Guest -> host. */
export type GuestMessage =
  | { type: 'call'; callId: number; method: string; args: unknown[] }
  /** The guest ran every `onDispose` after `deactivate`; teardown calls are done. */
  | { type: 'deactivated' }
  | { type: 'error'; message: string }
  | { type: 'invoke-result'; invokeId: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'manifest'; id: string; name?: string; description?: string; defaultEnabled?: boolean }
  /** Body-level layers (dialogs, popovers, menus) the guest painted OUTSIDE its
   *  slots: the host widens the frame's hit/paint region to these rects. */
  | { type: 'overlay'; rects: SlotRect[] }
  | { type: 'ready' }
  | { type: 'slot-size'; slotId: string; width: number; height: number }

/** Host -> guest. */
export type HostMessage =
  | { type: 'activate' }
  | { type: 'deactivate' }
  | { type: 'event'; subId: number; event: unknown }
  /** A host font file, so `Codicon` and the app's faces render in the frame
   *  (the CSP forbids the guest fetching them). */
  | { type: 'font'; family: string; descriptors: Record<string, string>; data: ArrayBuffer }
  | { type: 'invoke'; invokeId: number; callbackId: number; args: unknown[] }
  /** Active app locale + the catalog slice the SDK's own components read. */
  | { type: 'locale'; locale: string; strings: Record<string, unknown> }
  | { type: 'pane-visibility'; paneId: string; visible: boolean }
  | { type: 'reply'; callId: number; ok: boolean; result?: unknown; error?: string }
  /** `renderId` names the plugin's render function; `slotId` is this mount
   *  (one render can be mounted many times — a transcript directive per
   *  message — each with its own `props`). */
  | { type: 'slot-mount'; slotId: string; renderId: string; rect: SlotRect; fill: SlotFill; props?: unknown }
  | { type: 'slot-rect'; slotId: string; rect: SlotRect }
  | { type: 'slot-unmount'; slotId: string }
  /** A relayed `ctx.socket` frame. */
  | { type: 'socket'; sockId: number; data: unknown }
  | { type: 'state'; values: Record<string, unknown> }
  | { type: 'storage'; values: Record<string, unknown> }
  /** Host stylesheet text that appeared after boot (a lazily loaded chunk). */
  | { type: 'style'; css: string }
  | { type: 'theme'; className: string; style: string }

/** Marks a function leaf in the bridged catalog slice (`locale.strings`);
 *  the guest rebuilds it as `() => key`. */
export const FN_LEAF = '\u0000fn'

/** A function the guest handed over inside a data contribution. */
export interface CallbackRef {
  __hermesCallback: number
}

export const isCallbackRef = (value: unknown): value is CallbackRef =>
  typeof value === 'object' && value !== null && typeof (value as CallbackRef).__hermesCallback === 'number'

/** How a slot sizes itself: a bar chip (guest-measured), a zone filler
 *  (host-sized), or a block (host width, guest-measured height — a directive
 *  leaf inside a transcript message). */
export type SlotFill = 'block' | boolean

/** A React element (or, with `component`, a render function taking props)
 *  the guest kept: the host mounts a slot for it. */
export interface RenderRef {
  __hermesRender: string
  component?: boolean
}

export const isRenderRef = (value: unknown): value is RenderRef =>
  typeof value === 'object' && value !== null && typeof (value as RenderRef).__hermesRender === 'string'

export function isGuestMessage(value: unknown): value is GuestMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { hermes?: unknown }).hermes === SANDBOX_PROTOCOL &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}
