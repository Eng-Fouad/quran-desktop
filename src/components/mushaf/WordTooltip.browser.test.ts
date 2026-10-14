/**
 * WordTooltip's surface in a real browser: it floats over Quran text, so it is glass, translucent only with a backdrop
 * blur, and opaque where blur is not allowed (Linux, reduced transparency). A bare translucent fill let the line under
 * it show through the word and its gloss.
 */
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { WORD_DWELL_EVENT, type WordDwell } from '$lib/mushaf/interactions'
import { settings } from '$lib/stores'
import WordTooltip from './WordTooltip.svelte'

const previous = settings.value

beforeEach(() => {
  document.documentElement.dataset.theme = 'paper'
  settings.value = { ...previous, wbwTooltip: true, wbwPackId: 'wbw.en' }
})

afterEach(() => {
  settings.value = previous
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.platform
})

/** The tooltip for a word in the middle of the window. */
async function showTip(): Promise<HTMLElement> {
  await render(WordTooltip)
  const detail: WordDwell = {
    wordId: 11,
    ayahId: 3,
    page: 1,
    text: 'ٱلرَّحۡمَٰنِ',
    anchor: { left: 600, top: 400, right: 660, bottom: 440 },
  }
  window.dispatchEvent(new CustomEvent(WORD_DWELL_EVENT, { detail }))
  flushSync()
  await expect.poll(() => document.querySelector<HTMLElement>('.word-tooltip')).not.toBeNull()
  return document.querySelector<HTMLElement>('.word-tooltip') as HTMLElement
}

/** The alpha of a computed `rgb()`/`rgba()`/`color(srgb …)` colour (1 when it has none). */
function alpha(color: string): number {
  const slash = /\/\s*([\d.]+)\s*\)$/.exec(color)
  if (slash) return Number(slash[1])
  const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(color)
  return rgba ? Number(rgba[1]) : 1
}

describe('WordTooltip surface', () => {
  it('is translucent only over a backdrop blur', async () => {
    const tip = await showTip()
    const cs = getComputedStyle(tip)
    expect(cs.backdropFilter).toMatch(/blur\(20px\)/)
    expect(alpha(cs.backgroundColor)).toBeLessThan(1)
    expect(cs.boxShadow).not.toBe('none')
  })

  it('is opaque where blur is not allowed (Linux)', async () => {
    document.documentElement.dataset.platform = 'linux'
    const tip = await showTip()
    const cs = getComputedStyle(tip)
    expect(cs.backdropFilter).toBe('none')
    expect(alpha(cs.backgroundColor)).toBe(1)
  })
})
