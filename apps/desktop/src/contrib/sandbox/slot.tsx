import { useStore } from '@nanostores/react'
import { useLayoutEffect, useRef, useState } from 'react'

import type { SandboxRealm } from './realm'

interface SandboxSlotProps {
  /** Pane/workspace bodies fill their zone; bar chips take the guest-reported size. */
  fill: boolean
  /** Render props for this mount (a directive's attrs) — must survive
   *  structured clone; functions are dropped by the bridge. */
  props?: unknown
  realm: SandboxRealm
  /** The guest render function this mount paints. */
  renderId: string
}

let nextMountId = 1

/**
 * The host-side placeholder for a contribution a sandboxed plugin renders.
 * It paints nothing itself: the realm streams this element's rect to the
 * guest, whose React tree appears over it inside the plugin's frame. Every
 * mount has its own slot id — one render can be on screen many times.
 */
export function SandboxSlot({ fill, props, realm, renderId }: SandboxSlotProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [slotId] = useState(() => `${renderId}#${nextMountId++}`)
  const size = useStore(realm.$slotSizes)[slotId]

  useLayoutEffect(() => {
    const el = ref.current

    return el ? realm.mountSlot(slotId, renderId, el, fill, props) : undefined
    // Props are part of the mount: a directive re-rendered with new attrs
    // remounts its guest tree rather than diffing across the bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill, realm, renderId, slotId, JSON.stringify(props ?? null)])

  return (
    <div
      className={fill ? 'size-full' : 'inline-block h-full'}
      data-sandbox-slot={slotId}
      ref={ref}
      style={
        fill
          ? undefined
          : { minHeight: size ? `${Math.ceil(size.height)}px` : undefined, minWidth: size ? `${Math.ceil(size.width)}px` : '1px' }
      }
    />
  )
}
