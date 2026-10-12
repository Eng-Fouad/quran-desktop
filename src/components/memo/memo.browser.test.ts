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

/**
 * Waits, `ms` at most, until this page gets 30 animation frames in a row on time (≤ 20 ms apart), and says whether it
 * did: while another test file saturates the runner's CPUs, a timing measures that file, not the code under test.
 */
async function framesOnTime(ms: number): Promise<boolean> {
  const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve))
  const end = performance.now() + ms
  let last = await frame()
  for (let streak = 0; performance.now() < end;) {
    const t = await frame()
    streak = t - last <= 20 ? streak + 1 : 0
    last = t
    if (streak >= 30) return true
  }
  return false
}

/**
 * A heartbeat on a worker thread of this page (a timer every 4 ms or so) that tells the machine's stalls from the main
 * thread's: nothing the main thread does delays it, but it stops too while the OS gives the page's process no CPU
 * (other processes have them, or the container's CPU quota is spent). `stop()` gives the gaps over 12 ms, as
 * `[from, to]` on the page's clock.
 */
async function workerHeartbeat(): Promise<{ stop: () => Promise<[number, number][]> }> {
  const source = `
    const beats = []
    let on = true
    const beat = () => {
      if (!on) return
      beats.push(performance.timeOrigin + performance.now())
      setTimeout(beat, 1)
    }
    onmessage = () => {
      on = false
      postMessage(beats)
    }
    beat()
    postMessage(null)`
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  const worker = new Worker(url)
  await new Promise((resolve) => (worker.onmessage = resolve))
  return {
    stop: () =>
      new Promise((resolve) => {
        worker.onmessage = (e: MessageEvent<number[]>) => {
          worker.terminate()
          URL.revokeObjectURL(url)
          const at = e.data.map((t) => t - performance.timeOrigin)
          const gaps: [number, number][] = []
          for (let i = 1; i < at.length; i++) {
            const [a, b] = [at[i - 1] as number, at[i] as number]
            if (b - a > 12) gaps.push([a, b])
          }
          resolve(gaps)
        }
        worker.postMessage('stop')
      }),
  }
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
  // between runs), each run once this page gets frames on time: a press counts with its least time of the three, and
  // the frames with the run that kept them best. A reveal that is really over budget is over in every run. Frames that
  // came late while a worker thread of this page also stalled were held up by the machine, not by this page, and are
  // set aside; a run with more than a tenth of them is not judged, and when no run is (a saturated runner) the frames
  // are left to the metrics suite (§8.18, §12.6) with a note. Where filters are painted on the CPU, frames time that
  // rasteriser, not the reveal: there the W presses come back to back, with no frame between them, and only the
  // reveal's own work is held to its budget (in the blank style there).
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
      type Gap = { from: number; to: number }
      const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)
      const p95 = (xs: number[]) => sorted(xs)[Math.floor(xs.length * 0.95)] ?? 0
      const works: number[][] = []
      const judged: { run: number; late: number; idle: number; frames: number; p95: number }[] = []
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
        const onTime = await framesOnTime(5_000)
        /** One W keydown per animation frame (twice the OS key-repeat rate), for 90 frames. */
        const frames: Gap[] = []
        // A main-thread heartbeat, as in the word glide's test: a frame that comes late while it kept beating was not
        // held up by script, style, layout or paint on this thread; the browser drew the other test files' first.
        const beats: number[] = []
        let running = true
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
          beats.push(performance.now())
          if (running) setTimeout(() => channel.port2.postMessage(0), 2)
        }
        channel.port2.postMessage(0)
        const machine = await workerHeartbeat()
        await new Promise<void>((resolve) => {
          let last = 0
          const step = (t: number) => {
            if (last > 0) frames.push({ from: last, to: t })
            last = t
            work.push(press(work.length))
            if (work.length < 90) requestAnimationFrame(step)
            else resolve()
          }
          requestAnimationFrame(step)
        })
        running = false
        channel.port1.close()
        const stalls = await machine.stop()
        expect(memo.wordCounts.revealed).toBe(90)

        /** The longest the main thread went without a heartbeat during a frame gap. */
        const blocked = (g: Gap) => {
          const points = [g.from, ...beats.filter((b) => b > g.from && b < g.to), g.to]
          return Math.max(...points.slice(1).map((p, i) => p - (points[i] ?? p)))
        }
        const lateFrames = frames.filter((g) => g.to - g.from > 20)
        const starved = lateFrames.filter((g) => stalls.some(([a, b]) => a < g.to && b > g.from))
        const idle = lateFrames.filter((g) => !starved.includes(g) && blocked(g) <= 16)
        const own = frames.filter((g) => !starved.includes(g) && !idle.includes(g)).map((g) => g.to - g.from)
        const late = own.filter((d) => d > 34).length
        notes.push(
          `run ${run}${onTime ? '' : ' (frames never on time first)'}: work p95 ${p95(work).toFixed(1)} ms; ` +
            `of ${frames.length} frames, ${starved.length} late with the machine stalled, ${idle.length} late with ` +
            `this thread idle; the rest p95 ${p95(own).toFixed(1)} ms, ${late} late`,
        )
        if (starved.length <= frames.length * 0.1)
          judged.push({ run, late, idle: idle.length, frames: frames.length, p95: p95(own) })
      }
      // The script, style and layout of a reveal is a small part of a frame…
      const work = (works[0] ?? []).map((_, n) => Math.min(...works.map((w) => w[n] ?? Infinity)))
      notes.push(`work p95 ${p95(work).toFixed(1)} ms (each press at its least of ${works.length} runs)`)
      if (!cpuFilters && judged.length === 0) notes.push('frames not judged: the machine stalled every run')
      await annotate(notes.join('\n'))
      expect(p95(work)).toBeLessThan(8)
      if (cpuFilters || judged.length === 0) return
      // …and the frames keep coming at the display rate (≤ 16 ms of work each; one late frame of the shared test runner
      // is tolerated). Late frames with an idle main thread are set aside, never more than a tenth of them.
      const keeps = (r: (typeof judged)[number]) => r.idle <= r.frames * 0.1 && r.late <= 1 && r.p95 < 20
      const best =
        judged.find(keeps) ??
        judged.reduce((a, b) => (b.late < a.late || (b.late === a.late && b.p95 < a.p95) ? b : a))
      expect(best.idle, `run ${best.run}`).toBeLessThanOrEqual(best.frames * 0.1)
      expect(best.late, `run ${best.run}`).toBeLessThanOrEqual(1)
      expect(best.p95, `run ${best.run}`).toBeLessThan(20)
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

describe('the Memorize panel', () => {
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
