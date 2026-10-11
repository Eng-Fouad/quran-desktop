/**
 * The About screen's attribution groups (§9.7): the app itself, Quran text and layout, fonts, translations, tafsir, word
 * by word and recitations. Owner: WP12c. The open-source licences (`thirdparty.json`, WP3c) are listed separately by the About
 * view, which loads that file lazily.
 *
 * - **The app** (`APP_GROUP`, docs/deviations/LEAD.md item 16) comes first: its own licence (GPL-3.0-or-later, with the
 *   full text of the repository's `LICENSE`), the link to its source code (GPL-3.0 §6: the Corresponding Source must
 *   be reachable from the program; `SOURCE_URL`, Cargo's `repository`) and the credit for its name and icon, the
 *   identity of the Quran.com project (github.com/quran) taken from quran_android.
 * - **Quran text and layout** credits the source the bundled core.db was built from (`coreSource`): QUL in a release
 *   (`qul`) build, the Quran.com API in a development (`qdc`) build, never both.
 * - **Static sources** (`attributions`) are credited whatever is installed: the data core.db is built from, the
 *   bundled and on-demand fonts, and the audio sources every recitation streams from.
 * - **Pack sources** come from the catalogue (`PackInfo.attribution`, WP5a): each installed translation and tafsir is
 *   credited with its version and link (§9.7), the word-by-word data once a pack has content, and the optional Urdu
 *   Nastaliq font once installed. The catalogue's licence line is English; for a source it recognises by its host
 *   (QuranEnc, Quran Foundation, QuranicAudio, the Noto fonts) the Arabic UI gets a translated line.
 * - Names, credits and licences are data in both UI languages (`L10nText`, like the catalogue's), not dictionary
 *   messages: they name third parties and must read the same wherever they appear.
 */
import type { L10nText, PackInfo, PackKind } from '$lib/ipc/bindings'

export type AttributionGroupId = 'app' | 'text' | 'fonts' | 'translations' | 'tafsir' | 'wbw' | 'recitations'

/** The display order of the groups (§9.7): the app itself first. */
export const ATTRIBUTION_GROUPS: readonly AttributionGroupId[] = [
  'app',
  'text',
  'fonts',
  'translations',
  'tafsir',
  'wbw',
  'recitations',
]

/** A long licence text that ships with the app, which an entry can show in full (as plain text, never HTML). */
export type AttributionNotice = 'app-licence' | 'kfgqpc-hafs' | 'print-labels'

/**
 * Where each served notice comes from, relative to the app's base URL (`public/`, copied to `dist/` by Vite). The
 * app's own licence is not served: it is the repository's `LICENSE`, which the About view bundles as a lazily
 * loaded module (`components/about/links.ts`), so the text shown is always the file that ships with the source.
 */
export const NOTICE_PATHS: Readonly<Record<Exclude<AttributionNotice, 'app-licence'>, string>> = {
  // Written by `cargo xtask fetch-assets` (WP3c) from the font's own name table; committed next to the gitignored TTF.
  'kfgqpc-hafs': 'fonts/KFGQPC-Hafs-V30.LICENSE.txt',
  // Committed beside the font: its provenance and the Mushaf Database licence, verbatim (LEAD 25).
  'print-labels': 'fonts/QuranPrintLabels.LICENSE.txt',
}

export interface AttributionEntry {
  /** Stable key: a source id, or the pack id of a pack entry. */
  id: string
  /** The source or the work. */
  name: L10nText
  /** What the app takes from it, or the credit line the source asks for. */
  credit: L10nText
  /** The licence or terms it is used under. */
  licence: L10nText
  /** The source's website (https; opened with `system_open_external`); empty when there is none to link. */
  url: string
  /** The licence's own page (https), when it has one. */
  licenceUrl?: string
  /** Where the work's source code is published (https; the app's own entry). */
  sourceUrl?: string
  /** The installed version (pack entries). */
  version?: string
  /** BCP-47 language of the content (pack entries with a language). */
  language?: string
  /** A bundled licence text the entry can show in full. */
  notice?: AttributionNotice
}

export interface AttributionGroup {
  id: AttributionGroupId
  entries: AttributionEntry[]
}

// --- the app ------------------------------------------------------------------------------------------------------

/** GNU GPL v3's page; the app is "version 3 or (at your option) any later version". */
const GPL_URL = 'https://www.gnu.org/licenses/gpl-3.0.html'

/**
 * The app's public source repository: the workspace `repository` in `Cargo.toml`, which the tests hold this to, so the
 * two cannot drift. The final location is a release decision (a checklist item that blocks the first public build).
 */
