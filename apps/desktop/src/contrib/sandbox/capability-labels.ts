/**
 * Plain-language labels for the consent chips in Capabilities > Plugins. One
 * row per capability in `capabilities.ts`; the copy itself lives in the i18n
 * catalogs under `skills.plugins.capabilityLabels` so every locale carries it.
 * The `Record<Capability, …>` type makes a new capability without a label a
 * type error, not a blank chip.
 */

import type { Translations } from '@/i18n/types'

import type { Capability } from './capabilities'

export type CapabilityLabelKey = keyof Translations['skills']['plugins']['capabilityLabels']

export const CAPABILITY_LABEL_KEYS: Readonly<Record<Capability, CapabilityLabelKey>> = {
  ui: 'ui',
  storage: 'storage',
  events: 'events',
  rest: 'rest',
  'rest:any': 'restAny',
  'gateway:request': 'gatewayRequest',
  'prompt:submit': 'promptSubmit',
  llm: 'llm',
  composer: 'composer',
  navigate: 'navigate',
  'os:clipboard': 'osClipboard',
  'os:dialogs': 'osDialogs',
  'os:open-external': 'osOpenExternal',
  'os:reveal-path': 'osRevealPath',
  'os:notify': 'osNotify'
}

export const capabilityLabel = (t: Translations, capability: Capability): string =>
  t.skills.plugins.capabilityLabels[CAPABILITY_LABEL_KEYS[capability]]
