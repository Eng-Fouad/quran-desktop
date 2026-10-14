/**
 * The memo store on the browser mock: the hide class map (`isHidden`) with end markers kept, word and ayah reveals,
 * peeking, the memorisation keys (incl. the hold-to-peek release, a non-Latin layout and the self-test's mistake key),
 * random-start self-tests with their rating, progress (status, review, the overview and due runs, changes from
 * elsewhere) and loop presets; plus the pure schedule helpers.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '$lib/contracts/settings'
import { api, call, initIpc } from '$lib/ipc'
import type { Bootstrap, MemoProgress, Settings } from '$lib/ipc/bindings'
import { state } from '$lib/ipc/mock/state'
import { app } from './app.svelte'
import { history } from './history.svelte'
import { i18n } from './i18n.svelte'
import { resetStores } from './index'
import {
  AGAIN_S,
  BLANK_FILTER_ID,
  DAY_S,
  dueRanges,
  effectiveStatus,
  isDue,
  memo,
  schedule,
  suggestRating,
  summarize,
} from './memo.svelte'
import { player } from './player.svelte'
import { quran } from './quran.svelte'
import { reader } from './reader.svelte'
import { settings } from './settings.svelte'
import { shortcuts } from './shortcuts.svelte'
import { ui } from './ui.svelte'

/** The canvas at 1600 × 1000 with the sidebar open (a spread). */
const CANVAS: [number, number] = [1248, 960]

function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

async function boot(patch: Partial<Settings> = {}): Promise<Bootstrap> {
  stubMatchMedia()
  localStorage.clear()
  await initIpc()
  state.resetAll()
  state.loadAll()
  state.settings.set({ ...defaultSettings(), ...patch })
  const b = await call(api.appBootstrap())
  app.init(b)
  settings.init(b)
  i18n.init(b)
  quran.init(b)
  ui.init(b)
  shortcuts.init(b)
  history.init(b)
  reader.init(b)
  reader.setViewport(...CANVAS)
  memo.init(b)
  flushSync()
  return b
}

async function settle(ms = 120): Promise<void> {
  flushSync()
  await new Promise((resolve) => setTimeout(resolve, ms))
  flushSync()
}

/** A key event on the body, through the window listeners. `type` defaults to keydown. */
function press(key: string, init: KeyboardEventInit & { type?: string } = {}): KeyboardEvent {
  const code =
    init.code ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key.length === 1 ? undefined : key)
  const { type = 'keydown', ...rest } = init
  const e = new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, ...rest })
  document.body.dispatchEvent(e)
  flushSync()
  return e
}

/** Every word id of an ayah range, and which of them are ayah-end markers. */
function wordsOf(from: number, to: number): { ids: number[]; ends: Set<number> } {
  const ids: number[] = []
  const ends = new Set<number>()
  for (let a = from; a <= to; a++) {
    const first = quran.firstWordOf(a)
    const last = memo.lastWordOf(a)
    for (let w = first; w <= last; w++) ids.push(w)
    ends.add(last)
  }
  return { ids, ends }
}

/** The recitable words (end markers excluded) of a range, in order. */
function recitable(from: number, to: number): number[] {
  const { ids, ends } = wordsOf(from, to)
  return ids.filter((w) => !ends.has(w))
}

function progress(ayahId: number, patch: Partial<MemoProgress> = {}): MemoProgress {
  return {
    ayahId,
    status: 'learning',
    strength: 1,
    reviews: 1,
    lapses: 0,
    lastReviewedAt: 0,
    dueAt: null,
    ...patch,
  }
}

