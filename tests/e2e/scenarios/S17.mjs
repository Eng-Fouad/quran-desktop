// @ts-check
// S17: the player dock with the repeat popover open. Plays Al-Fatihah with each ayah ×3 and a gap of ×1.0 the ayah's
// length, waits for the second play of 1:1 (the live badge reads "2/3"), pauses there, and opens the Repeat popover
// from the dock. Asserts the dock geometry (the bar 64 px tall, 10 px above the canvas edge, centred,
// `clamp(min(560px, 100% − 24px), 70%, 880px)` wide), the badge, and the popover's values (each ayah ×3, the
// "× ayah length" gap at ×1). Writes the viewport and a close-up of the dock with the popover.
import { check, equal, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'web',
  settings: { mushafStyle: 'hafs', pageMode: 'spread' },
  description: 'Player dock with the repeat popover open (×3, gap ×1.0), live "2/3" badge',
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s17(ctx) {
  const { qd, page } = ctx
  await qd.goto({ type: 'page', data: { page: 1 } })
  await qd.waitIdle()

  await qd.play({
    reciterId: 7,
    from: { surah: 1, ayah: 1 },
    to: null,
    stopAt: 'end_of_surah',
    layout: 'v2',
    ayahRepeat: 3,
    rangeRepeat: 1,
    gap: { type: 'multiplier', data: { pct: 100 } },
    startPaused: false,
  })
  const badge = page.locator('[data-qd-dock] .repeat .badge')
  await waitUntil(
    async () => ((await badge.count()) > 0 ? (await badge.textContent())?.trim() : '') === '1/3',
    {
      message: 'the first play of 1:1 (badge 1/3)',
      timeout: 5000,
    },
  )
  await waitUntil(async () => (await badge.textContent())?.trim() === '2/3', {
    message: 'the second play of 1:1 (badge 2/3)',
    timeout: 10_000,
    interval: 50,
  })
  await qd.pause()
  await waitUntil(async () => (await qd.state()).player.status === 'paused', {
    message: 'paused',
    timeout: 3000,
  })
  equal((await badge.textContent())?.trim(), '2/3', 'the badge still reads 2/3 once paused')

  await page.locator('[data-qd-dock] .repeat').click()
  const popover = page.locator('[data-qd-popover="repeat"]')
  await waitUntil(async () => (await popover.count()) === 1 && (await popover.isVisible()), {
    message: 'the repeat popover',
    timeout: 3000,
  })
  await page.mouse.move(10, 10) // no tooltip over the popover
  await qd.waitIdle()
  await ctx.wait(250)

  const report = await page.evaluate(measure)
  ctx.log(JSON.stringify(report))
  check(report.ok, report.problems.join('\n'))

  await ctx.shot()
  await ctx.shot('dock', { clip: report.clip })
  await page.keyboard.press('Escape')
}

/** Runs in the page: the dock and popover. */
function measure() {
  /** @type {string[]} */
  const problems = []
  const dock = document.querySelector('[data-qd-dock]')
  const canvas = document.querySelector('main.canvas')?.getBoundingClientRect()
  // The visible pill: the dock's box spans the canvas, so the pill's morph never shifts the layout.
  const d = dock?.querySelector('[data-qd-dock-pill]')?.getBoundingClientRect()
  if (!dock || !d || !canvas)
    return { ok: false, problems: ['no dock or canvas'], clip: { x: 0, y: 0, width: 10, height: 10 } }
  if (dock.getAttribute('data-mode') !== 'bar') problems.push(`mode ${dock.getAttribute('data-mode')}`)
  if (Math.abs(d.height - 64) > 0.5) problems.push(`bar height ${d.height}, expected 64`)
  if (Math.abs(canvas.bottom - d.bottom - 10) > 1)
    problems.push(`bar bottom gap ${canvas.bottom - d.bottom}, expected 10`)
  const centre = (d.left + d.right) / 2 - (canvas.left + canvas.right) / 2
  if (Math.abs(centre) > 1) problems.push(`bar off-centre by ${centre}`)
  const expected = Math.min(880, Math.max(Math.min(560, canvas.width - 24), canvas.width * 0.7))
  if (Math.abs(d.width - expected) > 1) problems.push(`bar width ${d.width}, expected ${expected}`)

  const badge = dock.querySelector('.repeat .badge')?.textContent?.trim()
  if (badge !== '2/3') problems.push(`badge "${badge}"`)
  const pop = document.querySelector('[data-qd-popover="repeat"]')
  const p = pop?.getBoundingClientRect()
  if (!pop || !p) problems.push('no popover')
  const values = [...(pop?.querySelectorAll('output.value') ?? [])].map((o) => o.textContent?.trim())
  if (values[0] !== '×3') problems.push(`each ayah "${values[0]}"`)
  if (values[1] !== 'Off') problems.push(`whole range "${values[1]}"`)
  if (values[2] !== '×1') problems.push(`gap "${values[2]}"`)
  const activeGap = pop?.querySelector('[data-state="on"]')?.textContent?.trim() ?? ''
  if (!activeGap.includes('× ayah length')) problems.push(`gap kind "${activeGap}"`)
  if (p && p.bottom > d.top) problems.push('the popover covers the dock')

  const top = Math.max(0, Math.min(d.top, p?.top ?? d.top) - 24)
  const left = Math.max(0, Math.min(d.left, p?.left ?? d.left) - 24)
  const right = Math.min(window.innerWidth, Math.max(d.right, p?.right ?? d.right) + 24)
  const bottom = Math.min(window.innerHeight, d.bottom + 10)
  return {
    ok: problems.length === 0,
    problems,
    badge,
    values,
    clip: { x: left, y: top, width: right - left, height: bottom - top },
  }
}
