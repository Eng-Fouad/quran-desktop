/** Which edge the shell's toasts take so they never cover the Quran text (§7.5, §9.5). */
import { describe, expect, it } from 'vitest'
import { BLOCK_BOTTOM, TOAST_ROOM, TOAST_TOP_GAP, toastSide } from './toastPlacement'
import { BLOCK_TOP, PH } from '$lib/mushaf/geometry'

describe('toastSide', () => {
  it('stays at the bottom without a book on the canvas (translation mode, the other views)', () => {
    expect(toastSide(null, 96, TOAST_TOP_GAP)).toBe('bottom')
  })

  it('stays at the bottom when the toast fits under the text (the band the dock reserves)', () => {
    // 1440 × 940, bar dock: the book ends 100 px above the canvas bottom, qfs ≈ 24.5.
    const qfs = 24.5
    expect(toastSide({ above: 16 + BLOCK_TOP * qfs, below: 100 + BLOCK_BOTTOM * qfs }, 96, 12)).toBe('bottom')
  })

  it('takes the top edge in zen, where the book fills the canvas height but its running head leaves room', () => {
    // Zen at 1600 × 1000: the book centres in the whole canvas with 16 px above and below; above the dock (96)
    // the toast would cover the last line.
    const qfs = (1000 - 32) / PH
    const clear = { above: 16 + BLOCK_TOP * qfs, below: 16 + BLOCK_BOTTOM * qfs }
    expect(toastSide(clear, 96, TOAST_TOP_GAP)).toBe('top')
    // At rest, low in the paper's bottom margin (16 px), a toast fits under the text: it stays there.
    expect(toastSide(clear, 16, TOAST_TOP_GAP)).toBe('bottom')
  })

  it('covers the fewest lines when neither edge has room (a held qfs: the book overflows the canvas)', () => {
    expect(toastSide({ above: 66, below: -300 }, 96, 12)).toBe('top')
    expect(toastSide({ above: -400, below: 121 }, 96, 12)).toBe('bottom')
    // Equal overlap: the top (the running head before the dock and the slot).
    expect(toastSide({ above: 12 + TOAST_ROOM - 10, below: 96 + TOAST_ROOM - 10 }, 96, 12)).toBe('top')
  })
})
