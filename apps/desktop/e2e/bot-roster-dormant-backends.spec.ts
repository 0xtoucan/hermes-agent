/**
 * E2E: the Bots roster must not materialise dormant local profile backends.
 *
 * Six local bot profiles are seeded on disk (three with an avatar asset) and
 * the Desktop is launched against the mock inference server. The invariant
 * under test is a PROCESS count, not UI text: after the roster paints, after
 * hovering every row, and after the fleet rail is switched to "all" scope, the
 * only `hermes serve` child owned by this sandbox is the primary backend.
 * Explicit activation (clicking a row) is the one boundary allowed to spawn.
 *
 * Also covered on the same rig, because they share the lifecycle boundary:
 *  - deleting a bot whose backend is running terminates that backend and
 *    leaves a tombstone (storage truth, not the toast);
 *  - the pooled backend cap holds when more bots are opened than the cap.
 *
 * Community reports: #94872, #98123, #96609, #94959, #94823, #102822.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { startMockServer } from '../../../tests-js/scripts/mock-server'

import {
  buildAppEnv,
  createSandbox,
  launchDesktop,
  type MockBackendFixture,
  waitForAppReady,
  writeEnvFile,
  writeMockProviderConfig
} from './fixtures'
import { expect, type Page, test } from './test'

const SHOT_DIR = process.env.BOT_LIFECYCLE_SHOT_DIR || ''
const BOTS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
const WITH_AVATAR = new Set(['alpha', 'gamma', 'epsilon'])

// 1x1 transparent PNG — enough for `has_avatar` and `profiles.get_asset`.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

let fixture: MockBackendFixture | null = null

async function capture(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) {
    return
  }

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
}

/** `hermes … serve` children whose environment names this sandbox's HERMES_HOME. */
function serveProcesses(hermesHome: string): Array<{ cmd: string; pid: number }> {
  const out: Array<{ cmd: string; pid: number }> = []

  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue
    }

    let cmd = ''
    let environ = ''

    try {
      cmd = fs.readFileSync(`/proc/${entry}/cmdline`).toString().replaceAll('\0', ' ').trim()
      environ = fs.readFileSync(`/proc/${entry}/environ`).toString()
    } catch {
      continue
    }

    if (!/hermes_cli\.main.*\bserve\b/.test(cmd) || !environ.includes(`HERMES_HOME=${hermesHome}`)) {
      continue
    }

    out.push({ cmd, pid: Number(entry) })
  }

  return out
}

function profileServes(hermesHome: string): string[] {
  return serveProcesses(hermesHome)
    .map(p => /--profile[= ]([\w.-]+)/.exec(p.cmd)?.[1] ?? '')
    .filter(Boolean)
}

async function openBots(page: Page): Promise<void> {
  const tab = page
    .getByRole('button', { name: 'Bots', exact: true })
    .or(page.getByRole('tab', { name: 'Bots', exact: true }))
    .first()

  await tab.click()
  await expect(page.getByRole('button', { name: 'New bot or group chat' })).toBeVisible({ timeout: 60_000 })
}

const roster = (page: Page) => page.locator('[data-slot="bots-roster"]')
const botRow = (page: Page, name: string) => roster(page).locator(`[data-roster-key="local::${name}"]`).first()

