// @ts-check
// Smoke (also IC1's acceptance in the real app): the app boots into the reader and renders page 1 in the default style
// (hafs) through the real commands, a jump reaches page 262, the overlay stack opens and closes, and a settings change
// survives a relaunch (user.db in the app, the mock's storage in the browser).
import { check, equal, includes, mushaf } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  mode: 'both',
  description: 'Boot, page 1 in hafs, jump to page 262, overlay stack, settings persist across a relaunch',
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function smoke(ctx) {
  const { qd } = ctx

  // 1. First boot: the reader shows the opening spread in the default style.
  let state = await qd.state()
  check(state.ready, 'the app never called markReady()')
  equal(state.fatal, null, 'the fatal message')
  equal(state.view, 'reader', 'the view after the first boot')
  includes(state.visiblePages, 1, 'the pages on screen after the first boot')
  equal(state.style, 'hafs', 'the default Mushaf style')
  const page1 = ctx.page.locator(mushaf.page(1))
  equal(await page1.count(), 1, 'rendered page-1 sections')
  equal(await page1.getAttribute('data-style'), 'hafs', 'data-style of page 1')
  const words = await ctx.page.locator(mushaf.words(1)).count()
  check(words > 0, 'page 1 rendered no words (.mp-glyphs .w)')
  ctx.log(`page 1: ${words} words, pages on screen ${state.visiblePages.join(', ')}, qfs ${state.qfs}`)
  await ctx.shot()

  // 2. A jump renders the target page.
  await qd.goto({ type: 'page', data: { page: 262 } })
  state = await qd.state()
  equal(state.page, 262, 'reader.page after goto(page 262)')
  equal(await ctx.page.locator(mushaf.page(262)).count(), 1, 'rendered page-262 sections')
  check((await ctx.page.locator(mushaf.words(262)).count()) > 0, 'page 262 rendered no words')
  await ctx.shot('p262')

  // 3. The overlay stack.
  await qd.openOverlay('shortcuts')
  equal((await qd.state()).overlays, ['shortcuts'], 'the overlay stack after openOverlay(shortcuts)')
  await qd.closeOverlays()
  equal((await qd.state()).overlays, [], 'the overlay stack after closeOverlays()')

  // 4. A settings change is applied, stored, and still there after a relaunch.
  await qd.setSettings({ theme: 'sepia' })
  equal(
    await ctx.page.evaluate(() => document.documentElement.dataset.theme),
    'sepia',
    'html[data-theme] after setSettings',
  )
  equal((await qd.ipc('settingsGet')).theme, 'sepia', 'settings_get after settings_set')
  await ctx.relaunch()
  state = await qd.state()
  equal(state.settings.theme, 'sepia', 'the stored theme after a relaunch')
  equal(state.resolvedTheme, 'sepia', 'the resolved theme after a relaunch')
  equal(state.view, 'reader', 'the view after a relaunch')
  check(
    (await ctx.page.locator('section.mp .mp-glyphs .w').count()) > 0,
    'no Mushaf words after the relaunch',
  )
  await ctx.shot('relaunch')
}
