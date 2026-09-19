/**
 * Guest-side `@/lib/keybinds/use-keybind-hint`: the host's binding store is
 * not in the frame, so tooltips render their label with no shortcut hint.
 */

export function useKeybindHint(_actionId: string): null | string {
  return null
}
