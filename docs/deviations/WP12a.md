# WP12a deviations (Packs store and Downloads)

Owned and delivered:
- **Store**: `src/lib/stores/packs.svelte.ts` (§7.3 packs), with `packs.test.ts` (the acceptance suite).
- **Downloads manager**: `src/components/downloads/**`: `DownloadsView`, `DiskUsageBar`, `PackSection`, `PackRow`,
  `ReciterRow`, `SurahGrid`, plus `actions.ts` (what the buttons and menus do), `format.ts` (sizes, subtitles,
  monograms), `view.svelte.ts` (open grids) and `downloads.browser.test.ts`.
- **Mock**: `src/lib/ipc/mock/handlers/packs.ts` with `packs.test.ts`.
- **i18n**: `src/lib/i18n/{en,ar}/downloads.ts`.
- **Scenario**: `tests/e2e/scenarios/S23.mjs` (`S23.png`, plus `-top`, `-grid`, `-ar` and `-night`).

## Deviations from ARCHITECTURE.md

1. **Store API beyond §7.3** (all exported names of §7.3 are kept with their meaning):
   - **State**: `language` and `query` (the Downloads filters, next to `filter`), `status`/`error` (the `packs_list`
     load), `pending` (see 2) and `updatesCheckedAt`.
   - **Derived**: `byId`, `updatable` (packs in `update_available`).
   - **Lookups**: `pack(id)`, `jobOf(id)`, `isBusy(id)`, `title(p)`, `reciterPack(reciterId)`, `itemKib(p, item)`
     (the real size once present, else an estimate weighted by the surah's word count), `remainingKib(p)`,
     `defaultTranslation(ui)`, `starterSetFor(choices)`.
   - **Actions**: `installStarter(set)`.
   - **Module helpers**: `isActivePhase`, `ACTIVE_PHASES`, `isInstalled`, `hasContent`, `languageOf`, `reciterIdOf`,
     `mushafPackId`, `itemNoun`, `surahWords`.
   - **Return values**: `removeItems`, `clearStreamCache` and `clearCache` return the KiB freed (the placeholder
     returned `void`). `install`, `update`, `resume`, `retry`, `pause`, `cancel` and `remove` stay `Promise<void>`.
   - **`refresh()` never rejects**: a failure sets `status = 'error'` and `error`, which the view shows with Retry.
     The other actions reject with `IpcError`, and the callers toast it.
2. **One job per pack, without `conflict` in the UI.** `packs_install` answers `conflict` while the pack has a queued
   or running job (WP5b `JobQueue::enqueue`). The store therefore keeps items asked for meanwhile in `pending`
   (merged; `All` wins). The grid shows them queued, and they start as the pack's next job when it completes. A
   cancel or a remove drops them. A failed job keeps them until a retry completes. A click on a pack whose job is
   **paused** or **failed** installs right away: the runner *replaces* that job (its temps are reused), so the
   paused job's other items stop being queued. The UI shows exactly that.
3. **`starterSet` is a `StarterSet`** (`{ items: { pack, fetch: 'now' | 'on_demand' | 'timings_on_first_play', kib
   }[], nowKib }`), not `PackInfo[]`. It mirrors `Catalog::starter_set` and WP5a deviation 5, including the Arabic
   default (`tafsir.ar.muyassar`) and no WBW for Arabic. `nowKib` is what "Download now" fetches: the sizes of
   `now` packs that are **not installed yet** (equal to WP5a's totals on a first run: en 832 KiB = 851,422 B
   rounded up per pack, ar 1,119 KiB). `starterSet` follows the settings (UI language, style, reciter, the UI
   language's default translation). Onboarding passes its own choices to `starterSetFor` and calls
   `installStarter(set)`.
4. **A full download puts the pack to use** (§1.4 "enables the translation in settings"). A translation downloaded
   with scope `All` joins `settings.translations` (up to 5). A tafsir or WBW pack becomes `tafsirPackId`/`wbwPackId`
   when none is set. Updates and per-item downloads change no setting.
5. **`installedTafsir`** includes on-demand Quran.com tafsir that has chapters on disk. Whole packs count when
   installed, update included. **`activeJobs`** are the jobs that are queued, downloading, verifying or installing.
   Paused and failed jobs are not active, so the NavRail dot does not pulse for them.
6. **Online again.** Jobs that failed with `offline` resume by themselves once the app is online with network use
   allowed. The offline banner says so ("Downloads continue when you're back online").
7. **Job toasts.** Completed, updated and failed jobs toast; a failure toast offers Retry. While the Downloads view
   is open, none of them toast: the rows show the outcome in place. Removals and "Clear streaming cache" always
   confirm with a toast.
8. **Downloads view layout (§9.7):**
   - **Header.** The storage card (`DiskUsageBar`) holds the total, the stacked bar, the legend, the data folder and
     the two header actions (Open folder, Clear streaming cache).
   - **Bar.** Segments are sorted by size and coloured like the rows' kind tiles. The streaming cache is the
     half-tone of the recitation accent, as in the grid. Legend entries that need it (streaming cache, online
     content, your library) have a tooltip.
   - **Banners** under the card: Work offline (with "Allow network use"), offline, and "N updates available" with
     Update all.
   - **Filters.** The kind tabs (Mushaf includes the ornament fonts), the language select (text packs only: a
     recitation's `ar` is the Quran's own language) and the search sit in one bar that stays at the top while the
     list scrolls. The tabs carry no counts: each section heading counts its packs instead.
   - **Section order**: Mushaf and fonts, recitations, translations, tafsir, word by word. Language packs list the UI
     language first, then by language name. The current reciter comes first among the recitations.
   - **Rows.** The name carries "In use" (the style, a reading translation, the tafsir or WBW pack, or the reciter
     the settings name) or "Recommended" (recommended, not on disk, in the UI language). The state badge sits on the
     end side, before the actions. Remove is a trash icon button with a confirmation. Stop (cancel) is an × that
     asks first once something was received; it is disabled while `installing`, because the flip is the point of no
     return.
   - **Progress line.** While a job runs it reads "12.4 of 93.2 MB · 1.9 MB/s · 0:42 left". A paused job keeps its
     muted bar and amount, and a failed one shows the reason with the raw message on hover. The bar's width
     transition is off: progress arrives at 10 Hz, and an eased bar would keep a transition running for the whole
     download (QA `waitIdle` would never settle).
   - **The pack's description** (translator, edition) is the name's `title` and screen-reader text. It is not a
     Tooltip, because that would add a tab stop to every row.
9. **SurahGrid details (§9.7).**
   - **Layout.** 19 × 6 cells when there is room; one tab stop with roving focus; arrows mirrored in RTL; Home and
     End go to the first and last surah.
   - **Status line.** Under the grid, it describes the hovered or focused surah ("18. Al-Kahf · Downloaded · 34 MB",
     "about …" for an estimate).
   - **Footer.** The legend with counts, then Remove all and "Download all (1.6 GB)" / "Download the rest (…)".
   - **Surah 1.** While other surahs stay downloaded, surah 1 cannot be removed: its cell is `aria-disabled` and
     explains why (WP5d: `remove_items` must keep it).
   - **Remove.** Removing one surah asks nothing (a click downloads it again); Remove all asks first.
   - **Queued cells** breathe while the pack's job runs (not under reduced motion).
   - **Monograms.** Latin initials skip `Al-`/`Ar-`/… prefixes ("MH" for Al-Husary).
10. **Mock behaviour beyond §5.17** (see the module docs of `handlers/packs.ts`):
    - Throughput is 2 MB/s **per running job** (3 run at once).
    - `?mockPackRate=<MB/s>` changes the throughput; `?mockPackFail=<id>[:<kind>][@<pct>]` fails a pack's next job
      once; `?mockPacks=demo` seeds a lived-in state at the first packs command after the parameter appears.
    - A scope-`All` install also queues the packs it `requires` that are not installed: the ornaments for a
      Mushaf.
    - Interrupted jobs restart after a reload (`JobQueue::restore`).
    - Job scopes are mirrored in `localStorage["qd-mock-v1:packs-sim"]`, next to the `packs` slice.
    - Test and QA hooks: `packsMock.{failNext, setRate, itemKib, reset}`.
11. **Ports.** Web shots ran with `--serve 1768` (this package's assigned range 1768–1771; §14.3 says 1520).

## Requests

- **WP5e (manager and commands)**:
  - The UI relies on these runner semantics, which the mock mirrors: `packs_items` lists the not-yet-present items
    of a running **or paused** job as `queued`; `PackInfo.job` carries the pack's live job; `packs_subscribe`
    returns queued, running, paused and failed jobs.
  - A scope-`All` install of a pack with `requires` should bring the missing requirements (decor for a Mushaf), as
    the mock does. Otherwise a "Download all" of a Mushaf leaves the ornaments out.
  - Per WP5d, the "Update" of a recitation must run `revalidator.revalidate_pack(id)`, but the UI sends
    `packs_install(id, All)` (§5.9). Please route `install(All)` on an `update_available` recitation pack to the
    revalidator.
- **WP9a (audio mock)**: when the mock "streams and caches" a surah, call `recordStreamCached(reciterId, surah)` from
  `src/lib/ipc/mock/handlers/packs.ts`. The surah grid, the Index dots and the ReciterPicker's counts then see
  stream-cached surahs. The ReciterPicker can read `packs.items.get(packId)` (after `packs.loadItems(packId)`) and
  download with `packs.install(packId, { type: 'items', data: { items: [n] } })`.
- **WP8b (fonts mock)**: optionally call `recordCachedItem('mushaf.v{1|2|4}', page)` when a page font is fetched,
  so the Downloads row counts pages read on demand.
- **WP12b (Settings › Storage)**: embed `DiskUsageBar` (`<DiskUsageBar usage={packs.usage} />`; call
  `packs.loadUsage()` on mount). It accepts an optional `actions` snippet. "Clear cache" is `packs.clearCache()`
  (resolves to the KiB freed); open Downloads with `ui.setView('downloads')`.
- **WP12c (onboarding)**:
  - `packs.starterSetFor({ uiLanguage, translation, style, downloadAllPages, reciterId })` gives the exact set in
    §2.5.4 order with `nowKib` (format with `i18n.bytes`). `packs.installStarter(set)` runs "Download now".
  - A translation installed this way is added to `settings.translations` by the store (deviation 4).
- **Lead**: fold deviations 1–10 into §7.3, §9.7 and §5.17.

## Requests from other packages, done here

| From | Request | Where |
|---|---|---|
| WP10a | `loadItems` fills `items` and tolerates calls during a load | `packs.loadItems` joins the load in flight |
| WP5a | Mirror the starter-set rule (en 851,422 B, ar 1,144,830 B) | `starterSetFor`, deviation 3 |
| WP7c | `packs.activeJobs` for the NavRail dot | deviation 5 |
