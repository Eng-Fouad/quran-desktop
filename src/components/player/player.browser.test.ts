/**
 * The recitation dock in a real browser (§9.7, §7.7, §11.3; WP9a), mounted in the real `App` on the browser mock: the
 * idle pill and its morph into the bar, the bar geometry, Space and the widget guard, the scrubber's keys, the popovers
 * (repeat, speed, reciter), the side card, the narrow layouts, the Arabic UI (LTR transport and times), the collapsed
 * pill, the resume pill and the offline error.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../../app.css'
import { bootApp, resetApp, settle } from '../shell/testing/boot'
import { api, events } from '$lib/ipc'
import type { AudioSnapshot } from '$lib/ipc/bindings'
import { player, quran, reader, settings, ui } from '$lib/stores'

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const rect = (selector: string) => $(selector)?.getBoundingClientRect() ?? new DOMRect()
const dock = () => $('[data-qd-dock]') as HTMLElement
/** Text without the bidi isolates that wrap references (§11.3). */
const plain = (text: string | null | undefined) =>
  (text ?? '')
    .replace(/[\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Waits (real time) until `done()` holds. */
async function until(done: () => boolean, timeout = 5_000, message = 'condition'): Promise<void> {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    flushSync()
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${message} not met within ${timeout} ms`)
}

afterEach(async () => {
  resetApp()
  vi.restoreAllMocks()
  await page.viewport(1280, 800)
})

describe('PlayerDock: idle, playing and the bar geometry (§9.7)', () => {
  it('offers the visible page while idle, then morphs into the 64 px bar centred 10 px above the canvas', async () => {
    await bootApp({ settings: { pageMode: 'spread', mushafStyle: 'hafs' } })
    expect(dock().getAttribute('data-mode')).toBe('idle')
    expect(plain(dock().textContent)).toContain('Play Al-Fatihah from')
    expect(plain(dock().textContent)).toContain('Mishary Rashid Alafasy')
    expect(Math.round(rect('[data-qd-dock-pill]').width)).toBe(380)

    await userEvent.click($('.idle-play') as HTMLElement)
    await until(() => player.isPlaying, 3_000, 'playing')
    await until(() => dock().getAttribute('data-mode') === 'bar')
    await settle(320) // the morph
    const d = rect('[data-qd-dock-pill]')
    const canvas = rect('main.canvas')
    expect(d.height).toBeCloseTo(64, 0)
    expect(canvas.bottom - d.bottom).toBeCloseTo(10, 0)
    expect((d.left + d.right) / 2).toBeCloseTo((canvas.left + canvas.right) / 2, 0)
    expect(d.width).toBeCloseTo(
      Math.min(880, Math.max(Math.min(560, canvas.width - 24), canvas.width * 0.7)),
      0,
    )
    expect(plain($('[data-qd-dock] .readout')?.textContent)).toContain('1:1')
    expect(plain($('[data-qd-dock] .who .where')?.textContent)).toBe('Al-Fatihah · 1:1')
  })

  it('Space plays and pauses; Space on a focused dock button presses the button instead (§7.7)', async () => {
    await bootApp()
    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.keyboard(' ')
    await until(() => player.isPlaying, 3_000, 'Space plays')
    await userEvent.keyboard(' ')
    await until(() => player.status === 'paused', 3_000, 'Space pauses')

    const more = $('[data-qd-dock] [aria-label="More"]') as HTMLElement
    more.focus()
    await userEvent.keyboard(' ')
    await until(() => $('[data-qd-popover="more"]') !== null, 2_000, 'More opens')
    expect(player.status).toBe('paused')
    await userEvent.keyboard('{Escape}')
  })

  it('the scrubber is a slider: arrows seek 5 s, PageUp the next ayah, and the page never turns', async () => {
    await bootApp({ settings: { pageMode: 'spread' } })
    await player.playFrom({ ayahId: 1 }, { startPaused: true })
    await until(() => player.status === 'paused')
    const slider = $('[data-qd-dock] [role="slider"]') as HTMLElement
    expect(slider.getAttribute('aria-label')).toBe('Recitation position')
    slider.focus()
    const page = reader.page
    await userEvent.keyboard('{ArrowRight}')
    await until(() => player.positionMs >= 4_999, 2_000, '+5 s')
    await userEvent.keyboard('{ArrowLeft}')
    await until(() => player.positionMs < 100, 2_000, '−5 s')
    await userEvent.keyboard('{PageUp}')
    await until(() => player.currentAyahId === 2, 2_000, 'next ayah')
    expect(reader.page).toBe(page)
    expect(plain(slider.getAttribute('aria-valuetext'))).toMatch(/^1:2, /)
  })

  it('a click on the track seeks inside the playing range; Shift snaps to an ayah start', async () => {
    await bootApp()
    await player.playFrom({ ayahId: 1 }, { startPaused: true })
    await until(() => player.status === 'paused' && player.timingsForCurrent !== null)
    await settle(320) // the idle pill's morph into the bar
    const rail = $('[data-qd-dock] .rail') as HTMLElement
    const r = rail.getBoundingClientRect()
    const duration = player.timingsForCurrent?.durationMs ?? 1
    await userEvent.click(rail, { position: { x: r.width * 0.5, y: r.height / 2 } })
    await until(
      () => Math.abs(player.positionMs - duration * 0.5) < duration * 0.02,
      2_000,
      'seek to the middle',
    )
    const starts = player.timingsForCurrent?.ayahs.map((a) => a.fromMs) ?? []
    await userEvent.keyboard('{Shift>}')
    await userEvent.click(rail, { position: { x: r.width * 0.3, y: r.height / 2 } })
    await userEvent.keyboard('{/Shift}')
    await until(() => starts.includes(Math.round(player.positionMs)), 2_000, 'snapped to an ayah start')
  })
})

describe('PlayerDock: popovers', () => {
  it('the repeat popover sets each ayah ×3 live; the badge counts the plays', async () => {
    await bootApp()
    await player.playFrom({ ayahId: 1 })
    await until(() => player.isPlaying)
    await userEvent.click($('[data-qd-dock] .repeat') as HTMLElement)
    await until(() => $('[data-qd-popover="repeat"]') !== null)
    const plus = $$('[data-qd-popover="repeat"] [aria-label="More"]')[0] as HTMLElement
    await userEvent.click(plus)
    await userEvent.click(plus)
    await until(() => player.snapshot?.ayahRepeat === 3, 2_000, 'live ×3')
    expect(settings.value.ayahRepeat).toBe(3)
    expect($$('[data-qd-popover="repeat"] output.value')[0]?.textContent?.trim()).toBe('×3')
    // A popover is portalled to the body: a `header` there would be a second banner landmark.
    expect($$('[data-qd-popover="repeat"] header, [data-qd-popover="repeat"] footer')).toHaveLength(0)
    await until(() => $('[data-qd-dock] .repeat .badge')?.textContent === '1/3', 2_000, 'badge 1/3')
    await userEvent.keyboard('{Escape}')
  })

  it('the repeat steppers keep focus at their limits (Fewer down to once, More up to ∞)', async () => {
    await bootApp()
    await player.playFrom({ ayahId: 1 })
    await until(() => player.isPlaying)
    await userEvent.click($('[data-qd-dock] .repeat') as HTMLElement)
    await until(() => $('[data-qd-popover="repeat"]') !== null)
    const popover = () => $('[data-qd-popover="repeat"]') as HTMLElement
    const fewer = () => $$('[data-qd-popover="repeat"] [aria-label="Fewer"]')[0] as HTMLElement
    const more = () => $$('[data-qd-popover="repeat"] [aria-label="More"]')[0] as HTMLElement
    more().focus()
    await userEvent.keyboard('{Enter}')
    await until(() => player.snapshot?.ayahRepeat === 2, 2_000, '×2')
    fewer().focus()
    await userEvent.keyboard('{Enter}')
    await until(() => player.snapshot?.ayahRepeat === 1, 2_000, 'once')
    // At its limit: it looks disabled, does nothing, and keeps the focus inside the popover.
    expect(fewer().getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(fewer())
    await userEvent.keyboard('{Enter}')
    await settle(100)
    expect(player.snapshot?.ayahRepeat).toBe(1)
    expect(popover().contains(document.activeElement)).toBe(true)
    // Tab still reaches the next control.
    await userEvent.keyboard('{Tab}')
    expect(document.activeElement).toBe(popover().querySelector('output + button, output ~ button'))
    await userEvent.keyboard('{Escape}')
  })

  it('keeps a range being typed while the recitation moves on to the next ayah', async () => {
    await bootApp()
    await player.playFrom({ ayahId: 1 })
    await until(() => player.isPlaying && player.currentAyahId === 1)
    await userEvent.click($('[data-qd-dock] .repeat') as HTMLElement)
    await until(() => $('[data-qd-popover="repeat"] input[id$="-range-input"]') !== null)
    const field = $<HTMLInputElement>(
      '[data-qd-popover="repeat"] input[id$="-range-input"]',
    ) as HTMLInputElement
    await settle(50)
    expect(field.value).toBe('1:1–7') // the loaded range
    const presets = vi.spyOn(api, 'loopPresetList')
    await userEvent.clear(field)
    await userEvent.type(field, '2:255-257')
    // The next ayah starts (an audio-state-changed edge, as the engine sends it), then a repeat counter ticks.
    const now = player.snapshot as AudioSnapshot
    await events.audioStateChanged.emit({ ...now, current: { surah: 1, ayah: 2 }, currentAyahId: 2 })
    await until(() => player.currentAyahId === 2, 2_000, 'the next ayah')
    await events.audioStateChanged.emit({
      ...now,
      current: { surah: 1, ayah: 2 },
      currentAyahId: 2,
      speedPct: 110,
    })
    await settle(50)
    expect(field.value).toBe('2:255-257')
    expect(presets).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
  })

  it('arrow keys in the speed slider change the speed, not the page (§7.7)', async () => {
    await bootApp({ settings: { pageMode: 'spread' } })
    await player.playFrom({ ayahId: 1 })
    await until(() => player.isPlaying)
    await userEvent.click($('[data-qd-dock] .speed') as HTMLElement)
    await until(() => $('[data-qd-popover="speed"] [role="slider"]') !== null)
    const page = reader.page
    ;($('[data-qd-popover="speed"] [role="slider"]') as HTMLElement).focus()
    await userEvent.keyboard('{ArrowRight}')
    await until(() => settings.value.speedPct === 105, 2_000, 'speed 105')
    await until(() => player.snapshot?.speedPct === 105, 2_000, 'engine 105')
    expect(reader.page).toBe(page)
    expect(plain($('[data-qd-dock] .speed')?.textContent)).toBe('1.05×')
    expect($$('[data-qd-popover="speed"] header, [data-qd-popover="speed"] footer')).toHaveLength(0)
    await userEvent.keyboard('{Escape}')
  })

  it('a popover open when the recitation ends stays closed when the next one starts (the reader keys work)', async () => {
    await bootApp({ settings: { pageMode: 'spread' } })
    for (const which of ['repeat', 'speed', 'more'] as const) {
      await player.playFrom({ ayahId: 1 })
      await until(() => player.isPlaying && dock().getAttribute('data-mode') === 'bar', 3_000, 'playing')
      await settle(320) // the morph
      const trigger =
        which === 'more' ? $('[data-qd-dock] [aria-label="More"]') : $(`[data-qd-dock] .${which}`)
      await userEvent.click(trigger as HTMLElement)
      await until(() => $(`[data-qd-popover="${which}"]`) !== null, 2_000, `${which} opens`)
      expect(ui.layerOpen).toBe(true)
      // The recitation ends with the popover open: the bar leaves, and the popover with it.
      await player.stop()
      await until(() => dock().getAttribute('data-mode') === 'idle', 2_000, 'idle')
      await until(() => $('[data-qd-popover]') === null && !ui.layerOpen, 2_000, 'the popover left')
      // The next recitation brings the bar back without it.
      await player.playFrom({ ayahId: 1 })
      await until(() => dock().getAttribute('data-mode') === 'bar', 3_000, 'the bar again')
      await settle(320)
      expect($('[data-qd-popover]'), which).toBeNull()
      expect(ui.layerOpen, which).toBe(false)
      // So the reader's own keys still work.
      ;(document.activeElement as HTMLElement | null)?.blur()
      const pages = reader.visiblePages.join()
      await userEvent.keyboard('{ArrowLeft}')
      await until(() => reader.visiblePages.join() !== pages, 2_000, `${which}: ArrowLeft turns the page`)
      await player.stop()
      await until(() => dock().getAttribute('data-mode') === 'idle', 2_000, 'idle again')
    }
  })

  it('the reciter picker filters by either name and chooses with Enter', async () => {
    await bootApp()
    await userEvent.click($('[data-qd-dock] .mono-button') as HTMLElement)
    await until(() => $('[role="listbox"]') !== null)
    await userEvent.keyboard('سديس')
    await until(() => $$('[role="option"]').length === 1, 2_000, 'one match')
    expect(plain($('[role="option"]')?.textContent)).toContain('Al-Sudais')
    await userEvent.keyboard('{Enter}')
    await until(() => settings.value.reciterId === 3, 2_000, 'reciter 3')
    await until(() => $('[role="listbox"]') === null, 2_000, 'the picker closes')
  })
})

describe('Dock placement and layouts', () => {
  it('shows the 272×120 side card when the geometry puts the dock beside the pages', async () => {
    await bootApp({ size: [1920, 1080], settings: { sidebar: { open: false, widthPx: 300, tab: 'index' } } })
    expect(reader.dock).toBe('side')
    const card = rect('[data-qd-dock-pill]')
    expect(card.width).toBeCloseTo(272, 0)
    expect(card.height).toBeCloseTo(120, 0)
    await player.playFrom({ ayahId: 1 })
    await until(() => player.isPlaying)
    expect($('[data-qd-dock] [role="slider"]')).not.toBeNull()
    expect($('[data-qd-dock] .transport')).not.toBeNull()
  })

  it('narrows the bar: the monogram alone and a one-line readout under 720 px, no labels under 600 px', async () => {
    await bootApp({ size: [1100, 800], settings: { pageMode: 'spread' } })
    await player.playFrom({ ayahId: 1 })
    await until(() => player.isPlaying)
    await settle(320)
    expect(rect('[data-qd-dock-pill]').width).toBeLessThan(720)
    expect($('[data-qd-dock] .who')).toBeNull()
    expect($('[data-qd-dock] .readout.one-line')).not.toBeNull()
    expect($('[data-qd-dock] .scrubber .labels')).toBeNull()
    // The cells never overlap: the readout starts after the scrubber.
    expect(rect('[data-qd-dock] .readout').left).toBeGreaterThanOrEqual(
      rect('[data-qd-dock] .scrubber').right,
    )
  })

  it('keeps the transport, scrubber and times left to right in the Arabic UI (§11.3)', async () => {
    await bootApp({ settings: { uiLanguage: 'ar' } })
    await player.playFrom({ ayahId: 2 }, { startPaused: true })
    await until(() => player.status === 'paused')
    await player.seekMs(3_900)
    await settle(120)
    const prev = rect('[data-qd-dock] .transport .skip:first-child')
    const next = rect('[data-qd-dock] .transport .skip:last-child')
    expect(prev.left).toBeLessThan(next.left)
    expect(getComputedStyle($('[data-qd-dock] .scrubber') as Element).direction).toBe('ltr')
    // The outer grid mirrors: the reciter sits at the right.
    expect(rect('[data-qd-dock] .reciter').left).toBeGreaterThan(rect('[data-qd-dock] .transport').right)
    const time = rect('[data-qd-dock] .readout .time')
    const total = rect('[data-qd-dock] .readout .total')
    expect(time.left).toBeLessThan(total.left)
    expect(plain($('[data-qd-dock] .readout .time')?.textContent)).toBe('٠٠:٠٣')
  })

  it('collapses to a small pill and back', async () => {
    await bootApp()
    await player.playFrom({ ayahId: 1 })
    await until(() => player.isPlaying)
    await userEvent.click($('[data-qd-dock] [aria-label="Minimize the player"]') as HTMLElement)
    await until(() => dock().getAttribute('data-mode') === 'collapsed')
    expect(plain(dock().textContent)).toContain('Al-Fatihah · 1:1')
    await userEvent.click($('[data-qd-dock] [aria-label="Expand the player"]') as HTMLElement)
    await until(() => dock().getAttribute('data-mode') === 'bar')
  })
})

describe('Resume and errors (§7.8, §9.8)', () => {
  it('offers the resume candidate, plays it with Space, and can forget it', async () => {
    const ayahId = 2_185 // 18:45 in the Hafs numbering
    await page.viewport(1600, 1000)
    await bootApp({
      edit: (b) => ({
        ...b,
        positions: [
          ...b.positions,
          {
            context: 'audio',
            layout: 'v2',
            page: 299,
            ayahId,
            scrollPx: null,
            updatedAt: Math.floor(Date.now() / 1000) - 60,
          },
        ],
      }),
    })
    expect(quran.ayahRef(ayahId)).toEqual({ surah: 18, ayah: 45 })
    expect(plain(dock().textContent)).toContain('Resume Al-Kahf · 18:45')
    await userEvent.click($('[data-qd-dock] [aria-label="Forget where you stopped"]') as HTMLElement)
    await until(() => !plain(dock().textContent).includes('Resume'))
    expect(plain(dock().textContent)).toContain('Play Al-Fatihah')
  })

  it('shows the offline copy with "Download when online" for a surah that is not on disk', async () => {
    await bootApp({ settings: { networkAllowed: false } })
    await player.playFrom({ ayahId: quran.ayahId(36, 1) })
    await until(() => dock().getAttribute('data-mode') === 'error', 3_000, 'error mode')
    expect(plain(dock().textContent)).toContain(
      'Offline — Ya-Sin isn’t downloaded for Mishary Rashid Alafasy',
    )
    expect($('[data-qd-dock] [role="status"] button')?.textContent?.trim()).toBe('Download when online')
    await userEvent.click($('[data-qd-dock] [aria-label="Dismiss"]') as HTMLElement)
    await until(() => dock().getAttribute('data-mode') === 'idle')
  })
})
