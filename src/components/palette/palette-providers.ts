/**
 * Command palette providers (§9.7). Owner: WP10c. Each provider turns the query into rows; `paletteResults` runs them
 * in the §9.7 order and groups the rows under their headings:
 *
 * | Provider | Rows |
 * |---|---|
 * | **Go to** | the references of §10.4 (`parseReference`): ayahs and ranges, pages, juz, hizb, surahs by number, "kahf 10"; out-of-range ones disabled with the reason |
 * | **Surahs** | surah names and aliases (`quran.surahMatches`: Arabic normalisation, transliteration variants, a small typo) |
 * | **Commands** | the shortcut registry (`shortcuts.defs`, with their key hints), plus the commands without a key (About) |
 * | **Settings** | every boolean `Settings` field as a toggle, and the options of theme, accent, language, reading mode, page mode and Mushaf style; labels from `settingsMeta` (WP12b), else the field name |
 * | **Reciters** | `player.reciters` by Arabic or Latin name and style |
 * | **Recent** | the reading-bookmark "Continue" row (§7.8 step 5) and the reading history |
 * | **Search** | "Search the Quran for …" (the sidebar Search tab) for text that is not a reference |
 *
 * With an empty query the palette shows Recent, then every command. A leading `>`, `#` or `@` narrows the palette to
 * commands and settings, surahs, or reciters (the scope chip), and lists everything of that kind while the rest is
 * empty.
 *
 * Every row carries its action (`run`). The palette closes first and runs it once the dialog has gone, so a command acts
 * on the reader as if its key had been pressed there; a jump to an ayah moves focus to the ayah (`movesFocus`, §7.4).
 */
import type { LucideIcon } from '@lucide/svelte'
import AArrowDown from '@lucide/svelte/icons/a-arrow-down'
import AArrowUp from '@lucide/svelte/icons/a-arrow-up'
import ALargeSmall from '@lucide/svelte/icons/a-large-small'
import ArrowDown from '@lucide/svelte/icons/arrow-down'
import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line'
import ArrowLeft from '@lucide/svelte/icons/arrow-left'
import ArrowLeftToLine from '@lucide/svelte/icons/arrow-left-to-line'
import ArrowRight from '@lucide/svelte/icons/arrow-right'
import ArrowRightToLine from '@lucide/svelte/icons/arrow-right-to-line'
import ArrowUp from '@lucide/svelte/icons/arrow-up'
import ArrowUpToLine from '@lucide/svelte/icons/arrow-up-to-line'
import AudioLines from '@lucide/svelte/icons/audio-lines'
import Bell from '@lucide/svelte/icons/bell'
import BookBookmark from '@lucide/svelte/icons/book-bookmark'
import BookOpen from '@lucide/svelte/icons/book-open'
import BookOpenText from '@lucide/svelte/icons/book-open-text'
import Bookmark from '@lucide/svelte/icons/bookmark'
import Brain from '@lucide/svelte/icons/brain'
import ChevronsDown from '@lucide/svelte/icons/chevrons-down'
import ChevronsLeft from '@lucide/svelte/icons/chevrons-left'
import ChevronsRight from '@lucide/svelte/icons/chevrons-right'
import ChevronsUp from '@lucide/svelte/icons/chevrons-up'
import CircleArrowLeft from '@lucide/svelte/icons/circle-arrow-left'
import CircleArrowRight from '@lucide/svelte/icons/circle-arrow-right'
import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy'
import Columns2 from '@lucide/svelte/icons/columns-2'
import Command from '@lucide/svelte/icons/command'
import Compass from '@lucide/svelte/icons/compass'
import Copy from '@lucide/svelte/icons/copy'
import Download from '@lucide/svelte/icons/download'
import Droplet from '@lucide/svelte/icons/droplet'
import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical'
import Eraser from '@lucide/svelte/icons/eraser'
import Expand from '@lucide/svelte/icons/expand'
import Eye from '@lucide/svelte/icons/eye'
import EyeOff from '@lucide/svelte/icons/eye-off'
import FastForward from '@lucide/svelte/icons/fast-forward'
import FileText from '@lucide/svelte/icons/file-text'
import Focus from '@lucide/svelte/icons/focus'
import GalleryHorizontalEnd from '@lucide/svelte/icons/gallery-horizontal-end'
import Gauge from '@lucide/svelte/icons/gauge'
import Headphones from '@lucide/svelte/icons/headphones'
import Highlighter from '@lucide/svelte/icons/highlighter'
import Info from '@lucide/svelte/icons/info'
import Keyboard from '@lucide/svelte/icons/keyboard'
import Languages from '@lucide/svelte/icons/languages'
import Layers from '@lucide/svelte/icons/layers'
import Layers2 from '@lucide/svelte/icons/layers-2'
import ListChecks from '@lucide/svelte/icons/list-checks'
import Maximize from '@lucide/svelte/icons/maximize'
import NotebookPen from '@lucide/svelte/icons/notebook-pen'
import Palette from '@lucide/svelte/icons/palette'
import PanelLeft from '@lucide/svelte/icons/panel-left'
import PanelRight from '@lucide/svelte/icons/panel-right'
import Play from '@lucide/svelte/icons/play'
import Redo2 from '@lucide/svelte/icons/redo-2'
import Repeat from '@lucide/svelte/icons/repeat'
import Repeat2 from '@lucide/svelte/icons/repeat-2'
import Rewind from '@lucide/svelte/icons/rewind'
import RotateCcwClock from '@lucide/svelte/icons/rotate-ccw-clock'
import ScanSearch from '@lucide/svelte/icons/scan-search'
import Search from '@lucide/svelte/icons/search'
import SettingsIcon from '@lucide/svelte/icons/settings'
import Signpost from '@lucide/svelte/icons/signpost'
import SkipBack from '@lucide/svelte/icons/skip-back'
import SkipForward from '@lucide/svelte/icons/skip-forward'
import Square from '@lucide/svelte/icons/square'
import SunMoon from '@lucide/svelte/icons/sun-moon'
import ToggleLeft from '@lucide/svelte/icons/toggle-left'
import ToggleRight from '@lucide/svelte/icons/toggle-right'
import Type from '@lucide/svelte/icons/type'
import Undo2 from '@lucide/svelte/icons/undo-2'
import Volume2 from '@lucide/svelte/icons/volume-2'
import ZoomIn from '@lucide/svelte/icons/zoom-in'
import ZoomOut from '@lucide/svelte/icons/zoom-out'
import { openTarget } from '$components/index/navigate'
import { settingsMeta } from '$components/settings/meta'
import type { ShortcutLabelKey, TextKey } from '$lib/contracts/i18n'
import { defaultSettings } from '$lib/contracts/settings'
import { SHORTCUT_GROUPS, type ShortcutDef, type ShortcutGroup } from '$lib/contracts/shortcuts'
import { isTextKey, translate } from '$lib/i18n'
import type { HistoryEntry, HistoryMode, ReciterInfo, Settings, SurahInfo } from '$lib/ipc/bindings'
import { chordAvailable, type Chord, tryParseChord, US_PUNCTUATION } from '$lib/shortcuts'
import { app, history, i18n, library, player, quran, reader, settings, shortcuts, ui } from '$lib/stores'
import { FOCUS_TARGETS } from '$lib/stores/ui.svelte'
import {
  describeTarget,
  listSeparator,
  type ParsedTarget,
  parseReference,
  targetKey,
} from '$lib/text/refparse'
import { field, type MarkRange, markRanges, type MatchField, queryTokens, score } from './match'

