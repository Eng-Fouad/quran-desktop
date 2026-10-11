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

### Owner request 2026-10-11: the Downloads flyout and the manager's polish

The owner asked to show the Settings and Downloads panels "in a different way" and approved the plan ("Do all, with
your recommendations"). Downloads became two tiers: a compact activity flyout on the rail button, and the manager.

12. **The rail flyout** (`DownloadsFlyout.svelte`, its rules in `flyout.ts`).
    - **No arrow.** The design review kept one, but every popover the app anchors to a chrome button is arrowless
      (Repeat, Speed, More, the reciter picker), as are Windows 11 flyouts. It sits on the rail's inline-end side
      (`right`, `left` in the Arabic UI), `align="end"` (bottom edges aligned, it grows upward), 10 px off the button.
    - **Size.** `min(380px, the room)` wide. Its height cap is 60 % of the window but never under 440 px
      (`flyoutCap`), so under ~500 px of height only the room caps it (the review's `min(60vh, …)` left one row at
      380 × 300). The header and footer stay; the body is a `ScrollArea`.
    - **When it opens.** Always on a click, even idle: the idle flyout offers "Get content" links (Mushaf,
      Recitations, Translations, Tafsir, Word by word) that open the manager on that kind (`openManager(tab)` clears
      the language and search filters, so the tab is never empty). Below 480 × 400 CSS px in **either** dimension
      (`flyoutFits`; the 760 × 600 window at 200 % is 380 × 300) the click opens the manager instead, and the flyout
      closes if the window shrinks under it. While the manager shows, the click returns to the reader. It never
      opens by itself.
    - **Content.** The header row holds the title, the storage total (`usageTotal`, the card's own words) and a thin
      usage bar (`DiskUsageBar variant="strip"`, the same kind colours and the same bar markup as the card); under it
      the Work offline or offline note (the manager's banner titles) and "N updates available · Update all". The
      header and footer are `div`s: the content is portalled to the body, where `header` and `footer` would add a
      banner and a contentinfo landmark. Job rows (running, then queued, paused, failed) show
      "8.2 of 45.7 MB" without the rate and time left (`jobAmount`; the bar's accessible value keeps the full line), and
      the row actions as icon buttons (`rowActions`: Pause/Resume/Retry and Stop, or Cancel for a waiting request).
      "Recently finished" lines read "Downloaded · 318 kB", "Updated", "Downloaded Al-Kawthar" or "3 pages downloaded"
      (`finishedLine`). Opening it refreshes the disk usage and, when online, checks for updates (at most every 6 h).
    - **Keys and focus.** It is a floating layer, which pauses `Mod+Shift+D`; the flyout handles that key itself (a
      window listener while it is open and no overlay is above it, `shortcuts.matches`), since its footer shows it. It
      opens on its heading; Escape or an outside click returns focus to the rail button; when it closes for the
      manager, the manager's heading takes focus instead.
    - `Popover` (WP7b) gains a `role` prop: the flyout's content is `role="dialog"`, which its trigger announces
      (`aria-haspopup="dialog"`).

13. **Store and helpers.**
    - `packs.recent`: the last 5 jobs that **completed** this session (`FinishedJob`: pack, job, KiB, update, items,
      time), newest first, one per pack; a cancelled job is not one. Session state, cleared by `reset()`.
    - `packs.waitingIds` (requests in `waiting`, then jobs the connection broke while the app is still offline) and
      `packs.failedJobs` (failed jobs that do not merely wait); the rail counts both.
    - `actions.ts`: `updateAll()` (moved from `DownloadsView`, shared with the flyout), `openManager(tab?)` and
      `ManagerTab`. `format.ts`: `jobAmount`, `finishedLine`, `usageTotal` ("290 MB used", shared with the card).
      `flyout.ts`: `flyoutFits`, `flyoutCap`, `flyoutJobs`, `aggregateProgress` (the rail ring: KiB received of KiB
      known across queued and running jobs). "Recently finished" lists `packs.recent` as it is (`RECENT_KEPT` caps
      it), with no second limit of its own.
    - `KindTile.svelte`: the pack kind tile, taken out of `PackRow` (36 px there, 32 px in the flyout).

14. **Manager polish.**
    - The manager hides the sidebar (WP7c 27); a rail tab, `Mod+1…7`, `Mod+B` and `Mod+F` return to the reader with
      that panel.
    - Focus: the "Downloads" heading (`data-qd-focus="downloads"`, `tabindex="-1"`) on open; when the manager closes
      for the reader (Escape, the title bar, the rail button), the reading cursor, unless focus went to a rail tab.
    - `PackRow` is a named container (`pack-row`): below 560 px of row the badge and actions wrap under the title, at
      the body's inline start.
    - The dock: the column's end already kept its height free (`dockReserve`); a test now holds the last row above it.

15. **Tests and scenario.** `flyout.browser.test.ts` (9 tests: placement, semantics (no extra landmarks) and
    dismissal; "Get content" and the hidden sidebar; leaving the manager by Escape, the rail, `Mod+1`, `Mod+B`, `Mod+F`;
    job, waiting and finished rows with the rail marks and `Mod+Shift+D` inside; 760 × 600 at 150 % and 200 % in both
    languages, run at their CSS sizes because the mock's CSS zoom moves floating-ui's coordinates; the rail's buttons at
    those sizes (WP7c 26); the dock), `flyout.test.ts`, two store tests in
    `packs.test.ts`, the narrow row and the heading focus in `downloads.browser.test.ts`. S23 also checks the hidden
    sidebar and the rail button's `aria-current`, then returns to the reader and shoots the flyout (`S23-flyout`,
    `S23-flyout-ar`).

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
