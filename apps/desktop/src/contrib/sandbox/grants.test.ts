/**
 * Capability consent: a manifest's non-default `desktop_capabilities` are
 * requests. The realm runs with the defaults until the user allows them, the
 * grant is persisted per plugin id + profile, and a revoke returns the plugin
 * to the defaults.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $activeGatewayProfile } from '@/store/profile'

import { DEFAULT_CAPABILITIES } from './capabilities'
import {
  $capabilityGrants,
  allowCapabilities,
  dropCapabilityGrantsForProfile,
  effectiveCapabilities,
  grantsStorageKey,
  migrateCapabilityGrantsForProfile,
  pendingCapabilities,
  revokeCapabilities
} from './grants'
import { loadSandboxedPlugin, unloadSandboxedPlugin } from './loader'
import type { GuestMessage, HostMessage } from './protocol'
import type { SandboxFrame, SandboxRealm } from './realm'

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

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/** Load a remote-tier plugin that REQUESTS `capabilities`; returns its frame. */
async function loadRequesting(pluginId: string, capabilities: string[]) {
  const frames: FakeFrame[] = []

  const load = loadSandboxedPlugin('export default {}', pluginId, {
    bootTimeoutMs: 0,
    capabilities,
    createFrame: (_srcdoc, realm) => {
      frames.push(new FakeFrame(realm))

      return frames[frames.length - 1]
    },
    packageName: pluginId,
    packageOrigin: { catalogName: pluginId, repo: 'https://example.invalid/r.git' }
  })

  await flush()
  frames[0].realm.handle({ id: pluginId, name: `${pluginId} (manifest)`, type: 'manifest' })
  expect(await load).toBe(pluginId)

  return frames[0]
}

const call = (frame: FakeFrame, callId: number, method: string, args: unknown[] = []) =>
  frame.realm.handle({ args, callId, method, type: 'call' } satisfies GuestMessage)

