/**
 * Memorisation in a real browser (§8.16, §8.18, §7.7, §11.3; WP9b), mounted in the real `App` on the browser mock:
 * hide mode on real pages (the class map, the blur and blank styles, reveal on hover, peeking with Q held), the
 * per-frame budget while revealing with W on a spread, the toolbar (keys keep working after a click, press-and-hold
 * Peek), the self-test from Shift+E to the rating (M counts a mistake, never mutes), the Memorize panel (range scopes, a
 * typed range, marking, the Mushaf map, presets) and the Arabic UI.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, server, userEvent } from 'vitest/browser'
import '../../app.css'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import { api, call } from '$lib/ipc'
import { memo, player, quran, reader, settings } from '$lib/stores'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const plain = (text: string | null | undefined) =>
  (text ?? '').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim()

/**
 * Waits (real time) until `done()` holds, checked after every wait, the last one included: a long task (WebKit on Linux
 * paints in software, seconds at a time in CI) can keep the loop asleep past the deadline while the condition holds.
 */
async function until(done: () => boolean, timeout = 5_000, message = 'condition'): Promise<void> {
  const end = performance.now() + timeout
  for (;;) {
    flushSync()
    if (done()) return
    if (performance.now() >= end) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${message} not met within ${timeout} ms`)
}

/**
 * Playwright's WebKit on Linux paints CSS filters on the CPU (CI's runner has no GPU): a frame of the hidden spread takes
 * about a second there with the blur (300 spans under `blur()` on an empty page take 100–450 ms a frame; Chromium on the
 * same runner, 16.7 ms), about 50 ms with the blank style, mostly on the main thread, and every pointer action waits for
 * frames. There the tests hide with the blank style unless they are about the blur, hide mode's tests get three times
 * the time, and the frame budget checks only the reveal's own work (WP9b 14). The blur's painting would also take the
 * CPUs from the Chromium run of this file beside it, whose frame budget is measured at the same time.
 */
const cpuFilters = server.browser === 'webkit' && server.platform === 'linux'
const hideOptions = cpuFilters ? { timeout: 45_000 } : {}
const quickHide = cpuFilters ? ({ memoHideStyle: 'blank' } as const) : {}

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
    settings: { mushafStyle: 'hafs', pageMode: 'spread', ...quickHide, ...settingsPatch.settings },
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

describe('hide mode on the page (§8.16)', hideOptions, () => {
  it('E hides every word of the spread but the ayah markers; W and Shift+W reveal; E shows the text again', async () => {
    await bootOn50({ settings: { memoHideStyle: 'blur' } })
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
    await bootOn50({ settings: { memoHideStyle: 'blur', memoRevealOnHover: true } })
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

  // The timings share the runner's CPUs with the other test files (this file's WebKit run among them), and time the OS
  // gives to other processes only ever adds to them. So the 90 presses run three times (Restart hides the words again
  // between runs) and a press counts with its least time of the three. The frames are judged beside the page at rest
  // under the same load: each run alternates 30 frames with a W press with 30 frames without, three times, and the
  // pressed frames may be slow (over 20 ms) or late (over 34 ms) no more often than the budget allows on a quiet runner
  // (a twentieth slow, one late) or, where the machine already makes more of the frames at rest so, twice as often as
  // those. A run that keeps that budget passes the frame half: a reveal that is really over budget is over in every
  // run. Where filters are painted on the CPU, frames time that rasteriser, not the reveal: there the W presses
  // come back to back, with no frame between them, and only the reveal's own work is held to its budget (in the blank
  // style there).
  it(
    'stays within the frame budget while W reveals word after word on a spread (§8.18)',
    { timeout: 60_000 },
    async ({ annotate }) => {
      await bootOn50()
      await userEvent.keyboard('e')
      await until(() => $$('.w-hid').length > 0)
      await settle(300)

      /** The script, style and layout (ms) of the `n`th W press. */
      const press = (n: number): number => {
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
        return performance.now() - start
      }
      const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
      const p95 = (xs: number[]) => sorted(xs)[Math.floor(xs.length * 0.95)] ?? 0
      /** Frames over 20 ms (slow) and over 34 ms (late), and the budget for the pressed ones beside those at rest. */
      const judge = (pressed: number[], still: number[]) => {
        const count = (xs: number[], ms: number) => xs.filter((d) => d > ms).length
        const scale = pressed.length / Math.max(1, still.length)
        const slow = { pressed: count(pressed, 20), still: count(still, 20) }
        const late = { pressed: count(pressed, 34), still: count(still, 34) }
        const slowBudget = Math.max(Math.floor(pressed.length / 20), Math.floor(2 * slow.still * scale))
        const lateBudget = Math.max(1, Math.floor(2 * late.still * scale))
        return {
          frames: pressed.length,
          slow,
          late,
          slowBudget,
          lateBudget,
          keeps: slow.pressed <= slowBudget && late.pressed <= lateBudget,
        }
      }
      const works: number[][] = []
      const runs: (ReturnType<typeof judge> & { run: number })[] = []
      const notes: string[] = []
      for (let run = 1; run <= 3; run++) {
        if (run > 1) {
          memo.restart()
          await settle(300)
        }
        expect(memo.wordCounts.revealed).toBe(0)
        const work: number[] = []
        works.push(work)
        if (cpuFilters) {
          for (let n = 0; n < 90; n++) work.push(press(n))
          expect(memo.wordCounts.revealed).toBe(90)
          continue
        }
        /** A W keydown on every animation frame of three blocks of 30 (twice the OS key-repeat rate), each followed by
         * 30 frames without one. A frame counts for the block whose frame began it. */
        const pressed: number[] = []
        const still: number[] = []
        await new Promise<void>((resolve) => {
          let last = 0
          let lastPressed = false
          let n = 0
          const step = (t: number) => {
            if (last > 0) (lastPressed ? pressed : still).push(t - last)
            last = t
            if (n === 180) return resolve()
            lastPressed = Math.floor(n / 30) % 2 === 0
            if (lastPressed) work.push(press(work.length))
            n += 1
            requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        })
        expect(memo.wordCounts.revealed).toBe(90)
        const r = { run, ...judge(pressed, still) }
        runs.push(r)
        notes.push(
          `run ${run}: work p95 ${p95(work).toFixed(1)} ms; pressed frames ${r.slow.pressed} of ${r.frames} over 20 ms ` +
            `(budget ${r.slowBudget}), ${r.late.pressed} over 34 ms (budget ${r.lateBudget}); at rest ` +
            `${r.slow.still} of ${still.length} over 20 ms, ${r.late.still} over 34 ms`,
        )
      }
      // The script, style and layout of a reveal is a small part of a frame…
      const work = (works[0] ?? []).map((_, n) => Math.min(...works.map((w) => w[n] ?? Infinity)))
      notes.push(`work p95 ${p95(work).toFixed(1)} ms (each press at its least of ${works.length} runs)`)
      await annotate(notes.join('\n'))
      expect(p95(work)).toBeLessThan(8)
      if (cpuFilters) return
      // …and the frames keep coming at the display rate, as at rest.
      const best =
        runs.find((r) => r.keeps) ??
        runs.reduce((a, b) =>
          b.late.pressed - b.lateBudget + b.slow.pressed - b.slowBudget <
          a.late.pressed - a.lateBudget + a.slow.pressed - a.slowBudget
            ? b
            : a,
        )
      expect(best.slow.pressed, `run ${best.run}: frames over 20 ms`).toBeLessThanOrEqual(best.slowBudget)
      expect(best.late.pressed, `run ${best.run}: frames over 34 ms`).toBeLessThanOrEqual(best.lateBudget)
    },
  )
})

describe('the hide-mode toolbar', hideOptions, () => {
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

    // The style button switches blur ⇄ blank (the test starts in blank where WebKit paints filters on the CPU).
    const other = settings.value.memoHideStyle === 'blur' ? 'blank' : 'blur'
    await userEvent.click(bar.querySelector('[data-act="style"]') as HTMLElement)
    await until(() => settings.value.memoHideStyle === other, 2_000, 'style toggled')
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

// The panel's tests click through the panel, its menus and hide mode, each click waiting on frames: 11.2 s in CI and
// up to 13.3 s in a CI-like container for the first one, against vitest's 15 s. They get hide mode's time.
describe('the Memorize panel', hideOptions, () => {
  it('scopes the range, takes a typed one, hides and marks it, and draws the Mushaf map', async () => {
    await bootApp({
      settings: {
        mushafStyle: 'hafs',
        pageMode: 'spread',
        ...quickHide,
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
    // The pause choices in UI digits: the half is ½ here (١/٢ with Eastern Arabic numbers, `i18n.fraction`).
    expect(
      $$('[data-qd-preset-editor] .segmented .option .text > span:first-child').map((t) =>
        plain(t.textContent),
      ),
    ).toEqual(['None', '×½', '×1', '×2'])
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
