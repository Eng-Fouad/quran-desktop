/**
 * The command palette's providers (§9.7): Go to, Surahs, Commands, Settings toggles, Reciters, Recent and Search, the
 * scope prefixes, the group order and caps, and the actions the rows run. Runs over the synthetic index (the real Tanzil
 * metadata) with the stores set directly.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShortcutDef } from '$lib/contracts/shortcuts'
import { defaultSettings } from '$lib/contracts/settings'
import type { Bootstrap, HistoryEntry, QuranIndex, ReciterInfo } from '$lib/ipc/bindings'
import { syntheticIndex } from '$lib/ipc/mock/synthetic'
import { appShortcuts } from '$lib/shortcuts/app'
import { app } from '$lib/stores/app.svelte'
import { history } from '$lib/stores/history.svelte'
import { library } from '$lib/stores/library.svelte'
import { player } from '$lib/stores/player.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { shortcuts } from '$lib/stores/shortcuts.svelte'
import { ui } from '$lib/stores/ui.svelte'
import {
  continueItem,
  exampleQueries,
  GROUP_LIMITS,
  humanizeField,
  monogram,
  type PaletteGroup,
  type PaletteItem,
  paletteQuery,
  paletteResults,
  runShortcut,
  SETTING_CHOICES,
  settingLabel,
  splitScope,
  suraNameGlyph,
  syntheticKeyEvent,
  toggleKeys,
} from './palette-providers'

// A controlled `settingsMeta` (WP12b owns the real one): a plain label, an i18n key, and a description.
vi.mock('$components/settings/meta', () => ({
  settingsMeta: {
    showPageFrame: { label: 'Page frame', description: 'The gilded border around each page' },
    theme: { label: 'palette.groups.settings' },
    tajweedColors: { label: () => 'Tajweed colours' },
  },
}))

let index: QuranIndex

const RECITERS: ReciterInfo[] = [
  {
    id: 7,
    packId: 'audio.qdc.7',
    name: { en: 'Mishary Rashid Alafasy', ar: 'مشاري راشد العفاسي' },
    style: { en: 'Murattal', ar: 'مرتل' },
    wordLevel: true,
    sizeKib: 1_000_000,
    downloadedSurahs: 3,
    cachedSurahs: 0,
  },
  {
    id: 6,
    packId: 'audio.qdc.6',
    name: { en: 'Mahmoud Khalil Al-Husary', ar: 'محمود خليل الحصري' },
    style: null,
    wordLevel: false,
    sizeKib: 900_000,
    downloadedSurahs: 0,
    cachedSurahs: 0,
  },
]

function boot(lang: 'en' | 'ar' = 'en'): void {
  settings.value = { ...defaultSettings(), uiLanguage: lang, theme: 'paper', pageMode: 'single' }
  quran.init({ index } as unknown as Bootstrap)
  reader.reset()
  reader.page = 1
  player.reciters = RECITERS
}

const ids = (groups: PaletteGroup[]) => groups.map((g) => g.id)
const group = (groups: PaletteGroup[], id: string) => groups.find((g) => g.id === id)
const labels = (items: readonly PaletteItem[] | undefined) =>
  (items ?? []).map((i) => i.label.replace(/[\u2066-\u2069]/gu, ''))
const find = (groups: PaletteGroup[], id: string) =>
  groups.flatMap((g) => g.items).find((item) => item.id === id)

beforeAll(() => {
  index = syntheticIndex()
})

let unregister: (() => void) | null = null

beforeEach(() => {
  boot()
  unregister = shortcuts.register(appShortcuts)
})

afterEach(() => {
  unregister?.()
  unregister = null
  vi.restoreAllMocks()
  history.reset()
  library.reset()
  player.reset()
  reader.reset()
  ui.reset()
  quran.reset()
  settings.reset()
  app.reset()
})

describe('scopes and helpers', () => {
  it('reads a scope prefix', () => {
    expect(splitScope('> theme')).toEqual({ scope: 'commands', rest: 'theme' })
    expect(splitScope('#kahf')).toEqual({ scope: 'surahs', rest: 'kahf' })
    expect(splitScope('  @ husary')).toEqual({ scope: 'reciters', rest: 'husary' })
    expect(splitScope('2:255')).toEqual({ scope: null, rest: '2:255' })
    expect(splitScope('')).toEqual({ scope: null, rest: '' })
  })

  it('maps a surah to its sura-names glyph (§9.7: the padded number read as hex)', () => {
    expect(suraNameGlyph(1).codePointAt(0)).toBe(0xe001)
    expect(suraNameGlyph(10).codePointAt(0)).toBe(0xe010)
    expect(suraNameGlyph(99).codePointAt(0)).toBe(0xe099)
    expect(suraNameGlyph(114).codePointAt(0)).toBe(0xe114)
  })

  it('spells out a field name', () => {
    expect(humanizeField('showPageFrame')).toBe('Show page frame')
    expect(humanizeField('wbwTooltip')).toBe('WBW tooltip')
    expect(humanizeField('uiLanguage')).toBe('UI language')
    expect(humanizeField('theme')).toBe('Theme')
  })

  it('takes settings labels from settingsMeta, resolving i18n keys, else the field name', () => {
    expect(settingLabel('showPageFrame')).toBe('Page frame')
    expect(settingLabel('theme')).toBe('Settings')
    expect(settingLabel('tajweedColors')).toBe('Tajweed colours')
    expect(settingLabel('hoverHighlight')).toBe('Hover highlight')
  })

  it('offers examples in the UI language, the surah name in the other script', () => {
    const plain = (list: string[]) => list.map((s) => s.replace(/[\u2066-\u2069]/gu, ''))
    expect(plain(exampleQueries())).toEqual(['2:255', 'p 262', 'j 15', 'الكهف'])
    boot('ar')
    expect(plain(exampleQueries())).toEqual(['٢:٢٥٥', 'ص ٢٦٢', 'ج ١٥', 'Al-Kahf'])
  })
})

describe('Go to and Surahs', () => {
  it('answers "2:255" with one Go to row that moves focus to the ayah', () => {
    const groups = paletteResults('2:255', 'all')
    expect(ids(groups)).toEqual(['goto'])
    const row = groups[0]?.items[0]
    expect(row?.label.replace(/[\u2066-\u2069]/gu, '')).toBe(`${quran.surah(2)?.nameSimple} 2:255`)
    expect(row?.detail).toBe('Juz 3 · Page 42')
    expect(row?.arabic).toEqual({ text: 'البقرة', surah: 2 })
    expect(row?.movesFocus).toBe(true)
    expect(row?.badge.kind).toBe('icon')
    expect(row?.marks).toEqual([
      [11, 12],
      [13, 16],
    ])
  })

  it('answers a bare number with the surah and the page', () => {
    const groups = paletteResults('18', 'all')
    expect(group(groups, 'goto')?.items.map((i) => i.id)).toEqual(['goto:surah:18', 'goto:page:18'])
    expect(group(groups, 'goto')?.items[0]?.badge).toEqual({ kind: 'rosette', n: 18 })
    expect(group(groups, 'goto')?.items[1]?.movesFocus).toBe(false)
    expect(group(groups, 'surahs')).toBeUndefined()
    expect(group(groups, 'search')).toBeUndefined()
  })

  it('disables an out-of-range reference with its reason', () => {
    const row = paletteResults('p 700', 'all')[0]?.items[0]
    expect(row?.disabled).toBe(true)
    expect(row?.reason).toBe(true)
    expect(row?.detail).toMatch(/604/u)
  })

  it('lists surahs by name in both scripts, with a "kahf 10" reference', () => {
    const latin = paletteResults('kahf', 'all')
    expect(labels(group(latin, 'surahs')?.items)[0]).toBe('Al-Kahf')
    expect(group(latin, 'surahs')?.items[0]?.detail).toBe('The Cave · Meccan · 110 ayahs')
    expect(labels(group(latin, 'search')?.items)).toEqual(['Search the Quran for “kahf”'])
    expect(labels(group(paletteResults('الكهف', 'all'), 'surahs')?.items)[0]).toBe('Al-Kahf')
    const ref = paletteResults('kahf 10', 'all')
    expect(group(ref, 'goto')?.items[0]?.id).toBe('goto:ayah:18:10')
  })

  it('lists every surah in the Surahs scope, and a number as that surah', () => {
    expect(paletteResults('', 'surahs')[0]?.items).toHaveLength(114)
    expect(paletteResults('18', 'surahs')[0]?.items.map((i) => i.id)).toEqual(['surah:18'])
    expect(paletteResults('yasin', 'surahs')[0]?.items[0]?.id).toBe('surah:36')
  })

  it('names surahs in Arabic in the Arabic UI, the transliteration isolated in the detail', () => {
    boot('ar')
    const row = group(paletteResults('kahf', 'all'), 'surahs')?.items[0]
    expect(row?.label).toBe('الكهف')
    expect(row?.detail).toBe('\u2068Al-Kahf\u2069، مكية، ١١٠ آيات')
  })
})

describe('Commands', () => {
  it('lists the registered commands with their keys, the most used first, without the palette itself', () => {
    const groups = paletteResults('', 'all')
    expect(ids(groups)).toEqual(['commands'])
    const items = groups[0]?.items ?? []
    expect(items.length).toBeGreaterThan(GROUP_LIMITS.commands)
    expect(labels(items)).not.toContain('Command palette')
    expect(labels(items).some((l) => l.startsWith('Close'))).toBe(false)
    expect(labels(items).slice(0, 2)).toEqual(['Search', 'Cycle theme: paper, sepia, night, black'])
    const sidebar = items.find((i) => i.id === 'cmd:view.sidebar')
    expect(sidebar?.keys).toEqual(['Ctrl+B'])
    expect(sidebar?.badge).toMatchObject({ kind: 'icon', mirror: true })
    expect(labels(items)).toContain('About Quran')
  })

  it('ranks commands by the query and emphasises the match', () => {
    const items = group(paletteResults('sidebar', 'all'), 'commands')?.items ?? []
    const toggle = items.find((i) => i.id === 'cmd:view.sidebar')
    expect(toggle?.marks).toEqual([[17, 24]])
    expect(items.length).toBeLessThanOrEqual(GROUP_LIMITS.commands)
    // A whole-word match at the start of a short label ranks first.
    expect(labels(items)[0]).toBe('Sidebar: Index')
    expect(labels(group(paletteResults('hide sidebar', 'all'), 'commands')?.items)[0]).toBe(
      'Show or hide the sidebar',
    )
  })

  it('finds an Arabic command by its English words too', () => {
    boot('ar')
    const items = group(paletteResults('hide sidebar', 'all'), 'commands')?.items ?? []
    expect(items[0]?.id).toBe('cmd:view.sidebar')
    expect(items[0]?.label).toBe('إظهار الشريط الجانبي أو إخفاؤه')
    expect(items[0]?.marks).toBeUndefined()
    expect(group(paletteResults('الشريط', 'all'), 'commands')?.items.length ?? 0).toBeGreaterThan(0)
  })

  it('leaves out commands whose scope or condition does not hold, and runs reader commands in the reader', () => {
    const run = vi.fn()
    let allowed = false
    const defs: ShortcutDef[] = [
      {
        id: 'test.mushafOnly',
        keys: ['Shift+F2'],
        group: 'view',
        labelKey: 'shortcuts.view.zen',
        scope: 'mushaf',
        run,
      },
      {
        id: 'test.guarded',
        keys: ['Digit1'],
        group: 'study',
        labelKey: 'shortcuts.study.highlightYellow',
        scope: 'reader',
        when: () => allowed,
        run,
      },
    ]
    const off = shortcuts.register(defs)
    try {
      expect(find(paletteResults('zen', 'all'), 'cmd:test.mushafOnly')).toBeDefined()
      settings.value = { ...settings.value, readingMode: 'translation' }
      expect(find(paletteResults('zen', 'all'), 'cmd:test.mushafOnly')).toBeUndefined()

      expect(find(paletteResults('yellow', 'all'), 'cmd:test.guarded')).toBeUndefined()
      allowed = true
      const row = find(paletteResults('yellow', 'all'), 'cmd:test.guarded')
      expect(row?.badge).toEqual({ kind: 'swatch', color: 'var(--user-hl-yellow-solid)' })

      ui.setView('settings')
      row?.run()
      expect(ui.view).toBe('reader')
      expect(run).toHaveBeenCalledTimes(1)
      const event = run.mock.calls[0]?.[0] as KeyboardEvent
      expect(event.code).toBe('Digit1')
      expect(event.key).toBe('1')

      allowed = false
      runShortcut(defs[1] as ShortcutDef)
      expect(run).toHaveBeenCalledTimes(1)
    } finally {
      off()
    }
  })

  it('builds the key event of a chord for the platform', () => {
    const def = (keys: string[]): ShortcutDef => ({
      id: 't',
      keys,
      group: 'app',
      labelKey: 'shortcuts.app.search',
      scope: 'global',
      run: () => undefined,
    })
    const win = syntheticKeyEvent(def(['Mod+Shift+d']), false)
    expect([win.key, win.code, win.ctrlKey, win.metaKey, win.shiftKey]).toEqual([
      'D',
      'KeyD',
      true,
      false,
      true,
    ])
    const mac = syntheticKeyEvent(def(['Mod+k']), true)
    expect([mac.key, mac.code, mac.ctrlKey, mac.metaKey]).toEqual(['k', 'KeyK', false, true])
    const question = syntheticKeyEvent(def(['?']), false)
    expect([question.key, question.code, question.shiftKey]).toEqual(['?', 'Slash', true])
    expect(syntheticKeyEvent(def(['Space']), false).key).toBe(' ')
    expect(syntheticKeyEvent(def(['Mod+Ctrl+f', 'F11']), false).code).toBe('F11')
  })
})

describe('Settings', () => {
  it('offers every boolean preference, but not the bookkeeping ones', () => {
    const keys = toggleKeys()
    expect(keys).toContain('showPageFrame')
    expect(keys).toContain('networkAllowed')
    expect(keys).not.toContain('onboardingDone')
    expect(keys).not.toContain('closeToTrayAsked')
    const all = paletteResults('', 'commands')
    expect(ids(all)).toEqual(['commands', 'settings'])
    const settingRows = group(all, 'settings')?.items ?? []
    const choices = Object.values(SETTING_CHOICES).reduce((n, list) => n + list.length, 0)
    expect(settingRows).toHaveLength(keys.length + choices)
  })

  it('toggles a setting with its state and confirms it', async () => {
    const update = vi.spyOn(settings, 'update').mockResolvedValue(true)
    const toast = vi.spyOn(ui, 'toast').mockReturnValue(1)
    const row = group(paletteResults('page frame', 'all'), 'settings')?.items[0]
    expect(row?.label).toBe('Page frame')
    expect(row?.detail).toBe('The gilded border around each page')
    expect(row?.hint).toBe('On')
    expect(row?.hintTone).toBe('accent')
    await row?.run()
    expect(update).toHaveBeenCalledWith({ showPageFrame: false })
    expect(toast).toHaveBeenCalledWith({ message: 'Page frame: Off' })
  })

  it('finds a toggle by its field name when the label differs', () => {
    expect(group(paletteResults('show page', 'all'), 'settings')?.items[0]?.id).toBe('setting:showPageFrame')
  })

  it('offers the options of a choice, marking the current one', async () => {
    const update = vi.spyOn(settings, 'update').mockResolvedValue(true)
    vi.spyOn(ui, 'toast').mockReturnValue(1)
    const groups = paletteResults('night', 'all')
    const night = find(groups, 'setting:theme:night')
    expect(night?.label).toBe('Settings: Night')
    await night?.run()
    expect(update).toHaveBeenCalledWith({ theme: 'night' })
    const paper = find(paletteResults('paper', 'all'), 'setting:theme:paper')
    expect(paper?.hint).toBe('Current')
    update.mockClear()
    await paper?.run()
    expect(update).not.toHaveBeenCalled()
    expect(find(paletteResults('arabic', 'all'), 'setting:uiLanguage:ar')?.label).toBe('UI language: العربية')
    expect(find(paletteResults('dark', 'all'), 'setting:theme:night')).toBeDefined()
  })

  it('lists a whole group when the query names it', () => {
    const rows = group(paletteResults('settings', 'all'), 'settings')?.items ?? []
    expect(rows).toHaveLength(GROUP_LIMITS.settings)
    expect(group(paletteResults('reciters', 'all'), 'reciters')?.items).toHaveLength(RECITERS.length)
  })
})

describe('Reciters', () => {
  it('finds reciters by either name, marking the current one', () => {
    const rows = group(paletteResults('alafasy', 'all'), 'reciters')?.items ?? []
    expect(rows.map((r) => r.id)).toEqual(['reciter:7'])
    expect(rows[0]?.hint).toBe('Current')
    expect(rows[0]?.detail).toBe('Murattal · 3 surahs downloaded · Word highlighting')
    expect(rows[0]?.badge).toEqual({ kind: 'monogram', text: 'MA', arabic: false })
    expect(group(paletteResults('الحصري', 'all'), 'reciters')?.items[0]?.id).toBe('reciter:6')
    expect(paletteResults('', 'reciters')[0]?.items).toHaveLength(2)
  })

  it('switches the reciter and confirms it', async () => {
    const setReciter = vi.spyOn(player, 'setReciter').mockResolvedValue()
    const toast = vi.spyOn(ui, 'toast').mockReturnValue(1)
    const husary = find(paletteResults('husary', 'all'), 'reciter:6')
    await husary?.run()
    expect(setReciter).toHaveBeenCalledWith(6)
    expect(toast).toHaveBeenCalledWith({ message: 'Reciter: Mahmoud Khalil Al-Husary' })
  })

  it('draws monograms: Latin initials without particles, the first Arabic letter', () => {
    const [alafasy, husary] = RECITERS as [ReciterInfo, ReciterInfo]
    expect(monogram(husary, 'en')).toEqual({ text: 'MH', arabic: false })
    expect(monogram(alafasy, 'ar')).toEqual({ text: 'م', arabic: true })
  })
})

describe('Recent', () => {
  const now = Math.floor(Date.now() / 1000)
  const entry = (id: number, surah: number, ayah: number, mode: HistoryEntry['mode'], ago: number) => {
    const ayahId = quran.ayahId(surah, ayah)
    return {
      id,
      at: now - ago,
      mode,
      layout: 'v2',
      page: quran.pageOfAyah('v2', ayahId),
      ayahId,
      dwellS: 30,
    } satisfies HistoryEntry
  }

  it('shows the reading bookmark while it is away from the page on screen, and opens it', () => {
    const bookmark = {
      ayahId: quran.ayahId(18, 45),
      layout: 'v2' as const,
      page: 297,
      updatedAt: now - 3 * 86_400,
    }
    library.readingBookmark = bookmark
    const groups = paletteResults('', 'all')
    expect(ids(groups)).toEqual(['recent', 'commands'])
    const row = groups[0]?.items[0]
    expect(row?.label).toBe('Continue from reading bookmark')
    expect(row?.detail?.replace(/[\u2066-\u2069]/gu, '')).toBe('Al-Kahf 18:45 · p 297 · 3 days ago')
    expect(row?.badge).toEqual({ kind: 'ribbon' })
    const goToAyah = vi.spyOn(reader, 'goToAyah')
    row?.run()
    expect(goToAyah).toHaveBeenCalledWith(quran.ayahId(18, 45), { select: false, flash: true, focus: true })

    reader.page = 296
    expect(continueItem(paletteQuery('', 'all'))).toBeNull()
  })

  it('lists history newest first, once per place, without the page on screen', () => {
    history.entries = [
      entry(1, 67, 1, 'read', 86_400),
      entry(2, 36, 1, 'listen', 3_600),
      entry(3, 36, 2, 'listen', 3_500),
      entry(4, 1, 1, 'read', 60),
      entry(5, 2, 255, 'memorize', 2 * 86_400),
    ]
    const rows = group(paletteResults('', 'all'), 'recent')?.items ?? []
    expect(rows.map((r) => r.id)).toEqual(['recent:3', 'recent:1', 'recent:5'])
    expect(rows[0]?.detail).toBe('Listened · p 440 · 1 hour ago')
    expect(labels(group(paletteResults('mulk', 'all'), 'recent')?.items)).toEqual(['Al-Mulk 67:1'])
  })
})

describe('Search and the group order', () => {
  it('offers a full-text search for words, opening the sidebar search', () => {
    const navigate = vi.spyOn(ui, 'navigate').mockImplementation(() => undefined)
    vi.spyOn(ui, 'focusWhenRendered').mockResolvedValue(true)
    const row = find(paletteResults('mercy', 'all'), 'search')
    expect(row?.movesFocus).toBe(true)
    row?.run()
    expect(navigate).toHaveBeenCalledWith({ type: 'search', data: { query: 'mercy' } })
    expect(find(paletteResults('m', 'all'), 'search')).toBeUndefined()
    expect(find(paletteResults('p 262', 'all'), 'search')).toBeUndefined()
  })

  it('keeps the §9.7 provider order and caps each group in the Everything scope', () => {
    const groups = paletteResults('al', 'all')
    const order = ['goto', 'surahs', 'commands', 'settings', 'reciters', 'recent', 'search']
    const shown = ids(groups)
    expect([...shown].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(shown)
    for (const g of groups) expect(g.items.length).toBeLessThanOrEqual(GROUP_LIMITS[g.id])
    const all = groups.flatMap((g) => g.items.map((i) => i.id))
    expect(new Set(all).size).toBe(all.length)
  })

  it('narrows to commands and settings, surahs or reciters in a scope', () => {
    expect(ids(paletteResults('theme', 'commands'))).toEqual(['commands', 'settings'])
    expect(ids(paletteResults('kahf', 'surahs'))).toEqual(['surahs'])
    expect(ids(paletteResults('', 'reciters'))).toEqual(['reciters'])
  })
})
