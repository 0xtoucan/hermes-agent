/*
 * GUEST side of the catalog-plugin sandbox. This file is NOT bundled as a
 * module: `frame-document.ts` inlines it (`?raw`) into the srcdoc of the
 * per-plugin `<iframe sandbox="allow-scripts">`, after the React CJS bundles
 * and before the plugin module. It runs in an OPAQUE origin behind a
 * `default-src 'none'` CSP: no network, no parent DOM, no shared realm. The
 * only way out is `parent.postMessage`, and the host answers only the SDK
 * subset whose capability the plugin was granted (sandbox/capabilities.ts).
 *
 * Shape: classic script, runs once, reads its inputs from
 * `globalThis.__HERMES_SANDBOX__` (written by frame-document.ts):
 *   { pluginId, sdkExports: string[], pluginSource: string }
 * then builds the `@hermes/plugin-sdk` + `react*` shim modules as data: URLs,
 * imports the plugin, and drives its lifecycle from host messages.
 */
;(function bootGuest() {
  'use strict'

  const boot = globalThis.__HERMES_SANDBOX__
  const React = globalThis.__HERMES_REACT__
  const ReactDOMClient = globalThis.__HERMES_REACT_DOM_CLIENT__
  const PROTOCOL = 'hermes-plugin-sandbox'
  const pluginId = boot.pluginId

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

  // ── the tiny reactive store handed to plugins (nanostores-compatible subset)
  function atom(initial) {
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

  function useValue(store) {
    return React.useSyncExternalStore(
      cb => store.listen(cb),
      () => store.get(),
      () => store.get()
    )
  }

  // ── callbacks handed to the host (data contributions: palette `run`, keybinds)
  const callbacks = new Map()
  let nextCallbackId = 1

  function marshal(value, depth) {
    if (typeof value === 'function') {
      const id = nextCallbackId++
      callbacks.set(id, value)

      return { __hermesCallback: id }
    }

    if (!value || typeof value !== 'object' || depth > 6) {
      return value
    }

    if (Array.isArray(value)) {
      return value.map(item => marshal(item, depth + 1))
    }

    const out = {}

    for (const [key, item] of Object.entries(value)) {
      out[key] = marshal(item, depth + 1)
    }

    return out
  }

  // ── slot rendering: every contribution's React tree lives in THIS document,
  // positioned over the host's placeholder rect (host-sandbox-slot.tsx).
  const renders = new Map() // slotId -> () => ReactNode
  const mounted = new Map() // slotId -> { el, root, observer }
  const slotsEl = document.getElementById('slots')

  function Boundary({ children, slotId }) {
    const [error, setError] = React.useState(null)

    if (error) {
      return React.createElement(
        'span',
        { className: 'hermes-sandbox-error', title: String(error && error.message ? error.message : error) },
        `${slotId}: ${error && error.message ? error.message : String(error)}`
      )
    }

    return React.createElement(ErrorCatcher, { onError: setError }, children)
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

  function mountSlot(slotId, rect, fill) {
    const render = renders.get(slotId)

    if (!render || mounted.has(slotId)) {
      return
    }

    const el = document.createElement('div')
    el.className = 'hermes-sandbox-slot'
    el.dataset.slot = slotId
    el.dataset.fill = String(Boolean(fill))
    const inner = document.createElement('div')
    inner.className = 'hermes-sandbox-slot-inner'
    el.appendChild(inner)
    slotsEl.appendChild(el)
    applyRect(el, rect)

    const root = ReactDOMClient.createRoot(inner)
    root.render(React.createElement(Boundary, { slotId }, React.createElement(render)))

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
    el.style.display = rect.width > 0 && rect.height > 0 ? '' : 'none'
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

  // ── the SDK the plugin sees ──────────────────────────────────────────────────
  const state = {}
  const paneVisibility = new Map()

  function unsupported(name, hint) {
    const fail = () => {
      throw new Error(
        `${name} is not available to catalog plugins: it runs in a sandboxed realm` + (hint ? ` — ${hint}` : '')
      )
    }

    return fail
  }

  const DOM_REACH_HINT = 'this plugin needs an SDK hook instead of host DOM access'

  const host = {
    state,
    notify: input => fire('notify', [input]),
    notifyError: (error, fallback) => fire('notifyError', [error && error.message ? error.message : String(error), fallback]),
    request: (method, params) => call('request', [method, params ?? {}]),
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
      const slotId = `workspace:${id}`
      renders.set(slotId, options.render)
      const onClose = options.onClose
      const { render: _render, onClose: _onClose, ...rest } = options
      fire('openWorkspace', [id, marshal({ ...rest, onClose }, 0)])

      return () => {
        renders.delete(slotId)
        fire('closeWorkspace', [id])
      }
    },
    onEvent: (type, listener) => subscribeEvent(type, listener),
    // Host DOM reach (seen in the review sweep) is exactly what the boundary
    // forbids. Fail loudly with the remedy instead of silently returning null.
    querySelector: unsupported('host.querySelector', DOM_REACH_HINT),
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

  function createContext() {
    return {
      source: `plugin:${pluginId}`,
      register(c) {
        const { render, when: _when, ...rest } = c
        const slotId = c.id

        if (typeof render === 'function') {
          renders.set(slotId, render)
        }

        fire('register', [marshal({ ...rest, hasRender: typeof render === 'function' }, 0)])

        return () => {
          renders.delete(slotId)
          fire('unregister', [slotId])
        }
      },
      registerMany(cs) {
        const all = cs.map(c => this.register(c))

        return () => all.forEach(d => d())
      },
      onDispose: fn => void disposers.push(fn),
      onEvent: subscribeEvent,
      // Own namespace by default; an absolute `/api/...` path asks for the
      // `rest:any` capability on the host side.
      rest: (path, opts) => call(String(path).startsWith('/api/') ? 'restAny' : 'rest', [path, opts ?? {}]),
      socket: () => () => {},
      os: {
        notify: input => fire('osNotify', [input]),
        openExternal: url => call('osOpenExternal', [url]),
        revealPath: path => call('osRevealPath', [path]),
        writeClipboard: text => call('osWriteClipboard', [text]),
        pickOpenPath: async () => null,
        pickSavePath: async () => null
      },
      storage,
      i18n: { t: key => key, register: () => () => {} }
    }
  }

  // ── minimal UI fallbacks for the most common SDK components ────────────────
  const h = React.createElement
  const cn = (...parts) => parts.flat().filter(part => typeof part === 'string' && part).join(' ')
  const Tip = ({ children, label }) => h('span', { title: label }, children)
  const Button = ({ children, className, ...props }) => h('button', { className: cn('hermes-btn', className), type: 'button', ...props }, children)
  const passthrough = tag => ({ children, className, ...props }) => h(tag, { className, ...props }, children)

  const sdk = {
    atom,
    Button,
    cn,
    host,
    Tip,
    useValue,
    Badge: passthrough('span'),
    Input: passthrough('input'),
    Separator: () => h('hr'),
    Switch: passthrough('input'),
    Textarea: passthrough('textarea'),
    ScrollArea: passthrough('div'),
    PanelBody: passthrough('div'),
    PanelHeader: passthrough('header'),
    PanelList: passthrough('ul'),
    PanelListRow: passthrough('li'),
    PanelEmpty: passthrough('p'),
    useQuery: unsupported('useQuery', 'poll with ctx.rest inside useEffect'),
    useMutation: unsupported('useMutation'),
    PANES_AREA: 'panes',
    STATUSBAR_AREAS: { left: 'statusBar.left', right: 'statusBar.right' },
    TITLEBAR_AREAS: { center: 'titleBar.center', left: 'titleBar.left', right: 'titleBar.right' },
    PALETTE_AREA: 'palette.commands',
    KEYBINDS_AREA: 'keybinds',
    THEMES_AREA: 'themes'
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
    // catalog plugin cannot claim another plugin's namespace by renaming itself.
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
    'slot-mount': msg => mountSlot(msg.slotId, msg.rect, msg.fill),
    'slot-rect': msg => {
      const slot = mounted.get(msg.slotId)

      if (slot) {
        applyRect(slot.el, msg.rect)
      }
    },
    'slot-unmount': msg => unmountSlot(msg.slotId),
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
