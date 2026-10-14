// @ts-check
// Shared checks of the furniture scenarios (S03, S04, S06, S08, S13, S33): what a page's furniture shows and where,
// measured in the page against the page geometry in qfs units. Not a scenario (the registry skips files starting with
// `_`).
import { check, equal } from '../lib/index.mjs'

/** @typedef {import('../lib/types').ScenarioContext} ScenarioContext */
/** @typedef {ReturnType<typeof inspectFurniture>} FurnitureReport */

/**
 * Runs in the page: the furniture of one `section.mp` and its geometry problems. Every length is compared in qfs units
 * with a 0.75 px tolerance (sub-pixel layout).
 * @param {number} pageNo
 */
export function inspectFurniture(pageNo) {
  /** @type {string[]} */
  const problems = []
  const section = /** @type {HTMLElement | null} */ (
    document.querySelector(`section.mp[data-page="${pageNo}"]`)
  )
  if (!section) {
    return {
      ok: false,
      problems: [`no section.mp for page ${pageNo}`],
      qfs: Number.NaN,
      side: '',
      opening: false,
      frame: null,
      medallion: false,
      edges: { shown: false, count: 0 },
      head: null,
      foot: '',
      headers:
        /** @type {{ line: number, surah: number, decor: boolean, name: string, width: number }[]} */ ([]),
      basmalas: /** @type {{ line: number, decor: boolean, text: string }[]} */ ([]),
      markers:
        /** @type {{ kind: string, line: number, glyph: string, ornament: boolean, label: string, print: boolean, inside: boolean, mid: number, top: number, height: number }[]} */ ([]),
      marks: /** @type {{ kind: string, ayah: number, top: number }[]} */ ([]),
      ribbon: /** @type {{ ayah: number, height: number, x: number, width: number } | null} */ (null),
      dogEar: false,
      sajdaOverlines: 0,
    }
  }
  const qfs = Number.parseFloat(section.style.getPropertyValue('--qfs'))
  const near = (/** @type {number} */ a, /** @type {number} */ b, tol = 0.75) => Math.abs(a - b) <= tol
  const page = section.getBoundingClientRect()
  const side = section.dataset.side ?? ''
  const opening = section.hasAttribute('data-opening')

  // The frame: the SVG covers the page; its outer rule is the block grown by FR = 0.85 qfs.
  const svg = /** @type {SVGSVGElement | null} */ (section.querySelector(':scope > svg.mp-frame'))
  /** @type {{ outer: number[], stroke: number, inner: number, stars: number, tiles: number } | null} */
  let frame = null
  if (svg) {
    const box = svg.getBoundingClientRect()
    if (!near(box.width, 21 * qfs) || !near(box.height, 31.95 * qfs))
      problems.push(`frame svg ${box.width}×${box.height}, expected the page ${21 * qfs}×${31.95 * qfs}`)
    const rule = /** @type {SVGRectElement | null} */ (svg.querySelector('rect.rule'))
    if (rule) {
      const stroke = Number(rule.getAttribute('stroke-width'))
      const x = Number(rule.getAttribute('x')) - stroke / 2
      const y = Number(rule.getAttribute('y')) - stroke / 2
      const w = Number(rule.getAttribute('width')) + stroke
      const h = Number(rule.getAttribute('height')) + stroke
      const expectedX = (side === 'right' ? 0.9 : 1.9) * qfs
      if (!near(x, expectedX) || !near(y, 2 * qfs) || !near(w, 18.2 * qfs) || !near(h, 27.95 * qfs))
        problems.push(
          `frame box ${[x, y, w, h].join(',')}, expected ${[expectedX, 2 * qfs, 18.2 * qfs, 27.95 * qfs]}`,
        )
      if (!near(stroke, 0.09 * qfs, 0.05)) problems.push(`outer rule ${stroke}, expected ${0.09 * qfs}`)
      const inner = Number(svg.querySelector('path.rule')?.getAttribute('stroke-width'))
      if (!near(inner, Math.max(1, 0.04 * qfs), 0.05)) problems.push(`inner rule ${inner}`)
      frame = {
        outer: [x, y, w, h].map((v) => Math.round((v / qfs) * 100) / 100),
        stroke,
        inner,
        stars: (svg.querySelector(':scope > path.star')?.getAttribute('d') ?? '').split('M').length - 1,
        tiles: svg.querySelectorAll('pattern').length,
      }
    } else problems.push('frame svg without its outer rule')
  }
  const edgeBox = /** @type {HTMLElement | null} */ (section.querySelector(':scope > .mp-edges'))
  const edges = {
    shown: edgeBox !== null && getComputedStyle(edgeBox).display !== 'none',
    count: edgeBox?.children.length ?? 0,
  }

  /**
   * An item's words: the text, or for a glyph of the print's calligraphy (`qd-print-labels`) the words it stands for,
   * which its `data-text` carries.
   * @param {Element | null | undefined} el
   */
  const words = (el) => {
    const tagged =
      el instanceof HTMLElement && el.dataset.text !== undefined ? el : el?.querySelector('[data-text]')
    return ((tagged instanceof HTMLElement ? tagged.dataset.text : el?.textContent) ?? '').trim()
  }

  // Running heads: in the HEAD band above the frame; the print's calligraphy when its face is loaded.
  const headEl = /** @type {HTMLElement | null} */ (section.querySelector(':scope > .mp-head'))
  /** @type {{ surah: string, juz: string, size: number, print: boolean } | null} */
  let head = null
  if (headEl) {
    const box = headEl.getBoundingClientRect()
    if (!near(box.top - page.top, 0.6 * qfs) || !near(box.height, 1.4 * qfs))
      problems.push(
        `running head band ${box.top - page.top}+${box.height}, expected ${0.6 * qfs}+${1.4 * qfs}`,
      )
    const size = Number.parseFloat(getComputedStyle(headEl).fontSize)
    if (!near(size, Math.max(0.5 * qfs, 12), 0.1)) problems.push(`running head size ${size}`)
    const surahText = words(headEl.querySelector('.mp-head-surah'))
    const juzText = [...(headEl.querySelector('.mp-head-juz')?.children ?? [])]
      .map(words)
      .filter(Boolean)
      .join(' ')
    head = { surah: surahText, juz: juzText, size, print: headEl.hasAttribute('data-print') }
  }

  // Footer: the page number in Eastern Arabic numbers, centred under the block in a rosette tinted by its own fill (no
  // separate disc, whose circle left the lobes bare).
  const footEl = /** @type {HTMLElement | null} */ (section.querySelector(':scope > .mp-foot'))
  const foot = footEl?.textContent?.trim() ?? ''
  const block = section.querySelector('.mp-block')?.getBoundingClientRect()
  const medallionEl = footEl?.querySelector('.mp-foot-medallion')?.getBoundingClientRect()
  if (footEl && block && medallionEl) {
    const centre = medallionEl.left + medallionEl.width / 2
    if (!near(centre, block.left + block.width / 2, 1))
      problems.push(`footer off the block's centre by ${centre - (block.left + block.width / 2)}`)
    if (!near(medallionEl.width, 1.1 * qfs))
      problems.push(`footer medallion ${medallionEl.width}, expected ${1.1 * qfs}`)
    if (!near(medallionEl.top + medallionEl.height / 2 - page.top, (31.95 - 0.6 - 0.7) * qfs, 1))
      problems.push('footer medallion not centred in the FOOT band')
  }
  const medallionSvg = footEl?.querySelector('.mp-foot-medallion > svg')
  if (medallionSvg) {
    const shapes = medallionSvg.querySelectorAll('path, circle, ellipse, rect, polygon, polyline, line')
    const rosette = medallionSvg.querySelector(':scope > path.rosette')
    if (shapes.length !== 1 || !rosette)
      problems.push(`footer medallion draws ${shapes.length} shapes, not one rosette`)
    else {
      const paint = getComputedStyle(rosette)
      if (paint.fill === 'none' || Number(paint.fillOpacity) === 0)
        problems.push('footer rosette is not tinted')
    }
  }

  // Header and basmala lines of the visible rendition.
  const layer = [...section.querySelectorAll('.mp-block > .mp-glyphs')].at(-1)
  const headers = [...(layer?.querySelectorAll('.ln[data-k="surah_name"]') ?? [])].map((ln) => {
    const el = /** @type {HTMLElement | null} */ (ln.querySelector('.sh-line'))
    const art = el?.querySelector('.sc, .sh')?.getBoundingClientRect()
    return {
      line: Number(/** @type {HTMLElement} */ (ln).dataset.l),
      surah: Number(el?.dataset.surah ?? 0),
      decor: el?.hasAttribute('data-decor') ?? false,
      name: el?.querySelector('.sc-name')?.textContent?.trim() ?? '',
      width: art ? Math.round((art.width / qfs) * 100) / 100 : 0,
    }
  })
  const basmalas = [...(layer?.querySelectorAll('.ln[data-k="basmallah"]') ?? [])].map((ln) => {
    const el = /** @type {HTMLElement | null} */ (ln.querySelector('.bsm-line'))
    return {
      line: Number(/** @type {HTMLElement} */ (ln).dataset.l),
      decor: el?.hasAttribute('data-decor') ?? false,
      text: el?.querySelector('.bsm')?.textContent?.trim() ?? '',
    }
  })

  // Margin markers and marks: in the outer margin, centred on their line. `mid`: the middle of the label's box where
  // layout put it (its `translate` moves only the ink onto it), in qfs from the page top; for the print's label that
  // box is the ink of its kind, which an ornament's box centres on the line (owner request 2026-10-13).
  const margin = /** @type {HTMLElement | null} */ (section.querySelector(':scope > .mp-markers'))
  const markers = [...(margin?.querySelectorAll('.mk') ?? [])].map((el) => {
    const box = el.getBoundingClientRect()
    const line = Number(/** @type {HTMLElement} */ (el).dataset.line)
    const outer =
      side === 'right' ? page.right - (box.left + box.width / 2) : box.left + box.width / 2 - page.left
    if (!near(outer, 0.95 * qfs, 1.5)) problems.push(`marker on line ${line} at ${outer} from the outer edge`)
    const labelEl = /** @type {HTMLElement | null} */ (el.querySelector('.mk-label'))
    const labelBox = labelEl?.getBoundingClientRect()
    const shift = labelEl
      ? Number.parseFloat(getComputedStyle(labelEl).translate.split(' ')[1] ?? '0') || 0
      : 0
    return {
      kind: /** @type {HTMLElement} */ (el).dataset.kind ?? '',
      line,
      glyph: el.querySelector('.mk-glyph')?.textContent ?? '',
      ornament: el.querySelector('.mk-glyph')?.hasAttribute('data-ornament') ?? false,
      label: words(labelEl),
      print: labelEl?.hasAttribute('data-print') ?? false,
      inside: labelEl?.hasAttribute('data-inside') ?? false,
      mid: labelBox
        ? Math.round(((labelBox.top - shift + labelBox.height / 2 - page.top) / qfs) * 100) / 100
        : Number.NaN,
      top: Math.round(((box.top - page.top) / qfs) * 100) / 100,
      height: Math.round((box.height / qfs) * 100) / 100,
    }
  })
  const marks = [...section.querySelectorAll(':scope > .mp-marks .mm')].map((el) => ({
    kind: /** @type {HTMLElement} */ (el).dataset.kind ?? '',
    ayah: Number(/** @type {HTMLElement} */ (el).dataset.ayah),
    top: Math.round(((el.getBoundingClientRect().top - page.top) / qfs) * 100) / 100,
  }))
  const ribbonEl = /** @type {HTMLElement | null} */ (section.querySelector(':scope > .mp-ribbon'))
  const ribbonBox = ribbonEl?.getBoundingClientRect()
  const ribbon =
    ribbonEl && ribbonBox
      ? {
          ayah: Number(ribbonEl.dataset.ayah),
          height: Math.round((ribbonBox.height / qfs) * 100) / 100,
          x: Math.round(((ribbonBox.left - page.left) / qfs) * 100) / 100,
          width: Math.round((ribbonBox.width / qfs) * 100) / 100,
        }
      : null
  const sajdaOverlines = [...(layer?.querySelectorAll('.w-sajda') ?? [])].filter((w) =>
    getComputedStyle(w).textDecorationLine.includes('overline'),
  ).length

  return {
    ok: problems.length === 0,
    problems,
    qfs,
    side,
    opening,
    frame,
    medallion: svg?.querySelector('.opening .medallion') != null,
    edges,
    head,
    foot,
    headers,
    basmalas,
    markers,
    marks,
    ribbon,
    dogEar: section.querySelector(':scope > .mp-dogear') !== null,
    sajdaOverlines,
  }
}