afterEach(() => {
  resetStores()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pure helpers', () => {
  it('schedules every strength and rating like the Leitner table', () => {
    for (let s = 0; s <= 5; s++) {
      expect(schedule(s, 1)).toEqual({ strength: Math.max(s - 2, 0), intervalS: AGAIN_S })
      expect(schedule(s, 2)).toEqual({ strength: Math.max(s, 1), intervalS: DAY_S })
      expect(schedule(s, 3)).toEqual({ strength: Math.min(s + 1, 5), intervalS: 2 ** s * DAY_S })
      expect(schedule(s, 4)).toEqual({ strength: Math.min(s + 2, 5), intervalS: 2 ** (s + 1) * DAY_S })
    }
    // Out-of-range strengths are clamped first.
    expect(schedule(9, 3)).toEqual({ strength: 5, intervalS: 32 * DAY_S })
    expect(schedule(-2, 3)).toEqual({ strength: 1, intervalS: DAY_S })
  })

  it('derives review for overdue memorised ayahs and knows what is due', () => {
    const now = 1_000_000
    expect(effectiveStatus(undefined, now)).toBe('new')
    expect(effectiveStatus(progress(1, { status: 'memorized', dueAt: now - 1 }), now)).toBe('review')
    expect(effectiveStatus(progress(1, { status: 'memorized', dueAt: now + 1 }), now)).toBe('memorized')
    expect(isDue(progress(1, { status: 'learning', dueAt: now }), now)).toBe(true)
    expect(isDue(progress(1, { status: 'learning', dueAt: now + 60 }), now)).toBe(false)
    expect(isDue(progress(1, { status: 'memorized', dueAt: now - 5 }), now)).toBe(true)
    expect(isDue(progress(1, { status: 'memorized', dueAt: null }), now)).toBe(false)
    expect(isDue(undefined, now)).toBe(false)
  })

  it('summarises a range from a sparse map, either way round', () => {
    const now = 1_000
    const map = new Map<number, MemoProgress>([
      [10, progress(10, { status: 'memorized', strength: 4, dueAt: now + 50 })],
      [11, progress(11, { status: 'memorized', strength: 4, dueAt: now - 50 })],
      [12, progress(12, { status: 'learning', dueAt: now - 1 })],
      [40, progress(40, { status: 'learning', dueAt: now + 1 })],
    ])
    const wide = summarize(map, 1, 100, now)
    expect(wide).toEqual({ total: 100, new: 96, learning: 2, memorized: 1, review: 1, due: 2 })
    // A small range walks the ids instead of the map.
    expect(summarize(map, 10, 12, now)).toEqual({
      total: 3,
      new: 0,
      learning: 1,
      memorized: 1,
      review: 1,
      due: 2,
    })
    expect(summarize(map, 5, 4, now).total).toBe(0)
  })

  it('groups due ayahs into runs inside one surah, most overdue first', () => {
    const now = 10_000
    const map = new Map<number, MemoProgress>()
    for (const id of [5, 6, 7, 8, 9]) map.set(id, progress(id, { dueAt: now - 100 }))
    map.set(20, progress(20, { dueAt: now - 5_000 }))
    map.set(21, progress(21, { dueAt: now + 5_000 })) // not due yet
    const surahOf = (id: number) => (id <= 7 ? 1 : 2) // a surah boundary between 7 and 8
    expect(dueRanges(map, now, surahOf)).toEqual([
      { from: 20, to: 20, dueAt: now - 5_000, count: 1 },
      { from: 5, to: 7, dueAt: now - 100, count: 3 },
      { from: 8, to: 9, dueAt: now - 100, count: 2 },
    ])
  })

  it('suggests an answer from hints and mistakes', () => {
    expect(suggestRating(0, 0, 120)).toBe(4)
    expect(suggestRating(1, 0, 10)).toBe(3)
    expect(suggestRating(2, 1, 100)).toBe(3)
    expect(suggestRating(2, 2, 40)).toBe(2)
    expect(suggestRating(2, 2, 20)).toBe(1)
    expect(suggestRating(10, 10, 50)).toBe(1)
  })
})

