/**
 * The seam between the guest SDK bundle and guest-runtime.js. The bundle is
 * evaluated BEFORE the runtime (it only needs React), so it cannot import the
 * transport; instead the runtime installs `globalThis.__HERMES_SANDBOX_BRIDGE__`
 * at boot and the stubs here read it lazily, at call time.
 */

import { atom } from 'nanostores'

import type { Locale } from '@/i18n/types'

import { FN_LEAF } from '../protocol'

export interface SandboxGuestBridge {
  /** Host RPC — rejects with the host's error (capability refusals included). */
  call: (method: string, args?: unknown[]) => Promise<unknown>
  /** Fire-and-forget twin for void SDK members. */
  fire: (method: string, args?: unknown[]) => void
}

declare global {
  var __HERMES_SANDBOX_BRIDGE__: SandboxGuestBridge | undefined
}

export function bridge(): SandboxGuestBridge {
  const installed = globalThis.__HERMES_SANDBOX_BRIDGE__

  if (!installed) {
    throw new Error('sandbox bridge is not installed yet')
  }

  return installed
}

/** The app's active locale, pushed by the host at boot and on every switch. */
export const $locale = atom<Locale>('en')

/** The slice of the app catalog the SDK's own components read (`t.common.*`,
 *  search/pagination labels). Function leaves arrive as the `FN_LEAF`
 *  sentinel and are rebuilt as `() => key` — an untranslated label beats a
 *  crash on `t.x.y(n)`. */
export const $appStrings = atom<Record<string, unknown>>({})

export { FN_LEAF }