/**
 * Runs in the page: a point of empty canvas (no page, no control) where the pointer can rest, or null.
 * Tried in order: just above the first page, just below it, the canvas corners.
 */
export function restingPoint() {
  const page = document.querySelector('section.mp')?.getBoundingClientRect()
  const view = document.querySelector('main, [role="main"]')?.getBoundingClientRect()
  /** @type {[number, number][]} */
  const candidates = []
  if (page) {
    const x = page.left + page.width / 2
    candidates.push([x, page.top - 6], [x, page.bottom + 6], [page.left - 6, page.top + page.height / 2])
  }
  if (view) candidates.push([view.left + 4, view.top + 4], [view.right - 4, view.top + 4])
  for (const [x, y] of candidates) {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
    const el = document.elementFromPoint(x, y)
    if (
      el &&
      !el.closest(
        'section.mp, button, a, input, [role="button"], [role="slider"], [role="tooltip"], [role="dialog"]',
      )
    )
      return { x, y }
  }
  return null
}

/**
 * Parks the pointer on empty canvas, so no hover tint, hover halo or tooltip leaks into a report or a screenshot (in the
 * real app the OS cursor may rest wherever the window opened, and a click leaves the pointer on its target).
 * @param {ScenarioContext} ctx
 */
export async function restPointer(ctx) {
  const at = await ctx.page.evaluate(restingPoint)
  if (!at) return
  await ctx.page.mouse.move(at.x, at.y)
  // Hover tints and halos fade out over --dur-fast/--dur-quick (≤ 150 ms).
  await ctx.wait(160)
}

