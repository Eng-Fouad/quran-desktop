// @ts-check
// S21: translation mode on Al-Fatihah with two translations, one left to right (English) and one right to left (Urdu),
// and a footnote popover open. In the browser mock the two packs are marked installed in the mock catalogue (the
// `packs` slice) and the app is relaunched, the way a user who installed them would open it. Asserts the feed (its
// surah card, seven verses in order, the Arabic in qd-hafs), each translation block's language, direction and
// translator label, and that a footnote marker opens its note in a popover that names the translation.
import { check, equal, waitUntil } from '../lib/index.mjs'

/** An English pack with synthetic footnotes in Al-Fatihah, and an RTL (Urdu) pack. */
export const PACKS = ['tr.en.rwwad', 'tr.ur.junagarhi']

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'web',
  settings: { readingMode: 'translation', translations: PACKS, footnotesInline: false },
  description: 'Translation mode, surah 1, two translations, footnote popover open',
}

/**
 * Marks packs installed in the browser mock's catalogue (the frozen `packs` state slice) and relaunches, so the
 * bootstrap and the packs store see them installed.
 * @param {import('../lib/types').ScenarioContext} ctx
 * @param {readonly string[]} ids
 */
export async function installPacks(ctx, ids) {
  const missing = await ctx.page.evaluate((ids) => {
    /** @type {any} */
    const mock = /** @type {any} */ (window).__QD_MOCK__
    if (!mock) return ['(no browser mock)']
    const found = new Set()
    mock.state.packs.update((/** @type {any} */ value) => {
      for (const p of value.list) {
        if (!ids.includes(p.id)) continue
        p.state = { type: 'installed', data: { version: p.version } }
        p.installedKib = p.sizeKib
        found.add(p.id)
      }
    })
    return ids.filter((id) => !found.has(id))
  }, ids)
  equal(missing, [], 'packs missing from the mock catalogue')
  await ctx.relaunch()
}

/**
 * Waits until the verse `ayahId` is on screen with its text and every translation.
 * @param {import('../lib/types').ScenarioContext} ctx
 * @param {number} ayahId
 * @param {number} packs
 */
