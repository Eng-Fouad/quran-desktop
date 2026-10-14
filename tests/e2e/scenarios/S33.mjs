// @ts-check
// S33: all four margin marks on page 262 (the 261–262 spread, hafs), in paper and in night:
//   - ayah bookmarks on 15:1 (stacked under the juz 14 marker of line 3) and on 15:9,
//   - a note on 15:4–5 (its glyph on 15:4's line; the tooltip shows the note's first 80 characters),
//   - the reading bookmark at 15:6: the silk ribbon hanging at the spine down to that line, and its popover,
//   - a page bookmark on 262: the dog-ear at the outer top corner.
// The marks are seeded through the user commands; where those are not available (a browser mock without the mutation
// handlers), straight into the mock's `user` slice, then the app is relaunched so every store starts from them.
import { check, equal, mushaf } from '../lib/index.mjs'
import { furniture } from './_furniture.mjs'

/** @type {import('../lib/types').ScenarioMeta} */
export const meta = {
  window: [1600, 1000],
  ui: 'en',
  theme: 'paper',
  mode: 'both',
  settings: { mushafStyle: 'hafs', pageMode: 'spread', highlightBookmarks: true },
  description: 'All four margin marks (ayah bookmark, note, reading ribbon, page dog-ear), paper and night',
}

const PAGE = 262
/** Ayah ids on page 262: 15:1 = 1803. */
const A = (/** @type {number} */ ayah) => 1802 + ayah
const NOTE =
  '**Leave them** to eat and enjoy themselves: the respite of this life is short. Compare 15:3 with 47:12 and 77:46, ' +
  'where the same warning closes the passage.'

/** @param {import('../lib/types').ScenarioContext} ctx */
export default async function s33(ctx) {
  await seed(ctx)
  const { qd } = ctx
  await qd.goto({ type: 'page', data: { page: PAGE } })
  await qd.waitIdle()
  await ctx.wait(200)

  const r = await furniture(ctx, PAGE)
  equal(
    r.marks.map((m) => [m.kind, m.ayah]),
    [
      ['bookmark', A(1)],
      ['note', A(4)],
      ['bookmark', A(9)],
    ],
    'the ayah bookmarks and the note glyph, in line order',
  )
  // The 15:1 bookmark stacks after the juz marker of line 3 (0.2 qfs below it).
  const marker = r.markers.find((m) => m.line === 3)
  const first = r.marks[0]
  check(marker && first, 'a marker and a mark on line 3')
  if (marker && first)
    check(first.top > marker.top + marker.height, 'the line-3 bookmark sits under the marker')
  check(r.ribbon !== null, 'the reading ribbon')
  equal(r.ribbon?.ayah, A(6), 'the ribbon marks 15:6')
  check(
    (r.ribbon?.width ?? 0) > 0.5 && (r.ribbon?.width ?? 0) < 0.6,
    `ribbon width ${r.ribbon?.width} qfs (0.55)`,
  )
  // Spine side: page 262 is a left page, its spine on the right (x from 21 − 0.9 qfs).
  check((r.ribbon?.x ?? 0) > 20.1, `ribbon at x ${r.ribbon?.x} qfs, in the spine margin of a left page`)
  check(r.dogEar, 'the page dog-ear')

  await ctx.shot()
  await ctx.shot('page', { selector: mushaf.page(PAGE) })

  // The note's tooltip and the ribbon's popover.
  await ctx.page.locator(`${mushaf.page(PAGE)} .mm[data-kind="note"]`).hover()
  await ctx.wait(700)
  const tip = (await ctx.page.locator('.mk-tip-quote').first().textContent())?.trim() ?? ''
  check(
    tip.startsWith('Leave them to eat') && tip.length <= 81,
    `the note preview (${tip.length} chars): ${tip}`,
  )
  await ctx.shot('note', { idle: false })
  await ctx.page.mouse.move(0, 0)
  await ctx.page.locator(`${mushaf.page(PAGE)} .mp-ribbon`).click()
  await ctx.wait(400)
  check((await ctx.page.locator('.rb').count()) === 1, 'the reading-bookmark popover')
  await ctx.shot('ribbon', { idle: false })
  await ctx.page.keyboard.press('Escape')
  await ctx.wait(300)

  await qd.setSettings({ theme: 'night' })
  await qd.waitIdle()
  await furniture(ctx, PAGE)
  await ctx.shot('night')
  await ctx.shot('night-page', { selector: mushaf.page(PAGE) })
}

/**
 * Puts the marks into the user data and relaunches.
 * @param {import('../lib/types').ScenarioContext} ctx
 */
async function seed(ctx) {
  const { qd } = ctx
  try {
    await qd.ipc('bookmarkToggleAyah', A(1))
    await qd.ipc('bookmarkToggleAyah', A(9))
    await qd.ipc('bookmarkUpsert', {
      id: null,
      kind: 'page',
      ayahId: A(1),
      layout: 'v2',
      page: PAGE,
      label: null,
      collectionIds: [],
      tagIds: [],
    })
    await qd.ipc('noteUpsert', {
      id: null,
      fromAyahId: A(4),
      toAyahId: A(5),
      title: null,
      body: NOTE,
      tagIds: [],
    })
    await qd.ipc('readingBookmarkSet', { ayahId: A(6), layout: 'v2', page: PAGE })
  } catch (e) {
    if (ctx.mode !== 'web') throw e
    ctx.log(
      `user commands unavailable in the mock (${e instanceof Error ? e.message : String(e)}): seeding its storage`,
    )
    const now = Math.floor(Date.now() / 1000)
    await ctx.page.evaluate(
      ({ now, note, ids }) => {
        const key = 'qd-mock-v1:user'
        const user = JSON.parse(localStorage.getItem(key) ?? 'null') ?? {}
        const bookmark = (/** @type {string} */ id, /** @type {number} */ ayah, kind = 'ayah') => ({
          id,
          kind,
          ayahId: ids.first + ayah - 1,
          surah: 15,
          ayah,
          layout: kind === 'page' ? 'v2' : null,
          page: kind === 'page' ? 262 : null,
          label: null,
          collectionIds: [],
          tagIds: [],
          createdAt: now,
          updatedAt: now,
        })
        user.bookmarks = [bookmark('s33-b1', 1), bookmark('s33-b9', 9), bookmark('s33-p262', 1, 'page')]
        user.notes = [
          {
            id: 's33-n1',
            fromAyahId: ids.first + 3,
            toAyahId: ids.first + 4,
            title: null,
            body: note,
            tagIds: [],
            createdAt: now,
            updatedAt: now,
          },
        ]
        user.readingBookmark = { ayahId: ids.first + 5, layout: 'v2', page: 262, updatedAt: now - 3 * 86_400 }
        localStorage.setItem(key, JSON.stringify(user))
      },
      { now, note: NOTE, ids: { first: A(1) } },
    )
  }
  await ctx.relaunch()
}