describe('hide mode', () => {
  it('hides every word of the range but the ayah-end markers, and nothing outside it', async () => {
    await boot()
    const from = quran.ayahId(3, 1)
    const to = quran.ayahId(3, 9)
    memo.startHide(to, from) // either order
    flushSync()
    expect(memo.active).toEqual({ from, to, mode: 'hide' })
    const { ids, ends } = wordsOf(from, to)
    for (const w of ids) expect(memo.isHidden(w), `word ${w}`).toBe(!ends.has(w))
    expect(memo.isHidden(quran.firstWordOf(from) - 1)).toBe(false)
    expect(memo.isHidden(memo.lastWordOf(to) + 1)).toBe(false)
    expect(memo.wordCounts).toEqual({ total: ids.length - ends.size, revealed: 0 })
  })

  it('reveals word by word over the markers, then the rest of an ayah, then reports the end', async () => {
    await boot()
    const from = quran.ayahId(3, 1)
    const to = quran.ayahId(3, 3)
    const words = recitable(from, to)
    memo.startHide(from, to)
    for (let i = 0; i < 3; i++) memo.revealNextWord()
    flushSync()
    expect(words.slice(0, 3).every((w) => !memo.isHidden(w))).toBe(true)
    expect(words.slice(3).every((w) => memo.isHidden(w))).toBe(true)
    expect(memo.wordCounts.revealed).toBe(3)

    // Shift+W: the rest of the ayah holding the next hidden word (its marker included).
    const ayah = quran.ayahOfWord(memo.nextHidden ?? 0)
    memo.revealNextAyah()
    flushSync()
    expect(memo.revealedThrough).toBe(memo.lastWordOf(ayah))
    expect(memo.nextHidden).toBe(quran.firstWordOf(ayah + 1))

    while (memo.nextHidden !== null) memo.revealNextWord()
    flushSync()
    expect(memo.wordCounts).toEqual({ total: words.length, revealed: words.length })
    memo.revealNextWord()
    expect(ui.announcement).toBe(i18n.t('memo.announce.allRevealed'))

    memo.restart()
    flushSync()
    expect(memo.wordCounts.revealed).toBe(0)
    expect(words.every((w) => memo.isHidden(w))).toBe(true)
  })

  it('peeks while held, and never outside a session', async () => {
    await boot()
    memo.peek(true)
    expect(memo.peeking).toBe(false)
    const from = quran.ayahId(3, 1)
    memo.startHide(from, from + 2)
    const word = recitable(from, from + 2)[1] ?? 0
    expect(memo.isHidden(word)).toBe(true)
    memo.peek(true)
    expect(memo.isHidden(word)).toBe(false)
    memo.peek(false)
    expect(memo.isHidden(word)).toBe(true)
  })

  it('mirrors the session onto <html> and installs the blank style’s filter only while needed', async () => {
    await boot({ memoHideStyle: 'blur', memoRevealOnHover: true })
    const root = document.documentElement
    expect(root.dataset.memo).toBeUndefined()
    memo.startHide(quran.ayahId(3, 1), quran.ayahId(3, 2))
    flushSync()
    expect(root.dataset.memo).toBe('hide')
    expect(root.dataset.memoStyle).toBe('blur')
    expect(root.dataset.memoHover).toBe('')
    expect(document.getElementById(BLANK_FILTER_ID)).toBeNull()

    await settings.update({ memoHideStyle: 'blank', memoRevealOnHover: false })
    flushSync()
    expect(root.dataset.memoStyle).toBe('blank')
    expect(root.dataset.memoHover).toBeUndefined()
    const filter = document.getElementById(BLANK_FILTER_ID)
    expect(filter?.tagName.toLowerCase()).toBe('filter')
    expect(filter?.querySelector('feFlood')).not.toBeNull()

    memo.stop()
    flushSync()
    expect(root.dataset.memo).toBeUndefined()
    expect(root.dataset.memoStyle).toBeUndefined()
    expect(document.getElementById(BLANK_FILTER_ID)).toBeNull()
  })

  it('ignores ranges outside the index and leaves translation mode for the Mushaf', async () => {
    await boot({ readingMode: 'translation' })
    memo.startHide(Number.NaN, 3)
    expect(memo.active).toBeNull()
    memo.startHide(9000, 9100) // clamped into the index
    flushSync()
    expect(memo.active).toEqual({ from: quran.ayahCount, to: quran.ayahCount, mode: 'hide' })
    expect(settings.value.readingMode).toBe('mushaf')
  })

  it('turns the page when a reveal lands on a page that is not on screen', async () => {
    await boot({ pageMode: 'single' })
    reader.setViewport(700, 960)
    flushSync()
    reader.goToPage(50, { transition: false })
    await settle()
    expect(reader.visiblePages).toEqual([50])
    const range = quran.pageRange('v2', 50)
    // Hide the page's last ayah and the next one: revealing past page 50 turns to 51.
    memo.startHide(range.to, range.to + 1)
    while (memo.nextHidden !== null && quran.pageOfWord('v2', memo.nextHidden) === 50) memo.revealNextWord()
    memo.revealNextWord()
    await settle(300)
    expect(reader.visiblePages).toEqual([51])
  })
})