// ---------------------------------------------------------------------------------------------------------------------
// Types

export type ProviderId = 'goto' | 'surahs' | 'commands' | 'settings' | 'reciters' | 'recent' | 'search'

/** What the palette searches: everything, or one kind (the scope chip; prefixes `>`, `#`, `@`). */
export type PaletteScope = 'all' | 'commands' | 'surahs' | 'reciters'

/** The leading badge of a row (§9.7: "surah number in a rosette or a command icon"). */
export type PaletteBadge =
  | { kind: 'rosette'; n: number }
  /** `tone`: `on` for a switched-on toggle; `mirror` for directional icons that follow the UI direction. */
  | { kind: 'icon'; icon: LucideIcon; tone?: 'on'; mirror?: boolean }
  /** A highlight colour (`var(--user-hl-…-solid)`). */
  | { kind: 'swatch'; color: string }
  /** A reciter's initials (Latin UI) or first Arabic letter (Arabic UI, in Naskh). */
  | { kind: 'monogram'; text: string; arabic: boolean }
  /** The reading-bookmark ribbon. */
  | { kind: 'ribbon' }

export interface PaletteItem {
  /** Unique across the palette (`goto:ayah:2:255`, `surah:18`, `cmd:view.theme`, `setting:theme:night`). */
  id: string
  label: string
  /** Parts of `label` that match the query (emphasised; never inside Arabic). */
  marks?: readonly MarkRange[]
  /** Secondary text after the label. */
  detail?: string
  /** The detail is the reason the row is disabled. */
  reason?: boolean
  /** A surah's Arabic name at the inline end: the sura-names glyph when the decor font is loaded, else Naskh text. */
  arabic?: { text: string; surah: number }
  /** Shortcut labels (`shortcuts.format`), shown as keycaps at the inline end. */
  keys?: readonly string[]
  /** A short state at the inline end ("On", "Current"). */
  hint?: string
  /** `accent` marks an active state. */
  hintTone?: 'accent' | 'muted'
  badge: PaletteBadge
  disabled?: boolean
  /** The action moves focus to its target (a jump to an ayah, the search field); otherwise focus returns. */
  movesFocus?: boolean
  run: () => unknown
}

export interface PaletteGroup {
  id: ProviderId
  heading: string
  items: PaletteItem[]
}

export interface PaletteQuery {
  /** The text after the scope prefix, trimmed. */
  text: string
  /** Its folded words (`match.ts`). */
  tokens: string[]
  scope: PaletteScope
}

export interface PaletteProvider {
  id: ProviderId
  /** The scopes this provider answers in. */
  scopes: readonly PaletteScope[]
  search(q: PaletteQuery): PaletteItem[]
}

// ---------------------------------------------------------------------------------------------------------------------
// Scopes

/** The scope chip's order. */
export const SCOPES = ['all', 'commands', 'surahs', 'reciters'] as const satisfies readonly PaletteScope[]

/** Typing one of these first narrows the palette (VS Code's `>` for commands). */
export const SCOPE_PREFIXES: Readonly<Record<Exclude<PaletteScope, 'all'>, string>> = {
  commands: '>',
  surahs: '#',
  reciters: '@',
}