export const SOURCE_URL = 'https://github.com/Eng-Fouad/quran-desktop'

/** The app's own licence (docs/deviations/LEAD.md item 16; the `LICENSE` file, Cargo and package.json fields). */
const APP: AttributionEntry = {
  id: 'app',
  name: { en: 'Quran for Desktop', ar: 'قرآن لسطح المكتب' },
  credit: {
    en: '© Quran for Desktop contributors. Free software: you can redistribute it and change it under the terms of the GNU General Public License, version 3 or any later version. It comes with no warranty.',
    ar: '© المساهمون في «قرآن لسطح المكتب». برنامج حر: يمكنك إعادة توزيعه وتعديله وفق رخصة جنو العمومية العامة، الإصدار الثالث أو أي إصدار لاحق، دون أي ضمان.',
  },
  licence: {
    en: 'GNU General Public License v3.0 or later (GPL-3.0-or-later)',
    ar: 'رخصة جنو العمومية العامة، الإصدار 3.0 أو أي إصدار لاحق (GPL-3.0-or-later)',
  },
  url: '',
  licenceUrl: GPL_URL,
  sourceUrl: SOURCE_URL,
  notice: 'app-licence',
}

/** The name and the icon: the Quran.com identity (LEAD.md item 16; `assets/brand/README.md`). */
const APP_ICON: AttributionEntry = {
  id: 'app-icon',
  name: { en: 'App icon', ar: 'أيقونة التطبيق' },
  credit: {
    en: 'Quran.com / quran_android contributors. The app is built to the identity of the Quran.com project (github.com/quran): its name and its icon, the قرآن mark from quran_android.',
    ar: 'من Quran.com والمساهمين في quran_android. بُني التطبيق على هوية مشروع Quran.com (github.com/quran): اسمه وأيقونته، شعار «قرآن» من تطبيق quran_android.',
  },
  licence: { en: 'GPL-3.0', ar: 'رخصة جنو العمومية العامة، الإصدار 3.0 (GPL-3.0)' },
  url: 'https://github.com/quran/quran_android',
  licenceUrl: GPL_URL,
}

/** The app's own group, first in the About screen's list. */
export const APP_GROUP: AttributionGroup = { id: 'app', entries: [APP, APP_ICON] }

// --- static sources -----------------------------------------------------------------------------------------------

/**
 * The terms QUL's data is used under. QUL publishes no licence for its layouts and scripts (FACT_SHEET §8.1, risk R1),
 * and written permission from Tarteel is a release prerequisite (§15.3 item 1): until it is recorded in
 * `data/sources/README.md` this stays `null` and the line claims no licence. Then quote it here, e.g. "Used with
 * permission of Tarteel (QUL)".
 */
export const QUL_PERMISSION: L10nText | null = null

const QUL: AttributionEntry = {
  id: 'qul',
  name: { en: 'Quranic Universal Library (QUL) by Tarteel', ar: 'المكتبة القرآنية الشاملة (QUL) من ترتيل' },
  credit: {
    en: 'The Mushaf page layouts, the word glyph codes and the Quran script the pages are built from.',
    ar: 'تخطيطات صفحات المصحف ورموز خطوط الكلمات ونص القرآن الذي تُبنى منه الصفحات.',
  },
  licence: QUL_PERMISSION ?? {
    en: 'QUL publishes no licence for this data',
    ar: 'لا تنشر المكتبة القرآنية الشاملة رخصة لهذه البيانات',
  },
  url: 'https://qul.tarteel.ai',
}

const KFGQPC: AttributionEntry = {
  id: 'kfgqpc',
  name: { en: "King Fahd Glorious Qur'an Printing Complex", ar: 'مجمع الملك فهد لطباعة المصحف الشريف' },
  credit: {
    en: 'The Madani Mushaf: its text, its page layout and its typefaces.',
    ar: 'مصحف المدينة النبوية: نصه وتخطيط صفحاته وخطوطه.',
  },
  licence: { en: '© KFGQPC', ar: '© مجمع الملك فهد لطباعة المصحف الشريف' },
  url: 'https://qurancomplex.gov.sa',
}