beforeEach(() => {
  notify.mockClear()
  hostRequest.mockClear()
  hostNavigate.mockClear()
  window.localStorage.clear()
  $activeGatewayProfile.set('default')
  $capabilityGrants.set({})
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('request is not grant', () => {
  it('a plugin requesting prompt:submit runs with the defaults; the call is refused with a Review toast', async () => {
    const frame = await loadRequesting('asker', ['ui', 'storage', 'events', 'rest', 'prompt:submit', 'os:clipboard'])

    expect([...frame.realm.granted].sort()).toEqual([...DEFAULT_CAPABILITIES].sort())
    expect(pendingCapabilities('asker', frame.realm.requested)).toEqual(['prompt:submit', 'os:clipboard'])

    // The first-run notice: one info toast with a Review action, no navigation.
    const notice = notify.mock.calls.map(c => c[0]).find(n => n.kind === 'info')
    expect(notice).toMatchObject({ title: expect.stringContaining('asker (manifest)') })
    expect(hostNavigate).not.toHaveBeenCalled()
    notice.action.onClick()
    expect(hostNavigate).toHaveBeenCalledWith('/skills?tab=plugins&plugin=asker')

    call(frame, 1, 'request', ['prompt.submit', { text: 'hi' }])
    await flush()

    expect(hostRequest).not.toHaveBeenCalled()
    expect(frame.replies()[0]).toMatchObject({ ok: false, error: expect.stringContaining('"prompt:submit" not granted') })
    const refusal = notify.mock.calls.map(c => c[0]).find(n => n.kind === 'error')
    expect(refusal.message).not.toContain('desktop_capabilities') // it WAS declared — the user has not allowed it
    expect(refusal.action?.label).toBeTruthy()

    // A grants write that does not move THIS plugin's set (another plugin's
    // Allow) must not re-arm the toast for a plugin that keeps retrying.
    allowCapabilities('someone-else', ['llm'])
    call(frame, 2, 'request', ['prompt.submit', { text: 'hi' }])
    await flush()
    expect(notify.mock.calls.filter(c => c[0].kind === 'error')).toHaveLength(1)

    unloadSandboxedPlugin('asker')
  })

  it('Allow takes effect on the next call without a reload; Revoke returns the plugin to the defaults', async () => {
    const frame = await loadRequesting('asker', ['ui', 'prompt:submit'])

    allowCapabilities('asker', ['prompt:submit'])
    expect(frame.realm.granted.has('prompt:submit')).toBe(true)

    call(frame, 1, 'request', ['prompt.submit', { text: 'hi' }])
    await flush()
    expect(hostRequest).toHaveBeenCalledWith('prompt.submit', { text: 'hi' })
    expect(frame.replies()[0]).toMatchObject({ ok: true })

    revokeCapabilities('asker')
    expect(frame.realm.granted.has('prompt:submit')).toBe(false)

    call(frame, 2, 'request', ['prompt.submit', { text: 'again' }])
    await flush()
    expect(hostRequest).toHaveBeenCalledTimes(1)
    expect(frame.replies()[1]).toMatchObject({ ok: false })

    unloadSandboxedPlugin('asker')
  })

  it('an allowance never widens past the request, and never grants a capability the manifest dropped', () => {
    allowCapabilities('p', ['os:clipboard', 'prompt:submit'])

    // Requested only os:clipboard: the prompt:submit grant is inert.
    expect([...effectiveCapabilities('p', new Set(['ui', 'os:clipboard']))].sort()).toEqual(['os:clipboard', 'ui'])
    // A default is never "allowed" into existence for a plugin that did not ask.
    expect([...effectiveCapabilities('p', new Set(['ui']))]).toEqual(['ui'])
  })

  it('the first-run notice is shown once per plugin + profile, not on every load', async () => {
    await loadRequesting('asker', ['ui', 'llm'])
    unloadSandboxedPlugin('asker')
    expect(notify.mock.calls.filter(c => c[0].kind === 'info')).toHaveLength(1)

    await loadRequesting('asker', ['ui', 'llm'])
    unloadSandboxedPlugin('asker')
    expect(notify.mock.calls.filter(c => c[0].kind === 'info')).toHaveLength(1)
  })
})

describe('grant persistence', () => {
  it('persists per plugin id AND per profile; a fresh load reads it back', async () => {
    allowCapabilities('p', ['os:clipboard'])

    const key = grantsStorageKey('default')
    expect(key).toContain('.profile.default')
    expect(JSON.parse(window.localStorage.getItem(key)!).p.allowed).toEqual(['os:clipboard'])

    // Another plugin under the same profile: nothing.
    expect(effectiveCapabilities('q', new Set(['ui', 'os:clipboard'])).has('os:clipboard')).toBe(false)

    // Another profile: nothing, and its own grants do not leak back.
    $activeGatewayProfile.set('work')
    expect(effectiveCapabilities('p', new Set(['ui', 'os:clipboard'])).has('os:clipboard')).toBe(false)
    allowCapabilities('p', ['llm'])
    expect(window.localStorage.getItem(grantsStorageKey('work'))).toContain('llm')
    expect(window.localStorage.getItem(grantsStorageKey('default'))).not.toContain('llm')

    $activeGatewayProfile.set('default')
    expect(effectiveCapabilities('p', new Set(['ui', 'os:clipboard', 'llm']))).toEqual(new Set(['ui', 'os:clipboard']))

    // A realm loaded now starts with the persisted grant already in force.
    const frame = await loadRequesting('p', ['ui', 'os:clipboard'])
    expect(frame.realm.granted.has('os:clipboard')).toBe(true)
    expect(notify.mock.calls.some(c => c[0].kind === 'info')).toBe(false) // nothing pending — no notice
    unloadSandboxedPlugin('p')
  })

  it('a revoke survives a reload (takes effect on the next load too)', async () => {
    allowCapabilities('p', ['navigate'])
    revokeCapabilities('p')

    const frame = await loadRequesting('p', ['ui', 'navigate'])
    expect(frame.realm.granted.has('navigate')).toBe(false)
    // Revoke is a decision: the first-run notice does not come back.
    expect(notify.mock.calls.some(c => c[0].kind === 'info')).toBe(false)
    unloadSandboxedPlugin('p')
  })

  it('follows a profile rename and dies with a profile delete', () => {
    allowCapabilities('p', ['navigate'])

    migrateCapabilityGrantsForProfile('default', 'renamed')
    expect(window.localStorage.getItem(grantsStorageKey('default'))).toBeNull()
    $activeGatewayProfile.set('renamed')
    expect(effectiveCapabilities('p', new Set(['ui', 'navigate'])).has('navigate')).toBe(true)

    dropCapabilityGrantsForProfile('renamed')
    expect(window.localStorage.getItem(grantsStorageKey('renamed'))).toBeNull()
    expect(effectiveCapabilities('p', new Set(['ui', 'navigate'])).has('navigate')).toBe(false)
  })
})
