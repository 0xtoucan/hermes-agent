/**
 * Builds the srcdoc of a remote-tier plugin's sandbox frame. Everything the guest
 * needs is INLINED — React + ReactDOM (CJS bundles behind a 3-line require
 * shim), the guest SDK bundle (the real `@hermes/plugin-sdk` components and
 * hooks, built for the frame by vite-sandbox-guest-sdk.ts), the guest runtime,
 * the plugin source — because the frame's CSP is `default-src 'none'`: it
 * cannot fetch, it cannot import from the app's origin, it cannot load a
 * remote script. The plugin module and the SDK shims become `data:` module
 * URLs INSIDE the frame (guest-runtime.js), so the host never hands the guest
 * a same-origin URL of any kind.
 *
 * The plugin source lands as a JSON string inside a classic `<script>`, so
 * `</script>` inside it is escaped and can never terminate the tag.
 */

// Nested library builds (vite-sandbox-guest-sdk.ts): the SDK proper, and the
// Markdown renderer as an opt-in chunk (~450 KB, only for plugins that import it).
import { css as guestSdkCss, js as guestSdkSource } from '@hermes/sandbox-vendor/guest-sdk-core.js'
import { js as guestStreamdownSource } from '@hermes/sandbox-vendor/guest-sdk-streamdown.js'
// Resolved by the `hermes:sandbox-vendor` plugin in vite.config.ts to the
// app's own React package files (their `exports` maps hide `cjs/*`).
import reactDomClientSource from '@hermes/sandbox-vendor/react-dom-client.js?raw'
import reactDomSource from '@hermes/sandbox-vendor/react-dom.js?raw'
import jsxDevRuntimeSource from '@hermes/sandbox-vendor/react-jsx-dev-runtime.js?raw'
import jsxRuntimeSource from '@hermes/sandbox-vendor/react-jsx-runtime.js?raw'
import reactSource from '@hermes/sandbox-vendor/react.js?raw'
import schedulerSource from '@hermes/sandbox-vendor/scheduler.js?raw'

import guestRuntimeSource from './guest-runtime.js?raw'

/** The frame's CSP: nothing loads from anywhere. Inline + data: scripts are
 *  the guest's own code; inline styles are the copied app stylesheet; `blob:`
 *  images let a plugin show a canvas/file it produced itself. */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:"

export interface FrameDocumentInput {
  pluginId: string
  pluginSource: string
  /** Export names of the real `@hermes/plugin-sdk` so every named import links. */
  sdkExports: readonly string[]
  /** App stylesheet text copied into the frame (design tokens + utilities). */
  styleText: string
  /** Include the Markdown renderer chunk (`Streamdown`). */
  streamdown?: boolean
}

const cjsModule = (name: string, source: string) =>
  `__def(${JSON.stringify(name)}, function (module, exports, require) {\n${source}\n});`

/** A three-line CommonJS shim: `__def` registers a factory, `__req` evaluates
 *  on first use. Bare `require('react')` inside the React bundles resolves
 *  against the registry only — nothing else is requirable. */
const REQUIRE_SHIM = `
var __mods = {}, __cache = {};
function __def(name, factory) { __mods[name] = factory; }
function __req(name) {
  if (__cache[name]) return __cache[name].exports;
  var module = { exports: {} }; __cache[name] = module;
  if (!__mods[name]) throw new Error('sandbox: unknown module ' + name);
  __mods[name](module, module.exports, __req);
  return module.exports;
}
`

/** Inside a classic `<script>`, `</` can end the element and `<!--` flips the
 *  tokenizer into the "script data escaped" state, where a later `</script>`
 *  inside the JSON is honoured. Both are JS-neutral once escaped: `<\/` and
 *  `\u003c!--` read back as the original characters. */