/**
 * Inspects a page's furniture, logs a summary and fails on geometry problems. Parks the pointer first (`restPointer`),
 * so the screenshots that follow show the page at rest.
 * @param {ScenarioContext} ctx
 * @param {number} pageNo
 */
export async function furniture(ctx, pageNo) {
  await restPointer(ctx)
  const report = await ctx.page.evaluate(inspectFurniture, pageNo)
  ctx.log(
    `p${pageNo} qfs ${report.qfs}: frame ${JSON.stringify(report.frame?.outer)} head ${JSON.stringify(report.head)} ` +
      `foot ${report.foot} headers ${JSON.stringify(report.headers)} basmalas ${JSON.stringify(report.basmalas)} ` +
      `markers ${JSON.stringify(report.markers)} marks ${JSON.stringify(report.marks)} ribbon ${JSON.stringify(report.ribbon)}`,
  )
  check(report.ok, `page ${pageNo} furniture:\n${report.problems.join('\n')}`)
  return report
}

/** Arabic-Indic digits, as the furniture draws them. @param {number} n */
export const arabic = (n) => new Intl.NumberFormat('ar-u-nu-arab', { useGrouping: false }).format(n)

/** The centre of a line of an ordinary page, in qfs from the page top (block top 2.85 + (line − ½)·1.75). */
export const lineMid = (/** @type {number} */ line) => 2.85 + (line - 0.5) * 1.75

