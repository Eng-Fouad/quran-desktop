import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PageMode } from '$lib/ipc/bindings'
import {
  BLOCK_INNER,
  BLOCK_OUTER,
  BLOCK_TOP,
  blockBox,
  FIT_UNIFORM_BELOW,
  fitLayout,
  fitLines,
  FOOT,
  FR,
  FRAME_BOTTOM,
  HEAD,
  isOpeningPage,
  LH,
  lineBox,
  lineFit,
  M_IN,
  M_OUT,
  M_TB,
  OPENING_INSET,
  OPENING_TOP_LINES,
  pageBox,
  pageSide,
  paneCanDock,
  PH,
  PW,
  QFS_MAX,
  QFS_MIN,
  SHIFT,
  SINGLE_W,
  SLOT_CLEAR_GAP,
  slotBottom,
  slotClearance,
  snapQfs,
  TB_H,
  TB_W,
} from './geometry'

/** Shell measures of the acceptance table: title bar 40, rail 52, sidebar 300, side pane 400. */
function canvas(
  window: [number, number],
  opts: { sidebar?: boolean; pane?: boolean } = {},
): [number, number] {
  const { sidebar = true, pane = false } = opts
  return [window[0] - 52 - (sidebar ? 300 : 0) - (pane ? 400 : 0), window[1] - 40]
}

describe('page constants', () => {
  it('PW and PH are the sums of their components', () => {
    expect(PW).toBeCloseTo(M_IN + FR + TB_W + FR + M_OUT, 12)
    expect(PH).toBeCloseTo(M_TB + HEAD + FR + TB_H + FR + FOOT + M_TB, 12)
    // The v1.0 table had 20.90/31.85, which clipped the frame band and footer by 0.1·qfs.
    expect(PW).toBeCloseTo(21, 12)
    expect(PH).toBeCloseTo(31.95, 12)
  })

  it('derives the text block, single-page footprint and offsets', () => {
    expect(TB_H).toBeCloseTo(26.25, 12)
    expect(LH).toBe(1.75)
    expect(SHIFT).toBeCloseTo(0.5, 12)
    expect(SINGLE_W).toBeCloseTo(22, 12)
    expect(BLOCK_TOP).toBeCloseTo(2.85, 12)
    expect(BLOCK_OUTER).toBeCloseTo(2.75, 12)
    expect(BLOCK_INNER).toBeCloseTo(1.75, 12)
    expect(BLOCK_INNER + TB_W + BLOCK_OUTER).toBeCloseTo(PW, 12)
    expect(OPENING_TOP_LINES).toBe(3.5)
    // The frame's bottom edge is where the page-number band starts (the page rail's reveal zone).
    expect(FRAME_BOTTOM).toBeCloseTo(PH - FOOT - M_TB, 12)
    expect(FRAME_BOTTOM).toBeCloseTo(29.95, 12)
    expect(FRAME_BOTTOM).toBeCloseTo(BLOCK_TOP + TB_H + FR, 12)
  })

  it('page.css mirrors every constant as a --mp-* custom property', () => {
    const css = readFileSync(resolve('src/styles/mushaf/page.css'), 'utf8')
    const factor = (name: string): number => {
      const m = new RegExp(`--mp-${name}:\\s*calc\\(var\\(--qfs\\)\\s*\\*\\s*([\\d.]+)\\)`).exec(css)
      if (!m?.[1]) throw new Error(`page.css has no --mp-${name}: calc(var(--qfs) * <n>)`)
      return Number(m[1])
    }
    expect(factor('pw')).toBeCloseTo(PW, 12)
    expect(factor('ph')).toBeCloseTo(PH, 12)
    expect(factor('tb-w')).toBeCloseTo(TB_W, 12)
    expect(factor('lh')).toBeCloseTo(LH, 12)
    expect(factor('fr')).toBeCloseTo(FR, 12)
    expect(factor('head')).toBeCloseTo(HEAD, 12)
    expect(factor('foot')).toBeCloseTo(FOOT, 12)
    expect(factor('m-out')).toBeCloseTo(M_OUT, 12)
    expect(factor('m-in')).toBeCloseTo(M_IN, 12)
    expect(factor('m-tb')).toBeCloseTo(M_TB, 12)
    expect(factor('block-top')).toBeCloseTo(BLOCK_TOP, 12)
    expect(factor('block-outer')).toBeCloseTo(BLOCK_OUTER, 12)
    expect(factor('block-inner')).toBeCloseTo(BLOCK_INNER, 12)
    expect(factor('opening-inset')).toBeCloseTo(OPENING_INSET, 12)
    expect(css).toMatch(/--mp-tb-h:\s*calc\(var\(--mp-lh\)\s*\*\s*15\)/)
  })

  it('lines.css centres the opening block with the same offset', () => {
    const css = readFileSync(resolve('src/styles/mushaf/lines.css'), 'utf8')
    expect(css).toMatch(new RegExp(`\\(var\\(--l\\) - 1 \\+ ${OPENING_TOP_LINES}\\)`))
  })
})

