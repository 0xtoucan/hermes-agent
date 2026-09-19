import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $pluginRecords } from '@/contrib/plugins-store'
import { registry } from '@/contrib/registry'

import { DEFAULT_CAPABILITIES, GATEWAY_METHOD_ALLOWLIST, gatewayMethodAllowed, resolveCapabilities } from './capabilities'
import { buildFrameDocument, SANDBOX_CSP } from './frame-document'
import { loadSandboxedPlugin, unloadSandboxedPlugin } from './loader'
import type { GuestMessage, HostMessage } from './protocol'
import { MAX_CHIP_HEIGHT, MAX_CHIP_WIDTH, type SandboxFrame, SandboxRealm } from './realm'

const notify = vi.fn()
const hostRequest = vi.fn(async (_method: string, _params: unknown) => ({ ok: true }))
const hostNavigate = vi.fn()

vi.mock('@/store/notifications', () => ({
  notify: (input: unknown) => notify(input),
  notifyError: (error: unknown, fallback: string) => notify({ error, fallback })
}))

vi.mock('@/sdk', () => ({
  host: {
    navigate: (path: string) => hostNavigate(path),
    notify: (input: unknown) => notify(input),
    notifyError: (error: unknown, fallback: string) => notify({ error, fallback }),
    request: (method: string, params: unknown) => hostRequest(method, params),
    state: { gateway: { get: () => 'open', listen: () => () => {} } }
  },
  cn: () => '',
  useValue: () => undefined
}))

/** A guest that never runs script: records host->guest frames; the test
 *  speaks as the guest through `realm.handle`. */
class FakeFrame implements SandboxFrame {
  element = document.createElement('iframe')
  sent: (HostMessage & { hermes: string })[] = []
  removed = false
  window = null

  constructor(readonly realm: SandboxRealm) {}

  post = (message: HostMessage & { hermes: string }) => void this.sent.push(message)
  remove = () => void (this.removed = true)

  replies() {
    return this.sent.filter(m => m.type === 'reply') as Extract<HostMessage, { type: 'reply' }>[]
  }
}

function realmWith(granted: Parameters<typeof resolveCapabilities>[0], name = 'fixture', file?: string) {
  let frame!: FakeFrame

  const realm = new SandboxRealm({
    createFrame: (_srcdoc, owner) => (frame = new FakeFrame(owner)),
    file,
    granted: resolveCapabilities(granted).granted,
    name,
    pluginId: name,
    srcdoc: ''
  })

  realm.activate(() => {})

  return { frame, realm }
}

const call = (realm: SandboxRealm, callId: number, method: string, args: unknown[] = []) =>
  realm.handle({ args, callId, method, type: 'call' } satisfies GuestMessage)

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  notify.mockClear()
  hostRequest.mockClear()
  hostNavigate.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('capability table', () => {
  it('defaults to the minimal set and drops unknown names without widening', () => {
    expect([...resolveCapabilities(undefined).granted]).toEqual([...DEFAULT_CAPABILITIES])

    const { granted, unknown } = resolveCapabilities(['ui', 'os:clipboard', 'root', 'gateway:request'])
    expect([...granted]).toEqual(['ui', 'os:clipboard', 'gateway:request'])
    expect(unknown).toEqual(['root'])
  })

  it('allowlists gateway methods by exact name only — no prefixes', () => {
    expect(gatewayMethodAllowed('session.list')).toBe(true)
    expect(gatewayMethodAllowed('session.list.anything')).toBe(false)
    expect(gatewayMethodAllowed('kanban.board')).toBe(false)
    expect(gatewayMethodAllowed('plugins.manage')).toBe(false)
    expect(gatewayMethodAllowed('cli.exec')).toBe(false)
    expect([...GATEWAY_METHOD_ALLOWLIST].some(name => name.endsWith('.'))).toBe(false)
  })
})