const TANZIL: AttributionEntry = {
  id: 'tanzil',
  name: { en: 'Tanzil Quran metadata', ar: 'بيانات القرآن من مشروع تنزيل' },
  credit: {
    en: 'Surah, juz, hizb, manzil, ruku and sajda data (quran-data.xml), used verbatim.',
    ar: 'بيانات السور والأجزاء والأحزاب والمنازل والركوعات والسجدات (quran-data.xml)، دون تعديل.',
  },
  licence: {
    en: 'Creative Commons Attribution 3.0 (CC BY 3.0)',
    ar: 'المشاع الإبداعي، نسب المصنف 3.0 (CC BY 3.0)',
  },
  url: 'https://tanzil.net',
  licenceUrl: 'https://creativecommons.org/licenses/by/3.0/',
}

/** Only for a core.db built by the development adapter (`AppInfo.core.source === 'qdc'`, §4.2). */
const QDC_DEV: AttributionEntry = {
  id: 'qdc-dev',
  name: { en: 'Quran.com API (Quran Foundation)', ar: 'واجهة Quran.com البرمجية (Quran Foundation)' },
  credit: {
    en: "This development build's Quran data was fetched from the Quran.com API, for local development only.",
    ar: 'جُلبت بيانات القرآن في نسخة التطوير هذه من واجهة Quran.com البرمجية، للتطوير المحلي فقط.',
  },
  licence: { en: 'Quran Foundation developer terms', ar: 'شروط Quran Foundation للمطورين' },
  url: 'https://api-docs.quran.foundation/legal/developer-terms/',
}

const HAFS_FONT: AttributionEntry = {
  id: 'kfgqpc-hafs',
  name: { en: 'KFGQPC Hafs (version 3.0)', ar: 'خط حفص من مجمع الملك فهد (الإصدار 3.0)' },
  credit: {
    en: 'The Quran typeface that ships with the app, unmodified, so every page reads offline.',
    ar: 'خط القرآن المضمَّن في التطبيق دون تعديل، لتُقرأ كل صفحة دون اتصال.',
  },
  licence: {
    en: 'KFGQPC end-user licence: free to use, copy and distribute, never modified or sold',
    ar: 'رخصة المستخدم من مجمع الملك فهد: مجانية الاستخدام والنسخ والتوزيع، دون تعديل أو بيع',
  },
  url: 'https://fonts.qurancomplex.gov.sa',
  notice: 'kfgqpc-hafs',
}

/**
 * The print's furniture calligraphy (LEAD 25): the running heads and margin labels of the 1441H Madinah print, cut from
 * the Mushaf Database SVG Mushaf into a font that ships with the app (`public/fonts/QuranPrintLabels.otf`).
 */
const PRINT_LABELS_FONT: AttributionEntry = {
  id: 'print-labels',
  name: {
    en: 'Quran Print Labels (Mushaf Database SVG Mushaf)',
    ar: 'خط عناوين المصحف المطبوع (مصحف SVG من Mushaf Database)',
  },
  credit: {
    en: 'The running heads and the hizb labels in the margin, in the calligraphy of the 1441 AH Madinah print: outlines from the Mushaf Database Ligature-Based SVG Mushaf (version 1.01), from the printing-use Mushaf of the King Fahd Complex, which allows its use in computer programs.',
    ar: 'عناوين رؤوس الصفحات وعلامات الأحزاب في الهامش بخط طبعة المدينة النبوية لعام ١٤٤١هـ: محارف مأخوذة من مصحف SVG المبني على الأربطة من Mushaf Database (الإصدار 1.01)، المأخوذ من ملفات المصحف المعدّة للطباعة من مجمع الملك فهد، الذي يأذن باستخدامها في البرامج الحاسوبية.',
  },
  licence: {
    en: 'Mushaf Database open permission (Sadaqa-e-Jaria): free to use, copy, modify and distribute, the Quranic content never altered',
    ar: 'إذن Mushaf Database المفتوح (صدقة جارية): حرية الاستخدام والنسخ والتعديل والتوزيع، دون أي تغيير في النص القرآني',
  },
  url: 'https://github.com/mushafdatabase/MushafDatabase-Ligature-Based-SVG',
  notice: 'print-labels',
}

/** The §9.7 credit for the QCF page fonts ("Quran fonts provided by Quran Foundation"). */
const QCF_FONTS: AttributionEntry = {
  id: 'qcf',
  name: { en: 'Mushaf page fonts (QCF V1, V2 and V4)', ar: 'خطوط صفحات المصحف (QCF)' },
  credit: { en: 'Quran fonts provided by Quran Foundation', ar: 'خطوط المصحف مقدمة من Quran Foundation' },
  licence: {
    en: '© KFGQPC; used under the Quran Foundation terms, within the app only',
    ar: '© مجمع الملك فهد؛ تُستخدم وفق شروط Quran Foundation وداخل التطبيق فقط',
  },
  url: 'https://quran.foundation',
}

