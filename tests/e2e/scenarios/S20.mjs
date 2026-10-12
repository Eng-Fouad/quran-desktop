// @ts-check
// S20 (§12.6, §9.7; WP10c): the command palette with "2:255". Opens the palette with Mod+K from the reader, types the
// reference and checks the result: the Go to row "Al-Baqarah 2:255" is the first option and active, with the juz/page
// detail and the Arabic name, the field keeps focus, and the dialog sits at 14 vh, 640 px wide. Then close-ups of the
// other states: the empty palette (Recent and Commands), the commands scope ("> theme"), the surah names in the
// sura-names calligraphy once the decor fonts are installed (qcf_v2, when `data/dev-packs` has them), and the Arabic UI
// in the night theme with an Arabic surah name.
import { check, equal, waitUntil } from '../lib/index.mjs'
import { waitDecor } from './_furniture.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'web',
  settings: { pageMode: 'spread' },
  description:
    'Command palette "2:255": the Go to row first and active, plus empty, scoped and Arabic states',
}

const DIALOG = '[role="dialog"]:has([data-command-input])'
const INPUT = `${DIALOG} [data-command-input]`
const OPTIONS = `${DIALOG} [role="option"]`

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s20(ctx) {
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: 1 } })
  await qd.waitIdle()

  // Mod+K from the reader opens the palette with the field focused.
  await ctx.page.locator('main#qd-main').focus()
  await ctx.page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await ctx.page.locator(INPUT).waitFor({ state: 'visible' })
  await settle(ctx)
  equal(
    await ctx.page.evaluate(() => document.activeElement?.hasAttribute('data-command-input')),
    true,
    'focus',
  )

  await ctx.page.keyboard.type('2:255')
  await waitUntil(async () => (await firstOption(ctx)).includes('2:255'), { timeout: 5000 })
  await settle(ctx)

  const report = await ctx.page.evaluate(inspect, { dialog: DIALOG, options: OPTIONS })
  ctx.log(JSON.stringify(report))
  equal(report.value, '2:255', 'the field')
  check(report.options.length >= 1, `options (${report.options.length})`)
  const first = report.options[0]
  check(first !== undefined && /Al-Baqara?h 2:255/u.test(first.text), `first option "${first?.text}"`)
  equal(first?.selected, true, 'the first option is active')
  equal(report.headings[0], 'Go to', 'the first group')
  check(report.activeDescendant === first?.id, 'the field points at the active option')
  check(Math.abs(report.box.width - 640) <= 1, `dialog width ${report.box.width}`)
  check(Math.abs(report.box.top - 0.14 * report.viewport.h) <= 2, `dialog top ${report.box.top}`)
  await ctx.shot()

  // The empty palette: where to pick up (a reading bookmark and some history), then every command.
  await ctx.page.evaluate(seedRecent)
  await ctx.page.keyboard.press('Control+a')
  await ctx.page.keyboard.press('Backspace')
  await waitUntil(async () => (await headings(ctx)).includes('Recent'), { timeout: 5000 })
  await settle(ctx)
  await ctx.shot('empty', { clip: await dialogClip(ctx) })

  // The commands scope: "> theme" turns the prefix into the scope chip.
  await ctx.page.keyboard.type('> theme')
  await waitUntil(async () => (await headings(ctx)).includes('Settings'), { timeout: 5000 })
  await settle(ctx)
  const chip = await ctx.page.locator(`${DIALOG} button.scope`).innerText()
  check(chip.includes('Commands'), `scope chip "${chip}"`)
  equal(await ctx.page.locator(INPUT).inputValue(), 'theme', 'the field after the prefix')
  await ctx.shot('commands', { clip: await dialogClip(ctx) })

  // Escape closes. With a QCF style the decor fonts arrive, and surah names show in the sura-names calligraphy.
  await ctx.page.keyboard.press('Escape')
  await ctx.page.locator(INPUT).waitFor({ state: 'detached' })
  await qd.setSettings({ mushafStyle: 'qcf_v2' })
  await qd.waitIdle()
  // A loaded qd-sura-names face, not `document.fonts.check()`: that is true when no such face is registered at all (no
  // dev packs, as on CI), since nothing would need loading.
  const decor = await waitDecor(ctx, 'qd-sura-names', 6000)
  if (decor) {
    await qd.openOverlay('palette', { query: 'al' })
    await ctx.page.locator(INPUT).waitFor({ state: 'visible' })
    await waitUntil(async () => (await ctx.page.locator(`${DIALOG} .glyph`).count()) > 0, { timeout: 5000 })
    await settle(ctx)
    await ctx.shot('glyphs', { clip: await dialogClip(ctx) })
    await qd.closeOverlays()
    await ctx.page.locator(INPUT).waitFor({ state: 'detached' })
  } else {
    ctx.log('the decor fonts are not in data/dev-packs: no sura-names close-up')
  }

  // The Arabic UI, night theme, with an Arabic surah name.
  await qd.setSettings({ uiLanguage: 'ar', theme: 'night' })
  await qd.waitIdle()
  await qd.openOverlay('palette', { query: 'الكهف' })
  await ctx.page.locator(INPUT).waitFor({ state: 'visible' })
  await waitUntil(async () => (await firstOption(ctx)).includes('الكهف'), { timeout: 5000 })
  await settle(ctx)
  const dir = await ctx.page.evaluate((sel) => document.querySelector(sel)?.getAttribute('dir'), DIALOG)
  equal(dir, 'rtl', 'the dialog direction in the Arabic UI')
  await ctx.shot('ar', { clip: await dialogClip(ctx) })
  await qd.closeOverlays()
}