describe('SandboxRealm bridge', () => {
  it('runs a granted call and replies with its result', async () => {
    const { frame, realm } = realmWith(['ui', 'gateway:request'])

    call(realm, 1, 'request', ['session.list', { limit: 1 }])
    await flush()

    expect(hostRequest).toHaveBeenCalledWith('session.list', { limit: 1 })
    expect(frame.replies()).toEqual([expect.objectContaining({ callId: 1, ok: true, result: { ok: true } })])
    realm.dispose()
  })

  it('forwards only kind/title/message/detail of a guest toast', async () => {
    const { realm } = realmWith(['ui'])

    call(realm, 1, 'notify', [
      {
        action: { label: 'Run', onClick: { __hermesCallback: 1 } },
        detail: 'd',
        durationMs: 0,
        id: 'host-toast-id',
        kind: 'success',
        message: 'm',
        placement: 'center',
        secondaryAction: { label: 'x' },
        title: 't'
      }
    ])
    call(realm, 2, 'notify', [{ kind: 'bogus', message: 'plain' }])
    await flush()

    expect(notify.mock.calls[0][0]).toEqual({ detail: 'd', kind: 'success', message: 'm', title: 't' })
    expect(notify.mock.calls[1][0]).toEqual({ detail: undefined, kind: undefined, message: 'plain', title: undefined })
    realm.dispose()
  })

  it('refuses an ungranted call with an error reply and ONE toast naming plugin + capability', async () => {
    const { frame, realm } = realmWith(['ui'], 'weather-widget')

    call(realm, 1, 'navigate', ['/settings'])
    call(realm, 2, 'navigate', ['/settings'])
    await flush()

    expect(hostNavigate).not.toHaveBeenCalled()
    expect(frame.replies().map(r => r.ok)).toEqual([false, false])
    expect(frame.replies()[0].error).toContain('"navigate" not granted')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'error', title: 'Plugin "weather-widget" blocked' })
    expect(String(notify.mock.calls[0][0].message)).toContain('"navigate"')
    expect(String(notify.mock.calls[0][0].message)).toContain('desktop_capabilities')
    realm.dispose()
  })

  it('refuses gateway methods outside the allowlist even when gateway:request is granted', async () => {
    const { frame, realm } = realmWith(['gateway:request'])

    call(realm, 1, 'request', ['plugins.manage', { action: 'install' }])
    await flush()

    expect(hostRequest).not.toHaveBeenCalled()
    expect(frame.replies()[0]).toMatchObject({ ok: false, error: expect.stringContaining('allowlist') })
    realm.dispose()
  })

  it('has no method that reaches the host DOM', async () => {
    const { frame, realm } = realmWith(['ui', 'storage', 'events', 'rest', 'rest:any', 'gateway:request'])

    for (const [index, method] of ['querySelector', 'insertBefore', 'firstChild', 'eval'].entries()) {
      call(realm, index + 1, method, ['body'])
    }

    await flush()
    expect(frame.replies()).toHaveLength(4)
    expect(frame.replies().every(r => !r.ok && r.error?.includes('not part of the sandbox SDK'))).toBe(true)
    realm.dispose()
  })

  it('ignores messages whose source is a DIFFERENT window, even with a valid frame and origin', async () => {
    const realm = new SandboxRealm({ granted: new Set(['gateway:request']), name: 'p', pluginId: 'p', srcdoc: '' })
    realm.activate(() => {})
    const own = document.querySelector('iframe')!
    const other = document.createElement('iframe')
    document.body.appendChild(other)

    // Well-formed call, sandbox origin, but spoken by another document.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { args: ['session.list', {}], callId: 9, hermes: 'hermes-plugin-sandbox', method: 'request', type: 'call' },
        origin: 'null',
        source: other.contentWindow
      })
    )
    await flush()

    expect(other.contentWindow).not.toBe(own.contentWindow)
    expect(hostRequest).not.toHaveBeenCalled()
    expect(own.isConnected).toBe(true) // a stranger's message is noise, not a violation
    realm.dispose()
  })

  it('drops the bridge when its own frame speaks from a real origin (it left its srcdoc)', async () => {
    const onError = vi.fn()
    const realm = new SandboxRealm({
      granted: new Set(['gateway:request']),
      name: 'p',
      onError,
      pluginId: 'p',
      srcdoc: ''
    })
    realm.activate(() => {})
    const own = document.querySelector('iframe')!
    const data = { args: ['session.list', {}], callId: 1, hermes: 'hermes-plugin-sandbox', method: 'request', type: 'call' }

    // Control: the same window with the sandbox's opaque origin is the plugin.
    window.dispatchEvent(new MessageEvent('message', { data, origin: 'null', source: own.contentWindow }))
    await flush()
    expect(hostRequest).toHaveBeenCalledTimes(1)

    // The navigated frame keeps the WindowProxy but gains an origin: refuse + dispose.
    window.dispatchEvent(
      new MessageEvent('message', { data: { ...data, callId: 2 }, origin: 'https://attacker.example', source: own.contentWindow })
    )
    await flush()

    expect(hostRequest).toHaveBeenCalledTimes(1)
    expect(own.isConnected).toBe(false)
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('https://attacker.example'))
    expect(notify.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'error', title: 'Plugin "p" disabled' })
  })

  it('admits only http(s) for os.openExternal and only own-folder paths for os.revealPath', async () => {
    const openExternal = vi.fn(async (_url: string) => undefined)
    const revealPath = vi.fn(async (_path: string) => true)
    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { openExternal, revealPath }

    try {
      const { frame, realm } = realmWith(['os:open-external', 'os:reveal-path'], 'p', '/home/u/.hermes/desktop-plugins/p/plugin.js')
      const urls = ['https://example.com/x', 'http://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'hermes://x', 'not a url']
      const paths = [
        '/home/u/.hermes/desktop-plugins/p/README.md',
        '/home/u/.hermes/desktop-plugins/p',
        '/home/u/.hermes/desktop-plugins/p/../other/plugin.js',
        '/home/u/.hermes/desktop-plugins/p-evil/plugin.js',
        '/etc/passwd'
      ]

      urls.forEach((url, i) => call(realm, i + 1, 'osOpenExternal', [url]))
      paths.forEach((path, i) => call(realm, 100 + i, 'osRevealPath', [path]))
      await flush()

      expect(openExternal.mock.calls.map(c => c[0])).toEqual(['https://example.com/x', 'http://example.com/'])
      expect(revealPath.mock.calls.map(c => c[0])).toEqual([
        '/home/u/.hermes/desktop-plugins/p/README.md',
        '/home/u/.hermes/desktop-plugins/p'
      ])
      const refused = frame.replies().filter(r => !r.ok)
      expect(refused).toHaveLength(4 + 3)
      expect(refused.every(r => /only http\(s\)|own install folder/.test(r.error ?? ''))).toBe(true)
      realm.dispose()
    } finally {
      delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
    }
  })

  it('refuses os.revealPath outright when the realm has no install file', async () => {
    const revealPath = vi.fn(async () => true)
    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { revealPath }

    try {
      const { frame, realm } = realmWith(['os:reveal-path'])
      call(realm, 1, 'osRevealPath', ['/anything'])
      await flush()

      expect(revealPath).not.toHaveBeenCalled()
      expect(frame.replies()[0]).toMatchObject({ ok: false })
      realm.dispose()
    } finally {
      delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
    }
  })

  it('registers a contribution whose render is a host placeholder, and dispose tears it all down', async () => {
    const { frame, realm } = realmWith(['ui'])

    call(realm, 1, 'register', [{ area: 'statusBar.right', hasRender: true, id: 'chip', order: 5 }])
    await flush()

    const item = registry.getArea('statusBar.right').find(c => c.id === 'fixture:chip')
    expect(item?.source).toBe('plugin:fixture')
    expect(typeof item?.render).toBe('function')

    realm.dispose()

    expect(registry.getArea('statusBar.right').some(c => c.id === 'fixture:chip')).toBe(false)
    expect(frame.removed).toBe(true)
    expect(frame.sent.some(m => m.type === 'deactivate')).toBe(true)
  })
})