describe('memorisation keys', () => {
  it('E hides the visible page(s) without a selection, the selection with one, and E again shows the text', async () => {
    await boot({ pageMode: 'spread' })
    reader.goToPage(50, { transition: false })
    await settle()
    const visible = reader.visibleRange
    expect(press('e').defaultPrevented).toBe(true)
    expect(memo.active).toEqual({ from: visible.from, to: visible.to, mode: 'hide' })
    press('e')
    expect(memo.active).toBeNull()

    const a = quran.ayahId(3, 2)
    reader.select(a)
    reader.select(a + 2, true)
    press('e')
    expect(memo.active).toEqual({ from: a, to: a + 2, mode: 'hide' })
  })

  it('W and Shift+W reveal while hiding, and pass through otherwise', async () => {
    await boot()
    reader.goToPage(50, { transition: false })
    await settle()
    expect(press('w').defaultPrevented).toBe(false)
    press('e')
    const before = memo.wordCounts.revealed
    press('w')
    expect(memo.wordCounts.revealed).toBe(before + 1)
    const ayah = quran.ayahOfWord(memo.nextHidden ?? 0)
    press('W', { shiftKey: true, code: 'KeyW' })
    expect(memo.revealedThrough).toBe(memo.lastWordOf(ayah))
    // Holding W repeats (key repeat is allowed for reveals).
    const n = memo.wordCounts.revealed
    press('w', { repeat: true })
    expect(memo.wordCounts.revealed).toBe(n + 1)
  })

  it('Q peeks until the same physical key is released, also on a non-Latin layout; a blur ends it too', async () => {
    await boot()
    reader.goToPage(50, { transition: false })
    await settle()
    press('e')
    press('q')
    expect(memo.peeking).toBe(true)
    press('w', { type: 'keyup' })
    expect(memo.peeking).toBe(true)
    press('q', { type: 'keyup' })
    expect(memo.peeking).toBe(false)

    // Arabic layout: the key that types ض sits where US has Q.
    press('ض', { code: 'KeyQ' })
    expect(memo.peeking).toBe(true)
    press('ض', { code: 'KeyQ', type: 'keyup' })
    expect(memo.peeking).toBe(false)

    press('q')
    window.dispatchEvent(new Event('blur'))
    expect(memo.peeking).toBe(false)
  })

  it('Shift+E opens the self-test for the selection, else the surah of the reading cursor', async () => {
    await boot()
    reader.goToAyah(quran.ayahId(67, 3))
    await settle(300)
    press('E', { shiftKey: true, code: 'KeyE' })
    expect(ui.topOverlay).toEqual(
      expect.objectContaining({
        kind: 'self-test',
        props: { fromAyahId: quran.ayahId(67, 1), toAyahId: quran.ayahId(67, 30) },
      }),
    )
    ui.close()
    reader.select(quran.ayahId(67, 5))
    reader.select(quran.ayahId(67, 8), true)
    press('E', { shiftKey: true, code: 'KeyE' })
    expect(ui.topOverlay?.props).toEqual({ fromAyahId: quran.ayahId(67, 5), toAyahId: quran.ayahId(67, 8) })
  })
})

