import { describe, expect, it } from 'vitest'

import { isRecord } from '../i18n'

import { commonEn, type CommonLocale, commonLocales } from './index'

function leafPaths(node: unknown, prefix = ''): string[] {
  if (!isRecord(node)) {
    return [prefix]
  }

  return Object.entries(node).flatMap(([key, value]) => leafPaths(value, prefix ? `${prefix}.${key}` : key))
}

function readPath(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), catalog)
}

const COMMON_PATHS = leafPaths(commonEn).sort()
const LOCALES = Object.keys(commonLocales) as CommonLocale[]

describe('i18n-common catalog', () => {
  // A locale file that drops or misspells a key would make BOTH apps fall back
  // to English for a string each used to translate on its own before the key
  // moved here; the type only guarantees this for keys, not for stray extras.
  it('translates exactly the common English keys in every locale, with no English left behind', () => {
    expect(COMMON_PATHS.length).toBeGreaterThan(0)

    for (const locale of LOCALES) {
      expect(leafPaths(commonLocales[locale]).sort(), locale).toEqual(COMMON_PATHS)

      for (const path of COMMON_PATHS) {
        const translated = readPath(commonLocales[locale], path)

        expect(typeof translated, `${locale}:${path}`).toBe('string')
        expect(translated, `${locale}:${path} still English`).not.toBe(readPath(commonEn, path))
      }
    }
  })
})
