/**
 * Rosette (§9.7) in a real browser: the number stays inside the star at every size the app uses, three digits included
 * (114 in the surah index, ayah 286 in the side pane and translation keys).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import Rosette from './Rosette.svelte'

afterEach(() => {
  document.body.replaceChildren()
})

describe('Rosette', () => {
  it('keeps two and three digits inside the star at every size (the square is 2 × 7.78 of 24 at the digits)', async () => {
    await document.fonts.ready
    for (const size of [20, 22, 24, 26, 28, 32, 36]) {
      for (const n of [88, 114, 286]) {
        const screen = await render(Rosette, { n, size })
        const num = screen.container.querySelector<HTMLElement>('.num')
        if (!num) throw new Error('no .num')
        await document.fonts.load(`${getComputedStyle(num).fontSize} ${getComputedStyle(num).fontFamily}`)
        const width = num.getBoundingClientRect().width
        const inner = (size * 2 * 7.778) / 24
        expect(width, `${n} at ${size} px`).toBeLessThanOrEqual(inner - 0.5)
        screen.unmount()
      }
    }
  })
})
