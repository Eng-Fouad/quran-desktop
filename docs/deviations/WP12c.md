# WP12c deviations (Onboarding and About)

Owned and delivered:
- **Onboarding** (§9.7): `src/components/onboarding/OnboardingDialog.svelte`, `steps/{Welcome, MushafSetup,
  ReadingSetup, Summary, Keys}.svelte`, plus `flow.svelte.ts` (the flow's state), `StepHeader.svelte`,
  `StylePreview.svelte` (the Mushaf step's live preview, owner 2026-10-11), `ThemePreview.svelte` with `themeTokens.ts`
  (theme thumbnails), `OptionCheck.svelte` (the style options' checkbox), `format.ts` and `onboarding.browser.test.ts`
  (the acceptance suite, 20 tests; 37 since the owner's 2026-10-11 request).
- **About** (§9.7): `src/components/about/AboutView.svelte`, `AttributionList.svelte`, plus `OpenSourceList.svelte`,
  `links.ts`, `thirdparty.ts`, `thirdparty.test.ts` and `about.browser.test.ts`; `src/lib/about/attributions.ts` with
  `attributions.test.ts`.
- **i18n**: `src/lib/i18n/{en,ar}/{onboarding, about}.ts`.
- **Scenarios**: `tests/e2e/scenarios/{S01, S02, S25}.mjs` (`S01.png` + `-dialog`, `-night`; `S02.png` + `-dialog`,
  `-offline`; `S25.png` + `-licences`, `-ar`).

## Deviations from ARCHITECTURE.md

### Onboarding

1. **Flow state outside the component.** `OverlayHost` renders only the top overlay, so Mod+K (which the Keys step
   teaches) or any overlay opened on top unmounts the dialog. The choices and the current step therefore live in a
   module singleton (`flow.svelte.ts`), and the dialog comes back on the same step. The flow resets once the dialog has
   closed after Finish or Skip.
2. **What applies when.**
   - The language and the theme apply live (§9.7 "live switch"). The "Work offline" switch is the `networkAllowed`
     setting itself, so it is live too.
   - The Mushaf style and the reciter apply when the starter set is decided, on "Download now" or "Start reading".
     Picking a QCF card therefore neither re-renders the page behind the dialog nor starts a font download. Skip keeps
     the defaults.
   - A translation that is already installed is put to use at that point: it is added to `settings.translations`, or
     a tafsir becomes `tafsirPackId`. A new download is put to use by the packs store (WP12a deviation 4).
3. **Both buttons of step 3 lead to step 4.** Step 3's buttons are "Download now" and "Start reading". Both go on to
   the Keys step, because Finish is what sets `onboardingDone` (§9.7 step 4). After "Download now", the Keys step
   follows the download ("Downloading your starter set · 45%", then "Your starter set is ready"). If part of it fails,
   it offers "Open Downloads", which also finishes the onboarding.
4. **Closing.** (A first run has no Skip and ignores Escape since the owner's 2026-10-11 request: 22.)
   - Finish and Skip set `onboardingDone` and close the dialog.
   - Escape is Skip. It acts in the capture phase, and not while a listbox of the step is open: Escape then closes
     only the listbox.
   - A click outside does nothing (`dismissible={false}`). A stray click on the faint backdrop over the page must not
     end the setup for good.
5. **Offline.** §9.7 names "Work offline". The flow treats "no connection" the same way, through the Downloads
   manager's `networkAllowed && app.online`:
   - the QCF cards are locked ("Needs download — available when you're online");
   - the effective style is Hafs (the chosen card comes back when the app is online again);
   - "Download all pages" is ignored and the reciter preview is disabled;
   - the download rows and "Download now" are disabled.
6. **Style options sit under the cards.** (The cards have their own step since 2026-10-11, and "Ornate surah headers"
   is offered for every style: 23–24.) The chosen style's option is one row under the three cards. For Hafs it is
   "Ornate surah headers · 325 kB", ticked. For a QCF card it is "Download all pages in the background (93 MB)", off.
   Inside each card, the options of the cards not chosen showed disabled checkboxes and pushed the dialog past
   540 px in the Arabic UI. "Download all pages" is offered for Tajweed too (`starterSetFor` supports it).
7. **Decor on the Hafs card.** (Superseded by 24: every style, persisted as `ornateHeaders`.) §2.5.4 puts `decor` in every starter set, and §9.7 offers it on the Hafs card. Unticking
   "Ornate surah headers" therefore removes `decor` from the set, for Hafs only: every `mushaf.*` requires it.
8. **The exact total.** Below 10 MB the total is in kB, grouped and exact: "832 kB", "١٬١١٩ كيلوبايت". It is then the
   sum of the rows above it, which are in kB too. `i18n.bytes` would round 1,119 KiB to "1.1 MB". Larger totals use
   `i18n.bytes`. The totals match WP5a: en 832 KiB (851,422 B), ar 1,119 KiB (1,144,830 B), and "all pages" adds
   `mushaf.v2` (95,458 KiB).
9. **Theme thumbnails read the token sheet.** The tokens apply themes on `:root` only (§9.1), yet each card shows page
   1 in its own theme. `themeTokens.ts` collects the custom properties (and `color-scheme`) that the loaded sheets
   declare for exactly `:root[data-theme="<theme>"]`, in sheet order. They are set on the card's wrapper, so no colour
   is copied into a component and the previews follow `tokens.css`.
   - The Match system card shows `lightVariant` and `darkVariant`, split on a diagonal (mirrored in RTL).
   - The thumbnail is `MushafPage interactive={false}` at qfs 4.25 (inert, `aria-hidden`), with its top rising out of
     the theme's app surface.
10. **Reciter preview.** It plays Al-Fatihah 1:1 through `audio_play` (from = to = 1:1, the chosen reciter,
    `startPaused: false`). Its state follows `audio-state-changed`, and it stops on a step change, a reciter change,
    Work offline, Finish or Skip.
    - It never changes `settings.reciterId`.
    - It calls the command directly: `player` has no "play this reciter without selecting it" method.
    - In the browser mock `audio_play` is still WP9a's stub, so a click there toasts "unsupported".
11. **Focus.** The step title takes focus when the dialog opens (`data-autofocus`) and on every step change, so screen
    readers read the step first. The theme and style cards are radio groups: one tab stop, arrows (mirrored in RTL),
    Home and End.
12. **Copy.**
    - "Next" uses the frozen `common.next`.
    - The feature tiles' counts come from data: `PAGE_COUNT`, and the reciter list's length.
    - The Arabic theme names are ورقي / سيبيا / ليلي / أسود.

### About

13. **The attribution model** (`attributions.ts`) replaces the wave-0 stub's shape.
    - An entry has `{ id, name, credit, licence, url, licenceUrl?, version?, language?, notice? }`. Names, credits and
      licences are `L10nText` data, like the catalogue's attributions. A group is `{ id, entries }`, and
      `AttributionList` takes its title from the `about.groups.*` messages.
    - `attributions` holds the static sources. `attributionGroups({ packs, coreSource })` adds the pack entries.
14. **What is credited.**
    - Static sources: QUL/Tarteel, KFGQPC and Tanzil (CC BY 3.0, with the licence link); the KFGQPC Hafs font; the QCF
      page fonts ("Quran fonts provided by Quran Foundation"); the ornament fonts; the interface typefaces (OFL 1.1);
      QuranicAudio (personal, non-commercial use); and Quran Foundation timings.
    - Packs, with their catalogue attribution, version and language: each installed translation and tafsir (on-demand
      tafsir once it has chapters on disk), word-by-word packs that have content (a "Word by word" group the spec does
      not list: it is QF content), and the Noto Nastaliq font once installed.
    - The translations and tafsir groups say where installed packs will appear while they are empty.
    - A core.db built by the development adapter (`core.source = 'qdc'`) adds a "Quran.com API (development only)"
      entry.
15. **Arabic licence lines.** The catalogue's `licence` strings are English. The Arabic UI shows a translated line for
    the sources recognised by the attribution URL's host: quranenc.com, quran.com, quran.foundation, quranicaudio.com,
    and the Noto font on github.com. Any other host shows the catalogue's line.
16. **The KFGQPC Hafs EULA.** "Show the licence" fetches `public/fonts/KFGQPC-Hafs-V30.LICENSE.txt` (WP3c, served
    beside the font in `dist/`) and renders it as plain text. A response that is HTML (a missing file served as
    `index.html`) counts as an error.
17. **Header additions.**
    - "Open data folder" (`system_reveal_data_dir`).
    - A "Development build" badge when `AppInfo.debug`.
    - The platform line (OS, version, architecture).
    - The name uses `--text-4xl` (§9.3 about/brand).
    - "Copy diagnostics" copies `{ app: AppInfo, session: { uiLanguage, theme, mushafStyle, uiScalePct,
      networkAllowed, online }, userAgent }` and announces "Diagnostics copied".
    - The build line stays technical and LTR in both languages: "core.db: qul · 2026-10-10 · schema 1".
18. **Open-source licences** (`thirdparty.json`, WP3c deviation 1).
    - The file is imported lazily when the section opens, so it is its own ≈ 305 KB chunk and never in the startup
      bundle. It is validated on load: malformed entries are dropped.
    - The list has a filter by name, licence or author.
    - Each package expands to its authors, its declared licence when it differs from the one used, a link to its
      repository, and its licence text as plain text. A package that ships no licence file says so.
19. **Links** open with `system_open_external` (https only) and never navigate the webview.

### Scenarios and ports

20. **Scenarios.**
    - S01 runs with `theme: 'system'` and `colorScheme: 'light'`: the paper look, with Match system selected as on a
      first run.
    - S02 additionally asserts the Work offline lock.
    - S25 uses `?mockPacks=demo` so that installed packs are credited.
    - All three run in `web` mode.
21. **Ports.** Web shots ran with `--serve 1776` (this package's range 1776–1779; §14.3 says 1520).

### Owner request 2026-10-11: a mandatory first run, the Mushaf step and its preview

The owner asked that the onboarding cannot be skipped, and that the Madani 1421 AH print and the ornate surah headers
be selected by default, un-tickable, with a live preview of the Mushaf. Lead decisions: a persistent `ornateHeaders`
setting for every style; the preview fetches while online and the Summary lede says so; mandatory only on a first run.

22. **A first run must be finished.** `flow.mandatory` is `app.firstRun` when the flow is seeded. Then there is no Skip,
    Escape does nothing (the dialog's escape layer swallows it, and `ui.dismissLayer` never closes the onboarding), a
    click outside does nothing, Back stays, and `complete()` acts only on the last step (Finish, or "Open Downloads").
    `complete()` sets `app.firstRun = false`, as Rust's `first_run()` turns false once `onboarding_done` is stored. A tour
    reopened from Settings › System ("Show the welcome tour") keeps Skip, and Escape is Skip there as before. A re-run
    left unfinished by quitting reopens at the next launch as a first run (`first_run()` is true again, since "Show the
    welcome tour" clears `onboardingDone`).
23. **Five steps.** Welcome, Mushaf, Translation and recitation, Starter set, Keys. The Mushaf step stacks the three
    style cards at the inline start (the style's sentence is read with the card and shown under the preview) and puts
    the preview beside them; the reading step keeps the two pickers. Both fit 720 × 540 in English and Arabic (the fit
    test runs every step).
24. **"Ornate surah headers" for every style, persisted.** A new setting, `ornateHeaders` (default true; contract
    change). Unticking it drops `decor` from the starter set for every style, unless "Download all pages" fetches a Mushaf
    pack that requires it (then it downloads but is not drawn). "Download now" and "Start reading" apply it with the
    style. In the reader, off means the plain look in every style, and no style fetches `decor` by itself; on, a QCF style
    fetches it as before, and turning it on fetches it in any style. The surah-name calligraphy of lists comes from the
    same pack and stays whenever it is installed; the setting's description says so, and Settings › Mushaf has the
    switch, with a note giving the download size while `decor` is missing.
25. **First-run choices.** A first run preselects the 1421 AH print (`FIRST_RUN_STYLE = 'qcf_v2'`) with the ornaments
    ticked, unless a style other than the default is stored. The `mushafStyle` default stays `hafs`: an offline first run,
    or one that is never finished, reads Hafs. A re-run starts from the settings (style and `ornateHeaders`). A Tajweed
    card this webview cannot draw (the §8.6 probe failed) is locked with "Not supported on this system", and a Tajweed
    choice then counts as the 1421 AH print, as the fonts store would switch it.
26. **The live preview** is Settings' `PreviewCard` (new optional props `style`, `ornaments`, `qfs`, `label`; it keeps the
    previous page while a new style's page loads) at qfs 14, in the effective style and with the ornaments as ticked,
    through the new `MushafPageProps.ornaments`. Online it fetches page 1's font of the chosen print (interactive lane)
    and, while ticked, installs `decor` once (`flow.requestOrnaments` → `decor_ensure`); the starter set then shows it as
    already downloaded. Offline it shows Hafs and fetches nothing (tested). A status line says when the page or the
    ornaments are still downloading, or that the page shows in Hafs until it downloads. The Summary lede now reads "…
    Apart from the Mushaf preview's first page, nothing is fetched without asking."
27. **Mock fidelity.** The mock's `decor_ensure` records the `decor` pack installed in the packs mock
    (`recordWholeInstalled`, with `packs-changed`), as Rust's `sync_decor_row` does.
28. **Scenarios.** S01 checks "Step 1 of 5" and no Skip; S02 covers the Mushaf step (the 1421 AH print and the ornaments
    preselected, the preview, the fit), then the reading step (new shot `S02-reading`), then the offline lock on the
    Mushaf step with the preview in Hafs.

## Requests

- **WP7c (`App.svelte`): open the onboarding on first run.** Nothing opens the onboarding today. `OnboardingDialog` is
  mounted only by `OverlayHost` once `ui.open('onboarding', {})` has run, so no WP12c file can trigger it. Suggested,
  in `App.svelte`'s `onMount`:
  ```ts
  if (!settings.value.onboardingDone && !app.testMode) ui.open('onboarding', {})
  ```
  Test mode is left out so that QA scenarios are not covered by it; S01 and S02 open it with `openOverlay`.
  `app.firstRun` is equivalent (`first_run()` is "true until onboarding_done is set", §2.2).
- **WP7b (`Select`/`Combobox` in a `Dialog`).** This repeats WP10c's request. A listbox opened in a dialog is portalled
  to `<body>` at `--z-menu` (50), which is under `--z-dialog` (60), so it renders behind the dialog. The onboarding
  works around this with a scoped rule, as the palette does:
  `body:has(.qd-onboarding) .qd-listbox { z-index: calc(var(--z-dialog) + 1) }`. The rule can go once the primitives
  lift floating content above an open dialog.
- **WP7b (`Kbd`).** The caps use `--font-mono`. Arabic key labels from the frozen dictionary, such as "مسافة" for Space,
  fall back to a monospaced face and render with their letters spaced apart. The Keys step sets `--font-ui` on its own
  large caps. The shortcut sheet and tooltips in the Arabic UI would benefit from the same.
- **WP9a (`player`).** A `previewReciter(reciterId, ayah)` method, or `playFrom` with a reciter override, would let the
  preview go through the store. Today it calls `audio_play`/`audio_stop` directly (deviation 10). The mock's
  `audio_play` is needed for the preview to work in the browser mock.
- **WP12b (Settings › About).** The About section can link to this view with `ui.setView('about')`. It can also offer
  "Run setup again": `ui.open('onboarding', {})` works at any time, and the flow seeds itself from the current
  settings.
- **Lead.** Fold deviations 1–19 into §9.7 (onboarding behaviour, starter-set display, About content and the
  attribution model). 22–28 are folded into §9.7, §2.5 and §5.11 (v1.2) and IMPLEMENTATION_NOTES §11.4.
