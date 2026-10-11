/**
 * Memorisation in a real browser (§8.16, §8.18, §7.7, §11.3; WP9b), mounted in the real `App` on the browser mock:
 * hide mode on real pages (the class map, the blur and blank styles, reveal on hover, peeking with Q held), the
 * per-frame budget while revealing with W on a spread, the toolbar (keys keep working after a click, press-and-hold
 * Peek), the self-test from Shift+E to the rating (M counts a mistake, never mutes), the Memorize panel (range scopes, a
 * typed range, marking, the Mushaf map, presets) and the Arabic UI.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../../app.css'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import { api, call } from '$lib/ipc'
import { memo, player, quran, reader, settings } from '$lib/stores'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const plain = (text: string | null | undefined) =>
  (text ?? '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim()

async function until(done: () => boolean, timeout = 5_000, message = 'condition'): Promise<void> {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    flushSync()
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${message} not met within ${timeout} ms`)
}

/** Word spans of the visible pages' interactive renditions. */
function words(): HTMLElement[] {
  return $$('section.mp .mp-glyphs[data-interactive] .w')
}

function blurFocus(): void {
  ;(document.activeElement as HTMLElement | null)?.blur()
}

/** Boots the app on page 50 (a spread at 1600 × 1000, hafs) with the pointer parked off the pages. */
async function bootOn50(settingsPatch: Parameters<typeof bootApp>[0] = {}): Promise<void> {
  await bootApp({
    ...settingsPatch,
    settings: { mushafStyle: 'hafs', pageMode: 'spread', ...settingsPatch.settings },
  })
  reader.goToPage(50, { transition: false })
  await until(() => reader.visiblePages.includes(50) && words().length > 0, 5_000, 'page 50')
  await settle(200)
  await userEvent.hover(document.querySelector('.titlebar, header') ?? document.body)
  blurFocus()
}

