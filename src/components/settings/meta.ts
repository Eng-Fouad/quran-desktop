/**
 * `settingsMeta`: where every `Settings` field lives in the Settings view, its label and description (i18n keys of the
 * `settings` domain), its search words and its range. Used by the Settings view (rows read their texts and ranges here)
 * and by the command palette (which translates `label` and `description`).
 *
 * - Every field of `Settings` has an entry; nested settings (`sidePane`, `sidebar`, `copy`) have one per sub-field in
 *   `fields`. The type makes a missing field a compile error, and `meta.test.ts` checks it at run time too.
 * - Ranges are the validated ranges of quran-types (`SETTING_LIMITS`), with the step a control moves by.
 * - Besides the fields, the view has a few rows that act (`SETTING_ACTIONS`: Clear cache, Reset all settings, …). Rows of
 *   both kinds are identified by a `RowId`: the field name, `sidePane.width`-style paths for nested fields, or the
 *   action id. `searchRows` finds rows by any word of their texts, in the UI language and in English.
 */
import { foldForMatch } from '$components/ui/filter'
import type { Locale, TextKey } from '$lib/contracts/i18n'
import { SETTING_LIMITS } from '$lib/contracts/settings'
import { lookup, translate } from '$lib/i18n'
import type { CopySettings, Settings, SidebarSettings, SidePaneSettings } from '$lib/ipc/bindings'