describe('self-test', () => {
  it('starts at a random ayah of the range, jumps there and hides from it to the end', async () => {
    await boot()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const from = quran.ayahId(67, 1)
    const to = quran.ayahId(67, 30)
    expect(await memo.startTest(from, to)).toBe(true)
    flushSync()
    const start = from + 15
    expect(memo.test).toEqual(expect.objectContaining({ fromAyahId: from, toAyahId: to, startAyahId: start }))
    expect(memo.active).toEqual({ from: start, to, mode: 'test' })
    expect(reader.cursorAyahId).toBe(start)
    expect(memo.isHidden(quran.firstWordOf(start))).toBe(true)
    expect(memo.isHidden(quran.firstWordOf(start - 1))).toBe(false)
    expect(document.documentElement.dataset.memo).toBe('test')
    // No hover reveal in a test: every hint is counted.
    expect(document.documentElement.dataset.memoHover).toBeUndefined()
  })

  it('counts hints (W, Shift+W, a peek) and mistakes (M, never the mute), then rates the recited span', async () => {
    await boot()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const from = quran.ayahId(67, 1)
    const to = quran.ayahId(67, 4)
    await memo.startTest(from, to)
    await settle()
    press('w')
    press('W', { shiftKey: true, code: 'KeyW' })
    press('q')
    press('q', { type: 'keyup' })
    expect(memo.testReveals).toBe(3)

    const muted = player.muted
    const m = press('m')
    expect(m.defaultPrevented).toBe(true)
    expect(memo.testMistakes).toBe(1)
    expect(player.muted).toBe(muted)
    memo.addMistake()
    memo.undoMistake()
    expect(memo.testMistakes).toBe(1)

    // E during a test asks for the rating instead of showing the text.
    press('e')
    expect(ui.topOverlay?.kind).toBe('self-test')
    expect(memo.active?.mode).toBe('test')
    ui.close()

    const testId = memo.test?.id ?? 0
    expect(await memo.finishTest(3)).toBe(true)
    await settle()
    expect(memo.test).toBeNull()
    expect(memo.active).toBeNull()
    const stored = state.memo.value.tests.find((t) => t.id === testId)
    expect(stored).toEqual(expect.objectContaining({ reveals: 3, mistakes: 1, rating: 3 }))
    expect(stored?.finishedAt).not.toBeNull()
    // "Good" at strength 0: learning, strength 1, due in a day, for every ayah of [start, to].
    for (let id = from; id <= to; id++) {
      expect(memo.progress.get(id)).toEqual(expect.objectContaining({ status: 'learning', strength: 1 }))
    }
    expect(ui.toasts.at(-1)?.message).toContain(i18n.t('memo.rating.good'))
    // The history records a memorisation session at the start ayah.
    expect(state.user.value.history.some((h) => h.mode === 'memorize' && h.ayahId === from)).toBe(true)
  })

  it('keeps a test running when saving fails, and retries without finishing it twice', async () => {
    await boot()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    await memo.startTest(quran.ayahId(1, 1), quran.ayahId(1, 7))
    const review = vi.spyOn(api, 'memoReview').mockResolvedValueOnce({
      status: 'error',
      error: { kind: 'database', message: 'busy' },
    })
    expect(await memo.finishTest(2)).toBe(false)
    expect(memo.test).not.toBeNull()
    expect(ui.toasts.at(-1)?.tone).toBe('danger')
    const finish = vi.spyOn(api, 'memoTestFinish')
    expect(await memo.finishTest(2)).toBe(true)
    expect(finish).not.toHaveBeenCalled()
    expect(review).toHaveBeenCalledTimes(2)
    expect(await memo.finishTest(2)).toBe(false) // nothing runs any more
  })

  it('M outside a test, or in a text field, is not a mistake', async () => {
    await boot()
    press('m')
    expect(memo.testMistakes).toBe(0)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    await memo.startTest(quran.ayahId(1, 1), quran.ayahId(1, 7))
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', bubbles: true, cancelable: true }),
    )
    expect(memo.testMistakes).toBe(0)
    input.remove()
    memo.cancelTest()
    expect(memo.test).toBeNull()
    expect(memo.active).toBeNull()
  })
})

