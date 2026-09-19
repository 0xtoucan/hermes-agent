import { useStore } from '@nanostores/react'
import { useLayoutEffect, useRef, useState } from 'react'

import type { SlotFill } from './protocol'
import type { SandboxRealm } from './realm'

interface SandboxSlotProps {
  /** Pane/workspace bodies fill their zone; bar chips take the guest-reported
   *  size; blocks take the host's width and the guest-reported height. */
  fill: SlotFill
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

  const minHeight = size ? `${Math.ceil(size.height)}px` : undefined

  return (
    <div
      className={fill === true ? 'size-full' : fill === 'block' ? 'block w-full' : 'inline-block h-full'}
      data-sandbox-slot={slotId}
      ref={ref}
      style={
        fill === true
          ? undefined
          : fill === 'block'
            ? { minHeight: minHeight ?? '1px' }
            : { minHeight, minWidth: size ? `${Math.ceil(size.width)}px` : '1px' }
      }
    />
  )
}