describe('fitLayout acceptance table', () => {
  type Row = {
    name: string
    canvas: [number, number]
    spread: boolean
    dock: 'side' | 'bar' | 'compact'
    qfs: number
    scroll: boolean
  }
  const rows: Row[] = [
    {
      name: '1366×768',
      canvas: canvas([1366, 768]),
      spread: true,
      dock: 'compact',
      qfs: 19.75,
      scroll: false,
    },
    {
      name: '1536×864 (1920×1080 @125 %)',
      canvas: canvas([1536, 864]),
      spread: true,
      dock: 'compact',
      qfs: 22.75,
      scroll: false,
    },
    { name: '1920×1080', canvas: canvas([1920, 1080]), spread: true, dock: 'bar', qfs: 28.75, scroll: false },
    {
      name: '1920×1080, sidebar closed',
      canvas: canvas([1920, 1080], { sidebar: false }),
      spread: true,
      dock: 'side',
      qfs: 31.5,
      scroll: false,
    },
    {
      name: '1536×864, sidebar and side pane open (S32)',
      canvas: canvas([1536, 864], { pane: true }),
      spread: false,
      dock: 'compact',
      qfs: 22.75,
      scroll: false,
    },
    {
      name: '1024×700 (S29)',
      canvas: canvas([1024, 700]),
      spread: false,
      dock: 'compact',
      qfs: 18,
      scroll: true,
    },
  ]

  it('derives the documented canvases from the window sizes', () => {
    expect(rows.map((r) => r.canvas)).toEqual([
      [1014, 728],
      [1184, 824],
      [1568, 1040],
      [1868, 1040],
      [784, 824],
      [672, 660],
    ])
  })

  it.each(rows)('$name → spread $spread, $dock dock, qfs $qfs', (row) => {
    const [w, h] = row.canvas
    expect(fitLayout(w, h, 'auto', 100)).toEqual({
      spread: row.spread,
      dock: row.dock,
      qfs: row.qfs,
      scroll: row.scroll,
    })
  })

  it('1366×768: the side-dock single page would be 21.75, and the spread wins at ≥ 0.85 of it', () => {
    const [w, h] = canvas([1366, 768])
    expect(fitLayout(w, h, 'single', 100)).toEqual({ spread: false, dock: 'side', qfs: 21.75, scroll: false })
    expect(19.75 / 21.75).toBeGreaterThanOrEqual(0.85)
  })

  it('S29: the raw fit is 17.65, below the legibility floor', () => {
    const [, h] = canvas([1024, 700])
    expect((h - 2 * 16 - 64) / PH).toBeCloseTo(17.65, 2)
  })
})

