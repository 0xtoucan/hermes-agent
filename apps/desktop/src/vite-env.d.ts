/// <reference types="vite/client" />

// Nested library builds for the plugin sandbox frame (vite-sandbox-guest-sdk.ts,
// resolved by `hermes:sandbox-vendor`): bundle text, never a live module.
declare module '@hermes/sandbox-vendor/guest-sdk-core.js' {
  export const css: string
  export const js: string
}

declare module '@hermes/sandbox-vendor/guest-sdk-streamdown.js' {
  export const css: string
  export const js: string
}