const escapeScriptClose = (json: string) => json.replace(/<\//g, '<\\/').replace(/<!--/g, '\\u003c!--')

/** Stylesheet text is inert once `</style>` cannot occur inside it. */
export const escapeStyleClose = (css: string) => css.replace(/<\//g, '<\\/')

/** Bundle CODE (not JSON): only the two exact tokenizer triggers are touched,
 *  and only in forms that read back unchanged inside a string, template or
 *  regex literal — the sole places minified code carries them (a Markdown
 *  sanitizer's `/<!--/` regex). */
const escapeBundle = (js: string) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '\\u003c!--')

export function buildFrameDocument(input: FrameDocumentInput): string {
  const boot = escapeScriptClose(
    JSON.stringify({ pluginId: input.pluginId, pluginSource: input.pluginSource, sdkExports: input.sdkExports })
  )

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">
<style>
html, body { margin: 0; background: transparent; overflow: hidden; }
body { pointer-events: none; }
/* Layers the SDK portals to <body> (dialogs, popovers, menus) are interactive;
   the host widens the frame's hit region to them (guest-runtime.js, overlay). */
body > :not(#slots) { pointer-events: auto; }
.hermes-sandbox-slot { position: fixed; overflow: hidden; pointer-events: auto; }
.hermes-sandbox-slot-inner { display: inline-flex; align-items: center; min-height: 100%; width: max-content; white-space: nowrap; }
.hermes-sandbox-slot[data-fill="true"] .hermes-sandbox-slot-inner { display: block; height: 100%; width: 100%; white-space: normal; overflow: auto; }
.hermes-sandbox-slot[data-fill="block"] .hermes-sandbox-slot-inner { display: block; width: 100%; white-space: normal; }
.hermes-sandbox-error { font-size: 0.6875rem; color: #c0392b; }
</style>
<style id="hermes-host-style">${escapeStyleClose(input.styleText)}</style>
<style>${escapeStyleClose(guestSdkCss)}</style>
</head>
<body>
<div id="slots"></div>
<script>
process = { env: { NODE_ENV: 'production' } };
${REQUIRE_SHIM}
${cjsModule('react', reactSource)}
${cjsModule('react/jsx-runtime', jsxRuntimeSource)}
${cjsModule('react/jsx-dev-runtime', jsxDevRuntimeSource)}
${cjsModule('scheduler', schedulerSource)}
${cjsModule('react-dom', reactDomSource)}
${cjsModule('react-dom/client', reactDomClientSource)}
globalThis.__HERMES_REACT__ = __req('react');
globalThis.__HERMES_REACT_JSX__ = __req('react/jsx-runtime');
globalThis.__HERMES_REACT_JSX_DEV__ = __req('react/jsx-dev-runtime');
globalThis.__HERMES_SCHEDULER__ = __req('scheduler');
globalThis.__HERMES_REACT_DOM__ = __req('react-dom');
globalThis.__HERMES_REACT_DOM_CLIENT__ = __req('react-dom/client');
globalThis.__HERMES_SANDBOX__ = ${boot};
</script>
<script>${escapeBundle(guestSdkSource)}</script>
${input.streamdown ? `<script>${escapeBundle(guestStreamdownSource)}</script>` : ''}
<script>${guestRuntimeSource}</script>
</body>
</html>`
}

/** Only plugins whose source names `Streamdown` pay for the Markdown chunk. */
export const pluginWantsStreamdown = (source: string): boolean => /\bStreamdown\b/.test(source)

/** A host stylesheet's rules, as text, minus `@font-face` (the frame gets the
 *  font FILES over the bridge — `bridgeFonts` — because its CSP forbids the
 *  URL fetch a face declaration would make). Style is not authority; a
 *  stylesheet the host can't read (cross-origin) is skipped. */
export function styleSheetText(sheet: CSSStyleSheet): string {
  try {
    return Array.from(sheet.cssRules)
      .filter(rule => !(rule instanceof CSSFontFaceRule))
      .map(rule => rule.cssText)
      .join('\n')
  } catch {
    return ''
  }
}

/** The app's own stylesheet rules, as text, so plugin UI inside the frame
 *  gets the same tokens and utility classes. */
export function collectHostStyleText(doc: Document = document): string {
  return Array.from(doc.styleSheets, styleSheetText).filter(Boolean).join('\n')
}

export interface HostFontFace {
  descriptors: Record<string, string>
  family: string
  url: string
}

/** Every `@font-face` the host declares with a URL source, resolved against
 *  the document, so the loader can fetch the files and hand them to the frame. */
export function collectHostFontFaces(doc: Document = document): HostFontFace[] {
  const faces: HostFontFace[] = []

  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList

    try {
      rules = sheet.cssRules
    } catch {
      continue
    }

    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) {
        continue
      }

      const style = rule.style
      const family = style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '')
      const url = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(style.getPropertyValue('src'))?.[1]

      if (!family || !url) {
        continue
      }

      const descriptors: Record<string, string> = {}

      for (const [prop, key] of [
        ['font-style', 'style'],
        ['font-weight', 'weight'],
        ['font-display', 'display'],
        ['unicode-range', 'unicodeRange']
      ] as const) {
        const value = style.getPropertyValue(prop).trim()

        if (value) {
          descriptors[key] = value
        }
      }

      try {
        faces.push({ descriptors, family, url: new URL(url, sheet.href ?? doc.baseURI).href })
      } catch {
        // An unresolvable URL is not a font the host renders either.
      }
    }
  }

  return faces
}
