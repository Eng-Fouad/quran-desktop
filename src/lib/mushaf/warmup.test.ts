/**
 * The shaping warm-up (§8.18): slices of a few lines, laid out and removed at once; preferred pages in idle time (or
 * urgently while flipping), needed pages first; each page once per key and font set.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  glyphKey,
  renditionFontFamily,
  ShapeWarmer,
  WARM_LINES_PER_SLICE,
  WARM_MIN_IDLE_MS,
  WARM_REMEMBER,
  warmPageOf,
  type WarmPage,
} from './warmup'

/** A scheduler the test drives: `idle(n)` runs the pending callback with idle time for `n` slices. */
function manualScheduler() {
  let next: ((deadline: { didTimeout: boolean; timeRemaining(): number }) => void) | null = null
  let handles = 0
  return {
    scheduler: {
      request(run: NonNullable<typeof next>) {
        next = run
        return ++handles
      },
      cancel() {
        next = null
      },
    },
    get scheduled() {
      return next !== null
    },
    idle(slices: number, didTimeout = false) {
      const run = next
      next = null
      let left = slices
      run?.({ didTimeout, timeRemaining: () => (left-- > 0 ? WARM_MIN_IDLE_MS + 10 : 0) })
    },
  }
}

function page(key: string, lineCount: number, words = 3): WarmPage {
  return {
    key,
    family: `"qcf-v2-p${key}"`,
    glyphScale: 1.03,
    lines: Array.from({ length: lineCount }, (_, l) =>
      Array.from({ length: words }, (_, w) => `${key}.${l}.${w}`),
    ),
  }
}

/** Every box the warmer appended to `host`, as the word texts of its lines (recorded before it is removed). */
function recordBoxes(host: HTMLElement): string[][][] {
  const boxes: string[][][] = []
  const append = host.append.bind(host)
  host.append = (...nodes: (Node | string)[]) => {
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue
      expect(node.classList.contains('quran-text')).toBe(true)
      expect(node.lang).toBe('ar')
      expect(node.dir).toBe('rtl')
      expect(node.style.getPropertyValue('--glyph-scale')).toBe('1.03')
      boxes.push(
        [...node.children].map((line) => {
          expect(line.className).toBe('qd-warm-ln')
          return [...line.children].map((span) => span.textContent ?? '')
        }),
      )
    }
    append(...nodes)
  }
  return boxes
}

const hosts: HTMLElement[] = []
afterEach(() => {
  for (const h of hosts.splice(0)) h.remove()
})

function newHost(): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  hosts.push(host)
  return host
}

function setup() {
  const host = newHost()
  const idle = manualScheduler()
  const urgent = manualScheduler()
  const warmer = new ShapeWarmer(idle.scheduler, urgent.scheduler)
  const boxes = recordBoxes(host)
  return { host, idle, urgent, warmer, boxes }
}