describe('overlay frame', () => {
  const box = (el: HTMLElement, width: number, height: number) => {
    el.getBoundingClientRect = () =>
      ({ bottom: height, height, left: 0, right: width, top: 0, width, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  }

  it('is hidden and inert while no slot is on screen, live only while one is', () => {
    const realm = new SandboxRealm({ granted: new Set(['ui']), name: 'p', pluginId: 'p', srcdoc: '' })
    const frame = document.querySelector('iframe')!

    // Boot: nothing to show — the full-window overlay must not paint or take focus.
    expect(frame.hasAttribute('inert')).toBe(true)
    expect(frame.style.visibility).toBe('hidden')
    expect(frame.style.clipPath).toBe('inset(100%)')
    expect(frame.style.pointerEvents).toBe('none')

    const chip = document.createElement('div')
    document.body.appendChild(chip)
    box(chip, 80, 20)
    const unmount = realm.mountSlot('chip', chip, false)

    expect(frame.hasAttribute('inert')).toBe(false)
    expect(frame.style.visibility).toBe('')
    expect(frame.style.pointerEvents).toBe('auto')
    expect(frame.style.clipPath).toContain('path(')

    // A slot with an empty rect (scrolled out of view) does not count.
    const hidden = document.createElement('div')
    document.body.appendChild(hidden)
    box(hidden, 0, 0)
    realm.mountSlot('gone', hidden, false)
    unmount()

    expect(frame.hasAttribute('inert')).toBe(true)
    expect(frame.style.visibility).toBe('hidden')
    expect(frame.style.clipPath).toBe('inset(100%)')
    realm.dispose()
  })

  it('clamps guest-reported chip sizes and ignores sizes for filling slots', () => {
    const { realm } = realmWith(['ui'])
    const chip = document.createElement('div')
    const pane = document.createElement('div')
    document.body.append(chip, pane)
    realm.mountSlot('chip', chip, false)
    realm.mountSlot('pane', pane, true)

    realm.handle({ height: 9000, slotId: 'chip', type: 'slot-size', width: 5000 })
    realm.handle({ height: 9000, slotId: 'pane', type: 'slot-size', width: 5000 })
    realm.handle({ height: -1, slotId: 'unknown', type: 'slot-size', width: Number.NaN })

    expect(realm.$slotSizes.get()).toEqual({ chip: { height: MAX_CHIP_HEIGHT, width: MAX_CHIP_WIDTH } })
    realm.dispose()
  })
})

describe('frame document', () => {
  it('locks the frame down: no-network CSP, plugin source can never close the script tag', () => {
    const html = buildFrameDocument({
      pluginId: 'p',
      pluginSource: 'export default { id: "p", register() {} } // </script><script>alert(1)</script>',
      sdkExports: ['host'],
      styleText: ''
    })

    expect(html).toContain(`content="${SANDBOX_CSP}"`)
    expect(SANDBOX_CSP.startsWith("default-src 'none'")).toBe(true)
    expect(SANDBOX_CSP).not.toContain('connect-src')
    // Exactly the two real script tags: the plugin's `</script>` is escaped.
    expect(html.split('</script>')).toHaveLength(3)
  })

  it('builds an iframe with sandbox="allow-scripts" and nothing more; dispose removes it', () => {
    const realm = new SandboxRealm({ granted: new Set(['ui']), name: 'p', pluginId: 'p', srcdoc: '<html></html>' })
    const frames = document.querySelectorAll('iframe')

    expect(frames).toHaveLength(1)
    expect(frames[0].getAttribute('sandbox')).toBe('allow-scripts')
    realm.dispose()
    expect(document.querySelectorAll('iframe')).toHaveLength(0)
  })
})

describe('loadSandboxedPlugin', () => {
  const frameFactory = (frames: FakeFrame[]) => (_srcdoc: string, realm: SandboxRealm) => {
    frames.push(new FakeFrame(realm))

    return frames[frames.length - 1]
  }

  it('disposes the realm when the frame never boots (timeout) or reports a boot error', async () => {
    const timedOut: FakeFrame[] = []
    expect(
      await loadSandboxedPlugin('export default {}', 'slow', {
        bootTimeoutMs: 5,
        createFrame: frameFactory(timedOut),
        packageName: 'slow',
        packageOrigin: { repo: 'r' }
      })
    ).toBeNull()
    expect(timedOut[0].removed).toBe(true)
    expect($pluginRecords.get().slow).toMatchObject({ status: 'error', error: expect.stringContaining('boot') })

    const errored: FakeFrame[] = []
    const load = loadSandboxedPlugin('export default {}', 'broken', {
      bootTimeoutMs: 0,
      createFrame: frameFactory(errored),
      packageName: 'broken',
      packageOrigin: { repo: 'r' }
    })
    await flush()
    errored[0].realm.handle({ message: 'SyntaxError: nope', type: 'error' })

    expect(await load).toBeNull()
    expect(errored[0].removed).toBe(true)
    expect($pluginRecords.get().broken).toMatchObject({ status: 'error', error: 'SyntaxError: nope' })
  })

  it('inventories the plugin from the guest manifest under its TRUSTED id and unloads cleanly', async () => {
    const frames: FakeFrame[] = []

    const load = loadSandboxedPlugin('export default {}', 'cat-plugin', {
      bootTimeoutMs: 0,
      capabilities: ['ui'],
      createFrame: (_srcdoc, realm) => {
        frames.push(new FakeFrame(realm))

        return frames[frames.length - 1]
      },
      packageName: 'cat-plugin',
      packageOrigin: { catalogName: 'cat-plugin', repo: 'https://example.invalid/r.git' }
    })

    await flush()
    expect(frames).toHaveLength(1)
    // The guest declares another id; the host keeps scoping to the install folder.
    frames[0].realm.handle({ description: 'd', id: 'kanban', name: 'Cat Plugin', type: 'manifest' })

    expect(await load).toBe('cat-plugin')
    expect($pluginRecords.get()['cat-plugin']).toMatchObject({ name: 'Cat Plugin', status: 'loaded' })
    expect($pluginRecords.get().kanban).toBeUndefined()
    expect(frames[0].sent.map(m => m.type)).toEqual(expect.arrayContaining(['storage', 'state', 'theme', 'activate']))

    unloadSandboxedPlugin('cat-plugin')
    expect(frames[0].removed).toBe(true)
  })
})
