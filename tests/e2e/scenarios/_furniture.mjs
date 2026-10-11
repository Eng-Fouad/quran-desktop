// @ts-check
// Shared checks of the WP8c scenarios (S03, S04, S06, S08, S13, S33): what a page's furniture shows and where (§8.8,
// §8.9), measured in the page against the §8.2 geometry in qfs units. Not a scenario (the registry skips files
// starting with `_`). Owner: WP8c.
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
        /** @type {{ kind: string, line: number, glyph: string, label: string, top: number, height: number }[]} */ ([]),
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

  // The frame (§8.9): the SVG covers the page; its outer rule is the block grown by FR = 0.85 qfs.
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

  // Running heads (§8.9): in the HEAD band above the frame.
  const headEl = /** @type {HTMLElement | null} */ (section.querySelector(':scope > .mp-head'))
  /** @type {{ surah: string, juz: string, size: number } | null} */
  let head = null
  if (headEl) {
    const box = headEl.getBoundingClientRect()
    if (!near(box.top - page.top, 0.6 * qfs) || !near(box.height, 1.4 * qfs))
      problems.push(
        `running head band ${box.top - page.top}+${box.height}, expected ${0.6 * qfs}+${1.4 * qfs}`,
      )
    const size = Number.parseFloat(getComputedStyle(headEl).fontSize)
    if (!near(size, Math.max(0.5 * qfs, 12), 0.1)) problems.push(`running head size ${size}`)
    const surahText = headEl.querySelector('.mp-head-surah')?.textContent?.trim() ?? ''
    const juzText = [...(headEl.querySelector('.mp-head-juz')?.children ?? [])]
      .map((c) => c.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
    head = { surah: surahText, juz: juzText, size }
  }

  // Footer (§8.9): the page number in Arabic-Indic digits, centred under the block.
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

  // Header and basmala lines of the visible rendition (§8.8).
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

  // Margin markers and marks (§8.9): in the outer margin, centred on their line.
  const margin = /** @type {HTMLElement | null} */ (section.querySelector(':scope > .mp-markers'))
  const markers = [...(margin?.querySelectorAll('.mk') ?? [])].map((el) => {
    const box = el.getBoundingClientRect()
    const line = Number(/** @type {HTMLElement} */ (el).dataset.line)
    const outer =
      side === 'right' ? page.right - (box.left + box.width / 2) : box.left + box.width / 2 - page.left
    if (!near(outer, 0.95 * qfs, 1.5)) problems.push(`marker on line ${line} at ${outer} from the outer edge`)
    return {
      kind: /** @type {HTMLElement} */ (el).dataset.kind ?? '',
      line,
      glyph: el.querySelector('.mk-glyph')?.textContent ?? '',
      label: el.querySelector('.mk-label')?.textContent?.trim() ?? '',
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

/**
 * The frame, the footer and the page-stack edges of a spread page (§8.9).
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
 * Waits until a decor face has loaded (a QCF style asks for decor at start-up, §8.5).
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
