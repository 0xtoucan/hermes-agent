/*
 * GUEST side of the remote-plugin sandbox. This file is NOT bundled as a
 * module: `frame-document.ts` inlines it (`?raw`) into the srcdoc of the
 * per-plugin `<iframe sandbox="allow-scripts">`, after the React CJS bundles
 * and the guest SDK bundle, before the plugin module. It runs in an OPAQUE
 * origin behind a `default-src 'none'` CSP: no network, no parent DOM, no
 * shared realm. The only way out is `parent.postMessage`, and the host
 * answers only the methods in sandbox/methods.ts whose capability the plugin
 * was granted (sandbox/capabilities.ts).
 *
 * Shape: classic script, runs once, reads its inputs from
 * `globalThis.__HERMES_SANDBOX__` (written by frame-document.ts):
 *   { pluginId, sdkExports: string[], pluginSource: string }
 * plus `globalThis.__HERMES_SANDBOX_SDK__` (the real SDK components, hooks and
 * helpers — vite-sandbox-guest-sdk.ts) and, when the plugin imports it,
 * `__HERMES_SANDBOX_SDK_STREAMDOWN__`. It adds the boundary members on top
 * (`host.*`, `ctx.*`, the bridged `useValue` stores), builds the
 * `@hermes/plugin-sdk` + `react*` shim modules as data: URLs, imports the
 * plugin, and drives its lifecycle from host messages.
 */