const ORNAMENT_FONTS: AttributionEntry = {
  id: 'decor',
  name: { en: 'Surah header and ornament fonts', ar: 'خطوط عناوين السور والزخارف' },
  credit: {
    en: 'Surah header, ornament and surah-name fonts from QUL (Tarteel) and Quran Foundation.',
    ar: 'خطوط عناوين السور والزخارف وأسماء السور من المكتبة القرآنية الشاملة (ترتيل) و Quran Foundation.',
  },
  licence: {
    en: '© KFGQPC; QUL and Quran Foundation terms, within the app only',
    ar: '© مجمع الملك فهد؛ وفق شروط المكتبة القرآنية الشاملة و Quran Foundation وداخل التطبيق فقط',
  },
  url: 'https://qul.tarteel.ai',
}

const UI_FONTS: AttributionEntry = {
  id: 'ui-fonts',
  name: {
    en: 'Inter, Noto Naskh Arabic and IBM Plex Sans Arabic',
    ar: 'Inter و Noto Naskh Arabic و IBM Plex Sans Arabic',
  },
  credit: {
    en: 'The interface typefaces, packaged by Fontsource.',
    ar: 'خطوط الواجهة، بحزم Fontsource.',
  },
  licence: { en: 'SIL Open Font License 1.1', ar: 'رخصة SIL للخطوط المفتوحة 1.1' },
  url: 'https://fontsource.org',
  licenceUrl: 'https://openfontlicense.org',
}

const QURANICAUDIO: AttributionEntry = {
  id: 'quranicaudio',
  name: { en: 'QuranicAudio.com', ar: 'QuranicAudio.com' },
  credit: {
    en: 'The recitations, streamed and cached on this computer for your own listening.',
    ar: 'التلاوات، تُبَثّ وتُحفَظ مؤقتًا على هذا الحاسوب لاستماعك الشخصي.',
  },
  licence: { en: 'Free for personal, non-commercial use', ar: 'مجانية للاستخدام الشخصي غير التجاري' },
  url: 'https://quranicaudio.com',
}

const QF_TIMINGS: AttributionEntry = {
  id: 'qf-timings',
  name: { en: 'Quran Foundation (Quran.com)', ar: 'Quran Foundation (Quran.com)' },
  credit: {
    en: 'Ayah and word timings for follow-along highlighting.',
    ar: 'توقيتات الآيات والكلمات لتظليل التلاوة أثناء الاستماع.',
  },
  licence: {
    en: 'Quran Foundation terms (refreshed at least every 7 days)',
    ar: 'شروط Quran Foundation (تُحدَّث كل ٧ أيام على الأكثر)',
  },
  url: 'https://quran.foundation',
}

/** The sources credited whatever is installed, by group (the pack groups start empty; the app's group is separate). */
export const attributions: readonly AttributionGroup[] = [
  { id: 'text', entries: [QUL, KFGQPC, TANZIL] },
  { id: 'fonts', entries: [HAFS_FONT, PRINT_LABELS_FONT, QCF_FONTS, ORNAMENT_FONTS, UI_FONTS] },
  { id: 'translations', entries: [] },
  { id: 'tafsir', entries: [] },
  { id: 'wbw', entries: [] },
  { id: 'recitations', entries: [QURANICAUDIO, QF_TIMINGS] },
]

// --- pack sources -------------------------------------------------------------------------------------------------

/** Arabic licence lines for the catalogue's sources, keyed by the attribution URL's host (the catalogue's are English). */
const LICENCE_BY_HOST: Readonly<Record<string, L10nText>> = {
  'quranenc.com': {
    en: 'QuranEnc terms: republished unmodified, credited with its version, kept up to date',
    ar: 'شروط موسوعة القرآن الكريم: يُعاد نشرها دون تعديل، مع ذكر إصدارها، وتُحدَّث دائمًا',
  },
  'quran.com': {
    en: 'Quran Foundation terms (cached in the app for at most 7 days, then refreshed)',
    ar: 'شروط Quran Foundation (تُحفَظ في التطبيق ٧ أيام على الأكثر ثم تُحدَّث)',
  },
  'quran.foundation': {
    en: 'Quran Foundation terms',
    ar: 'شروط Quran Foundation',
  },
  'quranicaudio.com': {
    en: 'Free for personal, non-commercial use',
    ar: 'مجانية للاستخدام الشخصي غير التجاري',
  },
  'github.com': {
    en: 'SIL Open Font License 1.1',
    ar: 'رخصة SIL للخطوط المفتوحة 1.1',
  },
}

