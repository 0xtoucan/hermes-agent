import { commonEn, commonLocales } from '@hermes/shared/i18n-common'
import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from './catalog'
import type { Locale } from './types'

type Node = Record<string, unknown>

function leafPaths(node: unknown, prefix = ''): string[] {
  if (typeof node !== 'object' || node === null) {
    return [prefix]
  }

  return Object.entries(node).flatMap(([key, value]) => leafPaths(value, prefix ? `${prefix}.${key}` : key))
}

function readPath(catalog: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, key) => (typeof node === 'object' && node !== null ? (node as Node)[key] : undefined), catalog)
}

// Desktop keeps no per-app override for any shared key, so every locale it
// ships must resolve each common key to exactly the shared translation. A key
// re-declared in a desktop catalog would shadow the spread and drift from web.
describe('desktop catalog vs @hermes/shared/i18n-common', () => {
  it('resolves every common key to the shared string in every desktop locale', () => {
    const paths = leafPaths(commonEn)

    expect(paths.length).toBeGreaterThan(0)

    for (const locale of Object.keys(TRANSLATIONS) as Locale[]) {
      const common: unknown = locale === 'en' ? commonEn : commonLocales[locale]

      for (const path of paths) {
        expect(readPath(TRANSLATIONS[locale], path), `${locale}:${path}`).toBe(readPath(common, path))
      }
    }
  })
})