/** Lets the list's height transition and bits-ui's selection settle. @param {import('../lib/types').ScenarioContext} ctx */
async function settle(ctx) {
  await ctx.wait(260)
}

/** @param {import('../lib/types').ScenarioContext} ctx */
async function firstOption(ctx) {
  const first = ctx.page.locator(OPTIONS).first()
  return (await first.count()) > 0 ? await first.innerText() : ''
}

/** @param {import('../lib/types').ScenarioContext} ctx */
async function headings(ctx) {
  // textContent, not innerText: the Latin headings are uppercased by CSS.
  return ctx.page
    .locator(`${DIALOG} [data-command-group-heading]`)
    .evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ''))
}

/** The dialog plus a margin, for the close-ups. @param {import('../lib/types').ScenarioContext} ctx */
async function dialogClip(ctx) {
  const box = await ctx.page.locator(`${DIALOG}`).boundingBox()
  if (box === null) throw new Error('the palette is not on screen')
  const pad = 32
  return {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: box.width + 2 * pad,
    height: box.height + 2 * pad,
  }
}

/**
 * Runs in the page (browser mock): a reading bookmark at 18:45 three days ago and a few history entries, in the mock's
 * user data (what `history.load()` reads) and in the stores the palette reads.
 */
async function seedRecent() {
  const storesUrl = '/src/lib/stores/index.ts'
  const { history, library, quran } = await import(/* @vite-ignore */ storesUrl)
  const now = Math.floor(Date.now() / 1000)
  const day = 86_400
  const bookmark = { ayahId: quran.ayahId(18, 45), layout: 'v2', page: 297, updatedAt: now - 3 * day }
  /** @type {[number, number, 'read' | 'listen' | 'memorize', number, number][]} */
  const rows = [
    [36, 1, 'listen', 440, 2 * 3600],
    [67, 1, 'read', 562, day + 3600],
    [2, 255, 'memorize', 42, 2 * day],
    [55, 1, 'read', 531, 5 * day],
  ]
  const entries = rows.map(([surah, ayah, mode, page, ago], i) => ({
    id: 100 - i,
    at: now - ago,
    mode,
    layout: 'v2',
    page,
    ayahId: quran.ayahId(surah, ayah),
    dwellS: 60,
  }))
  const mock = /** @type {any} */ (window).__QD_MOCK__
  mock?.state?.user?.update((/** @type {any} */ u) => {
    u.history = entries
    u.readingBookmark = bookmark
  })
  library.readingBookmark = bookmark
  history.entries = entries
}

/**
 * Runs in the page: the palette's geometry, field, headings and options.
 * @param {{ dialog: string, options: string }} sel
 */
function inspect(sel) {
  const dialog = document.querySelector(sel.dialog)
  const r = dialog?.getBoundingClientRect()
  const input = dialog?.querySelector('[data-command-input]')
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    box: { top: Math.round(r?.top ?? 0), width: Math.round(r?.width ?? 0) },
    value: input instanceof HTMLInputElement ? input.value : '',
    activeDescendant: input?.getAttribute('aria-activedescendant') ?? null,
    headings: [...(dialog?.querySelectorAll('[data-command-group-heading]') ?? [])].map(
      (h) => h.textContent?.trim() ?? '',
    ),
    options: [...document.querySelectorAll(sel.options)].map((o) => ({
      id: o.id,
      text: (o.textContent ?? '')
        .replace(/[\u2066-\u2069]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim(),
      selected: o.getAttribute('aria-selected') === 'true',
    })),
  }
}
