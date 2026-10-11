/**
 * The Settings dialog's frame (§7.4): when it fills the room, the dock's band a floating dialog stays above, and the
 * room its views keep free for the dock.
 */
import { describe, expect, it } from 'vitest'
import { settingsFrame } from './settingsDialog'

const TITLE = 40

describe('settingsFrame', () => {
  it('floats between the title bar and the dock, never under it', () => {
    // 1600 × 1000: the bar reaches 74 px, so the dialog stays 82 px above the window's bottom (58 px band + 24 margin).
    expect(settingsFrame({ windowW: 1600, windowH: 1000, insetTop: TITLE, dock: 'bar' })).toEqual({
      fill: false,
      insetBottom: 58,
      dockReserve: 0,
    })
    // The compact bar reaches 66 px, the side card 130 px.
    expect(settingsFrame({ windowW: 1366, windowH: 768, insetTop: TITLE, dock: 'compact' }).insetBottom).toBe(
      50,
    )
    expect(settingsFrame({ windowW: 1920, windowH: 1080, insetTop: TITLE, dock: 'side' }).insetBottom).toBe(
      114,
    )
    // 1067 × 667 (1600 × 1000 at 150 %, S24): still floating, still clear of the dock.
    expect(settingsFrame({ windowW: 1067, windowH: 667, insetTop: TITLE, dock: 'bar' })).toEqual({
      fill: false,
      insetBottom: 58,
      dockReserve: 0,
    })
  })

  it('fills the room under 880 × 560 CSS px, keeping the whole dock band free', () => {
    // 1600 × 1000 at 200 %: 800 × 500 CSS px.
    expect(settingsFrame({ windowW: 800, windowH: 500, insetTop: TITLE, dock: 'compact' })).toEqual({
      fill: true,
      insetBottom: 0,
      dockReserve: 66,
    })
    // Wide but short: 1067 × 590 at 150 % (550 px of room).
    expect(settingsFrame({ windowW: 1067, windowH: 590, insetTop: TITLE, dock: 'bar' }).fill).toBe(true)
    // 1067 × 667 (1600 × 1000 at 150 %, S24) still floats.
    expect(settingsFrame({ windowW: 1067, windowH: 667, insetTop: TITLE, dock: 'bar' }).fill).toBe(false)
  })

  it('measures the room under the band it is given (the title bar’s, zen included), and floats unmeasured', () => {
    // 1000 × 590: 550 px of room under the bar's band fills; the whole window would not.
    expect(settingsFrame({ windowW: 1000, windowH: 590, insetTop: TITLE, dock: 'bar' }).fill).toBe(true)
    expect(settingsFrame({ windowW: 1000, windowH: 590, insetTop: 0, dock: 'bar' }).fill).toBe(false)
    expect(settingsFrame({ windowW: 0, windowH: 0, insetTop: TITLE, dock: 'bar' }).fill).toBe(false)
  })
})
