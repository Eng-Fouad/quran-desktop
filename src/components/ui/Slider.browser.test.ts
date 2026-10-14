/**
 * Slider: arrow keys step, Shift+arrows and PageUp/PageDown take big steps, Home/End jump to the ends,
 * the value text comes from `format`, value sliders mirror in RTL, and arrow keys in the slider never reach the reader
 * (the widget-guard test: "ArrowRight in the Speed slider changes speed and leaves the page unchanged").
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { installShortcuts, resetUi, setUi, settle, spyShortcut } from './testing/harness'
import Slider from './Slider.svelte'

const thumb = () => document.querySelector<HTMLElement>('[role="slider"]')

async function speedSlider(onValueChange = vi.fn(), onValueCommit = vi.fn()) {
  await render(Slider, {
    props: {
      value: 100,
      min: 50,
      max: 200,
      step: 5,
      ticks: [75, 100, 125, 150, 200],
      format: (v: number) => `${v / 100}×`,
      label: 'Speed',
      onValueChange,
      onValueCommit,
    },
  })
  thumb()?.focus()
  await settle(0)
  return { onValueChange, onValueCommit }
}

afterEach(() => resetUi())

describe('Slider', () => {
  it('is a labelled slider with a formatted value text', async () => {
    await speedSlider()
    const el = thumb()
    expect(el?.getAttribute('aria-label')).toBe('Speed')
    expect(el?.getAttribute('aria-valuenow')).toBe('100')
    expect(el?.getAttribute('aria-valuemin')).toBe('50')
    expect(el?.getAttribute('aria-valuemax')).toBe('200')
    expect(el?.getAttribute('aria-valuetext')).toBe('1×')
    expect(document.querySelectorAll('.tick')).toHaveLength(5)
  })

  it('steps with the arrows, takes big steps with Shift and PageUp/PageDown, and jumps with Home/End', async () => {
    const { onValueChange, onValueCommit } = await speedSlider()
    await userEvent.keyboard('{ArrowRight}')
    expect(onValueChange).toHaveBeenLastCalledWith(105)
    await userEvent.keyboard('{ArrowUp}')
    expect(onValueChange).toHaveBeenLastCalledWith(110)
    await userEvent.keyboard('{ArrowLeft}{ArrowDown}')
    expect(onValueChange).toHaveBeenLastCalledWith(100)
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(onValueChange).toHaveBeenLastCalledWith(150)
    await userEvent.keyboard('{PageDown}')
    expect(onValueChange).toHaveBeenLastCalledWith(100)
    await userEvent.keyboard('{PageUp}{PageUp}{PageUp}')
    expect(onValueChange).toHaveBeenLastCalledWith(200) // clamped at max
    await userEvent.keyboard('{Home}')
    expect(onValueChange).toHaveBeenLastCalledWith(50)
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(onValueChange).toHaveBeenLastCalledWith(50) // already at min: no change event
    await userEvent.keyboard('{End}')
    expect(onValueChange).toHaveBeenLastCalledWith(200)
    expect(onValueCommit).toHaveBeenCalled()
    expect(thumb()?.getAttribute('aria-valuetext')).toBe('2×')
  })

  it('mirrors in RTL: ArrowLeft increases, the range grows from the right', async () => {
    setUi('ar')
    const { onValueChange } = await speedSlider()
    await userEvent.keyboard('{ArrowLeft}')
    expect(onValueChange).toHaveBeenLastCalledWith(105)
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(onValueChange).toHaveBeenLastCalledWith(155)
    await userEvent.keyboard('{ArrowRight}')
    expect(onValueChange).toHaveBeenLastCalledWith(150)
    await settle(0)
    const range = document.querySelector<HTMLElement>('.range')?.getBoundingClientRect()
    const track = document.querySelector<HTMLElement>('.track')?.getBoundingClientRect()
    expect(Math.abs((range?.right ?? 0) - (track?.right ?? 1))).toBeLessThan(1)
  })

  it('keeps arrow and page keys away from the reader (widget guard)', async () => {
    const uninstall = installShortcuts()
    const nextPage = spyShortcut(['ArrowRight', 'PageDown'], {
      scope: 'reader',
      labelKey: 'shortcuts.nav.nextPage',
    })
    const extend = spyShortcut(['Shift+ArrowRight'], {
      scope: 'reader',
      labelKey: 'shortcuts.nav.extendNext',
    })
    const { onValueChange } = await speedSlider()
    await userEvent.keyboard('{ArrowRight}')
    await userEvent.keyboard('{PageDown}')
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(onValueChange).toHaveBeenCalledTimes(3)
    expect(nextPage).not.toHaveBeenCalled()
    expect(extend).not.toHaveBeenCalled()
    uninstall()
  })

  it('places tick labels under their values', async () => {
    await speedSlider()
    const track = document.querySelector<HTMLElement>('.rail')?.getBoundingClientRect()
    const ticks = [...document.querySelectorAll<HTMLElement>('.tick')].map((t) => t.getBoundingClientRect())
    const at = (v: number) => (track?.left ?? 0) + ((v - 50) / 150) * (track?.width ?? 0)
    expect(Math.abs((ticks[1]?.left ?? 0) - at(100))).toBeLessThan(1.5)
    expect(Math.abs((ticks[4]?.left ?? 0) - at(200))).toBeLessThan(1.5)
  })
})
