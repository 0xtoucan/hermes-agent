/**
 * Guest-side `@/i18n`. The app catalog is ~180 KB per locale as strings alone,
 * so the frame never carries it: the host bridges the ACTIVE locale plus the
 * few catalog namespaces the SDK's own components read (`common`, `ui.search`,
 * …), and a plugin's own bundles (`ctx.i18n.register`) live right here, in
 * the guest, resolved exactly like core's `plugin-i18n.ts`.
 */

import { isRecord } from '@hermes/shared/i18n'
import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useCallback } from 'react'

import { DEFAULT_LOCALE } from '@/i18n/languages'
import type { PluginI18n, PluginLocaleBundles, PluginMessages, PluginTranslate } from '@/i18n/plugin-i18n'
import type { Locale, Translations } from '@/i18n/types'

import { $appStrings, $locale, FN_LEAF } from './bridge'

export { DEFAULT_LOCALE, isLocale, normalizeLocale } from '@/i18n/languages'
export type { PluginI18n, PluginLocaleBundles, PluginMessages, PluginMessageValue, PluginTranslate } from '@/i18n/plugin-i18n'
export type { Locale, Translations } from '@/i18n/types'

function resolvePath(source: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((current, part) => (isRecord(current) ? current[part] : undefined), source)
}

function render(value: unknown, args: unknown[]): null | string {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'function') {
    return (value as (...args: unknown[]) => string)(...args)
  }

  return null
}

export function translateFrom(source: (locale: Locale) => unknown, locale: Locale, key: string, args: unknown[]): string {
  const active = render(resolvePath(source(locale), key), args)

  if (active !== null) {
    return active
  }

  if (locale !== DEFAULT_LOCALE) {
    const fallback = render(resolvePath(source(DEFAULT_LOCALE), key), args)

    if (fallback !== null) {
      return fallback
    }
  }

  return key
}

/** Rebuild the host's string snapshot: sentinel leaves become `() => path`. */
export function reviveAppStrings(value: unknown, path = ''): unknown {
  if (value === FN_LEAF) {
    return () => path
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, reviveAppStrings(item, path ? `${path}.${key}` : key)])
    )
  }

  return value
}

export function getRuntimeI18nLocale(): Locale {
  return $locale.get()
}

export function setRuntimeI18nLocale(locale: Locale): void {
  $locale.set(locale)
}

export function translateNow(key: string, ...args: unknown[]): string {
  return translateFrom(() => $appStrings.get(), $locale.get(), key, args)
}

/** `useI18n` inside the frame: the live locale, and `t` over the bridged
 *  slice of the catalog (missing namespaces read as `undefined`, so a plugin
 *  that walks core strings should feature-detect or use `usePluginI18n`). */
export function useI18n() {
  const locale = useStore($locale)
  const strings = useStore($appStrings)

  return {
    configLoadError: null,
    isLoadingConfig: false,
    isSavingLocale: false,
    locale,
    saveError: null,
    setLocale: async () => undefined,
    t: strings as unknown as Translations
  }
}

// ── plugin bundles (guest-local) ─────────────────────────────────────────────

const registry = new Map<string, Map<Locale, PluginMessages>>()
const $version = atom(0)

function mergeMessages(base: PluginMessages, overrides: PluginMessages): PluginMessages {
  const result: PluginMessages = { ...base }

  for (const [key, value] of Object.entries(overrides)) {
    const prev = result[key]
    result[key] = isRecord(prev) && isRecord(value) ? mergeMessages(prev, value) : value
  }

  return result
}

export function registerPluginLocales(pluginId: string, bundles: PluginLocaleBundles): () => void {
  const byLocale = registry.get(pluginId) ?? new Map<Locale, PluginMessages>()
  registry.set(pluginId, byLocale)

  for (const [locale, messages] of Object.entries(bundles) as [Locale, PluginMessages | undefined][]) {
    if (!messages) {
      continue
    }

    const prev = byLocale.get(locale)
    byLocale.set(locale, prev ? mergeMessages(prev, messages) : messages)
  }

  $version.set($version.get() + 1)

  return () => {
    registry.delete(pluginId)
    $version.set($version.get() + 1)
  }
}

export function translatePlugin(pluginId: string, locale: Locale, key: string, args: unknown[]): string {
  return translateFrom(l => registry.get(pluginId)?.get(l), locale, key, args)
}

export function createPluginI18n(pluginId: string, track: (dispose: () => void) => () => void): PluginI18n {
  return {
    register: bundles => track(registerPluginLocales(pluginId, bundles)),
    t: (key, ...args) => translatePlugin(pluginId, $locale.get(), key, args)
  }
}

export function usePluginI18n(pluginId: string): PluginTranslate {
  const locale = useStore($locale)
  const version = useStore($version)

  return useCallback(
    (key: string, ...args: unknown[]) => translatePlugin(pluginId, locale, key, args),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pluginId, locale, version]
  )
}
