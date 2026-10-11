// @ts-check
// S25 (§12.6, §9.7; WP12c): About and attribution.
//
// About shows in the Settings dialog over the reader (owner request 2026-10-11), named "About Quran for Desktop".
// Browser mock with a lived-in library (`?mockPacks=demo`: two installed translations, Al-Muyassar, the ornaments), so
// the attribution lists installed packs with their versions. Checks: the header (64 px app icon, name, version, the
// "core.db: … · schema 1" build line, Copy diagnostics), every §9.7 group in order (the app itself: its
// GPL-3.0-or-later licence, its "Source code" link to the workspace's Cargo `repository`, and the Quran.com credit for
// its name and icon, LEAD.md item 16; Quran text and layout with
// Tanzil's CC BY 3.0 and its link; the fonts with the KFGQPC Hafs licence and the "Quran fonts provided by Quran
// Foundation" credit; each installed translation with its version; tafsir; recitations with QuranicAudio's
// personal-use terms), the bundled Hafs licence and GPL texts, and the collapsible open-source list loaded from
// thirdparty.json.
// Shots: S25.png (the view), S25-licences (open-source list open, filtered, one package expanded), S25-ar (Arabic UI,
// night theme).
import { readFileSync } from 'node:fs'
import { check, equal, includes, waitUntil } from '../lib/index.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'web',
  description: 'About / attribution with installed packs, the Hafs licence and the open-source licences',
}

const VIEW = '[data-qd-view="about"]'