/** A leading scope prefix of the input: `{ scope: 'commands', rest: 'theme' }` for "> theme"; `scope` null if none. */
export function splitScope(input: string): { scope: PaletteScope | null; rest: string } {
  const trimmed = input.trimStart()
  for (const [scope, prefix] of Object.entries(SCOPE_PREFIXES) as [PaletteScope, string][]) {
    if (trimmed.startsWith(prefix)) return { scope, rest: trimmed.slice(prefix.length).trimStart() }
  }
  return { scope: null, rest: input }
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared helpers

/** The sura-names decor face (§8.5, §9.7). */
export const SURA_NAMES_FAMILY = 'qd-sura-names'

/**
 * The sura-names glyph of surah `n` (§9.7): the zero-padded decimal number read as hex, from U+E000 (`uniE001` …
 * `uniE114`; surah 10 is U+E010; U+E000 itself is "سورة").
 */
export function suraNameGlyph(n: number): string {
  return String.fromCodePoint(0xe000 + Number.parseInt(String(n).padStart(3, '0'), 16))
}

/** Rows shown at most per group in the "Everything" scope (scoped lists are not capped). */
export const GROUP_LIMITS: Readonly<Record<ProviderId, number>> = {
  goto: 5,
  surahs: 6,
  commands: 8,
  settings: 6,
  reciters: 4,
  recent: 4,
  search: 1,
}

/** Recent rows shown with an empty query (the Continue row and the latest history). */
export const RECENT_LIMIT = 5

/** The reading-bookmark row shows while the bookmark is more than this many pages from every page on screen (§7.8). */
const NEAR_PAGES = 2

/** First-strong isolate: a name in another script keeps its own direction inside a detail line (§11.3). */
const FSI = String.fromCodePoint(0x2068)
const PDI = String.fromCodePoint(0x2069)

/** Wraps text written in the other script than the UI's, so it never reorders the separators around it. */
export function isolate(text: string): string {
  return `${FSI}${text}${PDI}`
}

/** Heading of a group in the UI language. */
export function groupHeading(id: ProviderId): string {
  return i18n.t(`palette.groups.${id}`)
}

/** A row's label parts to emphasise (none for an empty query). */
function marksFor(label: string, q: PaletteQuery): MarkRange[] | undefined {
  if (q.tokens.length === 0) return undefined
  const ranges = markRanges(label, q.tokens)
  return ranges.length > 0 ? ranges : undefined
}

/** The fields of a group's own name, in the UI language and in English, so "settings" or "قراء" lists a group. */
function headingFields(id: ProviderId): MatchField[] {
  const key: TextKey = `palette.groups.${id}`
  return [field(i18n.t(key), 0.45), field(translate('en', key), 0.45)]
}

/** Sorts scored rows best first (stable for ties) and drops non-matches. */
function ranked(entries: readonly { item: PaletteItem; score: number }[]): PaletteItem[] {
  return entries
    .map((e, i) => ({ ...e, i }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((e) => e.item)
}

/** Runs an action, reporting a thrown error or a rejected promise as an error toast. */
export function runAction(action: () => unknown): void {
  try {
    const result = action()
    if (result instanceof Promise) result.catch((e: unknown) => ui.toastError(e))
  } catch (e) {
    ui.toastError(e)
  }
}

/** The page of an ayah in the reader's current layout. */
function pageInLayout(ayahId: number): number {
  return quran.isAyahId(ayahId) ? quran.pageOfAyah(reader.layout, ayahId) : 0
}

// ---------------------------------------------------------------------------------------------------------------------
// Go to (§10.4)

const TARGET_ICONS = { ayah: BookOpenText, page: FileText, juz: Layers, hizb: Layers2 } as const

/** A row that opens a parsed reference (`reason` disables it). */
export function targetItem(t: ParsedTarget, q: PaletteQuery, reason?: string): PaletteItem {
  const d = describeTarget(t, reader.layout)
  const disabled = reason !== undefined
  const surah = (t.type === 'surah' || t.type === 'ayah') && !disabled ? quran.surah(t.surah) : undefined
  const movesFocus = t.type !== 'page'
  return {
    id: `goto:${targetKey(t)}`,
    label: d.title,
    marks: marksFor(d.title, q),
    detail: reason ?? (d.detail || undefined),
    reason: disabled,
    disabled,
    badge:
      t.type === 'surah' ? { kind: 'rosette', n: t.surah } : { kind: 'icon', icon: TARGET_ICONS[t.type] },
    arabic: surah ? { text: surah.nameAr, surah: surah.id } : undefined,
    movesFocus,
    run: () => openTarget(t, { focus: movesFocus }),
  }
}

const gotoProvider: PaletteProvider = {
  id: 'goto',
  scopes: ['all'],
  search(q) {
    if (q.text === '') return []
    const out: PaletteItem[] = []
    const seen = new Set<string>()
    for (const r of parseReference(q.text, { nameLimit: 3 })) {
      // Bare surah names are the Surahs group's; names with an ayah ("kahf 10") are references.
      if (r.source === 'name' && r.target.type === 'surah') continue
      const key = targetKey(r.target)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(targetItem(r.target, q, r.disabledReason))
    }
    return out
  },
}

/** Whether the query is a reference the Go to group answers (then "Search the Quran for …" adds nothing). */
function isReference(text: string): boolean {
  return parseReference(text, { names: false }).length > 0
}

// ---------------------------------------------------------------------------------------------------------------------
// Surahs

/** A row that opens a surah. */
export function surahItem(s: SurahInfo, q: PaletteQuery): PaletteItem {
  const label = quran.surahName(s.id)
  const place = s.revelationPlace === 'makkah' ? i18n.t('common.meccan') : i18n.t('common.medinan')
  const other = i18n.locale === 'ar' ? isolate(s.nameSimple) : s.nameEn
  return {
    id: `surah:${s.id}`,
    label,
    marks: marksFor(label, q),
    detail: [other, place, i18n.tp('common.ayahCount', s.ayahCount)].join(listSeparator()),
    badge: { kind: 'rosette', n: s.id },
    arabic: { text: s.nameAr, surah: s.id },
    movesFocus: true,
    run: () => openTarget({ type: 'surah', surah: s.id }, { focus: true }),
  }
}

const surahsProvider: PaletteProvider = {
  id: 'surahs',
  scopes: ['all', 'surahs'],
  search(q) {
    const scoped = q.scope === 'surahs'
    if (q.text === '') return scoped ? quran.index.surahs.map((s) => surahItem(s, q)) : []
    const digits = q.tokens.length === 1 && /^\d+$/u.test(q.tokens[0] ?? '') ? Number(q.tokens[0]) : null
    if (digits !== null) {
      // "18" is the Go to group's (surah 18 and page 18); in the Surahs scope it is the surah.
      const s = scoped ? quran.surah(digits) : undefined
      return s ? [surahItem(s, q)] : []
    }
    return quran.surahMatches(q.text, scoped ? Number.POSITIVE_INFINITY : 12).map((s) => surahItem(s, q))
  },
}

// ---------------------------------------------------------------------------------------------------------------------
// Commands (the shortcut registry, §7.7)

/** Shortcuts that make no sense from the palette: the palette itself, Escape, and a key that acts while held. */
const EXCLUDED_COMMANDS: ReadonlySet<ShortcutLabelKey> = new Set<ShortcutLabelKey>([
  'shortcuts.app.palette',
  'shortcuts.app.escape',
  'shortcuts.memorize.peek',
])

const GROUP_ICONS: Readonly<Record<ShortcutGroup, LucideIcon>> = {
  navigation: Compass,
  view: Eye,
  audio: AudioLines,
  study: Bookmark,
  memorize: Brain,
  app: Command,
}

/**
 * Icons per shortcut label (the frozen `shortcuts.*` keys, so they hold whoever registers the definition). Page-turn
 * arrows follow the keys (← is the next page in a right-to-left book) and never mirror; history back/forward and the
 * panels follow the UI direction.
 */
const COMMAND_ICONS: Partial<Record<ShortcutLabelKey, LucideIcon | { icon: LucideIcon; mirror: true }>> = {
  'shortcuts.nav.nextPage': ArrowLeft,
  'shortcuts.nav.prevPage': ArrowRight,
  'shortcuts.nav.nextSurah': ChevronsLeft,
  'shortcuts.nav.prevSurah': ChevronsRight,
  'shortcuts.nav.firstPage': ArrowRightToLine,
  'shortcuts.nav.lastPage': ArrowLeftToLine,
  'shortcuts.nav.nextAyah': ArrowDown,
  'shortcuts.nav.prevAyah': ArrowUp,
  'shortcuts.nav.extendNext': ChevronsDown,
  'shortcuts.nav.extendPrev': ChevronsUp,
  'shortcuts.nav.firstAyahOnPage': ArrowUpToLine,
  'shortcuts.nav.lastAyahOnPage': ArrowDownToLine,
  'shortcuts.nav.pageRail': GalleryHorizontalEnd,
  'shortcuts.nav.back': { icon: CircleArrowLeft, mirror: true },
  'shortcuts.nav.forward': { icon: CircleArrowRight, mirror: true },
  'shortcuts.nav.goTo': Signpost,
  'shortcuts.nav.nextHit': ScanSearch,
  'shortcuts.nav.prevHit': ScanSearch,
  'shortcuts.app.search': Search,
  'shortcuts.app.shortcutSheet': Keyboard,
  'shortcuts.app.settings': SettingsIcon,
  'shortcuts.app.downloads': Download,
  'shortcuts.app.focusToasts': Bell,
  'shortcuts.app.undo': Undo2,
  'shortcuts.app.redo': Redo2,
  'shortcuts.view.readingMode': Languages,
  'shortcuts.view.pageMode': Columns2,
  'shortcuts.view.zoomIn': ZoomIn,
  'shortcuts.view.zoomOut': ZoomOut,
  'shortcuts.view.zoomFit': Expand,
  'shortcuts.view.uiScaleUp': AArrowUp,
  'shortcuts.view.uiScaleDown': AArrowDown,
  'shortcuts.view.uiScaleReset': ALargeSmall,
  'shortcuts.view.sidebar': { icon: PanelLeft, mirror: true },
  'shortcuts.view.sidePane': { icon: PanelRight, mirror: true },
  'shortcuts.view.tabIndex': BookOpen,
  'shortcuts.view.tabSearch': Search,
  'shortcuts.view.tabBookmarks': Bookmark,
  'shortcuts.view.tabHighlights': Highlighter,
  'shortcuts.view.tabNotes': NotebookPen,
  'shortcuts.view.tabHistory': RotateCcwClock,
  'shortcuts.view.tabMemorize': Brain,
  'shortcuts.view.theme': Palette,
  'shortcuts.view.fullscreen': Maximize,
  'shortcuts.view.zen': Focus,
  'shortcuts.audio.playPause': Play,
  'shortcuts.audio.nextAyah': SkipForward,
  'shortcuts.audio.prevAyah': SkipBack,
  'shortcuts.audio.seekForward': FastForward,
  'shortcuts.audio.seekBack': Rewind,
  'shortcuts.audio.repeat': Repeat,
  'shortcuts.audio.abLoop': Repeat2,
  'shortcuts.audio.faster': Gauge,
  'shortcuts.audio.slower': Gauge,
  'shortcuts.audio.muchFaster': Gauge,
  'shortcuts.audio.muchSlower': Gauge,
  'shortcuts.audio.normalSpeed': Gauge,
  'shortcuts.audio.mute': Volume2,
  'shortcuts.audio.stop': Square,
  'shortcuts.study.bookmark': Bookmark,
  'shortcuts.study.readingBookmark': BookBookmark,
  'shortcuts.study.removeHighlight': Eraser,
  'shortcuts.study.note': NotebookPen,
  'shortcuts.study.copy': Copy,
  'shortcuts.study.copySelection': ClipboardCopy,
  'shortcuts.study.copyWithTranslation': Languages,
  'shortcuts.study.openSidePane': { icon: PanelRight, mirror: true },
  'shortcuts.study.contextMenu': EllipsisVertical,
  'shortcuts.memorize.hide': EyeOff,
  'shortcuts.memorize.selfTest': ListChecks,
  'shortcuts.memorize.revealWord': Eye,
  'shortcuts.memorize.revealAyah': Eye,
}

/**
 * The commands people reach for first lead the list (an empty query shows every command); the rest follow in the
 * shortcut sheet's group order. Ties in a ranked list keep this order too.
 */
const COMMAND_PRIORITY: readonly ShortcutLabelKey[] = [
  'shortcuts.nav.goTo',
  'shortcuts.app.search',
  'shortcuts.audio.playPause',
  'shortcuts.view.readingMode',
  'shortcuts.study.bookmark',
  'shortcuts.study.readingBookmark',
  'shortcuts.study.note',
  'shortcuts.view.theme',
  'shortcuts.view.sidebar',
  'shortcuts.view.sidePane',
  'shortcuts.view.zen',
  'shortcuts.view.fullscreen',
  'shortcuts.app.settings',
  'shortcuts.app.downloads',
  'shortcuts.app.shortcutSheet',
]

/** The highlight shortcuts show their colour instead of an icon (§10.1 `Digit1`…`Digit5`). */
const HIGHLIGHT_SWATCHES: Partial<Record<ShortcutLabelKey, string>> = {
  'shortcuts.study.highlightYellow': 'var(--user-hl-yellow-solid)',
  'shortcuts.study.highlightGreen': 'var(--user-hl-green-solid)',
  'shortcuts.study.highlightBlue': 'var(--user-hl-blue-solid)',
  'shortcuts.study.highlightRed': 'var(--user-hl-red-solid)',
  'shortcuts.study.highlightPurple': 'var(--user-hl-purple-solid)',
}

function commandBadge(def: ShortcutDef): PaletteBadge {
  const swatch = HIGHLIGHT_SWATCHES[def.labelKey]
  if (swatch !== undefined) return { kind: 'swatch', color: swatch }
  const icon = COMMAND_ICONS[def.labelKey]
  if (icon === undefined) return { kind: 'icon', icon: GROUP_ICONS[def.group] }
  return 'mirror' in icon ? { kind: 'icon', icon: icon.icon, mirror: true } : { kind: 'icon', icon }
}

/** Whether a definition's scope can apply now (a reader command also runs from another view: it opens the reader). */
function scopeApplies(def: ShortcutDef): boolean {
  switch (def.scope) {
    case 'global':
    case 'reader':
      return true
    case 'mushaf':
      return settings.value.readingMode === 'mushaf'
    case 'translation':
      return settings.value.readingMode === 'translation'
  }
}

/** `def.when()`, with a throwing guard counting as "not now". */
function whenHolds(def: ShortcutDef): boolean {
  if (def.when === undefined) return true
  try {
    return def.when()
  } catch {
    return false
  }
}

/**
 * The key event a definition's first chord would produce on this platform, for `run(e)`: definitions may read the key
 * (a digit, Shift), and a few call `preventDefault()`.
 */
export function syntheticKeyEvent(def: ShortcutDef, isMac: boolean): KeyboardEvent {
  let chord: Chord | null = null
  for (const text of def.keys) {
    const c = tryParseChord(text)
    if (c !== null && chordAvailable(c, isMac)) {
      chord = c
      break
    }
  }
  if (chord === null) return new KeyboardEvent('keydown', { cancelable: true })
  let key = chord.key
  let code = chord.key
  let shift = chord.shift
  switch (chord.kind) {
    case 'named':
      key = chord.key === 'Space' ? ' ' : chord.key
      break
    case 'digit':
      key = chord.key.slice(-1)
      break
    case 'letter':
      key = shift ? chord.key.toUpperCase() : chord.key
      code = `Key${chord.key.toUpperCase()}`
      break
    case 'punct': {
      const us = US_PUNCTUATION[chord.key]
      code = us?.[0] ?? ''
      shift = shift || (us?.[1] ?? false)
      break
    }
  }
  return new KeyboardEvent('keydown', {
    key,
    code,
    ctrlKey: chord.ctrl || (chord.mod && !isMac),
    metaKey: chord.mod && isMac,
    altKey: chord.alt,
    shiftKey: shift,
    cancelable: true,
  })
}

/** Runs a shortcut's action from the palette: the reader first for reader commands, and only if it still applies. */
export function runShortcut(def: ShortcutDef): void {
  if (def.scope !== 'global' && ui.view !== 'reader') ui.setView('reader')
  if (!whenHolds(def)) return
  runAction(() => def.run(syntheticKeyEvent(def, app.isMac)))
}

interface CommandEntry {
  item: PaletteItem
  fields: MatchField[]
}

/** The commands available now — the priority commands first, then the sheet's group order — one per label. */
function commandEntries(q: PaletteQuery): CommandEntry[] {
  const defs: ShortcutDef[] = []
  const seen = new Set<ShortcutLabelKey>()
  const byGroup = shortcuts.byGroup
  for (const group of SHORTCUT_GROUPS) {
    for (const def of byGroup[group]) {
      if (EXCLUDED_COMMANDS.has(def.labelKey) || seen.has(def.labelKey)) continue
      if (!shortcuts.isAvailable(def) || !scopeApplies(def) || !whenHolds(def)) continue
      seen.add(def.labelKey)
      defs.push(def)
    }
  }
  const rank = (def: ShortcutDef) => {
    const i = COMMAND_PRIORITY.indexOf(def.labelKey)
    return i < 0 ? COMMAND_PRIORITY.length : i
  }
  const ordered = defs.map((def, i) => ({ def, i })).sort((a, b) => rank(a.def) - rank(b.def) || a.i - b.i)

  const out: CommandEntry[] = []
  for (const { def } of ordered) {
    const groupKey: TextKey = `shortcuts.groups.${def.group}`
    const label = i18n.t(def.labelKey)
    const keys = shortcuts.formatAll(def).slice(0, 1)
    out.push({
      item: {
        id: `cmd:${def.id}`,
        label,
        marks: marksFor(label, q),
        keys: keys.length > 0 ? keys : undefined,
        badge: commandBadge(def),
        run: () => runShortcut(def),
      },
      fields: [
        field(label),
        field(translate('en', def.labelKey), 0.9),
        field(i18n.t(groupKey), 0.5),
        field(translate('en', groupKey), 0.5),
      ],
    })
  }
  // Views without a key.
  const about = i18n.t('palette.commands.about')
  out.push({
    item: {
      id: 'cmd:palette.about',
      label: about,
      marks: marksFor(about, q),
      badge: { kind: 'icon', icon: Info },
      run: () => ui.setView('about'),
    },
    fields: [field(about), field(translate('en', 'palette.commands.about'), 0.9)],
  })
  return out
}

const commandsProvider: PaletteProvider = {
  id: 'commands',
  scopes: ['all', 'commands'],
  search(q) {
    const entries = commandEntries(q)
    if (q.text === '') return entries.map((e) => e.item)
    const heading = headingFields('commands')
    return ranked(entries.map((e) => ({ item: e.item, score: score(q.tokens, [...e.fields, ...heading]) })))
  },
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings (labels from `settingsMeta`, WP12b)

/** Boolean fields that are bookkeeping, not preferences. */
const INTERNAL_SETTINGS: ReadonlySet<string> = new Set(['closeToTrayAsked', 'onboardingDone'])

/** The settings the palette offers as one row per option, with their options in display order. */
export const SETTING_CHOICES = {
  theme: ['system', 'paper', 'sepia', 'night', 'black', 'high_contrast'],
  accent: ['teal', 'emerald', 'blue', 'indigo', 'rose', 'amber'],
  uiLanguage: ['en', 'ar'],
  mushafStyle: ['hafs', 'qcf_v2', 'qcf_v1', 'qcf_v4'],
  pageMode: ['auto', 'single', 'spread'],
  readingMode: ['mushaf', 'translation'],
} as const satisfies { [K in keyof Settings]?: readonly Settings[K][] }

type ChoiceKey = keyof typeof SETTING_CHOICES

/**
 * Extra words an option answers to (search keywords, never shown): what people call it in either language ("dark",
 * "Arabic", "1421", "داكن").
 */
const CHOICE_KEYWORDS: { [K in ChoiceKey]?: Partial<Record<(typeof SETTING_CHOICES)[K][number], string>> } = {
  theme: {
    system: 'auto automatic os النظام تلقائي',
    paper: 'light white فاتح',
    sepia: 'warm cream دافئ',
    night: 'dark داكن مظلم',
    black: 'dark oled amoled داكن مظلم',
    high_contrast: 'contrast accessibility تباين',
  },
  uiLanguage: {
    en: 'English إنجليزية انجليزي',
    ar: 'Arabic عربية عربي',
  },
  mushafStyle: {
    hafs: 'Hafs KFGQPC builtin',
    qcf_v2: 'QCF V2 1421 Madani print KFGQPC',
    qcf_v1: 'QCF V1 1405 Madani print KFGQPC',
    qcf_v4: 'QCF V4 tajweed colour color تجويد ملون',
  },
  pageMode: {
    spread: 'two pages double book صفحتين',
    single: 'one page صفحة',
  },
}

const CHOICE_ICONS: Readonly<Record<ChoiceKey, LucideIcon>> = {
  theme: SunMoon,
  accent: Droplet,
  uiLanguage: Languages,
  mushafStyle: Type,
  pageMode: Columns2,
  readingMode: BookOpenText,
}

function isChoiceKey(key: string): key is ChoiceKey {
  return Object.hasOwn(SETTING_CHOICES, key)
}

/** Every boolean preference, in `Settings` order. */
export function toggleKeys(): (keyof Settings)[] {
  const defaults = defaultSettings()
  return (Object.keys(defaults) as (keyof Settings)[]).filter(
    (k) => typeof defaults[k] === 'boolean' && !INTERNAL_SETTINGS.has(k),
  )
}

/** Words written in capitals when a field name is spelled out. */
const ACRONYMS: Readonly<Record<string, string>> = { ui: 'UI', wbw: 'WBW', id: 'ID', pct: '%', px: 'px' }

/** A field name spelled out: `showPageFrame` → "Show page frame", `wbwTooltip` → "WBW tooltip". */
export function humanizeField(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[\s_]+/u)
    .filter((p) => p !== '')
    .map((p) => ACRONYMS[p.toLowerCase()] ?? p.toLowerCase())
  const first = parts[0] ?? ''
  if (first !== '' && ACRONYMS[first.toLowerCase()] === undefined)
    parts[0] = first.charAt(0).toUpperCase() + first.slice(1)
  return parts.join(' ')
}

/** A text of `settingsMeta[key]` (`label`, `description`): an i18n key is translated, plain text used as is. */
function metaText(key: string, prop: 'label' | 'description'): string | null {
  const meta: unknown = (settingsMeta as Readonly<Record<string, unknown>>)[key]
  if (typeof meta !== 'object' || meta === null) return null
  const record = meta as Record<string, unknown>
  const names = prop === 'label' ? ['label', 'labelKey', 'title'] : ['description', 'descriptionKey', 'hint']
  for (const name of names) {
    let value = record[name]
    if (typeof value === 'function') value = (value as () => unknown)()
    if (typeof value !== 'string' || value.trim() === '') continue
    return isTextKey(value) ? i18n.t(value) : value
  }
  return null
}

/** The label of a settings field: `settingsMeta` (WP12b), else the field name spelled out (§9.7). */
export function settingLabel(key: string): string {
  return metaText(key, 'label') ?? humanizeField(key)
}

function onOff(on: boolean): string {
  return i18n.t(on ? 'common.on' : 'common.off')
}

/** Saves a settings patch from the palette and confirms it in a toast (the store reverts and reports a failure). */
function applySetting(patch: Partial<Settings>, confirmation: string): Promise<void> {
  return settings.update(patch).then((saved) => {
    if (saved) ui.toast({ message: confirmation })
  })
}

function toggleEntry(key: keyof Settings, q: PaletteQuery): { item: PaletteItem; fields: MatchField[] } {
  const on = settings.value[key] === true
  const label = settingLabel(key)
  const description = metaText(key, 'description') ?? undefined
  const english = humanizeField(key)
  return {
    item: {
      id: `setting:${key}`,
      label,
      marks: marksFor(label, q),
      detail: description,
      hint: onOff(on),
      hintTone: on ? 'accent' : 'muted',
      badge: { kind: 'icon', icon: on ? ToggleRight : ToggleLeft, tone: on ? 'on' : undefined },
      run: () =>
        applySetting(
          { [key]: !on } as Partial<Settings>,
          i18n.t('palette.settings.toggled', { setting: label, state: onOff(!on) }),
        ),
    },
    fields: [
      field(label),
      field(english, 0.85),
      ...(description === undefined ? [] : [field(description, 0.5)]),
    ],
  }
}

function choiceEntries(key: ChoiceKey, q: PaletteQuery): { item: PaletteItem; fields: MatchField[] }[] {
  const setting = settingLabel(key)
  const settingEn = humanizeField(key)
  const current: unknown = settings.value[key]
  const keywords: Partial<Record<string, string>> = CHOICE_KEYWORDS[key] ?? {}
  const options: readonly string[] = SETTING_CHOICES[key]
  return options.map((value) => {
    const valueKey = `palette.settings.values.${key}.${value}` as TextKey
    const valueLabel = i18n.t(valueKey)
    const label = i18n.t('palette.settings.choice', { setting, value: valueLabel })
    const selected = current === value
    const extra = keywords[value]
    return {
      item: {
        id: `setting:${key}:${value}`,
        label,
        marks: marksFor(label, q),
        hint: selected ? i18n.t('palette.settings.current') : undefined,
        hintTone: 'accent',
        badge: { kind: 'icon', icon: CHOICE_ICONS[key] },
        run: () => (selected ? undefined : applySetting({ [key]: value } as Partial<Settings>, label)),
      },
      fields: [
        field(label),
        field(`${settingEn} ${translate('en', valueKey)}`, 0.9),
        field(valueLabel, 0.8),
        ...(extra === undefined ? [] : [field(extra, 0.75)]),
      ],
    }
  })
}

/** Every settings row, in `Settings` field order. */
function settingEntries(q: PaletteQuery): { item: PaletteItem; fields: MatchField[] }[] {
  const toggles = new Set<string>(toggleKeys())
  const out: { item: PaletteItem; fields: MatchField[] }[] = []
  for (const key of Object.keys(defaultSettings()) as (keyof Settings)[]) {
    if (isChoiceKey(key)) out.push(...choiceEntries(key, q))
    else if (toggles.has(key)) out.push(toggleEntry(key, q))
  }
  return out
}

const settingsProvider: PaletteProvider = {
  id: 'settings',
  scopes: ['all', 'commands'],
  search(q) {
    if (q.text === '') return q.scope === 'commands' ? settingEntries(q).map((e) => e.item) : []
    const heading = headingFields('settings')
    return ranked(
      settingEntries(q).map((e) => ({ item: e.item, score: score(q.tokens, [...e.fields, ...heading]) })),
    )
  },
}

// ---------------------------------------------------------------------------------------------------------------------
// Reciters

/** Name particles skipped for Latin initials ("Mahmoud Khalil Al-Husary" → "MH"). */
const PARTICLES = /^(?:al|el|ad|ar|as|ash|at|az|an|bin|ibn|abu|abdul|abdel)$/iu

/** A reciter's monogram (§9.7 dock reciter cell): Latin initials in the English UI, the first Arabic letter in Arabic. */
export function monogram(r: ReciterInfo, locale: 'en' | 'ar'): { text: string; arabic: boolean } {
  if (locale === 'ar') {
    const letter = [...r.name.ar].find((ch) => /\p{L}/u.test(ch))
    if (letter !== undefined) return { text: letter, arabic: true }
  }
  const all = r.name.en.split(/[\s-]+/u).filter((w) => w !== '')
  const words = all.filter((w) => !PARTICLES.test(w))
  const pick = words.length > 0 ? words : all
  const first = pick[0]?.charAt(0) ?? ''
  const last = pick.length > 1 ? (pick.at(-1)?.charAt(0) ?? '') : ''
  return { text: `${first}${last}`.toUpperCase(), arabic: false }
}

function reciterEntry(r: ReciterInfo, q: PaletteQuery): { item: PaletteItem; fields: MatchField[] } {
  const locale = i18n.locale
  const label = r.name[locale] || r.name.en
  const style = r.style?.[locale] || (r.style?.en ? isolate(r.style.en) : undefined)
  const current = settings.value.reciterId === r.id
  const detail = [
    style,
    r.downloadedSurahs > 0 ? i18n.tp('palette.reciters.downloaded', r.downloadedSurahs) : undefined,
    r.wordLevel ? i18n.t('palette.reciters.wordTiming') : undefined,
  ].filter((p): p is string => p !== undefined && p !== '')
  return {
    item: {
      id: `reciter:${r.id}`,
      label,
      marks: marksFor(label, q),
      detail: detail.length > 0 ? detail.join(listSeparator()) : undefined,
      hint: current ? i18n.t('palette.reciters.current') : undefined,
      hintTone: 'accent',
      badge: { kind: 'monogram', ...monogram(r, locale) },
      run: () =>
        current
          ? undefined
          : player.setReciter(r.id).then(() => {
              ui.toast({ message: i18n.t('palette.reciters.chosen', { name: label }) })
            }),
    },
    fields: [
      field(label),
      field(locale === 'ar' ? r.name.en : r.name.ar, 0.95),
      field(`${r.style?.en ?? ''} ${r.style?.ar ?? ''}`, 0.5),
    ],
  }
}

const recitersProvider: PaletteProvider = {
  id: 'reciters',
  scopes: ['all', 'reciters'],
  search(q) {
    const entries = player.reciters.map((r) => reciterEntry(r, q))
    if (q.text === '') return q.scope === 'reciters' ? entries.map((e) => e.item) : []
    const heading = headingFields('reciters')
    return ranked(entries.map((e) => ({ item: e.item, score: score(q.tokens, [...e.fields, ...heading]) })))
  },
}

// ---------------------------------------------------------------------------------------------------------------------
// Recent (§7.8 step 5 and the history)

const MODE_ICONS: Readonly<Record<HistoryMode, LucideIcon>> = {
  read: BookOpen,
  listen: Headphones,
  memorize: Brain,
}

/** A jump to an ayah that moves focus there. */
function openAyah(ayahId: number): void {
  const { surah, ayah } = quran.ayahRef(ayahId)
  if (surah > 0) openTarget({ type: 'ayah', surah, ayah }, { focus: true })
}

/** The "Continue from reading bookmark" row, while the bookmark is away from the pages on screen (§7.8 step 5). */
export function continueItem(q: PaletteQuery): { item: PaletteItem; fields: MatchField[] } | null {
  const b = library.readingBookmark
  if (b === null || !quran.isAyahId(b.ayahId)) return null
  const page = b.layout === reader.layout ? b.page : pageInLayout(b.ayahId)
  if (page <= 0 || reader.visiblePages.some((p) => Math.abs(p - page) <= NEAR_PAGES)) return null
  const label = i18n.t('palette.recent.continue')
  const ref = quran.refLabel(b.ayahId, 'long')
  const s = quran.surah(quran.ayahRef(b.ayahId).surah)
  return {
    item: {
      id: 'recent:continue',
      label,
      marks: marksFor(label, q),
      detail: [ref, i18n.t('palette.pageShort', { page }), i18n.relTime(b.updatedAt)].join(listSeparator()),
      badge: { kind: 'ribbon' },
      movesFocus: true,
      run: () => openAyah(b.ayahId),
    },
    fields: [
      field(label),
      field(translate('en', 'palette.recent.continue'), 0.9),
      field(`${ref} ${s?.nameSimple ?? ''} ${s?.nameAr ?? ''}`, 0.8),
    ],
  }
}

/** History rows, newest first: one per place and mode, leaving out what is on screen now. */
export function historyEntries(q: PaletteQuery): { item: PaletteItem; fields: MatchField[] }[] {
  const out: { item: PaletteItem; fields: MatchField[] }[] = []
  const seen = new Set<string>()
  const visible = new Set(reader.visiblePages)
  const entries = [...history.entries].sort((a, b) => b.at - a.at || b.id - a.id)
  for (const e of entries) {
    if (!quran.isAyahId(e.ayahId)) continue
    const page = e.layout === reader.layout && e.page !== null ? e.page : pageInLayout(e.ayahId)
    if (visible.has(page)) continue
    const key = `${e.mode}:${page}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(historyEntry(e, page, q))
  }
  return out
}

function historyEntry(
  e: HistoryEntry,
  page: number,
  q: PaletteQuery,
): { item: PaletteItem; fields: MatchField[] } {
  const label = quran.refLabel(e.ayahId, 'long')
  const s = quran.surah(quran.ayahRef(e.ayahId).surah)
  const mode = i18n.t(`palette.recent.${e.mode}`)
  return {
    item: {
      id: `recent:${e.id}`,
      label,
      marks: marksFor(label, q),
      detail: [mode, i18n.t('palette.pageShort', { page }), i18n.relTime(e.at)].join(listSeparator()),
      badge: { kind: 'icon', icon: MODE_ICONS[e.mode] },
      movesFocus: true,
      run: () => openAyah(e.ayahId),
    },
    fields: [field(`${label} ${s?.nameSimple ?? ''} ${s?.nameAr ?? ''}`), field(mode, 0.6)],
  }
}

const recentProvider: PaletteProvider = {
  id: 'recent',
  scopes: ['all'],
  search(q) {
    const cont = continueItem(q)
    const rows = cont === null ? historyEntries(q) : [cont, ...historyEntries(q)]
    if (q.text === '') return rows.slice(0, RECENT_LIMIT).map((e) => e.item)
    return ranked(rows.map((e) => ({ item: e.item, score: score(q.tokens, e.fields) })))
  },
}

// ---------------------------------------------------------------------------------------------------------------------
// Search (full text, WP10b's sidebar tab)

const searchProvider: PaletteProvider = {
  id: 'search',
  scopes: ['all'],
  search(q) {
    if ([...q.text].length < 2 || isReference(q.text)) return []
    const query = q.text
    return [
      {
        id: 'search',
        label: i18n.t('palette.search.item', { query: isolate(query) }),
        badge: { kind: 'icon', icon: Search },
        movesFocus: true,
        run: () => {
          ui.navigate({ type: 'search', data: { query } })
          void ui.focusWhenRendered(FOCUS_TARGETS.search)
        },
      },
    ]
  },
}

// ---------------------------------------------------------------------------------------------------------------------
// The palette

/** Every provider, in the §9.7 order. */
export const providers: readonly PaletteProvider[] = [
  gotoProvider,
  surahsProvider,
  commandsProvider,
  settingsProvider,
  recitersProvider,
  recentProvider,
  searchProvider,
]

/** With an empty query in the "Everything" scope: where to pick up, then what can be done. */
const EMPTY_ORDER: readonly PaletteProvider[] = [recentProvider, commandsProvider]

/** Builds the query of an input in a scope. */
export function paletteQuery(text: string, scope: PaletteScope): PaletteQuery {
  const trimmed = text.trim()
  return { text: trimmed, tokens: queryTokens(trimmed), scope }
}

/**
 * The palette's groups for an input in a scope, in provider order, without empty groups and without a row twice. In
 * the "Everything" scope each group is capped (`GROUP_LIMITS`; `RECENT_LIMIT` for the Recent rows of an empty query),
 * except the command list of an empty query.
 */
export function paletteResults(text: string, scope: PaletteScope): PaletteGroup[] {
  const q = paletteQuery(text, scope)
  const order = q.text === '' && scope === 'all' ? EMPTY_ORDER : providers
  const groups: PaletteGroup[] = []
  const seen = new Set<string>()
  for (const provider of order) {
    if (!provider.scopes.includes(scope)) continue
    const limit =
      scope !== 'all' || (q.text === '' && provider.id === 'commands')
        ? Number.POSITIVE_INFINITY
        : q.text === '' && provider.id === 'recent'
          ? RECENT_LIMIT
          : GROUP_LIMITS[provider.id]
    const items: PaletteItem[] = []
    for (const item of provider.search(q)) {
      if (items.length >= limit) break
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
    if (items.length > 0) groups.push({ id: provider.id, heading: groupHeading(provider.id), items })
  }
  return groups
}

/** The example references of the empty state (§9.7: "Try 2:255, p 262, j 15, الكهف"), as typed in the UI language. */
export function exampleQueries(): string[] {
  const kahf = quran.surah(18)
  return [
    i18n.ref(2, 255),
    i18n.t('palette.pageShort', { page: 262 }),
    i18n.t('palette.juzShort', { juz: 15 }),
    // The other script than the UI's: Arabic names work in the English UI and Latin ones in the Arabic UI.
    (i18n.locale === 'ar' ? kahf?.nameSimple : kahf?.nameAr) ?? '',
  ].filter((s) => s !== '')
}
