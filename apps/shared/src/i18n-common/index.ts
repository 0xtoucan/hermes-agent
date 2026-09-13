import { af } from './af'
import { ar } from './ar'
import { de } from './de'
import { commonEn, type CommonTranslations } from './en'
import { es } from './es'
import { fr } from './fr'
import { ga } from './ga'
import { hu } from './hu'
import { it } from './it'
import { ja } from './ja'
import { ko } from './ko'
import { pt } from './pt'
import { ru } from './ru'
import { tr } from './tr'
import { uk } from './uk'
import { zh } from './zh'
import { zhHant } from './zh-hant'

export { commonEn, type CommonTranslations }

export type CommonLocale = 'af' | 'ar' | 'de' | 'es' | 'fr' | 'ga' | 'hu' | 'it' | 'ja' | 'ko' | 'pt' | 'ru' | 'tr' | 'uk' | 'zh' | 'zh-hant'

/** Translations of `commonEn` for every locale either app ships. An app spreads
 *  `commonLocales[locale].<namespace>` at the top of that namespace and lists
 *  only its own keys after it. */
export const commonLocales: Record<CommonLocale, CommonTranslations> = {
  af,
  ar,
  de,
  es,
  fr,
  ga,
  hu,
  it,
  ja,
  ko,
  pt,
  ru,
  tr,
  uk,
  zh,
  'zh-hant': zhHant
}
