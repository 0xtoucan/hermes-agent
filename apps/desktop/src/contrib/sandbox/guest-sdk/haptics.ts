/**
 * Guest-side `@/lib/haptics`: the actuator lives in the host window, so a
 * plugin's `haptic('tap')` crosses the bridge (`ui` capability) and the host's
 * mute setting applies unchanged. Fire-and-forget, like the host's own.
 */

import type { HapticIntent } from '@/lib/haptics'

import { bridge } from './bridge'

export type { HapticIntent } from '@/lib/haptics'

export function triggerHaptic(intent: HapticIntent = 'selection'): void {
  try {
    bridge().fire('haptic', [intent])
  } catch {
    // Not booted yet — a haptic is never worth an error.
  }
}