/** The ornaments' heights in qfs (their ink is one em): the lamp, the medallion and, at a juz start, a larger one. */
const ORNAMENT_QFS = { quarter: 3.56, hizb: 3.72, juz: 4.48 }

/**
 * A rub start's marker in the margin's one family (owner request 2026-10-13), at any page size: the print's label in
 * the lamp (U+FC22, a quarter) or the medallion (U+FC23, a hizb or juz start; larger at a juz start), the ornament's
 * box on the line, while decor is loaded; else the label under the solid ۞. Either way the label's box is on the line.
 * @param {FurnitureReport['markers'][number] | undefined} m
 * @param {'quarter' | 'hizb' | 'juz'} kind
 * @param {string} where
 */
export function expectRubMarker(m, kind, where) {
  check(m !== undefined && m.kind === 'rub', `${where}: a rub marker`)
  if (!m) return
  check(m.print, `${where}: the print's own label`)
  const mid = lineMid(m.line)
  if (m.ornament) {
    const lamp = kind === 'quarter'
    equal(
      m.glyph,
      String.fromCodePoint(lamp ? 0xfc22 : 0xfc23),
      `${where}: the ${lamp ? 'lamp' : 'medallion'}`,
    )
    check(
      Math.abs(m.height - ORNAMENT_QFS[kind]) <= 0.05,
      `${where}: the ${kind} ornament ${ORNAMENT_QFS[kind]} qfs tall (${m.height} qfs)`,
    )
    check(m.inside, `${where}: the label inside the ornament`)
  } else {
    equal(m.glyph, '۞', `${where}: the ۞ without decor`)
    check(!m.inside, `${where}: the label under the ۞`)
    check(m.top + m.height / 2 < mid, `${where}: the ۞ above the line (${m.top} qfs, ${m.height} qfs tall)`)
  }
  check(
    Math.abs(m.mid - mid) <= 0.05,
    `${where}: the label's box on line ${m.line} (${m.mid} qfs, not ${mid})`,
  )
}

/**
 * The frame, the footer and the page-stack edges of a spread page.
 * @param {FurnitureReport} report
 * @param {number} pageNo
 */
export function expectFramedPage(report, pageNo) {
  check(report.frame !== null, `page ${pageNo}: no frame`)
  equal(report.frame?.stars, 8, `page ${pageNo}: corner khatams (two squares each, four corners)`)
  equal(report.foot, arabic(pageNo), `page ${pageNo}: the footer number`)
}

/**
 * Whether a decor face is loaded in the document (`qd-surah-header`, `qd-quran-common`, `qd-sura-names`).
 * @param {ScenarioContext} ctx
 * @param {string} family
 */
export function decorLoaded(ctx, family) {
  return ctx.page.evaluate(
    (name) =>
      [...document.fonts].some((f) => f.family.replace(/["']/g, '') === name && f.status === 'loaded'),
    family,
  )
}

/**
 * Waits until a decor face has loaded (a QCF style asks for decor at start-up).
 * @param {ScenarioContext} ctx
 * @param {string} family
 */
export async function waitDecor(ctx, family, timeoutMs = 15_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await decorLoaded(ctx, family)) return true
    await ctx.wait(100)
  }
  return false
}