describe('progress', () => {
  it('marks, rates and resets ranges, merging the answers', async () => {
    await boot()
    const from = quran.ayahId(112, 1)
    const to = quran.ayahId(112, 4)
    expect(await memo.setStatus(from, to, 'memorized')).toBe(true)
    expect(memo.progress.get(from)).toEqual(expect.objectContaining({ status: 'memorized', strength: 4 }))
    expect(ui.toasts.at(-1)?.message).toContain('memorized')

    expect(await memo.rate(from, from, 1)).toBe(true)
    expect(memo.progress.get(from)).toEqual(
      expect.objectContaining({ status: 'learning', strength: 2, lapses: 1 }),
    )
    expect(memo.minStrength(from, to)).toBe(2)

    expect(await memo.setStatus(from, to, 'new')).toBe(true)
    expect(memo.progress.has(from)).toBe(false)
    expect(memo.progress.has(to)).toBe(false)
    expect(await memo.rate(from, to, 7)).toBe(false)
  })

  it('loads the whole Quran, summarises it, lists what is due, and follows changes made elsewhere', async () => {
    await boot()
    await call(api.memoSetStatus(quran.ayahId(78, 1), quran.ayahId(78, 40), 'memorized'))
    await call(api.memoSetStatus(quran.ayahId(18, 1), quran.ayahId(18, 10), 'review'))
    expect(await memo.loadAll()).toBe(true)
    expect(memo.loaded).toBe(true)
    expect(memo.overview).toEqual(
      expect.objectContaining({ total: quran.ayahCount, memorized: 40, review: 10, due: 10 }),
    )
    expect(memo.due).toEqual([
      expect.objectContaining({ from: quran.ayahId(18, 1), to: quran.ayahId(18, 10), count: 10 }),
    ])

    // Another surface (the context menu, the index) changes progress: the store re-reads the loaded span.
    await call(api.memoSetStatus(quran.ayahId(1, 1), quran.ayahId(1, 7), 'learning'))
    await settle(400)
    expect(memo.progress.get(quran.ayahId(1, 3))).toEqual(expect.objectContaining({ status: 'learning' }))
  })
})

describe('loop presets', () => {
  it('saves, lists by name, deletes with an undo, and plays a preset with its reciter, speed and repeats', async () => {
    await boot()
    const base = {
      id: null,
      reciterId: 3,
      fromAyahId: quran.ayahId(67, 1),
      toAyahId: quran.ayahId(67, 30),
      ayahRepeat: 3,
      rangeRepeat: 2,
      gap: { type: 'multiplier' as const, data: { pct: 100 } },
      speedPct: 125,
    }
    const b = await memo.savePreset({ ...base, name: 'b Mulk' })
    await memo.savePreset({ ...base, name: 'A Kahf' })
    expect(memo.presets.map((p) => p.name)).toEqual(['A Kahf', 'b Mulk'])
    expect(await memo.savePreset({ ...base, name: '   ' })).toBeNull()

    const play = vi.spyOn(player, 'playRange').mockResolvedValue()
    if (!b) throw new Error('not saved')
    await memo.applyPreset(b)
    expect(settings.value.reciterId).toBe(3)
    expect(settings.value.speedPct).toBe(125)
    expect(play).toHaveBeenCalledWith(base.fromAyahId, base.toAyahId, {
      ayahRepeat: 3,
      rangeRepeat: 2,
      gap: { type: 'multiplier', data: { pct: 100 } },
    })

    expect(await memo.deletePreset(b.id)).toBe(true)
    expect(memo.presets.map((p) => p.name)).toEqual(['A Kahf'])
    ui.toasts.at(-1)?.action?.run()
    await settle()
    expect(memo.presets.map((p) => p.name)).toEqual(['A Kahf', 'b Mulk'])
  })
})