describe('fitLayout page modes, zoom and edge cases', () => {
  it('single mode never spreads; spread mode always does', () => {
    for (const [w, h] of [
      [1868, 1040],
      [1014, 728],
      [672, 660],
    ] as const) {
      expect(fitLayout(w, h, 'single', 100).spread).toBe(false)
      expect(fitLayout(w, h, 'spread', 100).spread).toBe(true)
    }
  })

  it('forced spread on a narrow canvas uses the bar dock at the width fit', () => {
    // 784×824: barSpreadQ = min(22.79, 736 / 42 = 17.52) → floor 18.
    expect(fitLayout(784, 824, 'spread', 100)).toEqual({
      spread: true,
      dock: 'compact',
      qfs: 18,
      scroll: true,
    })
  })

  it('takes a side-dock single page when it fits and a bar spread is much smaller', () => {
    // Tall and narrow: a bar spread (34.57) would be well under 85 % of the height-fit single page (42.82).
    const r = fitLayout(1500, 1400, 'auto', 100)
    expect(r.spread).toBe(false)
    expect(r.dock).toBe('side')
    expect(r.qfs).toBe(snapQfs((1400 - 32) / PH))
    expect(r.qfs).toBe(42.75)
  })

  it('the dock is compact below 860 px of canvas height and a bar at or above it', () => {
    expect(fitLayout(1300, 859, 'auto', 100).dock).toBe('compact')
    expect(fitLayout(1300, 860, 'auto', 100).dock).toBe('bar')
  })

  it('zoom multiplies the fit, snaps to quarter px and scrolls above 100 %', () => {
    const [w, h] = canvas([1920, 1080])
    expect(fitLayout(w, h, 'auto', 200)).toEqual({ spread: true, dock: 'bar', qfs: 57.75, scroll: true })
    expect(fitLayout(w, h, 'auto', 110).qfs).toBe(snapQfs((((h - 32 - 84) / PH) * 110) / 100))
    for (const zoom of [50, 80, 90, 110, 130, 150, 300]) {
      const { qfs } = fitLayout(w, h, 'auto', zoom)
      expect(qfs * 4).toBe(Math.round(qfs * 4))
    }
  })

  it('applies the legibility floor before zoom, so only an explicit zoom-out goes below 18', () => {
    const [w, h] = canvas([1024, 700])
    expect(fitLayout(w, h, 'auto', 100).qfs).toBe(QFS_MIN)
    expect(fitLayout(w, h, 'auto', 50).qfs).toBe(9)
    expect(fitLayout(w, h, 'auto', 50).scroll).toBe(true)
    expect(fitLayout(w, h, 'auto', 10).qfs).toBe(8)
  })

  it('ranks the legibility floor above the spread preference in auto (S29)', () => {
    // A spread just below the floor would scroll; the single page beside the card fits at 20.75 and does not.
    expect(fitLayout(800, 700, 'auto', 100)).toEqual({
      spread: false,
      dock: 'side',
      qfs: 20.75,
      scroll: false,
    })
    expect(fitLayout(800, 700, 'spread', 100)).toEqual({
      spread: true,
      dock: 'compact',
      qfs: QFS_MIN,
      scroll: true,
    })
    // S29 in the app (1024×700 at 130 %: the sidebar floats, a 736×498 canvas): both fall below the floor, and only
    // the single page still fits the width at QFS_MIN, so the canvas scrolls vertically only.
    expect(fitLayout(736, 498, 'auto', 100)).toEqual({
      spread: false,
      dock: 'side',
      qfs: QFS_MIN,
      scroll: true,
    })
    expect(2 * PW * QFS_MIN).toBeGreaterThan(736 - 48)
    // A spread that still fits the width at the floor keeps the preference.
    expect(fitLayout(900, 560, 'auto', 100)).toEqual({
      spread: true,
      dock: 'compact',
      qfs: QFS_MIN,
      scroll: true,
    })
  })

  it('caps qfs at QFS_MAX', () => {
    expect(fitLayout(20000, 12000, 'auto', 300).qfs).toBe(QFS_MAX)
  })

  it('keeps the book above a persistent slot bar: qfs is capped, the spread and the dock stay', () => {
    const BAR = 54
    // S27: 1600 × 1000, single page beside the side card, the memorisation toolbar 24 px above the canvas bottom.
    const [w, h] = canvas([1600, 1000], { sidebar: false })
    const plain = fitLayout(w, h, 'single', 100)
    expect(plain).toEqual({ spread: false, dock: 'side', qfs: 29, scroll: false })
    expect(slotBottom('side')).toBe(24)
    const clear = slotClearance('side', BAR)
    expect(clear).toBe(24 + BAR + SLOT_CLEAR_GAP)
    const memo = fitLayout(w, h, 'single', 100, clear)
    expect(memo).toEqual({ spread: false, dock: 'side', qfs: snapQfs((h - 16 - clear) / PH), scroll: false })
    // The page box ends at least `clear` above the canvas bottom when the book is centred in what the stage leaves.
    expect(16 + PH * memo.qfs + clear).toBeLessThanOrEqual(h + 1e-6)
    // A bar-dock spread keeps its dock and spread; only qfs shrinks (the slot sits above the bar dock there).
    const spread = fitLayout(w, h, 'auto', 100)
    const above = fitLayout(w, h, 'auto', 100, slotClearance(spread.dock, BAR))
    expect([above.spread, above.dock]).toEqual([spread.spread, spread.dock])
    expect(above.qfs).toBeLessThan(spread.qfs)
    expect(slotClearance('bar', BAR)).toBe(88 + BAR + 12)
    expect(slotClearance('compact', BAR)).toBe(80 + BAR + 12)
    // No bar, no change; a clearance within the dock reserve changes nothing either.
    expect(slotClearance('side', 0)).toBe(0)
    expect(fitLayout(w, h, 'auto', 100, 0)).toEqual(spread)
    expect(fitLayout(w, h, 'auto', 100, 16 + 84)).toEqual(spread)
    // Below the floor the canvas scrolls instead.
    expect(fitLayout(w, 520, 'single', 100, 200).scroll).toBe(true)
  })

  it('treats an unmeasured canvas and invalid zoom safely', () => {
    const expected = { spread: false, dock: 'compact', qfs: QFS_MIN, scroll: true }
    expect(fitLayout(0, 0, 'auto', 100)).toEqual(expected)
    expect(fitLayout(Number.NaN, -5, 'auto', 100)).toEqual(expected)
    expect(fitLayout(Infinity, Infinity, 'auto', 100)).toEqual(expected)
    const [w, h] = canvas([1920, 1080])
    expect(fitLayout(w, h, 'auto', Number.NaN)).toEqual(fitLayout(w, h, 'auto', 100))
    expect(fitLayout(w, h, 'auto', 0)).toEqual(fitLayout(w, h, 'auto', 100))
  })

  it('is stable across every page mode for a sweep of canvases (no NaN, floor respected, quarter steps)', () => {
    const modes: PageMode[] = ['auto', 'single', 'spread']
    for (let w = 300; w <= 4000; w += 97) {
      for (let h = 300; h <= 2400; h += 83) {
        for (const mode of modes) {
          const r = fitLayout(w, h, mode, 100)
          expect(Number.isFinite(r.qfs)).toBe(true)
          expect(r.qfs).toBeGreaterThanOrEqual(QFS_MIN)
          expect(r.qfs * 4).toBe(Math.round(r.qfs * 4))
          // The fitted pages never overflow the canvas unless the floor forced scrolling.
          if (!r.scroll) {
            const pagesW = (r.spread ? 2 * PW : SINGLE_W) * r.qfs
            const reserveW = r.dock === 'side' ? 288 : 0
            expect(pagesW).toBeLessThanOrEqual(w - 48 - reserveW + 1e-6)
            const reserveH = r.dock === 'side' ? 0 : h < 860 ? 64 : 84
            expect(PH * r.qfs).toBeLessThanOrEqual(h - 32 - reserveH + 1e-6)
          }
        }
      }
    }
  })
})