export async function waitForVerse(ctx, ayahId, packs) {
  await waitUntil(
    () =>
      ctx.page.evaluate(
        ([id, n]) => {
          const el = document.getElementById(`tv-a${id}`)
          if (!el) return false
          const r = el.getBoundingClientRect()
          return (
            r.bottom > 0 &&
            r.top < innerHeight &&
            el.querySelector('.arabic') !== null &&
            el.querySelectorAll('section.tr').length === n
          )
        },
        [ayahId, packs],
      ),
    { timeout: 10_000, message: `verse ${ayahId} with ${packs} translation(s) on screen` },
  )
}

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s21(ctx) {
  const { qd } = ctx
  if (ctx.mode !== 'web') ctx.pending('S21 seeds installed packs in the browser mock')
  await installPacks(ctx, PACKS)
  await qd.waitIdle()

  const state = await qd.state()
  equal(state.readingMode, 'translation', 'reading mode')
  equal(state.settings.translations, PACKS, 'selected translations')

  // The feed opens at the start of the reader's pages (1–2): the Al-Fatihah card, then its verses.
  await waitForVerse(ctx, 1, PACKS.length)
  const feed = await ctx.page.evaluate(inspectFeed)
  ctx.log(JSON.stringify(feed))
  equal(feed.role, 'feed', 'the verse list role')
  check(feed.card !== null, 'the Al-Fatihah card is rendered')
  if (feed.card) {
    check(feed.card.text.includes('Al-Fatihah'), `card names the surah ("${feed.card.text}")`)
    check(feed.card.text.includes('7 ayahs'), `card counts the ayahs ("${feed.card.text}")`)
    check(!feed.card.basmala, 'no basmala line before Al-Fatihah (its first ayah is the basmala)')
  }
  check(feed.verses.length >= 2, `verses on screen (${feed.verses.length})`)
  equal(feed.verses[0]?.id, 1, 'the first verse')
  for (const v of feed.verses) {
    equal(v.arabicFont.includes('qd-hafs'), true, `verse ${v.id}: Arabic in qd-hafs (${v.arabicFont})`)
    equal(v.arabicDir, 'rtl', `verse ${v.id}: Arabic direction`)
    equal(
      v.blocks.map((b) => b.pack),
      PACKS,
      `verse ${v.id}: translation order`,
    )
    equal(
      v.blocks.map((b) => [b.lang, b.dir]),
      [
        ['en', 'ltr'],
        ['ur', 'rtl'],
      ],
      `verse ${v.id}: block language and direction`,
    )
    equal(
      v.blocks.map((b) => b.label),
      ['Rowwad Translation Center', 'Muhammad Junagarhi'],
      `verse ${v.id}: translator labels`,
    )
  }

  // A footnote: the first verse of Al-Fatihah whose English translation carries a marker.
  const marker = ctx.page.locator('article[data-qd-ayah] section.tr[lang="en"] sup.fn[role="button"]').first()
  check((await marker.count()) === 1, 'a footnote marker in Al-Fatihah')
  const verseId = await marker.evaluate((el) => Number(el.closest('article')?.getAttribute('data-qd-ayah')))
  check(verseId >= 1 && verseId <= 7, `the marker belongs to Al-Fatihah (verse ${verseId})`)
  // Bring that verse up (keeping the card in view when it fits), then open the note.
  await ctx.page.evaluate((id) => {
    const el = document.getElementById(`tv-a${id}`)
    const scroller = document.querySelector('.qd-virtual-list')
    if (!el || !scroller) return
    const r = el.getBoundingClientRect()
    const s = scroller.getBoundingClientRect()
    if (r.bottom > s.bottom - 220) scroller.scrollBy(0, r.bottom - (s.bottom - 220))
  }, verseId)
  await ctx.wait(300)
  equal(await marker.getAttribute('aria-haspopup'), 'dialog', 'the marker announces its popover')
  await marker.click()
  const popover = ctx.page.locator('[data-qd-footnote]')
  await popover.waitFor({ state: 'visible', timeout: 5000 })
  const note = await popover.innerText()
  ctx.log(`footnote: ${note.replace(/\s+/g, ' ')}`)
  check(/Footnote \d+/.test(note), `the popover is titled with its marker ("${note}")`)
  check(note.includes('Rowwad Translation Center'), 'the popover names the translation')
  equal(await marker.getAttribute('aria-expanded'), 'true', 'the marker is expanded')
  await ctx.shot()

  // Escape closes it and returns focus to the marker.
  await ctx.page.keyboard.press('Escape')
  await popover.waitFor({ state: 'hidden', timeout: 5000 })
  const focused = await ctx.page.evaluate(() => document.activeElement?.matches('sup.fn') ?? false)
  check(focused, 'focus is back on the footnote marker')
}

/** Runs in the page: the feed's structure on screen. */
function inspectFeed() {
  const feed = document.querySelector('.qd-virtual-list')
  const visible = (/** @type {Element} */ el) => {
    const r = el.getBoundingClientRect()
    return r.bottom > 0 && r.top < innerHeight
  }
  const card = document.querySelector('article.card[data-surah="1"]')
  const verses = [...document.querySelectorAll('article[data-qd-ayah]')].filter(visible).map((v) => {
    const arabic = v.querySelector('.arabic')
    return {
      id: Number(v.getAttribute('data-qd-ayah')),
      arabicFont: arabic ? getComputedStyle(arabic).fontFamily : '',
      arabicDir: arabic?.getAttribute('dir') ?? '',
      blocks: [...v.querySelectorAll('section.tr')].map((b) => ({
        pack: b.getAttribute('data-pack'),
        lang: b.getAttribute('lang'),
        dir: b.getAttribute('dir'),
        label: b.querySelector('.label')?.textContent?.trim() ?? '',
      })),
    }
  })
  return {
    role: feed?.getAttribute('role') ?? null,
    card: card
      ? {
          text: card.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          basmala: card.querySelector('.basmala') !== null,
        }
      : null,
    verses,
  }
}