describe('ShapeWarmer.prefer', () => {
  it('lays a page out a few lines per idle slice, removes every line at once, and remembers the page', () => {
    const { host, idle, warmer, boxes } = setup()
    warmer.prefer(host, [page('51', 7)])
    expect(idle.scheduled).toBe(true)
    expect(warmer.pending).toBe(1)
    expect(boxes).toHaveLength(0)
    idle.idle(2)
    expect(boxes.map((b) => b.length)).toEqual([WARM_LINES_PER_SLICE, WARM_LINES_PER_SLICE])
    expect(boxes[0]?.[0]).toEqual(['51.0.0', '51.0.1', '51.0.2'])
    expect(host.childElementCount).toBe(0)
    expect(warmer.hasGlyphsNow('51')).toBe(false)
    idle.idle(5)
    expect(boxes.map((b) => b.length)).toEqual([3, 3, 1])
    expect(warmer.hasGlyphsNow('51')).toBe(true)
    expect(warmer.isWarm('51')).toBe(true)
    expect(warmer.pending).toBe(0)
    expect(idle.scheduled).toBe(false)
    // Warm pages are not laid out again for the same font set.
    warmer.prefer(host, [page('51', 7)])
    expect(idle.scheduled).toBe(false)
  })

  it('a newer font set warms the page again; its glyphs count as warm meanwhile', () => {
    const { host, idle, warmer, boxes } = setup()
    warmer.prefer(host, [page('52', 2)], 1)
    idle.idle(1)
    expect(warmer.isWarm('52', 1)).toBe(true)
    warmer.prefer(host, [page('52', 2)], 2)
    expect(warmer.isWarm('52', 2)).toBe(false)
    expect(warmer.hasGlyphsNow('52')).toBe(true)
    idle.idle(1)
    expect(boxes).toHaveLength(2)
    expect(warmer.isWarm('52', 2)).toBe(true)
  })

  it('waits for idle time, but a timed-out callback always gets one slice', () => {
    const { host, idle, warmer, boxes } = setup()
    warmer.prefer(host, [page('3', 2)])
    idle.idle(0)
    expect(boxes).toHaveLength(0)
    expect(idle.scheduled).toBe(true)
    idle.idle(0, true)
    expect(boxes).toHaveLength(1)
    expect(warmer.hasGlyphsNow('3')).toBe(true)
  })

  it('a newer list replaces the queue; duplicates and empty pages are skipped; a page keeps its progress', () => {
    const { host, idle, warmer, boxes } = setup()
    warmer.prefer(host, [page('10', 3), page('11', 3)])
    warmer.prefer(host, [page('20', 3), page('20', 3), page('21', 0), page('22', 9)])
    expect(warmer.pending).toBe(2)
    idle.idle(2)
    expect(boxes.map((b) => b[0]?.[0])).toEqual(['20.0.0', '22.0.0'])
    warmer.prefer(host, [page('23', 3), page('22', 9)])
    idle.idle(10)
    expect(boxes.map((b) => b[0]?.[0])).toEqual(['20.0.0', '22.0.0', '23.0.0', '22.3.0', '22.6.0'])
    warmer.prefer(host, [page('30', 3)])
    warmer.cancel()
    expect(idle.scheduled).toBe(false)
    expect(warmer.pending).toBe(0)
  })

  it('skips a page whose host left the document', () => {
    const { host, idle, warmer, boxes } = setup()
    warmer.prefer(host, [page('40', 6)])
    host.remove()
    idle.idle(10)
    expect(boxes).toHaveLength(0)
    expect(warmer.pending).toBe(0)
    expect(idle.scheduled).toBe(false)
  })

  it(`remembers the last ${WARM_REMEMBER} pages`, () => {
    const { host, idle, warmer } = setup()
    warmer.prefer(
      host,
      Array.from({ length: WARM_REMEMBER + 2 }, (_, i) => page(`k${i}`, 1, 1)),
    )
    idle.idle(1_000)
    expect(warmer.hasGlyphsNow('k0')).toBe(false)
    expect(warmer.hasGlyphsNow('k1')).toBe(false)
    expect(warmer.hasGlyphsNow('k2')).toBe(true)
    expect(warmer.hasGlyphsNow(`k${WARM_REMEMBER + 1}`)).toBe(true)
  })
})

