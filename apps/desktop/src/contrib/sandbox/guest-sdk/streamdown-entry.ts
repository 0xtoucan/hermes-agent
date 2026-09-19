/**
 * Opt-in guest chunk: the Markdown renderer is ~450 KB minified, more than the
 * rest of the guest SDK together, so the frame includes it only for plugins
 * whose source imports `Streamdown` (loader.ts decides; guest-runtime.js merges
 * `__HERMES_SANDBOX_SDK_STREAMDOWN__` into the SDK when present).
 */

export { Streamdown } from 'streamdown'