describe('snapQfs', () => {
  it('rounds down to quarter px without floating-point losses', () => {
    expect(snapQfs(22.75)).toBe(22.75)
    expect(snapQfs(22.7499)).toBe(22.5)
    expect(snapQfs(19.781)).toBe(19.75)
    expect(snapQfs(0.1 + 0.2 + 22.45)).toBe(22.75)
  })
})

describe('paneCanDock', () => {
  it('docks a 400 px pane with the sidebar open at 1366×768, 1536×864 and 1920×1080 (S32)', () => {
    for (const win of [
      [1366, 768],
      [1536, 864],
      [1920, 1080],
    ] as [number, number][]) {
      const [w, h] = canvas(win)
      expect(paneCanDock(w, h, 400)).toBe(true)
    }
  })

  it('does not dock when the remaining width cannot hold a single page', () => {
    const [w, h] = canvas([1024, 700])
    // 672 − 400 = 272 < 22 × 17.65 + 64.
    expect(paneCanDock(w, h, 400)).toBe(false)
    expect(paneCanDock(w, h, 320)).toBe(false)
    expect(paneCanDock(0, 0, 320)).toBe(false)
  })

  it('matches the documented inequality at its boundary', () => {
    const h = 824
    const need = SINGLE_W * ((h - 32 - 64) / PH) + 48 + 16
    expect(paneCanDock(Math.ceil(need) + 400, h, 400)).toBe(true)
    expect(paneCanDock(Math.floor(need) - 1 + 400, h, 400)).toBe(false)
  })

  it('is monotonic in the pane width', () => {
    for (const [w, h] of [canvas([1366, 768]), canvas([1200, 900]), canvas([1600, 1000])]) {
      let docked = true
      for (let pane = 240; pane <= 900; pane += 4) {
        const now = paneCanDock(w, h, pane)
        if (!docked) expect(now).toBe(false)
        docked = now
      }
    }
  })
})