/** The workspace `repository` (Cargo.toml), which the app's "Source code" link must open (GPL §6, `SOURCE_URL`). */
const REPOSITORY =
  /^\s*repository\s*=\s*"([^"]+)"/m.exec(
    readFileSync(new URL('../../../Cargo.toml', import.meta.url), 'utf8'),
  )?.[1] ?? ''

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s25(ctx) {
  const { page, qd } = ctx
  await page.evaluate(() =>
    history.replaceState(
      null,
      '',
      `${location.pathname}${location.search ? `${location.search}&` : '?'}mockPacks=demo`,
    ),
  )
  await qd.goto({ type: 'view', data: { view: 'about' } })
  await page.locator(VIEW).waitFor({ state: 'visible' })
  await waitUntil(
    async () => (await page.locator(`${VIEW} [data-group="translations"] [data-entry]`).count()) > 0,
    {
      timeout: 5000,
      message: 'the installed translations were not credited',
    },
  )
  await qd.waitIdle()

  // In the Settings dialog's frame, the reader still mounted under it.
  const dialog = page.locator(`[role="dialog"]:has(${VIEW})`)
  equal(await dialog.count(), 1, 'About in the Settings dialog')
  equal(
    await dialog.evaluate((el) =>
      (el.getAttribute('aria-labelledby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .join(' '),
    ),
    'About Quran for Desktop',
    'the dialog name',
  )
  check((await page.locator('[data-qd-view="mushaf"]').count()) === 1, 'the reader stays mounted')

  const report = await page.evaluate(inspect, VIEW)
  ctx.log(JSON.stringify(report))
  equal(report.title, 'Quran for Desktop', 'name')
  equal(report.icon, 64, 'app icon size')
  check(/^Version \d/.test(report.version), `version line "${report.version}"`)
  check(/^core\.db: \S+ · .+ · schema 1$/.test(report.build), `build line "${report.build}"`)
  equal(report.groups.join(','), 'app,text,fonts,translations,tafsir,recitations', 'groups in order')
  equal((report.entries.app ?? []).join(','), 'app,app-icon', 'the app: its licence and its icon')
  contains(report.appLicence, 'GPL-3.0-or-later', 'the app licence')
  equal(report.source.text, 'Source code', 'the app entry links its source code')
  check(REPOSITORY.startsWith('https://'), `the Cargo workspace repository "${REPOSITORY}"`)
  equal(report.source.href, REPOSITORY, 'the source link opens the Cargo repository')
  contains(report.iconCredit, 'Quran.com / quran_android contributors', 'the icon credit')
  contains(report.iconLicence, 'GPL-3.0', 'the icon licence')
  includes(report.entries.text ?? [], 'tanzil', 'Tanzil is credited')
  contains(report.tanzilLicence, 'CC BY 3.0', 'Tanzil licence')
  equal(report.tanzilLink, 'https://tanzil.net/', 'Tanzil link')
  includes(report.entries.fonts ?? [], 'kfgqpc-hafs', 'the bundled Hafs font')
  contains(report.qcfCredit, 'Quran fonts provided by Quran Foundation', 'QF credit line')
  includes(report.entries.translations ?? [], 'tr.en.saheeh', 'an installed translation')
  check(/Version \d/.test(report.saheehLine), `translation version ("${report.saheehLine}")`)
  includes(report.entries.tafsir ?? [], 'tafsir.ar.muyassar', 'installed tafsir')
  contains(report.audioLicence, 'personal', 'QuranicAudio terms')
  equal(report.copy, 'Copy diagnostics', 'Copy diagnostics')
  await ctx.shot()

  // The bundled licence of the Hafs font, as plain text.
  await page.locator(`${VIEW} [data-entry="kfgqpc-hafs"] .notice-toggle`).click()
  await page.locator(`${VIEW} [data-entry="kfgqpc-hafs"] pre.notice-text`).waitFor({ state: 'visible' })
  const eula = (await page.locator(`${VIEW} [data-entry="kfgqpc-hafs"] pre.notice-text`).textContent()) ?? ''
  contains(eula, 'ELECTRONIC END-USER LICENSE AGREEMENT', 'the Hafs EULA text')

  // The app's own licence: the repository's LICENSE, the GNU GPL v3 text.
  await page.locator(`${VIEW} [data-entry="app"] .notice-toggle`).click()
  await page.locator(`${VIEW} [data-entry="app"] pre.notice-text`).waitFor({ state: 'visible' })
  const gpl = (await page.locator(`${VIEW} [data-entry="app"] pre.notice-text`).textContent()) ?? ''
  contains(gpl, 'GNU GENERAL PUBLIC LICENSE', 'the GPL text')
  contains(gpl, 'Version 3, 29 June 2007', 'GPL version 3')

  // The open-source licences: collapsed, then loaded on demand.
  equal(await page.locator(`${VIEW} [data-package]`).count(), 0, 'licences start collapsed')
  await page.locator(`${VIEW} [data-action="toggle-licences"]`).click()
  await waitUntil(async () => (await page.locator(`${VIEW} [data-package]`).count()) > 100, {
    timeout: 10_000,
    message: 'thirdparty.json did not load',
  })
  const count =
    (await page.locator(`${VIEW} [data-section="open-source"] .count`).textContent())?.trim() ?? ''
  check(/^\d[\d,]* packages$/.test(count), `package count "${count}"`)
  await page.locator(`${VIEW} [data-section="open-source"] input[type="search"]`).fill('svelte')
  await waitUntil(async () => (await page.locator(`${VIEW} [data-package]`).count()) < 20, { timeout: 5000 })
  await page.locator(`${VIEW} [data-package="svelte"] .pkg-head`).click()
  const licence = (await page.locator(`${VIEW} [data-package="svelte"] pre.pkg-text`).textContent()) ?? ''
  contains(licence, 'Permission is hereby granted', 'svelte ships its MIT text')
  await page.locator(`${VIEW} [data-section="open-source"]`).scrollIntoViewIfNeeded()
  await qd.waitIdle()
  await ctx.shot('licences')

  await qd.setSettings({ uiLanguage: 'ar', theme: 'night' })
  await page.evaluate(
    (sel) => document.querySelector(`${sel} [data-scroll-area-viewport]`)?.scrollTo(0, 0),
    VIEW,
  )
  await qd.waitIdle()
  equal(
    (await page.locator(`${VIEW} h1`).first().textContent())?.trim(),
    'قرآن لسطح المكتب',
    'name in the Arabic UI',
  )
  equal(
    (await page.locator(`${VIEW} #about-attribution`).textContent())?.trim(),
    'المصادر والحقوق',
    'attribution heading in Arabic',
  )
  await ctx.shot('ar')
}

/**
 * Fails unless `text` contains `part`.
 * @param {string} text
 * @param {string} part
 * @param {string} what
 */
function contains(text, part, what) {
  check(text.includes(part), `${what}: expected "${part}" in "${text.slice(0, 160)}"`)
}

/**
 * The About view's content (runs in the page).
 * @param {string} view
 */
function inspect(view) {
  const root = /** @type {HTMLElement} */ (document.querySelector(view))
  const text = (/** @type {string} */ s) =>
    root.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  /** @type {Record<string, string[]>} */
  const entries = {}
  for (const g of root.querySelectorAll('[data-group]')) {
    entries[g.getAttribute('data-group') ?? ''] = [...g.querySelectorAll('[data-entry]')].map(
      (e) => e.getAttribute('data-entry') ?? '',
    )
  }
  const icon = /** @type {HTMLImageElement | null} */ (root.querySelector('.hero img'))
  const tanzilLink = /** @type {HTMLAnchorElement | null} */ (
    root.querySelector('[data-entry="tanzil"] a.site')
  )
  return {
    title: text('h1'),
    icon: icon ? Math.round(icon.getBoundingClientRect().width) : 0,
    version: text('.version-number'),
    build: text('[data-build-line]'),
    copy: text('[data-action="copy-diagnostics"]'),
    groups: [...root.querySelectorAll('[data-group]')].map((g) => g.getAttribute('data-group')),
    entries,
    appLicence: text('[data-entry="app"] .licence'),
    iconCredit: text('[data-entry="app-icon"] .credit'),
    iconLicence: text('[data-entry="app-icon"] .licence'),
    tanzilLicence: text('[data-entry="tanzil"] .licence'),
    tanzilLink: tanzilLink?.href ?? '',
    qcfCredit: text('[data-entry="qcf"] .credit'),
    saheehLine: text('[data-entry="tr.en.saheeh"] .pack-line'),
    audioLicence: text('[data-entry="quranicaudio"] .licence'),
    source: {
      text: text('[data-entry="app"] a.source'),
      href:
        /** @type {HTMLAnchorElement | null} */ (root.querySelector('[data-entry="app"] a.source'))?.href ??
        '',
    },
  }
}
