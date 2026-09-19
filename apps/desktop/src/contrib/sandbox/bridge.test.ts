/**
 * Behaviour of the bridge methods added with the full-SDK frame: composer,
 * socket relay, the boot locale snapshot, and the per-method capabilities of
 * `host.request` + the native dialogs. The guest never runs script here —
 * the test speaks as the guest through `realm.handle` and reads what the
 * host posted back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $composerLiveText,
  onComposerInsertRequest,
  onComposerReplaceRequest,
  publishComposerText
} from '@/app/chat/composer/focus'
import { setRuntimeI18nLocale } from '@/i18n'

import { resolveCapabilities } from './capabilities'
import { createPluginI18n, registerPluginLocales, reviveAppStrings, translatePlugin } from './guest-sdk/i18n'
import { loadSandboxedPlugin, serializeStrings, unloadSandboxedPlugin } from './loader'
import { FN_LEAF, type GuestMessage, type HostMessage } from './protocol'
import { type SandboxFrame, SandboxRealm } from './realm'

const notify = vi.fn()
const hostRequest = vi.fn(async (_method: string, _params: unknown) => ({ ok: true }))
const selectPaths = vi.fn(async () => ['/home/u/picked.txt'])

interface FakeSocket {
  path: string
  pluginId: string
  onMessage: (data: unknown) => void
  closed: boolean
}

const sockets: FakeSocket[] = []

vi.mock('@/store/notifications', () => ({
  notify: (input: unknown) => notify(input),
  notifyError: (error: unknown, fallback: string) => notify({ error, fallback })
}))

vi.mock('@/sdk', async importOriginal => {
  const original = await importOriginal<Record<string, unknown>>()
  const host = original.host as Record<string, unknown>

  return {
    ...original,
    host: {
      ...host,
      getGateway: () => null,
      request: (method: string, params: unknown) => hostRequest(method, params),
      state: { gateway: { get: () => 'open', listen: () => () => {} } }
    }
  }
})

vi.mock('@/api/plugins', async importOriginal => {
  const original = await importOriginal<Record<string, unknown>>()

  return {
    ...original,
    pluginSocket: (pluginId: string, path: string, onMessage: (data: unknown) => void) => {
      const socket: FakeSocket = { closed: false, onMessage, path, pluginId }
      sockets.push(socket)

      return () => {
        socket.closed = true
      }
    }
  }
})

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

  ofType<T extends HostMessage['type']>(type: T) {
    return this.sent.filter((m): m is Extract<HostMessage, { type: T }> & { hermes: string } => m.type === type)
  }
}

function realmWith(granted: readonly string[], name = 'fixture') {
  let frame!: FakeFrame

  const realm = new SandboxRealm({
    createFrame: (_srcdoc, owner) => (frame = new FakeFrame(owner)),
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
  selectPaths.mockClear()
  sockets.length = 0
  $composerLiveText.set({})
  window.localStorage.clear()
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = { selectPaths }
})

afterEach(() => {
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  document.body.innerHTML = ''
  setRuntimeI18nLocale('en')
})

describe('host.composer over the bridge', () => {
  it('is refused without the composer capability — the draft is neither read nor touched', async () => {
    publishComposerText('main', 'secret draft')
    const inserts = vi.fn()
    const replaces = vi.fn()
    const offInsert = onComposerInsertRequest(inserts)
    const offReplace = onComposerReplaceRequest(replaces)
    const { frame, realm } = realmWith(['ui', 'storage', 'events', 'rest'])

    call(realm, 1, 'composerGetText')
    call(realm, 2, 'composerInsertText', ['injected', 'block'])
    call(realm, 3, 'composerSetText', [''])
    await flush()

    expect(frame.replies().map(r => r.ok)).toEqual([false, false, false])
    expect(frame.replies().every(r => r.error?.includes('"composer" not granted'))).toBe(true)
    expect(frame.replies()[0].result).toBeUndefined()
    expect(inserts).not.toHaveBeenCalled()
    expect(replaces).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    realm.dispose()
    offInsert()
    offReplace()
  })

  it('reads and writes the REAL composer store when composer is granted', async () => {
    publishComposerText('main', 'hello from the editor')
    const inserts = vi.fn()
    const replaces = vi.fn()
    const offInsert = onComposerInsertRequest(inserts)
    const offReplace = onComposerReplaceRequest(replaces)
    const { frame, realm } = realmWith(['ui', 'composer'])

    call(realm, 1, 'composerGetText')
    call(realm, 2, 'composerInsertText', ['/enhance', 'prefix'])
    call(realm, 3, 'composerInsertText', ['no such mode', 'teleport'])
    call(realm, 4, 'composerSetText', ['replaced'])
    await flush()

    expect(frame.replies().map(r => r.ok)).toEqual([true, true, true, true])
    expect(frame.replies()[0].result).toBe('hello from the editor')
    expect(inserts.mock.calls.map(c => [c[0].text, c[0].mode])).toEqual([
      ['/enhance', 'prefix'],
      ['no such mode', 'block'] // an unknown mode falls back to the SDK default, never a string the editor does not know
    ])
    expect(replaces).toHaveBeenCalledWith(expect.objectContaining({ text: 'replaced' }))
    expect(notify).not.toHaveBeenCalled()
    realm.dispose()
    offInsert()
    offReplace()
  })
})

describe('ctx.socket relay', () => {
  it('relays parsed frames to the guest by socket id and closes the socket on dispose', async () => {
    const { frame, realm } = realmWith(['ui', 'events'])

    call(realm, 1, 'socketOpen', [7, '/stream'])
    await flush()

    expect(sockets).toHaveLength(1)
    expect(sockets[0]).toMatchObject({ path: '/stream', pluginId: 'fixture', closed: false })

    sockets[0].onMessage({ tick: 1 })
    expect(frame.ofType('socket')).toEqual([expect.objectContaining({ data: { tick: 1 }, sockId: 7 })])

    // Re-opening the same id replaces the socket; explicit close tears it down.
    call(realm, 2, 'socketOpen', [7, '/stream-2'])
    await flush()
    expect(sockets[0].closed).toBe(true)
    expect(sockets[1].closed).toBe(false)

    call(realm, 3, 'socketOpen', [8, '/other'])
    await flush()
    call(realm, 4, 'socketClose', [8])
    await flush()
    expect(sockets[2].closed).toBe(true)

    realm.dispose()
    expect(sockets.every(socket => socket.closed)).toBe(true)
    expect(frame.removed).toBe(true)
  })

  it('needs the events capability', async () => {
    const { frame, realm } = realmWith(['ui'])

    call(realm, 1, 'socketOpen', [1, '/stream'])
    await flush()

    expect(sockets).toHaveLength(0)
    expect(frame.replies()[0]).toMatchObject({ ok: false, error: expect.stringContaining('"events" not granted') })
    realm.dispose()
  })
})

describe('locale in the boot sequence', () => {
  it('delivers the active locale + the catalog slice (functions as leaves) and re-sends on switch', async () => {
    setRuntimeI18nLocale('ja')
    const frames: FakeFrame[] = []

    const load = loadSandboxedPlugin('export default {}', 'l10n', {
      bootTimeoutMs: 0,
      createFrame: (_srcdoc, realm) => {
        frames.push(new FakeFrame(realm))

        return frames[frames.length - 1]
      },
      packageName: 'l10n',
      packageOrigin: { repo: 'r' }
    })

    await flush()
    frames[0].realm.handle({ id: 'l10n', name: 'L10n', type: 'manifest' })
    expect(await load).toBe('l10n')

    const [boot] = frames[0].ofType('locale')
    expect(boot.locale).toBe('ja')
    // The slice the SDK's own components read — not the whole catalog.
    expect(Object.keys(boot.strings).sort()).toEqual(['common', 'errors', 'ui'])
    expect((boot.strings.ui as Record<string, unknown>).search).toBeDefined()
    expect((boot.strings.ui as Record<string, unknown>).pagination).toBeDefined()
    expect(boot.strings.settings).toBeUndefined()
    // Function leaves cannot cross postMessage: the snapshot is structured-
    // cloneable, and a function in the catalog travels as the sentinel the
    // guest revives into a callable.
    expect(() => structuredClone(boot.strings)).not.toThrow()
    expect(serializeStrings({ count: (n: number) => `${n}`, plain: 'x' })).toEqual({ count: FN_LEAF, plain: 'x' })
    const revived = reviveAppStrings({ ui: { count: FN_LEAF } }) as { ui: { count: () => string } }
    expect(typeof revived.ui.count).toBe('function')

    // The `locale` boot message precedes `activate` — a plugin's first render
    // already sees its locale.
    const order = frames[0].sent.map(m => m.type)
    expect(order.indexOf('locale')).toBeGreaterThan(-1)
    expect(order.indexOf('locale')).toBeLessThan(order.indexOf('activate'))

    setRuntimeI18nLocale('en')
    expect(frames[0].ofType('locale').at(-1)?.locale).toBe('en')

    unloadSandboxedPlugin('l10n')
  })

  it("resolves a plugin's own locale bundle guest-side with the active → English → key ladder", () => {
    const dispose = registerPluginLocales('bundle-plugin', {
      en: { greet: 'Hello', nested: { count: (n: number) => `${n} items` } },
      ja: { greet: 'こんにちは' }
    })

    expect(translatePlugin('bundle-plugin', 'ja', 'greet', [])).toBe('こんにちは')
    expect(translatePlugin('bundle-plugin', 'ja', 'nested.count', [3])).toBe('3 items')
    expect(translatePlugin('bundle-plugin', 'ja', 'missing.key', [])).toBe('missing.key')

    // `ctx.i18n.register` inside the frame merges and is tracked for dispose.
    const disposers: (() => void)[] = []
    const i18n = createPluginI18n('bundle-plugin', d => (disposers.push(d), d))
    i18n.register({ en: { extra: 'More' } })
    expect(translatePlugin('bundle-plugin', 'en', 'extra', [])).toBe('More')
    expect(translatePlugin('bundle-plugin', 'en', 'greet', [])).toBe('Hello')

    disposers.forEach(d => d())
    dispose()
    expect(translatePlugin('bundle-plugin', 'en', 'greet', [])).toBe('greet')
  })
})

describe('per-method capabilities of host.request and the native dialogs', () => {
  it('prompt.submit needs prompt:submit even when gateway:request is granted', async () => {
    const { frame, realm } = realmWith(['ui', 'gateway:request'])

    call(realm, 1, 'request', ['prompt.submit', { text: 'do it' }])
    call(realm, 2, 'request', ['session.list', {}])
    await flush()

    expect(hostRequest.mock.calls.map(c => c[0])).toEqual(['session.list'])
    expect(frame.replies()[0]).toMatchObject({ ok: false, error: expect.stringContaining('"prompt:submit" not granted') })
    expect(frame.replies()[1]).toMatchObject({ ok: true })
    realm.dispose()

    const granted = realmWith(['prompt:submit'], 'submitter')
    call(granted.realm, 1, 'request', ['prompt.submit', { text: 'do it' }])
    await flush()
    expect(hostRequest).toHaveBeenLastCalledWith('prompt.submit', { text: 'do it' })
    expect(granted.frame.replies()[0]).toMatchObject({ ok: true })
    granted.realm.dispose()
  })

  it('llm.oneshot needs llm even when gateway:request is granted', async () => {
    const { frame, realm } = realmWith(['ui', 'gateway:request'])

    call(realm, 1, 'request', ['llm.oneshot', { prompt: 'x' }])
    await flush()

    expect(hostRequest).not.toHaveBeenCalled()
    expect(frame.replies()[0]).toMatchObject({ ok: false, error: expect.stringContaining('"llm" not granted') })
    realm.dispose()

    const granted = realmWith(['llm'], 'thinker')
    call(granted.realm, 1, 'request', ['llm.oneshot', { prompt: 'x' }])
    await flush()
    expect(hostRequest).toHaveBeenLastCalledWith('llm.oneshot', { prompt: 'x' })
    granted.realm.dispose()
  })

  it('os.pickOpenPath needs os:dialogs; with it the user-picked path is the whole result', async () => {
    const { frame, realm } = realmWith(['ui', 'os:clipboard'])

    call(realm, 1, 'osPickOpenPath', [{ title: 'Pick' }])
    await flush()

    expect(selectPaths).not.toHaveBeenCalled()
    expect(frame.replies()[0]).toMatchObject({ ok: false, error: expect.stringContaining('"os:dialogs" not granted') })
    realm.dispose()

    const granted = realmWith(['os:dialogs'], 'picker')
    call(granted.realm, 1, 'osPickOpenPath', [{ title: 'Pick' }])
    await flush()
    expect(selectPaths).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, title: 'Pick' }))
    expect(granted.frame.replies()[0]).toMatchObject({ ok: true, result: '/home/u/picked.txt' })
    granted.realm.dispose()
  })
})