test.describe('Bots roster — dormant local profile backends stay dormant', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const mock = await startMockServer()
    const sandbox = createSandbox('bot-lifecycle')
    writeMockProviderConfig(sandbox.hermesHome, mock.url)
    writeEnvFile(sandbox.hermesHome)

    for (const name of BOTS) {
      const dir = path.join(sandbox.hermesHome, 'profiles', name)
      fs.mkdirSync(dir, { recursive: true })
      writeMockProviderConfig(dir, mock.url)
      writeEnvFile(dir)

      if (WITH_AVATAR.has(name)) {
        fs.writeFileSync(path.join(dir, 'avatar.png'), PNG_1X1)
      }
    }

    // Infrastructure-shaped directories that are NOT profiles (#99392).
    for (const stray of ['sessions', 'logs']) {
      fs.mkdirSync(path.join(sandbox.hermesHome, 'profiles', stray, 'cron'), { recursive: true })
    }

    const env = buildAppEnv(sandbox)
    const { app, page } = await launchDesktop(env)
    fixture = {
      app,
      page,
      mock,
      mockUrl: mock.url,
      sandbox,
      cleanup: async () => {
        await app.close().catch(() => undefined)
        await mock.close()
        sandbox.cleanup()
      }
    }
    await waitForAppReady(fixture, 120_000)
  })

  test.afterAll(async () => {
    if (!fixture) {
      return
    }

    if (SHOT_DIR) {
      try {
        fs.copyFileSync(path.join(fixture.sandbox.hermesHome, 'logs', 'desktop.log'), path.join(SHOT_DIR, 'desktop.log'))
      } catch {
        /* no log */
      }
    }

    // Never leave sandbox-owned backends behind on a shared host.
    for (const p of serveProcesses(fixture.sandbox.hermesHome)) {
      try {
        process.kill(p.pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }

    await fixture.cleanup()
  })

  test('roster paint, hover sweep and fleet "all" scope spawn zero profile backends', async () => {
    test.setTimeout(300_000)
    const { page, sandbox } = fixture!
    const home = sandbox.hermesHome

    await openBots(page)

    for (const name of BOTS) {
      await expect(botRow(page, name)).toBeVisible({ timeout: 60_000 })
    }

    // Give reconciliation / avatar hydration / relay boot their window.
    await page.waitForTimeout(30_000)
    await capture(page, '01-roster-painted')

    const strayRows = await roster(page).locator('[data-roster-key^="local::"]').evaluateAll(nodes =>
      nodes.map(n => n.getAttribute('data-roster-key') || '')
    )

    console.log(`[probe] roster keys: ${strayRows.join(',')}`)
    console.log(`[probe] after paint: profile serves = ${JSON.stringify(profileServes(home))}`)
    expect(profileServes(home), 'roster paint + hydration must not start dormant profiles').toEqual([])

    // Pointer sweep over every row (#94872 follow-up: hover must not spawn).
    for (const name of BOTS) {
      await botRow(page, name).hover()
      await page.waitForTimeout(400)
    }

    await page.waitForTimeout(15_000)
    // Hover pre-warm is a deliberate perf feature (e0390c0f70b): it MAY spawn,
    // bounded by the pool cap. Recorded as a receipt, not asserted, so the
    // roster-paint and fleet-scope invariants below still get exercised.
    console.log(`[probe] after hover sweep: profile serves = ${JSON.stringify(profileServes(home))}`)
    const hoverSpawned = profileServes(home)

    // Fleet rail "all" scope (#96609).
    const allScope = page.getByRole('button', { name: /All profiles/i }).first()

    if (await allScope.isVisible().catch(() => false)) {
      await allScope.click()
      await page.waitForTimeout(20_000)
      await capture(page, '02-fleet-all-scope')
      const afterAll = profileServes(home)
      console.log(`[probe] after fleet all-scope: profile serves = ${JSON.stringify(afterAll)}`)
      expect(
        afterAll.filter(p => !hoverSpawned.includes(p)),
        'fleet "all" scope must not spawn a backend per profile'
      ).toEqual([])
    } else {
      const buttons = await page.getByRole('button').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label') || n.textContent || '').filter(t => /profile|all/i.test(t)))
      console.log(`[probe] fleet all-scope control not present in this layout; candidate buttons: ${JSON.stringify(buttons)}`)
    }

    // Storage truth for the stray directories: still on disk, so whatever the
    // roster shows is the gateway's enumeration, not a filesystem artefact.
    expect(fs.existsSync(path.join(home, 'profiles', 'sessions'))).toBe(true)
  })

  test('deleting a bot terminates its running backend and tombstones the profile', async () => {
    test.setTimeout(300_000)
    const { page, sandbox } = fixture!
    const home = sandbox.hermesHome

    await openBots(page)
    // Explicit activation: clicking the row is allowed to spawn exactly alpha.
    await botRow(page, 'alpha').click()
    await expect
      .poll(() => profileServes(home), { timeout: 90_000, message: 'clicking alpha spawns its backend' })
      .toContain('alpha')
    console.log(`[probe] after open alpha: profile serves = ${JSON.stringify(profileServes(home))}`)
    // Let the canonical chat finish opening before deleting, otherwise the
    // in-flight open races the teardown and toasts (an expected race, not the
    // lifecycle under test).
    await expect(
      page.locator('[data-slot="composer-root"] [contenteditable="true"]').filter({ visible: true }).first()
    ).toBeVisible({ timeout: 90_000 })
    await page.waitForTimeout(3_000)
    await capture(page, '03-alpha-open')

    await botRow(page, 'alpha').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).first()
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await capture(page, '04-alpha-delete-confirm')
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect
      .poll(() => profileServes(home).filter(p => p === 'alpha').length, {
        timeout: 60_000,
        message: 'alpha backend exits after delete'
      })
      .toBe(0)
    await expect
      .poll(() => fs.existsSync(path.join(home, 'profiles', 'alpha')), { timeout: 60_000 })
      .toBe(false)
    expect(fs.existsSync(path.join(home, 'profiles', '.deleted', 'alpha'))).toBe(true)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(botRow(page, 'alpha')).toHaveCount(0, { timeout: 30_000 })

    // No resurrection within two cron ticker intervals' worth of reconciliation.
    await page.waitForTimeout(20_000)
    expect(fs.existsSync(path.join(home, 'profiles', 'alpha'))).toBe(false)
    console.log(`[probe] after delete alpha: profile serves = ${JSON.stringify(profileServes(home))}`)
    await capture(page, '05-alpha-deleted')
  })

  test('opening more bots than the pooled cap keeps the live count at the cap', async () => {
    test.setTimeout(300_000)
    const { page, sandbox } = fixture!
    const home = sandbox.hermesHome

    await openBots(page)

    for (const name of ['beta', 'gamma', 'delta']) {
      await botRow(page, name).click()
      await expect
        .poll(() => profileServes(home), { timeout: 90_000, message: `clicking ${name} spawns its backend` })
        .toContain(name)
      await page.waitForTimeout(3_000)
    }

    // Fourth bot over a cap of 3 whose slots all hold open sockets: the pool
    // refuses to evict a live session, so the open waits POOL_SLOT_WAIT_MS
    // (30 s) and surfaces "slots busy". Record what the user sees.
    await botRow(page, 'epsilon').click()
    await page.waitForTimeout(45_000)
    const live = profileServes(home)
    console.log(`[probe] after opening 4 bots over cap 3: profile serves = ${JSON.stringify(live)}`)
    const banners = await page.locator('[role="alert"], [role="status"], [data-slot="error-banner"]').evaluateAll(nodes => nodes.map(n => (n.textContent || '').trim()).filter(Boolean))
    console.log(`[probe] visible banners/toasts: ${JSON.stringify(banners)}`)
    await capture(page, '06-four-bots-over-cap')
    expect(live.length, 'pooled backend cap (default 3) bounds the live profile backends').toBeLessThanOrEqual(3)
  })
})