/** The host of an https URL without `www.`, or null. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

/** Whether a URL may be opened from the About screen (`system_open_external` accepts https only, §5.13). */
export function isOpenableUrl(url: string | undefined): url is string {
  return url !== undefined && hostOf(url) !== null
}

/**
 * The licence line of a catalogue attribution in both UI languages. English is always the catalogue's own line; the
 * Arabic line is a translation for the hosts this module knows, else the catalogue's English line.
 */
export function packLicence(p: PackInfo): L10nText {
  const raw = p.attribution.licence.trim()
  const host = hostOf(p.attribution.url)
  const known = host === null ? undefined : LICENCE_BY_HOST[host]
  // Only the Noto font is credited through github.com; any other repository keeps the catalogue's line.
  const usable = known && (host !== 'github.com' || /open font licen[cs]e/i.test(raw)) ? known : undefined
  return { en: raw || (usable?.en ?? ''), ar: usable?.ar ?? raw }
}

/** The entry of a pack (its catalogue attribution, version and language). */
export function packAttribution(p: PackInfo): AttributionEntry {
  const version = installedVersion(p)
  return {
    id: p.id,
    name: p.title,
    credit: p.attribution.text,
    licence: packLicence(p),
    url: p.attribution.url,
    ...(version !== null ? { version } : {}),
    ...(p.language ? { language: p.language } : {}),
  }
}

/** The version of the pack on disk: the installed one (also while an update is offered), else the catalogue's. */
function installedVersion(p: PackInfo): string | null {
  if (p.state.type === 'installed') return p.state.data.version
  if (p.state.type === 'update_available') return p.state.data.installed
  return p.version || null
}

function installed(p: PackInfo): boolean {
  return p.state.type === 'installed' || p.state.type === 'update_available'
}

/** Some of the pack is on disk (an installed whole pack, or items of an on-demand pack). */
function hasContent(p: PackInfo): boolean {
  if (installed(p)) return true
  if (p.state.type === 'partial' || p.state.type === 'paused') return p.state.data.itemsPresent > 0
  return p.installedKib > 0
}

/** Which packs are credited, and where: what is on disk, in the group of its kind. */
function creditedPacks(packs: readonly PackInfo[], kind: PackKind): PackInfo[] {
  return packs.filter((p) => p.kind === kind && (p.installMode === 'whole' ? installed(p) : hasContent(p)))
}

export interface AttributionInput {
  /** The catalogue with each pack's state (`packs.list`). */
  packs: readonly PackInfo[]
  /** `AppInfo.core.source`: `qul` (release) or `qdc` (development data, credited separately). */
  coreSource: string
}

/**
 * Every attribution group in display order (§9.7): the app, the static sources, plus each installed translation and tafsir
 * with its version and link, the word-by-word packs that have content, and the Urdu Nastaliq font once installed.
 * Groups keep their place when empty (translations and tafsir say what will appear there); the word-by-word group
 * is left out until a pack has content.
 */
export function attributionGroups({ packs, coreSource }: AttributionInput): AttributionGroup[] {
  const byId = new Map([APP_GROUP, ...attributions].map((g) => [g.id, g] as const))
  const groups: AttributionGroup[] = []
  for (const id of ATTRIBUTION_GROUPS) {
    const entries = [...(byId.get(id)?.entries ?? [])]
    switch (id) {
      case 'app':
        break
      case 'text': {
        // The source core.db was built from: QUL for a release build, the Quran.com API for a development one.
        const qul = entries.findIndex((e) => e.id === QUL.id)
        if (coreSource !== 'qul' && qul >= 0) entries.splice(qul, 1)
        if (coreSource === 'qdc') entries.unshift(QDC_DEV)
        break
      }
      case 'fonts':
        for (const p of packs) {
          if (p.kind === 'decor' && p.id !== 'decor' && installed(p)) entries.push(packAttribution(p))
        }
        break
      case 'translations':
        entries.push(...creditedPacks(packs, 'translation').map(packAttribution))
        break
      case 'tafsir':
        entries.push(...creditedPacks(packs, 'tafsir').map(packAttribution))
        break
      case 'wbw':
        entries.push(...creditedPacks(packs, 'wbw').map(packAttribution))
        if (entries.length === 0) continue
        break
      case 'recitations':
        break
    }
    groups.push({ id, entries })
  }
  return groups
}
