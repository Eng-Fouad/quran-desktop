/**
 * The self-test from start to rating in a real browser (§8.16, §5.10; WP9b), in the real `App` on the browser mock:
 * Shift+E opens the setup for the surah being read, Start jumps to the random start ayah and hides from it, W and M
 * count hints and mistakes (M never mutes the recitation), E asks for the rating, "Keep reciting" goes back to the test,
 * Discard ends a second test unrated, and the keys 1–4 answer.
 *
 * Everything runs in one test on purpose: bits-ui keeps its body scroll lock in module state, and a dialog opened after
 * the app was unmounted and mounted again in the same page never hands `<body>` its pointer events back (a test-harness
 * artifact; the app is mounted once). Hide mode and the panel are covered in `memo.browser.test.ts`.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../../app.css'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import { memo, player, quran, reader, ui } from '$lib/stores'

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

function blurFocus(): void {
  ;(document.activeElement as HTMLElement | null)?.blur()
}

/**
 * The dialog has gone, `<body>` takes pointer events again, and `OverlayHost`'s exit window (260 ms) is over: an overlay
 * opened inside that window leaves bits-ui's body lock behind for good (reported to WP7c, docs/deviations/WP9b.md).
 */
async function dialogGone(): Promise<void> {
  await until(() => $('.self-test-dialog') === null, 3_000, 'the dialog closes')
  await until(() => document.body.style.pointerEvents !== 'none', 3_000, 'pointer events back')
  await settle(350)
}

afterEach(async () => {
  resetApp()
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

describe('the self-test (§8.16)', () => {
  it('Shift+E → setup → start → hints and mistakes → E → keep reciting → rate with 3; then discard another', async () => {
    // The blank hide style: Playwright's WebKit on Linux paints the blur of hidden words on the CPU, about a second a
    // frame (WP9b 14), and this flow does not look at them (memo.browser.test.ts checks both styles).
    await bootApp({ settings: { mushafStyle: 'hafs', pageMode: 'single', memoHideStyle: 'blank' } })
    reader.goToPage(50, { transition: false })
    await until(() => reader.visiblePages.includes(50), 5_000, 'page 50')
    await settle(300)
    await userEvent.hover($('header') ?? document.body)
    blurFocus()
    vi.spyOn(Math, 'random').mockReturnValue(0)

    // Setup: the surah of the reading cursor (Ali 'Imran here), its status and the keys.
    await userEvent.keyboard('{Shift>}e{/Shift}')
    await until(() => $('[data-qd-self-test="setup"]') !== null, 3_000, 'setup dialog')
    const surah = quran.ayahRef(reader.actionTarget).surah
    const range = quran.surahRange(surah)
    const setup = plain($('.self-test-dialog')?.textContent)
    expect(setup).toContain(quran.surahName(surah))
    expect(setup).toContain(`${range.to - range.from + 1} ayahs`)
    expect(setup).toContain('Reveal the next word')
    expect(document.activeElement?.textContent?.trim()).toBe('Start the test')

    // Start: the random start (Math.random = 0 → the first ayah), the reader there, hidden from it.
    await userEvent.click($('.self-test-dialog button.v-primary') as HTMLElement)
    await dialogGone()
    await until(() => $('[data-qd-self-test-bar]') !== null, 3_000, 'test bar')
    const start = memo.test?.startAyahId ?? 0
    expect(start).toBe(range.from)
    expect(reader.cursorAyahId).toBe(start)
    expect(plain($('[data-qd-self-test-bar]')?.textContent)).toContain(
      `Recite from ${plain(quran.refLabel(start))}`,
    )
    expect($$('.mp-glyphs[data-interactive] .w.w-hid').length).toBeGreaterThan(0)

    // Hints and mistakes; M is the test's key while it runs, never the mute.
    blurFocus()
    await userEvent.keyboard('ww')
    await userEvent.keyboard('m')
    await until(() => memo.testMistakes === 1 && memo.testReveals === 2, 2_000, 'hint and mistake counts')
    expect(player.muted).toBe(false)
    expect(plain($('[data-qd-self-test-bar] [data-act="mistake"]')?.textContent)).toContain('1')
    expect(plain($('[data-qd-self-test-bar]')?.textContent)).toContain('2 hints · 1 mistake')

    // E asks for the rating; "Keep reciting" goes back to the running test.
    await userEvent.keyboard('e')
    await until(() => $('[data-qd-self-test="rate"]') !== null, 3_000, 'rating dialog')
    expect($$('[data-qd-self-test="rate"] .answer')).toHaveLength(4)
    expect($('[data-qd-self-test="rate"] .answer.suggested')).not.toBeNull()
    await userEvent.click(
      $$('.self-test-dialog button').find((b) => plain(b.textContent) === 'Keep reciting') as HTMLElement,
    )
    await dialogGone()
    expect(memo.test).not.toBeNull()
    blurFocus()
    await userEvent.keyboard('w')
    await until(() => memo.testReveals === 3, 2_000, 'still reciting')

    // The bar's Finish opens the rating again; 3 answers "good".
    await userEvent.click($('[data-qd-self-test-bar] [data-act="finish"]') as HTMLElement)
    await until(() => $('[data-qd-self-test="rate"]') !== null, 3_000, 'rating dialog again')
    expect(plain($('[data-qd-self-test="rate"]')?.textContent)).toContain('Good')
    await userEvent.keyboard('3')
    await until(() => memo.test === null && !ui.layerOpen, 3_000, 'saved')
    await dialogGone()
    expect(memo.progress.get(start)).toEqual(expect.objectContaining({ status: 'learning', strength: 1 }))
    expect(memo.progress.get(range.to)).toEqual(expect.objectContaining({ status: 'learning', strength: 1 }))
    await until(() => $('[data-qd-self-test-bar]') === null, 2_000, 'the bar leaves')
    expect($$('.w-hid')).toHaveLength(0)
    expect(ui.toasts.at(-1)?.message).toContain('Self-test saved')

    // A second test, discarded from the rating: nothing is rated.
    blurFocus()
    vi.spyOn(Math, 'random').mockReturnValue(0.9999)
    await userEvent.keyboard('{Shift>}e{/Shift}')
    await until(() => $('[data-qd-self-test="setup"]') !== null, 3_000, 'setup again')
    await userEvent.keyboard('{Enter}')
    await dialogGone()
    await until(() => memo.test !== null, 2_000, 'second test')
    const second = memo.test?.startAyahId ?? 0
    expect(second).toBe(range.to)
    const before = memo.progress.get(second)
    blurFocus()
    await userEvent.keyboard('e')
    await until(() => $('[data-qd-self-test="rate"]') !== null, 3_000, 'rating for the second test')
    await userEvent.click(
      $$('.self-test-dialog button').find((b) => plain(b.textContent) === 'Discard the test') as HTMLElement,
    )
    await dialogGone()
    expect(memo.test).toBeNull()
    expect(memo.progress.get(second)).toEqual(before)
  })
})
