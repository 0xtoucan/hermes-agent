/**
 * Builds the guest SDK bundle for the plugin sandbox frame
 * (`@hermes/sandbox-vendor/guest-sdk.js`, resolved by `hermes:sandbox-vendor`
 * in vite.config.ts): the real `@hermes/plugin-sdk` UI components, hooks and
 * helpers (src/contrib/sandbox/guest-sdk/entry.ts), compiled by a NESTED
 * library build with React external — mapped to the frame's `__HERMES_REACT__`
 * globals — and three modules swapped for guest twins that bridge to the host
 * instead of reaching app stores. Built once per process and inlined as text,
 * exactly like the React CJS bundles are.
 */

import path from 'path'

const APP_DIR = import.meta.dirname

/** Virtual-id prefix; the suffix names the entry (`core` | `streamdown`). */
export const GUEST_SDK_ID = '\0hermes:sandbox-guest-sdk:'

export type GuestSdkEntry = 'core' | 'streamdown'

const GUEST_SDK_ENTRIES: Record<GuestSdkEntry, { file: string; global: string }> = {
  core: { file: 'entry.ts', global: '__HERMES_SANDBOX_SDK__' },
  streamdown: { file: 'streamdown-entry.ts', global: '__HERMES_SANDBOX_SDK_STREAMDOWN__' }
}

export const isGuestSdkEntry = (value: string): value is GuestSdkEntry => Object.hasOwn(GUEST_SDK_ENTRIES, value)
const guestSdkDir = path.resolve(APP_DIR, 'src/contrib/sandbox/guest-sdk')

const SANDBOX_GUEST_ALIASES = [
  { find: /^@\/i18n$/, replacement: path.join(guestSdkDir, 'i18n.ts') },
  { find: /^@\/i18n\/(context|runtime|plugin-i18n|catalog)$/, replacement: path.join(guestSdkDir, 'i18n.ts') },
  { find: /^@\/lib\/haptics$/, replacement: path.join(guestSdkDir, 'haptics.ts') },
  { find: /^@\/lib\/keybinds\/use-keybind-hint$/, replacement: path.join(guestSdkDir, 'keybind-hint.ts') }
]

const REACT_GLOBALS: Record<string, string> = {
  react: '__HERMES_REACT__',
  'react-dom': '__HERMES_REACT_DOM__',
  'react-dom/client': '__HERMES_REACT_DOM_CLIENT__',
  'react/jsx-dev-runtime': '__HERMES_REACT_JSX_DEV__',
  'react/jsx-runtime': '__HERMES_REACT_JSX__',
  scheduler: '__HERMES_SCHEDULER__'
}

export interface GuestSdkBundle {
  css: string
  js: string
}

const guestSdkBuilds = new Map<GuestSdkEntry, Promise<GuestSdkBundle>>()

export function buildGuestSdk(entry: GuestSdkEntry): Promise<GuestSdkBundle> {
  let pending = guestSdkBuilds.get(entry)

  if (pending) {
    return pending
  }

  pending = (async () => {
    const { build } = await import('vite')

    const output = await build({
      configFile: false,
      logLevel: 'warn',
      root: APP_DIR,
      // Production JSX no matter which process hosts the build: the dev
      // server runs with NODE_ENV=development, and @vitejs/plugin-react
      // would then emit `jsxDEV`, which React's production
      // jsx-dev-runtime exports as `undefined`. Vite's native TSX
      // transform is enough here (no refresh, no compiler).
      mode: 'production',
      define: { 'process.env.NODE_ENV': '"production"' },
      oxc: { jsx: { development: false, runtime: 'automatic' } },
      resolve: {
        alias: [
          ...SANDBOX_GUEST_ALIASES,
          { find: '@hermes/shared/billing', replacement: path.resolve(APP_DIR, '../shared/src/billing-types.ts') },
          { find: '@hermes/shared/color', replacement: path.resolve(APP_DIR, '../shared/src/color.ts') },
          { find: '@hermes/shared/i18n', replacement: path.resolve(APP_DIR, '../shared/src/i18n.ts') },
          { find: /^@hermes\/shared$/, replacement: path.resolve(APP_DIR, '../shared/src') },
          { find: /^@\//, replacement: `${path.resolve(APP_DIR, './src')}/` }
        ],
        dedupe: ['react', 'react-dom', '@tanstack/react-query', 'nanostores']
      },
      build: {
        write: false,
        minify: true,
        sourcemap: false,
        cssCodeSplit: false,
        lib: {
          entry: path.join(guestSdkDir, GUEST_SDK_ENTRIES[entry].file),
          fileName: `guest-sdk-${entry}`,
          formats: ['iife'],
          name: GUEST_SDK_ENTRIES[entry].global
        },
        rollupOptions: {
          external: Object.keys(REACT_GLOBALS),
          output: { globals: REACT_GLOBALS }
        }
      }
    })

    const bundles = Array.isArray(output) ? output : [output as { output: unknown[] }]
    let js = ''
    let css = ''

    for (const bundle of bundles) {
      for (const chunk of (bundle as { output: Array<Record<string, unknown>> }).output) {
        if (chunk.type === 'chunk') {
          js += String(chunk.code)
        } else if (String(chunk.fileName).endsWith('.css')) {
          css += String(chunk.source)
        }
      }
    }

    if (!js) {
      throw new Error(`hermes:sandbox-vendor: the guest SDK build (${entry}) produced no chunk`)
    }

    return { css, js }
  })()

  guestSdkBuilds.set(entry, pending)

  return pending
}