/** The Settings sections, in navigation order. */
export const SETTINGS_SECTIONS = [
  'appearance',
  'mushaf',
  'translations',
  'audio',
  'memorization',
  'language',
  'keyboard',
  'storage',
  'system',
  'about',
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** The groups (cards) inside the sections; each has a title at `settings.groups.<id>`. */
export const SETTINGS_GROUPS = [
  'theme',
  'display',
  'layout',
  'style',
  'pages',
  'furniture',
  'interaction',
  'wbw',
  'reading',
  'translations',
  'studyPane',
  'copy',
  'playback',
  'repeat',
  'followAlong',
  'hiding',
  'keys',
  'language',
  'shortcuts',
  'usage',
  'library',
  'streaming',
  'network',
  'window',
  'guidance',
  'reset',
  'app',
] as const

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

export interface SettingRange {
  min: number
  max: number
  /** What one step of the control moves (the validated value may be finer). */
  step: number
}

/** The unit a numeric value is shown in. */
export type SettingUnit = 'pct' | 'px' | 'mib' | 'speed' | 'count'

export interface SettingMeta {
  /** The row title (an i18n key; the palette translates it too). */
  label: TextKey
  /** The line under the title. */
  description?: TextKey
  /** Extra search words, never shown. */
  keywords?: TextKey
  section: SettingsSection
  group: SettingsGroup
  /** A dictionary group whose strings name the options (also searched): `settings.options.theme`. */
  options?: string
  /** The range of a numeric field. */
  range?: SettingRange
  unit?: SettingUnit
  /** Ranges of a field with several numeric forms (`gap`: fixed milliseconds or a percentage of the ayah). */
  ranges?: Readonly<Record<string, SettingRange>>
}

type NestedKey = 'sidePane' | 'sidebar' | 'copy'
type FlatKey = Exclude<keyof Settings, NestedKey>

/** A nested setting: its own title plus one entry per sub-field. */
export interface NestedSettingMeta<T> extends SettingMeta {
  fields: { readonly [K in keyof T & string]: SettingMeta }
}

export type SettingsMeta = { readonly [K in FlatKey]: SettingMeta } & {
  readonly sidePane: NestedSettingMeta<SidePaneSettings>
  readonly sidebar: NestedSettingMeta<SidebarSettings>
  readonly copy: NestedSettingMeta<CopySettings>
}

/** A row holding a setting: a flat field, or `parent.sub` for a nested one. */
export type SettingPath =
  | FlatKey
  | `sidePane.${keyof SidePaneSettings & string}`
  | `sidebar.${keyof SidebarSettings & string}`
  | `copy.${keyof CopySettings & string}`

/** Rows that act rather than hold a setting. */
export type SettingActionId =
  | 'clearCache'
  | 'downloads'
  | 'backupCreate'
  | 'backupRestore'
  | 'resetAll'
  | 'shortcuts'
  | 'about'
  | 'version'

export type RowId = SettingPath | SettingActionId

const L = SETTING_LIMITS

/** The texts of a flat field (`settings.fields.<name>.*`). */
function texts(name: string): Pick<SettingMeta, 'label' | 'description' | 'keywords'> {
  return {
    label: `settings.fields.${name}.label` as TextKey,
    description: `settings.fields.${name}.description` as TextKey,
    keywords: `settings.fields.${name}.keywords` as TextKey,
  }
}

function field(
  name: string,
  section: SettingsSection,
  group: SettingsGroup,
  extra: Partial<SettingMeta> = {},
): SettingMeta {
  return { ...texts(name), section, group, ...extra }
}

const options = (name: string): string => `settings.options.${name}`

export const settingsMeta: SettingsMeta = {
  // appearance
  theme: field('theme', 'appearance', 'theme', { options: options('theme') }),
  lightVariant: field('lightVariant', 'appearance', 'theme', { options: options('theme') }),
  darkVariant: field('darkVariant', 'appearance', 'theme', { options: options('theme') }),
  accent: field('accent', 'appearance', 'theme', { options: options('accent') }),
  uiScalePct: field('uiScalePct', 'appearance', 'display', {
    range: { min: L.uiScalePct.min, max: L.uiScalePct.max, step: L.uiScalePct.step },
    unit: 'pct',
  }),
  inkBrightnessPct: field('inkBrightnessPct', 'appearance', 'display', {
    range: { min: L.inkBrightnessPct.min, max: L.inkBrightnessPct.max, step: 1 },
    unit: 'pct',
  }),
  motion: field('motion', 'appearance', 'display', { options: options('motion') }),
  chromeEffect: field('chromeEffect', 'appearance', 'display'),
  // language
  uiLanguage: field('uiLanguage', 'language', 'language', { options: options('uiLanguage') }),
  digits: field('digits', 'language', 'language', { options: options('digits') }),
  // mushaf
  mushafStyle: field('mushafStyle', 'mushaf', 'style', { options: options('mushafStyle') }),
  tajweedColors: field('tajweedColors', 'mushaf', 'style'),
  ornateHeaders: field('ornateHeaders', 'mushaf', 'style'),
  pageMode: field('pageMode', 'mushaf', 'pages', { options: options('pageMode') }),
  zoomPct: field('zoomPct', 'mushaf', 'pages', {
    range: { min: L.zoomPct.min, max: L.zoomPct.max, step: L.zoomPct.step },
    unit: 'pct',
  }),
  showPageFrame: field('showPageFrame', 'mushaf', 'furniture'),
  showRunningHeads: field('showRunningHeads', 'mushaf', 'furniture'),
  showMarginMarkers: field('showMarginMarkers', 'mushaf', 'furniture'),
  highlightBookmarks: field('highlightBookmarks', 'mushaf', 'furniture'),
  hoverHighlight: field('hoverHighlight', 'mushaf', 'interaction'),
  ayahActionBar: field('ayahActionBar', 'mushaf', 'interaction'),
  pageTurnAnimation: field('pageTurnAnimation', 'mushaf', 'interaction'),
  wbwPackId: field('wbwPackId', 'mushaf', 'wbw'),
  wbwTooltip: field('wbwTooltip', 'mushaf', 'wbw'),
  wbwShowTransliteration: field('wbwShowTransliteration', 'mushaf', 'wbw'),
  // translations
  readingMode: field('readingMode', 'translations', 'reading', { options: options('readingMode') }),
  translationFontPct: field('translationFontPct', 'translations', 'reading', {
    range: { min: L.translationFontPct.min, max: L.translationFontPct.max, step: 10 },
    unit: 'pct',
  }),
  translationArabic: field('translationArabic', 'translations', 'reading'),
  footnotesInline: field('footnotesInline', 'translations', 'reading'),
  translations: field('translations', 'translations', 'translations', {
    range: { min: 0, max: L.maxTranslations, step: 1 },
    unit: 'count',
  }),
  tafsirPackId: field('tafsirPackId', 'translations', 'studyPane'),
  sidePane: {
    label: 'settings.fields.sidePane.label',
    section: 'translations',
    group: 'studyPane',
    fields: {
      open: sub('sidePane', 'open', 'translations', 'studyPane'),
      tab: sub('sidePane', 'tab', 'translations', 'studyPane', { options: options('sidePaneTab') }),
      follow: sub('sidePane', 'follow', 'translations', 'studyPane', { options: options('sidePaneFollow') }),
      widthPx: sub('sidePane', 'widthPx', 'translations', 'studyPane', {
        range: { min: L.sidePaneWidthPx.min, max: L.sidePaneWidthPx.max, step: 10 },
        unit: 'px',
      }),
      autoCollapseSidebar: sub('sidePane', 'autoCollapseSidebar', 'translations', 'studyPane'),
    },
  },
  copy: {
    label: 'settings.fields.copy.label',
    section: 'translations',
    group: 'copy',
    fields: {
      includeReference: sub('copy', 'includeReference', 'translations', 'copy'),
      referenceStyle: sub('copy', 'referenceStyle', 'translations', 'copy', {
        options: options('referenceStyle'),
      }),
      ayahNumbers: sub('copy', 'ayahNumbers', 'translations', 'copy'),
      translationPackId: sub('copy', 'translationPackId', 'translations', 'copy'),
    },
  },
  sidebar: {
    label: 'settings.fields.sidebar.label',
    section: 'appearance',
    group: 'layout',
    fields: {
      open: sub('sidebar', 'open', 'appearance', 'layout'),
      widthPx: sub('sidebar', 'widthPx', 'appearance', 'layout', {
        range: { min: L.sidebarWidthPx.min, max: L.sidebarWidthPx.max, step: 10 },
        unit: 'px',
      }),
      tab: sub('sidebar', 'tab', 'appearance', 'layout', { options: options('sidebarTab') }),
    },
  },
  // audio
  reciterId: field('reciterId', 'audio', 'playback'),
  speedPct: field('speedPct', 'audio', 'playback', {
    range: { min: L.speedPct.min, max: L.speedPct.max, step: L.speedPct.step },
    unit: 'speed',
  }),
  volumePct: field('volumePct', 'audio', 'playback', {
    range: { min: L.volumePct.min, max: L.volumePct.max, step: 1 },
    unit: 'pct',
  }),
  stopAt: field('stopAt', 'audio', 'playback', { options: options('stopAt') }),
  ayahRepeat: field('ayahRepeat', 'audio', 'repeat', {
    range: { min: L.repeat.min, max: L.repeat.max, step: 1 },
    unit: 'count',
  }),
  rangeRepeat: field('rangeRepeat', 'audio', 'repeat', {
    range: { min: L.repeat.min, max: L.repeat.max, step: 1 },
    unit: 'count',
  }),
  gap: field('gap', 'audio', 'repeat', {
    options: options('gap'),
    ranges: {
      fixedMs: { min: L.gapFixedMs.min, max: L.gapFixedMs.max, step: 500 },
      multiplierPct: { min: L.gapMultiplierPct.min, max: L.gapMultiplierPct.max, step: 25 },
    },
  }),
  followAlong: field('followAlong', 'audio', 'followAlong'),
  wordHighlight: field('wordHighlight', 'audio', 'followAlong'),
  announceRecitation: field('announceRecitation', 'audio', 'followAlong'),
  // memorization
  memoHideStyle: field('memoHideStyle', 'memorization', 'hiding', { options: options('memoHideStyle') }),
  memoRevealOnHover: field('memoRevealOnHover', 'memorization', 'hiding'),
  // storage
  streamCacheCapMib: field('streamCacheCapMib', 'storage', 'streaming', {
    range: { min: L.streamCacheCapMib.min, max: L.streamCacheCapMib.max, step: 1 },
    unit: 'mib',
  }),
  networkAllowed: field('networkAllowed', 'storage', 'network'),
  // system
  showTrayIcon: field('showTrayIcon', 'system', 'window'),
  closeToTray: field('closeToTray', 'system', 'window'),
  closeToTrayAsked: field('closeToTrayAsked', 'system', 'window'),
  onboardingDone: field('onboardingDone', 'system', 'guidance'),
  hintsSeen: field('hintsSeen', 'system', 'guidance'),
}

function sub(
  parent: NestedKey,
  name: string,
  section: SettingsSection,
  group: SettingsGroup,
  extra: Partial<SettingMeta> = {},
): SettingMeta {
  return { ...texts(`${parent}.${name}`), section, group, ...extra }
}

/** Rows that act (search finds them like the settings). */
export const SETTING_ACTIONS: { readonly [K in SettingActionId]: SettingMeta } = {
  shortcuts: action('shortcuts', 'keyboard', 'shortcuts'),
  clearCache: action('clearCache', 'storage', 'usage'),
  downloads: action('downloads', 'storage', 'usage'),
  backupCreate: action('backupCreate', 'storage', 'library'),
  backupRestore: action('backupRestore', 'storage', 'library'),
  resetAll: action('resetAll', 'system', 'reset'),
  version: action('version', 'about', 'app'),
  about: action('about', 'about', 'app'),
}

function action(name: SettingActionId, section: SettingsSection, group: SettingsGroup): SettingMeta {
  return {
    label: `settings.actions.${name}.label` as TextKey,
    description: `settings.actions.${name}.description` as TextKey,
    keywords: `settings.actions.${name}.keywords` as TextKey,
    section,
    group,
  }
}

const NESTED: readonly NestedKey[] = ['sidePane', 'sidebar', 'copy']

function isNestedKey(key: string): key is NestedKey {
  return (NESTED as readonly string[]).includes(key)
}

/** Every row id: each flat field, each nested sub-field, then the actions. */
export const ROW_IDS: readonly RowId[] = (() => {
  const ids: RowId[] = []
  for (const key of Object.keys(settingsMeta) as (keyof SettingsMeta)[]) {
    if (isNestedKey(key)) {
      for (const sub of Object.keys(settingsMeta[key].fields)) ids.push(`${key}.${sub}` as SettingPath)
    } else ids.push(key)
  }
  for (const id of Object.keys(SETTING_ACTIONS) as SettingActionId[]) ids.push(id)
  return ids
})()

/** The metadata of a row, or `undefined` for an unknown id. */
export function metaOf(id: string): SettingMeta | undefined {
  if (Object.hasOwn(SETTING_ACTIONS, id)) return SETTING_ACTIONS[id as SettingActionId]
  const [parent, child] = id.split('.')
  if (parent === undefined || !Object.hasOwn(settingsMeta, parent)) return undefined
  if (child === undefined) return isNestedKey(parent) ? undefined : settingsMeta[parent as FlatKey]
  if (!isNestedKey(parent)) return undefined
  const fields: Readonly<Record<string, SettingMeta>> = settingsMeta[parent].fields
  return Object.hasOwn(fields, child) ? fields[child] : undefined
}

/** The rows of a section, in `ROW_IDS` order. */
export function rowsOf(section: SettingsSection): RowId[] {
  return ROW_IDS.filter((id) => metaOf(id)?.section === section)
}

/** Every string under a dictionary group (option labels), in both shapes the dictionary uses. */
function strings(locale: Locale, path: string): string[] {
  const node = lookup(locale, path)
  if (typeof node === 'string') return [node]
  if (typeof node !== 'object' || node === null) return []
  return Object.values(node).filter((v): v is string => typeof v === 'string')
}

/** The text a row is found by in one language: its title, description, keywords, options, group and section. */
export function searchText(id: RowId, locale: Locale): string {
  const meta = metaOf(id)
  if (!meta) return ''
  const parts = [
    translate(locale, meta.label),
    meta.description ? translate(locale, meta.description) : '',
    meta.keywords ? translate(locale, meta.keywords) : '',
    ...(meta.options ? strings(locale, meta.options) : []),
    translate(locale, `settings.groups.${meta.group}`),
    translate(locale, `settings.sections.${meta.section}.title`),
  ]
  return foldForMatch(parts.join('\n'))
}

/**
 * The rows matching `query`: every word of the query must occur in the row's text in the UI language or in English
 * (so "theme" still finds the Theme row in the Arabic UI). A blank query matches nothing.
 */
export function searchRows(query: string, locale: Locale): Set<RowId> {
  const tokens = foldForMatch(query).split(/\s+/u).filter(Boolean)
  const found = new Set<RowId>()
  if (tokens.length === 0) return found
  for (const id of ROW_IDS) {
    const local = searchText(id, locale)
    const english = locale === 'en' ? local : searchText(id, 'en')
    if (tokens.every((t) => local.includes(t) || english.includes(t))) found.add(id)
  }
  return found
}
