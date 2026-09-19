/**
 * CAPABILITY CONSENT for sandboxed (remote-tier) plugins. A plugin's
 * `desktop_capabilities` beyond the defaults are REQUESTS, not grants: the
 * plugin runs with DEFAULT_CAPABILITIES until the user allows the rest from
 * Capabilities > Plugins, and a grant can be revoked from the same row.
 *
 * Scope: renderer-owned, persisted PER PROFILE (the key carries the profile,
 * `apps/desktop/AGENTS.md` "Persisted state must declare its scope"), keyed
 * by the plugin's trusted id (its install folder). The profile is the one
 * the live gateway serves (`$activeGatewayProfile`) — the backend the
 * plugin's REST/RPC calls reach — so a grant made under one profile never
 * leaks into another; the store reloads when that profile changes.
 */

import { atom } from 'nanostores'

import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'

import { type Capability, DEFAULT_CAPABILITIES, isCapability } from './capabilities'

const KEY_BASE = 'hermes.desktop.pluginCapabilityGrants.v1'

export interface CapabilityGrant {
  /** Non-default capabilities the user allowed for this plugin. */
  allowed: Capability[]
  /** The first-run notice for this plugin's requests was shown (or the user
   *  decided) — it is never repeated for the same plugin under this profile. */
  noticed?: boolean
}

export type CapabilityGrants = Record<string, CapabilityGrant>

export function grantsStorageKey(profile = $activeGatewayProfile.get()): string {
  return `${KEY_BASE}.profile.${encodeURIComponent(normalizeProfileKey(profile))}`
}

function readGrants(key: string): CapabilityGrants {
  try {
    const raw = window.localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : null

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    const out: CapabilityGrants = {}

    for (const [pluginId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value && typeof value === 'object' ? (value as Partial<CapabilityGrant>) : null

      if (entry) {
        out[pluginId] = {
          allowed: Array.isArray(entry.allowed) ? entry.allowed.filter(isCapability) : [],
          ...(entry.noticed ? { noticed: true } : {})
        }
      }
    }

    return out
  } catch {
    return {}
  }
}

function writeGrants(key: string, grants: CapabilityGrants): void {
  try {
    if (Object.keys(grants).length === 0) {
      window.localStorage.removeItem(key)
    } else {
      window.localStorage.setItem(key, JSON.stringify(grants))
    }
  } catch {
    // Best effort: the in-memory decision still applies for this run.
  }
}

/** Grants for the ACTIVE profile. Reloaded on every profile switch. */
export const $capabilityGrants = atom<CapabilityGrants>(readGrants(grantsStorageKey()))

$activeGatewayProfile.listen(profile => $capabilityGrants.set(readGrants(grantsStorageKey(profile))))

function save(next: CapabilityGrants): void {
  $capabilityGrants.set(next)
  writeGrants(grantsStorageKey(), next)
}

const isDefault = (capability: Capability) => DEFAULT_CAPABILITIES.includes(capability)

/** The request list the manifest declared, minus what every plugin gets anyway. */
export const consentCapabilities = (requested: Iterable<Capability>): Capability[] =>
  [...requested].filter(capability => !isDefault(capability))

/** What the user allowed this plugin (active profile), as a set. */
export function allowedCapabilities(pluginId: string, grants = $capabilityGrants.get()): ReadonlySet<Capability> {
  return new Set(grants[pluginId]?.allowed ?? [])
}

/** The capability set a realm runs with: the defaults it asked for, plus
 *  every non-default request the user allowed. A request alone grants nothing;
 *  an allowance the manifest no longer asks for grants nothing either (a later
 *  version cannot ride an earlier grant for a different capability). */
export function effectiveCapabilities(
  pluginId: string,
  requested: ReadonlySet<Capability>,
  grants = $capabilityGrants.get()
): Set<Capability> {
  const allowed = allowedCapabilities(pluginId, grants)

  return new Set([...requested].filter(capability => isDefault(capability) || allowed.has(capability)))
}

/** Requested, non-default, and not (yet) allowed under the active profile. */
export function pendingCapabilities(
  pluginId: string,
  requested: Iterable<Capability>,
  grants = $capabilityGrants.get()
): Capability[] {
  const allowed = allowedCapabilities(pluginId, grants)

  return consentCapabilities(requested).filter(capability => !allowed.has(capability))
}

/** Allow every listed non-default capability for the plugin (active profile). */
export function allowCapabilities(pluginId: string, capabilities: Iterable<Capability>): void {
  const grants = $capabilityGrants.get()
  const allowed = new Set([...(grants[pluginId]?.allowed ?? []), ...consentCapabilities(capabilities)])

  save({ ...grants, [pluginId]: { allowed: [...allowed], noticed: true } })
}

/** Withdraw every grant for the plugin; it is back to the defaults. The
 *  `noticed` mark stays — a revoke is a decision, not a fresh install. */
export function revokeCapabilities(pluginId: string): void {
  const grants = $capabilityGrants.get()

  if (!grants[pluginId]) {
    return
  }

  save({ ...grants, [pluginId]: { allowed: [], noticed: true } })
}

/** Mark the first-run notice shown. True exactly once per plugin + profile. */
export function markCapabilitiesNoticed(pluginId: string): boolean {
  const grants = $capabilityGrants.get()

  if (grants[pluginId]?.noticed) {
    return false
  }

  save({ ...grants, [pluginId]: { allowed: grants[pluginId]?.allowed ?? [], noticed: true } })

  return true
}

/** Rename sibling: grants follow the profile they were made under. */
export function migrateCapabilityGrantsForProfile(oldProfile: string, newProfile: string): void {
  const from = grantsStorageKey(oldProfile)
  const to = grantsStorageKey(newProfile)

  if (from === to) {
    return
  }

  const moved = readGrants(from)
  writeGrants(to, { ...readGrants(to), ...moved })
  writeGrants(from, {})

  if (normalizeProfileKey(newProfile) === normalizeProfileKey($activeGatewayProfile.get())) {
    $capabilityGrants.set(readGrants(to))
  }
}

/** Delete sibling: a deleted profile's grants must not resurrect under a
 *  same-named profile created later. */
export function dropCapabilityGrantsForProfile(profile: string): void {
  writeGrants(grantsStorageKey(profile), {})

  if (normalizeProfileKey(profile) === normalizeProfileKey($activeGatewayProfile.get())) {
    $capabilityGrants.set({})
  }
}