afterEach(async () => {
  // Close what bits-ui keeps open (a tooltip under the pointer or on a focused button, a dialog's exit): unmounting the
  // app with one of them open leaves bits-ui's shared layer state behind, and a later dialog would then never give
  // <body> its pointer events back.
  blurFocus()
  await userEvent.hover(document.querySelector('.titlebar, header') ?? document.body)
  await settle(250)
  await until(() => document.body.style.pointerEvents !== 'none', 2_000, 'dialogs closed')
  resetApp()
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

describe('hide mode on the page (§8.16)', () => {
  it('E hides every word of the spread but the ayah markers; W and Shift+W reveal; E shows the text again', async () => {
    await bootOn50()
    await userEvent.keyboard('e')
    await until(() => $$('.w-hid').length > 0, 2_000, 'hidden')
    const all = words()
    const markers = all.filter((w) => w.classList.contains('e'))
    const recitable = all.filter((w) => !w.classList.contains('e'))
    expect(markers.length).toBeGreaterThan(0)
    expect(markers.every((w) => !w.classList.contains('w-hid'))).toBe(true)
    expect(recitable.every((w) => w.classList.contains('w-hid'))).toBe(true)

    const hidden = recitable[0] as HTMLElement
    const cs = getComputedStyle(hidden)
    expect(cs.filter).toMatch(/^blur\(/)
    expect(Number(cs.opacity)).toBeCloseTo(0.55, 2)
    expect(document.documentElement.dataset.memo).toBe('hide')

    await userEvent.keyboard('www')
    await until(() => memo.wordCounts.revealed === 3, 2_000, 'three reveals')
    const firstIds = recitable.slice(0, 3).map((w) => w.dataset.w)
    for (const id of firstIds) {
      expect($$(`.mp-glyphs .w[data-w="${id}"]`).every((w) => !w.classList.contains('w-hid'))).toBe(true)
    }
    expect(recitable[3]?.classList.contains('w-hid')).toBe(true)

    await userEvent.keyboard('{Shift>}w{/Shift}')
    await until(() => memo.wordCounts.revealed > 3, 2_000, 'the rest of the ayah')
    expect(plain($('[data-qd-memo-toolbar]')?.textContent)).toMatch(/\d+ of \d+ words/)

    await userEvent.keyboard('e')
    await until(() => $$('.w-hid').length === 0, 2_000, 'shown again')
    await until(() => $('[data-qd-memo-toolbar]') === null, 2_000, 'the toolbar leaves')
    expect(document.documentElement.dataset.memo).toBeUndefined()
  })

  it('holding Q peeks at every word; releasing it hides them again', async () => {
    await bootOn50()
    await userEvent.keyboard('e')
    await until(() => $$('.w-hid').length > 0)
    const count = $$('.w-hid').length
    await userEvent.keyboard('{q>}')
    await until(() => $$('.w-hid').length === 0, 2_000, 'peeking')
    expect(memo.peeking).toBe(true)
    await userEvent.keyboard('{/q}')
    await until(() => $$('.w-hid').length === count, 2_000, 'hidden again')
    expect(memo.peeking).toBe(false)
  })

  it('reveals a hidden word under the pointer (memoRevealOnHover), only while hiding', async () => {
    await bootOn50({ settings: { memoRevealOnHover: true } })
    await userEvent.keyboard('e')
    await until(() => $$('.w-hid').length > 0)
    const target = $$('.mp-glyphs[data-interactive] .w.w-hid')[10] as HTMLElement
    await userEvent.hover(target)
    await until(() => getComputedStyle(target).filter === 'none', 2_000, 'hover reveal')
    await settle(200)
    expect(Number(getComputedStyle(target).opacity)).toBeCloseTo(1, 2)
    await userEvent.hover(document.querySelector('.titlebar, header') ?? document.body)
    await until(() => getComputedStyle(target).filter.startsWith('blur('), 2_000, 'hidden again')
  })

  it('the blank style draws each hidden word as a rule (an SVG filter), whatever the glyph colours', async () => {
    await bootOn50({ settings: { memoHideStyle: 'blank' } })
    await userEvent.keyboard('e')
    await until(() => $$('.w-hid').length > 0)
    const hidden = $('.mp-glyphs[data-interactive] .w.w-hid') as HTMLElement
    expect(getComputedStyle(hidden).filter).toContain('qd-memo-blank')
    expect(document.getElementById('qd-memo-blank')?.tagName.toLowerCase()).toBe('filter')
    expect(getComputedStyle(hidden).opacity).toBe('1')
    // The rule: the hidden word's pixels hold only the --text-faint flood, not ink.
    await userEvent.keyboard('e')
    await until(() => document.getElementById('qd-memo-blank') === null, 2_000, 'filter removed')
  })

  it('stays within the frame budget while W reveals word after word on a spread (§8.18)', async () => {
    await bootOn50()
    await userEvent.keyboard('e')
    await until(() => $$('.w-hid').length > 0)
    await settle(300)

    /** One W keydown per animation frame (twice the OS key-repeat rate), for 90 frames. */
    const frames: number[] = []
    const work: number[] = []
    await new Promise<void>((resolve) => {
      let last = 0
      let n = 0
      const step = (t: number) => {
        if (last > 0) frames.push(t - last)
        last = t
        const start = performance.now()
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'w',
            code: 'KeyW',
            repeat: n > 0,
            bubbles: true,
            cancelable: true,
          }),
        )
        flushSync()
        // Style and layout of the changed words, as the frame would do them.
        void document.body.offsetHeight
        work.push(performance.now() - start)
        n += 1
        if (n < 90) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
    expect(memo.wordCounts.revealed).toBe(90)
    const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
    const p95 = (xs: number[]) => sorted(xs)[Math.floor(xs.length * 0.95)] ?? 0
    // The script, style and layout of a reveal is a small part of a frame…
    expect(p95(work)).toBeLessThan(8)
    // …and the frames keep coming at the display rate (≤ 16 ms of work each; one late frame of the
    // shared test runner is tolerated).
    const late = frames.filter((d) => d > 34).length
    expect(late).toBeLessThanOrEqual(1)
    expect(p95(frames)).toBeLessThan(20)
  })
})

describe('the hide-mode toolbar', () => {
  it('a click on Next word keeps the keys working; Peek reveals while held; × shows the text', async () => {
    await bootOn50()
    await userEvent.keyboard('e')
    await until(() => $('[data-qd-memo-toolbar]') !== null)
    const bar = $('[data-qd-memo-toolbar]') as HTMLElement
    expect(bar.getAttribute('role')).toBe('toolbar')
    await userEvent.click(bar.querySelector('[data-act="word"]') as HTMLElement)
    await until(() => memo.wordCounts.revealed === 1)
    expect(bar.contains(document.activeElement)).toBe(false)
    await userEvent.keyboard('w')
    await until(() => memo.wordCounts.revealed === 2, 2_000, 'W after a click')

    const peek = bar.querySelector('[data-act="peek"]') as HTMLElement
    const r = peek.getBoundingClientRect()
    peek.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: r.x + 4,
        clientY: r.y + 4,
      }),
    )
    await until(() => memo.peeking, 1_000, 'peek pressed')
    expect(peek.getAttribute('aria-pressed')).toBe('true')
    peek.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }))
    await until(() => !memo.peeking, 1_000, 'peek released')

    await userEvent.click(bar.querySelector('[data-act="style"]') as HTMLElement)
    await until(() => settings.value.memoHideStyle === 'blank', 2_000, 'style toggled')
    await userEvent.click(bar.querySelector('[data-act="stop"]') as HTMLElement)
    await until(() => memo.active === null && $('[data-qd-memo-toolbar]') === null, 2_000, 'stopped')
  })

  it('arrow keys move between its buttons (one tab stop), mirrored in the Arabic UI', async () => {
    await bootOn50({ settings: { uiLanguage: 'ar' } })
    await userEvent.keyboard('e')
    await until(() => $('[data-qd-memo-toolbar]') !== null)
    const bar = $('[data-qd-memo-toolbar]') as HTMLElement
    const stops = [...bar.querySelectorAll<HTMLElement>('[data-tb]')].filter((b) => b.tabIndex === 0)
    expect(stops).toHaveLength(1)
    ;(stops[0] as HTMLElement).focus()
    await userEvent.keyboard('{ArrowLeft}') // the next button in RTL
    expect((document.activeElement as HTMLElement).dataset.act).toBe('word')
    await userEvent.keyboard('{End}')
    expect((document.activeElement as HTMLElement).dataset.act).toBe('stop')
    expect(getComputedStyle(bar).direction).toBe('rtl')
  })
})