describe('ShapeWarmer.need', () => {
  it('warms a needed page urgently, ahead of the preferred ones, and in its own host', () => {
    const { host, idle, urgent, warmer, boxes } = setup()
    const own = newHost()
    const ownBoxes = recordBoxes(own)
    warmer.prefer(host, [page('80', 3)])
    const cancel = warmer.need(own, page('90', 4))
    expect(urgent.scheduled).toBe(true)
    expect(idle.scheduled).toBe(false)
    urgent.idle(0, true)
    urgent.idle(0, true)
    expect(ownBoxes.map((b) => b[0]?.[0])).toEqual(['90.0.0', '90.3.0'])
    expect(boxes).toHaveLength(0)
    expect(warmer.hasGlyphsNow('90')).toBe(true)
    // Done: the preferred page goes back to idle time.
    expect(idle.scheduled).toBe(true)
    idle.idle(1)
    expect(boxes).toHaveLength(1)
    cancel()
  })

  it('takes over a preferred page part-way, is a no-op when warm, and can be cancelled', () => {
    const { host, idle, urgent, warmer, boxes } = setup()
    warmer.prefer(host, [page('91', 9)])
    idle.idle(1)
    const cancel = warmer.need(host, page('91', 9))
    urgent.idle(0, true)
    expect(boxes.map((b) => b[0]?.[0])).toEqual(['91.0.0', '91.3.0'])
    cancel()
    // Cancelled: the preferred job is still queued, in idle time again.
    expect(urgent.scheduled).toBe(false)
    expect(idle.scheduled).toBe(true)
    warmer.markWarm('92')
    const noop = warmer.need(host, page('92', 3))
    expect(urgent.scheduled).toBe(false)
    noop()
  })
})

describe('ShapeWarmer painted pages (what a flip may show)', () => {
  it('records pages drawn in their font, apart from the warm-up, and forgets them on reset', () => {
    const { host, idle, warmer } = setup()
    warmer.prefer(host, [page('95', 1)])
    idle.idle(1)
    // Laid out off screen is not painted: a flip still shows the fallback for it.
    expect(warmer.hasGlyphsNow('95')).toBe(true)
    expect(warmer.wasPainted('95')).toBe(false)
    warmer.markPainted('95')
    expect(warmer.wasPainted('95')).toBe(true)
    warmer.reset()
    expect(warmer.wasPainted('95')).toBe(false)
    expect(warmer.hasGlyphsNow('95')).toBe(false)
  })
})

describe('keys and pages', () => {
  it('names a QCF page font alone, and the Hafs face over Naskh for Unicode text', () => {
    expect(renditionFontFamily('qcf-v2-p51', false)).toBe('"qcf-v2-p51"')
    expect(renditionFontFamily('"qcf-v4-p7"', false)).toBe('"qcf-v4-p7"')
    expect(renditionFontFamily('qd-hafs', false)).toBe('"qd-hafs", var(--font-naskh)')
    expect(renditionFontFamily('qcf-v2-p51', true)).toBe('"qd-hafs", var(--font-naskh)')
  })

  it('keys a page by style, page, font and size; builds its lines from the page data', () => {
    expect(glyphKey('qcf_v2', 51, 29)).toBe('qcf_v2:51|"qcf-v2-p51"|1.03|29')
    expect(glyphKey('hafs', 51, 29)).toBe('hafs:51|"qd-hafs", var(--font-naskh)|0.82|29')
    const warm = warmPageOf(
      {
        style: 'qcf_v2',
        page: 51,
        lines: [{ words: [] }, { words: [{ glyph: 'a' }, { glyph: 'b' }] }, { words: [{ glyph: 'c' }] }],
      },
      29,
    )
    expect(warm).toEqual({
      key: glyphKey('qcf_v2', 51, 29),
      family: '"qcf-v2-p51"',
      glyphScale: 1.03,
      lines: [['a', 'b'], ['c']],
    })
  })

  it('warms a hafs page at the scale of its spread, which is part of its key', () => {
    expect(glyphKey('hafs', 51, 29, 0.88)).toBe('hafs:51|"qd-hafs", var(--font-naskh)|0.88|29')
    const warm = warmPageOf({ style: 'hafs', page: 51, lines: [{ words: [{ glyph: 'a' }] }] }, 29, 0.88)
    expect(warm.glyphScale).toBe(0.88)
    expect(warm.key).toBe(glyphKey('hafs', 51, 29, 0.88))
    expect(warm.key).not.toBe(glyphKey('hafs', 51, 29))
  })
})