;(function bootGuest() {
  'use strict'

  const boot = globalThis.__HERMES_SANDBOX__
  const React = globalThis.__HERMES_REACT__
  const ReactDOMClient = globalThis.__HERMES_REACT_DOM_CLIENT__
  const guestSdk = globalThis.__HERMES_SANDBOX_SDK__ || {}
  const PROTOCOL = 'hermes-plugin-sandbox'
  const pluginId = boot.pluginId
  const h = React.createElement

  // ── transport ─────────────────────────────────────────────────────────────
  let nextCallId = 1
  const pending = new Map()

  function post(type, payload) {
    parent.postMessage({ hermes: PROTOCOL, type, ...payload }, '*')
  }

  /** Host RPC. Rejects with the host's error (including capability refusals). */
  function call(method, args) {
    return new Promise((resolve, reject) => {
      const callId = nextCallId++
      pending.set(callId, { resolve, reject })
      post('call', { callId, method, args: args ?? [] })
    })
  }

  /** Fire-and-forget twin for void SDK members: a refusal is already toasted
   *  by the host, so it is logged here instead of surfacing as an unhandled
   *  rejection the plugin never had a handle on. */
  function fire(method, args) {
    call(method, args).catch(error => console.warn(`[sandbox] ${method}: ${error.message}`))
  }

  // The guest SDK's bridged twins (haptics) read this lazily.
  globalThis.__HERMES_SANDBOX_BRIDGE__ = { call, fire }

  // ── reactive stores: the bundle's nanostores, so `useValue` is one thing ──
  const atom =
    guestSdk.atom ||
    function fallbackAtom(initial) {
      let value = initial
      const listeners = new Set()

      return {
        get: () => value,
        set(next) {
          if (next !== value) {
            value = next
            listeners.forEach(fn => fn(value))
          }
        },
        listen(fn) {
          listeners.add(fn)

          return () => listeners.delete(fn)
        },
        subscribe(fn) {
          fn(value)

          return this.listen(fn)
        }
      }
    }

  const useValue =
    guestSdk.useValue ||
    function fallbackUseValue(store) {
      return React.useSyncExternalStore(
        cb => store.listen(cb),
        () => store.get(),
        () => store.get()
      )
    }

  // ── callbacks handed to the host (data contributions: palette `run`, keybinds)
  const callbacks = new Map()
  let nextCallbackId = 1

  const REACT_ELEMENT = Symbol.for('react.transitional.element')
  const REACT_ELEMENT_LEGACY = Symbol.for('react.element')
  const isElement = value => Boolean(value) && (value.$$typeof === REACT_ELEMENT || value.$$typeof === REACT_ELEMENT_LEGACY)
  let nextRenderRef = 1
  let warnedMenuContent = false

  /**
   * Prepare a contribution payload for the bridge. Functions become callback
   * refs the host can invoke; a React ELEMENT in the data (a statusbar item's
   * `label`/`icon`/`detail`) becomes a render ref — the host mounts an inline
   * slot for it, painted here. `refs` collects the render ids so the
   * contribution's disposer can drop them.
   */
  function marshal(value, depth, key, refs) {
    if (typeof value === 'function') {
      // A palette/nav `icon` is a COMPONENT, not a callback: the host renders
      // its own glyph for sandboxed rows (it cannot render a guest component).
      if (key === 'icon') {
        return undefined
      }

      // `data.render` (a transcript directive's leaf) is a component taking
      // props, mounted per occurrence: a render ref the host calls with props.
      if (key === 'render') {
        const renderId = `ref#${nextRenderRef++}`
        renders.set(renderId, value)

        if (refs) {
          refs.push(renderId)
        }

        return { __hermesRender: renderId, component: true }
      }

      // `menuContent: close => <Menu/>` returns guest UI into a HOST popover,
      // which paints above the frame; not reachable from the sandbox.
      if (key === 'menuContent') {
        if (!warnedMenuContent) {
          warnedMenuContent = true
          console.warn(`[sandbox] ${pluginId}: statusbar \`menuContent\` is not supported in the sandbox — use \`render\` with an SDK Popover instead`)
        }

        return undefined
      }

      const id = nextCallbackId++
      callbacks.set(id, value)

      return { __hermesCallback: id }
    }

    if (!value || typeof value !== 'object' || depth > 6) {
      return value
    }

    if (isElement(value)) {
      if (key === 'menuContent') {
        return marshal(() => value, depth, key, refs)
      }

      const renderId = `ref#${nextRenderRef++}`
      renders.set(renderId, () => value)

      if (refs) {
        refs.push(renderId)
      }

      return { __hermesRender: renderId }
    }

    if (Array.isArray(value)) {
      return value.map(item => marshal(item, depth + 1, key, refs))
    }

    const out = {}

    for (const [k, item] of Object.entries(value)) {
      out[k] = marshal(item, depth + 1, k, refs)
    }

    return out
  }

  // ── slot rendering: every contribution's React tree lives in THIS document,
  // positioned over the host's placeholder rect (slot.tsx, SandboxSlot).
  const renders = new Map() // renderId -> (props) => ReactNode
  const mounted = new Map() // slotId -> { el, root, observer }
  const slotsEl = document.getElementById('slots')

  // One QueryClient per frame: `useQuery` caches, dedupes and polls exactly
  // like core screens, scoped to this plugin (the host's client stays host's).
  const queryClient = guestSdk.QueryClient ? new guestSdk.QueryClient() : null

  function Providers({ children }) {
    let tree = children

    if (guestSdk.TooltipProvider) {
      tree = h(guestSdk.TooltipProvider, null, tree)
    }

    if (queryClient && guestSdk.QueryClientProvider) {
      tree = h(guestSdk.QueryClientProvider, { client: queryClient }, tree)
    }

    return tree
  }

  function Boundary({ children, slotId }) {
    const [error, setError] = React.useState(null)

    if (error) {
      return h(
        'span',
        { className: 'hermes-sandbox-error', title: String(error && error.message ? error.message : error) },
        `${slotId}: ${error && error.message ? error.message : String(error)}`
      )
    }

    return h(ErrorCatcher, { onError: setError }, children)
  }

  class ErrorCatcher extends React.Component {
    static getDerivedStateFromError() {
      return {}
    }

    componentDidCatch(error) {
      this.props.onError(error)
    }

    render() {
      return this.props.children
    }
  }

  function mountSlot(slotId, renderId, rect, fill, props) {
    const render = renders.get(renderId)

    if (!render || mounted.has(slotId)) {
      return
    }

    const el = document.createElement('div')
    el.className = 'hermes-sandbox-slot'
    el.dataset.slot = slotId
    el.dataset.fill = String(fill)
    const inner = document.createElement('div')
    inner.className = 'hermes-sandbox-slot-inner'
    el.appendChild(inner)
    slotsEl.appendChild(el)
    applyRect(el, rect)

    const root = ReactDOMClient.createRoot(inner)
    root.render(h(Providers, null, h(Boundary, { slotId }, h(render, props ?? undefined))))

    // Bars need the chip's intrinsic size to lay the placeholder out; report it.
    const observer = new ResizeObserver(() => {
      const box = inner.getBoundingClientRect()
      post('slot-size', { slotId, height: box.height, width: box.width })
    })
    observer.observe(inner)
    mounted.set(slotId, { el, observer, root })
  }

  function applyRect(el, rect) {
    el.style.left = `${rect.left}px`
    el.style.top = `${rect.top}px`
    el.style.width = `${rect.width}px`
    el.style.height = `${rect.height}px`
    // A placeholder starts 1×0 (the host knows no size yet): keep it displayed
    // so the ResizeObserver can measure the chip and report it; only a slot
    // with NO extent (scrolled out of view) is hidden.
    el.style.display = rect.width > 0 || rect.height > 0 ? '' : 'none'
  }

  function unmountSlot(slotId) {
    const slot = mounted.get(slotId)

    if (!slot) {
      return
    }

    slot.observer.disconnect()
    slot.root.unmount()
    slot.el.remove()
    mounted.delete(slotId)
  }

  // ── overlays: SDK dialogs/popovers/menus portal to <body>, OUTSIDE every
  // slot. The host clips the frame to its slots, so it needs their rects too.
  // Report the outermost sized elements under each body-level layer.
  let lastOverlay = ''

  function overlayRects() {
    const rects = []

    const collect = (el, depth) => {
      if (rects.length >= 32 || depth > 6) {
        return
      }

      const style = getComputedStyle(el)

      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
        return
      }

      const box = el.getBoundingClientRect()

      // A layer nobody can interact with may still need painting (a tooltip),
      // but a LARGE one (a decorative full-window texture) must not widen the
      // host's hit region: it would swallow clicks meant for the app and paint
      // over it.
      if (style.pointerEvents === 'none' && box.width * box.height > innerWidth * innerHeight * 0.25) {
        return
      }

      if (box.width > 0 && box.height > 0) {
        rects.push({ height: box.height, left: box.left, top: box.top, width: box.width })

        return
      }

      for (const child of el.children) {
        collect(child, depth + 1)
      }
    }

    for (const layer of document.body.children) {
      if (layer !== slotsEl && layer.tagName !== 'SCRIPT') {
        collect(layer, 0)
      }
    }

    return rects
  }

  function syncOverlay() {
    const rects = overlayRects()
    const key = JSON.stringify(rects)

    if (key !== lastOverlay) {
      lastOverlay = key
      post('overlay', { rects })
    }
  }

  let overlayRaf = null

  function overlayTick() {
    syncOverlay()
    overlayRaf = document.body.children.length > 1 ? requestAnimationFrame(overlayTick) : null
  }

  new MutationObserver(() => {
    if (overlayRaf === null) {
      overlayTick()
    }
  }).observe(document.body, { childList: true })

  // ── the SDK the plugin sees ──────────────────────────────────────────────────
  const state = {}
  const paneVisibility = new Map()

  function unsupported(name, hint) {
    const fail = () => {
      throw new Error(
        `${name} is not available to sandboxed plugins: it runs in a sandboxed realm` + (hint ? ` — ${hint}` : '')
      )
    }

    return fail
  }

  const DOM_REACH_HINT = 'this plugin needs an SDK hook instead of host DOM access'
  const COMPOSER_HINT = 'use host.composer.getText() / insertText() / setText() (capability "composer")'

  const host = {
    state,
    notify: input => fire('notify', [input]),
    notifyError: (error, fallback) => fire('notifyError', [error && error.message ? error.message : String(error), fallback]),
    /** `timeoutMs` (third argument) opts one call out of the default deadline,
     *  as `host.getGateway().request` does host-side. */
    request: (method, params, timeoutMs) => call('request', [method, params ?? {}, timeoutMs]),
    /** The host gateway instance never crosses the boundary; this is the one
     *  member plugins use it for, routed through the same allowlist. */
    getGateway: () => ({ request: (method, params, timeoutMs) => call('request', [method, params ?? {}, timeoutMs]) }),
    navigate: path => fire('navigate', [path]),
    paneVisibility(paneId) {
      let store = paneVisibility.get(paneId)

      if (!store) {
        store = atom(false)
        paneVisibility.set(paneId, store)
        fire('paneVisibility', [paneId])
      }

      return store
    },
    openWorkspace(id, options) {
      const renderId = `workspace:${id}`
      renders.set(renderId, options.render)
      const onClose = options.onClose
      const { render: _render, onClose: _onClose, ...rest } = options
      fire('openWorkspace', [id, marshal({ ...rest, onClose }, 0, undefined, null)])

      return () => {
        renders.delete(renderId)
        fire('closeWorkspace', [id])
      }
    },
    onEvent: (type, listener) => subscribeEvent(type, listener),
    /** The composer as an API (capability "composer"). `getText` is async here —
     *  the draft lives in the host. */
    composer: {
      getText: () => call('composerGetText', []),
      insertText: (text, mode) => fire('composerInsertText', [text, mode]),
      setText: text => fire('composerSetText', [text])
    },
    // Host DOM reach (seen in the review sweep) is exactly what the boundary
    // forbids. Fail loudly with the remedy instead of silently returning null.
    querySelector: unsupported('host.querySelector', COMPOSER_HINT),
    querySelectorAll: unsupported('host.querySelectorAll', DOM_REACH_HINT),
    insertBefore: unsupported('host.insertBefore', DOM_REACH_HINT),
    firstChild: undefined
  }

  const eventSubs = new Map()
  let nextSubId = 1

  function subscribeEvent(type, listener) {
    const subId = nextSubId++
    eventSubs.set(subId, listener)
    fire('onEvent', [subId, type])

    return () => {
      eventSubs.delete(subId)
      fire('offEvent', [subId])
    }
  }

  // ctx.socket: the host owns the WebSocket and relays parsed frames.
  const sockets = new Map()
  let nextSockId = 1

  function openSocket(path, onMessage) {
    const sockId = nextSockId++
    sockets.set(sockId, onMessage)
    fire('socketOpen', [sockId, path])

    return () => {
      if (sockets.delete(sockId)) {
        fire('socketClose', [sockId])
      }
    }
  }

  const storageCache = new Map()

  const storage = {
    get(key, fallback) {
      return storageCache.has(key) ? storageCache.get(key) : fallback
    },
    set(key, value) {
      storageCache.set(key, value)
      fire('storageSet', [key, value])
    },
    remove(key) {
      storageCache.delete(key)
      fire('storageRemove', [key])
    }
  }

  const disposers = []
  const track = fn => {
    disposers.push(fn)

    return fn
  }

  function createContext() {
    return {
      source: `plugin:${pluginId}`,
      register(c) {
        const { render, when: _when, ...rest } = c
        const renderId = c.id

        if (typeof render === 'function') {
          renders.set(renderId, render)
        }

        // `when` is a host-evaluated predicate over host state; a function
        // cannot cross the boundary, so a sandboxed contribution is always on.
        if (typeof _when === 'function') {
          console.warn(`[sandbox] ${pluginId}: contribution "${c.id}" has a \`when\` predicate — not supported in the sandbox, always shown`)
        }

        const refs = []
        fire('register', [marshal({ ...rest, hasRender: typeof render === 'function' }, 0, undefined, refs)])

        return track(() => {
          renders.delete(renderId)
          refs.forEach(ref => renders.delete(ref))
          fire('unregister', [renderId])
        })
      },
      registerMany(cs) {
        const all = cs.map(c => this.register(c))

        return () => all.forEach(d => d())
      },
      onDispose: fn => void disposers.push(fn),
      onEvent: (type, listener) => track(subscribeEvent(type, listener)),
      // Exactly the SDK's contract: `ctx.rest` never leaves the plugin's own
      // namespace (`/api/plugins/<id>/...`, resolved by the host's pluginRest).
      // Reaching any other `/api/` route is a different door with its own
      // capability (`rest:any`), never an implicit reroute.
      rest: (path, opts) => call('rest', [path, opts ?? {}]),
      restAny: (path, opts) => call('restAny', [path, opts ?? {}]),
      socket: (path, onMessage) => track(openSocket(path, onMessage)),
      os: {
        notify: input => fire('osNotify', [input]),
        openExternal: url => call('osOpenExternal', [url]),
        revealPath: path => call('osRevealPath', [path]),
        writeClipboard: text => call('osWriteClipboard', [text]),
        pickOpenPath: options => call('osPickOpenPath', [options ?? {}]),
        pickSavePath: options => call('osPickSavePath', [options ?? {}])
      },
      storage,
      i18n: guestSdk.createPluginI18n
        ? guestSdk.createPluginI18n(pluginId, track)
        : { t: key => key, register: () => () => {} }
    }
  }

  // ── the exported SDK: the bundle's real members + the boundary members ─────
  const streamdown = globalThis.__HERMES_SANDBOX_SDK_STREAMDOWN__

  const sdk = {
    ...guestSdk,
    atom,
    host,
    useValue,
    /** Plugin-scoped invalidation outside React — this frame's client. */
    queryClient,
    Streamdown: streamdown && streamdown.Streamdown ? streamdown.Streamdown : unsupported('Streamdown')
  }

  // Every export name the real SDK has must LINK (a missing named import is a
  // hard failure at import time); the ones the sandbox does not carry throw a
  // readable error when USED instead.
  for (const name of boot.sdkExports) {
    if (!(name in sdk)) {
      sdk[name] = unsupported(name)
    }
  }

  globalThis.__HERMES_PLUGIN_SDK__ = sdk

  function shimModule(globalKey, names) {
    const valid = names.filter(name => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name))
    const source =
      `const m = globalThis.${globalKey};\nexport default m.default ?? m;\n` +
      (valid.length ? `export const { ${valid.join(', ')} } = m;\n` : '')

    return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`
  }

  const importMap = {
    '@hermes/plugin-sdk': shimModule('__HERMES_PLUGIN_SDK__', Object.keys(sdk)),
    'react/jsx-dev-runtime': shimModule('__HERMES_REACT_JSX_DEV__', Object.keys(globalThis.__HERMES_REACT_JSX_DEV__)),
    'react/jsx-runtime': shimModule('__HERMES_REACT_JSX__', Object.keys(globalThis.__HERMES_REACT_JSX__)),
    react: shimModule('__HERMES_REACT__', Object.keys(React))
  }

  const importSpecifierRe = /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g

  function rewriteSpecifiers(source) {
    return source.replace(importSpecifierRe, (whole, pre, quote, spec) =>
      importMap[spec] ? `${pre}${quote}${importMap[spec]}${quote}` : whole
    )
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  let plugin = null

  async function loadModule() {
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(rewriteSpecifiers(boot.pluginSource))}`
    const mod = await import(url)
    plugin = mod.default

    if (!plugin || !plugin.id || typeof plugin.register !== 'function') {
      throw new Error('no valid default HermesPlugin export')
    }

    // The declared id is informational only: the host scopes storage, REST
    // and contribution provenance to the INSTALL FOLDER (`pluginId`), so a
    // sandboxed plugin cannot claim another plugin's namespace by renaming itself.
    post('manifest', {
      defaultEnabled: plugin.defaultEnabled,
      description: plugin.description,
      id: plugin.id,
      name: plugin.name
    })
  }

  function activate() {
    plugin.register(createContext())
  }

  function deactivate() {
    for (const slotId of [...mounted.keys()]) {
      unmountSlot(slotId)
    }

    renders.clear()
    disposers.splice(0).forEach(fn => {
      try {
        fn()
      } catch (error) {
        console.error(`[plugins] ${pluginId} onDispose threw`, error)
      }
    })

    sockets.clear()
    eventSubs.clear()

    if (queryClient) {
      queryClient.clear()
    }

    // Every host call a disposer made is already posted (in order) — the host
    // keeps answering until it sees this.
    post('deactivated', {})
  }

  const handlers = {
    activate,
    deactivate,
    event: msg => {
      const listener = eventSubs.get(msg.subId)

      if (listener) {
        listener(msg.event)
      }
    },
    font: msg => {
      try {
        const face = new FontFace(msg.family, msg.data, msg.descriptors || {})
        document.fonts.add(face)
        face.load().catch(() => undefined)
      } catch (error) {
        console.warn(`[sandbox] font ${msg.family}: ${error && error.message ? error.message : error}`)
      }
    },
    invoke: async msg => {
      const fn = callbacks.get(msg.callbackId)
      let result

      try {
        result = fn ? await fn(...(msg.args ?? [])) : undefined
        post('invoke-result', { invokeId: msg.invokeId, ok: true, result })
      } catch (error) {
        post('invoke-result', { error: String(error && error.message ? error.message : error), invokeId: msg.invokeId, ok: false })
      }
    },
    locale: msg => {
      if (guestSdk.$locale) {
        guestSdk.$locale.set(msg.locale)
      }

      if (guestSdk.$appStrings) {
        guestSdk.$appStrings.set(guestSdk.reviveAppStrings ? guestSdk.reviveAppStrings(msg.strings || {}) : msg.strings || {})
      }
    },
    'pane-visibility': msg => {
      host.paneVisibility(msg.paneId).set(Boolean(msg.visible))
    },
    reply: msg => {
      const entry = pending.get(msg.callId)

      if (!entry) {
        return
      }

      pending.delete(msg.callId)

      if (msg.ok) {
        entry.resolve(msg.result)
      } else {
        entry.reject(new Error(msg.error))
      }
    },
    'slot-mount': msg => mountSlot(msg.slotId, msg.renderId, msg.rect, msg.fill, msg.props),
    'slot-rect': msg => {
      const slot = mounted.get(msg.slotId)

      if (slot) {
        applyRect(slot.el, msg.rect)
      }
    },
    'slot-unmount': msg => unmountSlot(msg.slotId),
    socket: msg => {
      const listener = sockets.get(msg.sockId)

      if (listener) {
        listener(msg.data)
      }
    },
    state: msg => {
      for (const [key, value] of Object.entries(msg.values)) {
        if (!state[key]) {
          state[key] = atom(value)
        } else {
          state[key].set(value)
        }
      }
    },
    storage: msg => {
      storageCache.clear()

      for (const [key, value] of Object.entries(msg.values)) {
        storageCache.set(key, value)
      }
    },
    style: msg => {
      const el = document.createElement('style')
      el.textContent = String(msg.css)
      document.head.appendChild(el)
    },
    theme: msg => {
      document.documentElement.className = msg.className
      document.documentElement.setAttribute('style', msg.style)
    }
  }

  window.addEventListener('message', event => {
    const msg = event.data

    if (event.source !== parent || !msg || msg.hermes !== PROTOCOL) {
      return
    }

    const handler = handlers[msg.type]

    if (handler) {
      try {
        handler(msg)
      } catch (error) {
        post('error', { message: `${msg.type}: ${String(error && error.message ? error.message : error)}` })
      }
    }
  })

  loadModule().then(
    () => post('ready', {}),
    error => post('error', { message: String(error && error.message ? error.message : error) })
  )
})()