describe('page boxes', () => {
  it('odd pages sit on the right, even pages on the left', () => {
    expect(pageSide(1)).toBe('right')
    expect(pageSide(2)).toBe('left')
    expect(pageSide(261)).toBe('right')
    expect(pageSide(604)).toBe('left')
  })

  it('pages 1 and 2 are the opening pages', () => {
    expect([0, 1, 2, 3, 604].map(isOpeningPage)).toEqual([false, true, true, false, false])
  })

  it('puts the text block against the outer margin of its side', () => {
    const qfs = 20
    const page = pageBox(qfs)
    expect(page.w).toBeCloseTo(420, 9)
    expect(page.h).toBeCloseTo(639, 9)
    const right = blockBox(qfs, 'right')
    const left = blockBox(qfs, 'left')
    expect(right.y).toBeCloseTo(57, 9)
    expect(right.w).toBeCloseTo(330, 9)
    expect(right.h).toBeCloseTo(525, 9)
    // Right page: spine margin on the left (1.75 qfs), outer margin on the right (2.75 qfs).
    expect(right.x).toBeCloseTo(35, 9)
    expect(PW * qfs - (right.x + right.w)).toBeCloseTo(55, 9)
    // Left page mirrors it.
    expect(left.x).toBeCloseTo(55, 9)
    expect(PW * qfs - (left.x + left.w)).toBeCloseTo(35, 9)
  })

  it('a single page shifted by ±SHIFT keeps the text block at the same x on both sides', () => {
    const qfs = 22.75
    const rightX = blockBox(qfs, 'right').x + SHIFT * qfs
    const leftX = blockBox(qfs, 'left').x - SHIFT * qfs
    expect(rightX).toBeCloseTo(leftX, 9)
  })

  it('places lines on the 1.75 qfs pitch, and opening lines in the centred, inset block', () => {
    expect(lineBox(20, 1)).toEqual({ x: 0, y: 0, w: 330, h: 35 })
    expect(lineBox(20, 15).y).toBeCloseTo(14 * 35, 9)
    const first = lineBox(20, 1, true)
    const last = lineBox(20, 8, true)
    expect(first.x).toBeCloseTo(44, 9)
    expect(first.w).toBeCloseTo(330 - 88, 9)
    // The 8-line block is centred in the 15-line block.
    expect(first.y).toBeCloseTo(TB_H * 20 - (last.y + last.h), 9)
  })
})