describe('the Memorize panel', () => {
  it('scopes the range, takes a typed one, hides and marks it, and draws the Mushaf map', async () => {
    await bootApp({
      settings: {
        mushafStyle: 'hafs',
        pageMode: 'spread',
        sidebar: { open: true, widthPx: 300, tab: 'memorize' },
      },
    })
    await call(api.memoSetStatus(quran.ayahId(78, 1), quran.ayahId(78, 40), 'memorized'))
    await call(api.memoSetStatus(quran.ayahId(18, 1), quran.ayahId(18, 10), 'review'))
    await until(() => $('[data-qd-memo-panel]') !== null)
    await until(() => memo.loaded && memo.due.length === 1, 3_000, 'progress loaded')
    // Memorised ayahs include the overdue ones (due for review): 40 + 10.
    expect(plain($('[data-qd-memo-panel] .overview')?.textContent)).toContain('50 ayahs memorized')

    // The Mushaf map: one square per page, the memorised ones shaded, the due one dotted.
    const cells = $$('[data-qd-heatmap] [data-page]')
    expect(cells).toHaveLength(quran.pageCount('v2'))
    const nabaPage = quran.pageOfAyah('v2', quran.ayahId(78, 1))
    expect($(`[data-qd-heatmap] [data-page="${nabaPage}"]`)?.className).toMatch(/\bl[34]\b/)
    expect(
      $(`[data-qd-heatmap] [data-page="${quran.pageOfAyah('v2', quran.ayahId(18, 1))}"]`)?.className,
    ).toMatch(/\bdue\b/)
    await userEvent.click($(`[data-qd-heatmap] [data-page="${nabaPage}"]`) as HTMLElement)
    await until(() => reader.visiblePages.includes(nabaPage), 3_000, 'the map opens the page')

    // A typed range.
    const input = $('[data-qd-memo-panel] input') as HTMLInputElement
    await userEvent.fill(input, '67')
    await until(
      () => plain($('[data-qd-memo-target]')?.textContent).includes('Al-Mulk'),
      2_000,
      'typed range',
    )
    expect(plain($('[data-qd-memo-target]')?.textContent)).toContain('30 ayahs')

    await userEvent.click($('[data-qd-memo-action="hide"]') as HTMLElement)
    await until(() => memo.active?.from === quran.ayahId(67, 1) && memo.active.to === quran.ayahId(67, 30))
    await until(() => plain($('[data-qd-memo-action="hide"]')?.textContent) === 'Show', 2_000, 'Show')
    await userEvent.click($('[data-qd-memo-action="hide"]') as HTMLElement)
    await until(() => memo.active === null)

    await userEvent.click($('[data-qd-memo-action="mark"]') as HTMLElement)
    await until(() => $('[role="menu"]') !== null)
    await userEvent.click(
      $$('[role="menuitem"]').find((m) => plain(m.textContent) === 'Memorized') as HTMLElement,
    )
    await until(() => memo.progress.get(quran.ayahId(67, 12))?.status === 'memorized', 2_000, 'marked')
    await until(
      () => plain($('[data-qd-memo-target]')?.textContent).includes('30 memorized'),
      2_000,
      'status bar',
    )
  })

  it('creates, plays and deletes a loop preset', async () => {
    await bootApp({
      settings: {
        mushafStyle: 'hafs',
        pageMode: 'spread',
        sidebar: { open: true, widthPx: 300, tab: 'memorize' },
      },
    })
    await until(() => $('[data-qd-memo-panel]') !== null)
    const input = $('[data-qd-memo-panel] input') as HTMLInputElement
    await userEvent.fill(input, '112')
    await until(() => plain($('[data-qd-memo-target]')?.textContent).includes('Al-Ikhlas'))
    await userEvent.click(
      $$('[data-qd-memo-panel] button').find((b) => plain(b.textContent) === 'New preset') as HTMLElement,
    )
    await until(() => $('[data-qd-preset-editor]') !== null)
    const name = $('[data-qd-preset-editor] input') as HTMLInputElement
    expect(plain(name.value)).toBe('Al-Ikhlas 112:1–4 ×3')
    await userEvent.click(
      $$('[data-qd-preset-editor] button').find((b) => plain(b.textContent) === 'Save preset') as HTMLElement,
    )
    await until(() => memo.presets.length === 1 && $('[data-qd-preset-editor]') === null, 2_000, 'saved')
    expect(memo.presets[0]).toEqual(
      expect.objectContaining({
        fromAyahId: quran.ayahId(112, 1),
        toAyahId: quran.ayahId(112, 4),
        ayahRepeat: 3,
      }),
    )

    const play = vi.spyOn(player, 'playRange').mockResolvedValue()
    await userEvent.click($('[data-preset] .play') as HTMLElement)
    await until(() => play.mock.calls.length === 1)
    expect(play).toHaveBeenCalledWith(
      quran.ayahId(112, 1),
      quran.ayahId(112, 4),
      expect.objectContaining({ ayahRepeat: 3 }),
    )

    await userEvent.click($('[data-preset] .more') as HTMLElement)
    await until(() => $('[role="menu"]') !== null)
    await userEvent.click(
      $$('[role="menuitem"]').find((m) => plain(m.textContent) === 'Delete') as HTMLElement,
    )
    await until(() => memo.presets.length === 0, 2_000, 'deleted')
  })

  it('lays the Mushaf map out right to left in the Arabic UI', async () => {
    await bootApp({
      settings: { uiLanguage: 'ar', sidebar: { open: true, widthPx: 300, tab: 'memorize' } },
    })
    await until(() => $$('[data-qd-heatmap] [data-page]').length > 0, 3_000, 'map')
    const first = ($('[data-qd-heatmap] [data-page="2"]') as HTMLElement).getBoundingClientRect()
    const later = ($('[data-qd-heatmap] [data-page="10"]') as HTMLElement).getBoundingClientRect()
    expect(first.left).toBeGreaterThan(later.left)
    expect(plain($('[data-qd-memo-panel] .head')?.textContent)).toBe('التقدم')
  })
})