describe('lineFit', () => {
  it('never stretches a short line', () => {
    expect(lineFit(300, 250)).toEqual({ fit: 1, fx: 1, fy: 1 })
    expect(lineFit(300, 300)).toEqual({ fit: 1, fx: 1, fy: 1 })
  })

  it('squeezes horizontally only down to 0.96', () => {
    const f = lineFit(300, 310)
    expect(f.fit).toBeCloseTo(300 / 310, 12)
    expect(f.fx).toBe(f.fit)
    expect(f.fy).toBe(1)
    expect(lineFit(96, 100)).toEqual({ fit: 0.96, fx: 0.96, fy: 1 })
  })

  it('scales uniformly below 0.96, so letterforms keep their proportions', () => {
    const f = lineFit(90, 100)
    expect(f.fit).toBeCloseTo(0.9, 12)
    expect(f.fx).toBe(f.fy)
    expect(f.fit).toBeLessThan(FIT_UNIFORM_BELOW)
  })

  it('leaves unmeasured lines alone', () => {
    expect(lineFit(0, 100)).toEqual({ fit: 1, fx: 1, fy: 1 })
    expect(lineFit(100, 0)).toEqual({ fit: 1, fx: 1, fy: 1 })
    expect(lineFit(Number.NaN, 100)).toEqual({ fit: 1, fx: 1, fy: 1 })
  })
})

describe('fitLines', () => {
  /** A rendition whose line widths are faked (jsdom has no layout); records the order of reads and writes. */
  function rendition(lines: { box: number; natural: number | null }[]) {
    const log: string[] = []
    const root = document.createElement('div')
    root.className = 'mp-glyphs'
    lines.forEach(({ box, natural }, i) => {
      const ln = document.createElement('div')
      ln.className = 'ln'
      ln.dataset.l = String(i + 1)
      Object.defineProperty(ln, 'clientWidth', {
        get: () => {
          log.push(`read ln${i + 1}`)
          return box
        },
      })
      const setProperty = ln.style.setProperty.bind(ln.style)
      ln.style.setProperty = (name: string, value: string | null) => {
        log.push(`write ln${i + 1} ${name}`)
        setProperty(name, value)
      }
      if (natural !== null) {
        const lw = document.createElement('div')
        lw.className = 'lw'
        Object.defineProperty(lw, 'offsetWidth', {
          get: () => {
            log.push(`read lw${i + 1}`)
            return natural
          },
        })
        ln.append(lw)
      }
      root.append(ln)
    })
    return { root, log }
  }

  it('writes --fx/--fy per line after reading every width first', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { root, log } = rendition([
      { box: 330, natural: 300 },
      { box: 330, natural: 340 },
      { box: 330, natural: 400 },
      { box: 330, natural: null }, // a header line: no .lw
    ])
    const report = fitLines(root)
    const lines = [...root.querySelectorAll<HTMLElement>('.ln')]
    const prop = (i: number, name: string) => lines[i]?.style.getPropertyValue(name)
    expect([prop(0, '--fx'), prop(0, '--fy')]).toEqual(['1', '1'])
    expect([prop(1, '--fx'), prop(1, '--fy')]).toEqual([(330 / 340).toFixed(4), '1'])
    expect([prop(2, '--fx'), prop(2, '--fy')]).toEqual([(330 / 400).toFixed(4), (330 / 400).toFixed(4)])
    expect(prop(3, '--fx')).toBe('')
    const firstWrite = log.findIndex((e) => e.startsWith('write'))
    const lastRead = log.findLastIndex((e) => e.startsWith('read'))
    expect(lastRead).toBeLessThan(firstWrite)
    expect(report).toEqual({ lines: 3, squeezed: 2, uniform: 1, minFit: 330 / 400 })
    // Lines needing more than 2 % are logged for tuning.
    expect(debug).toHaveBeenCalledTimes(2)
    debug.mockRestore()
  })

  it('leaves a rendition that is not laid out untouched', () => {
    const { root, log } = rendition([{ box: 0, natural: 0 }])
    expect(fitLines(root)).toEqual({ lines: 0, squeezed: 0, uniform: 0, minFit: 1 })
    expect(log.some((e) => e.startsWith('write'))).toBe(false)
  })
})
