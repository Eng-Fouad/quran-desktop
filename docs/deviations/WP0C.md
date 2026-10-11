# WP0C deviations (frontend contract and skeleton)

## Deviations from ARCHITECTURE.md

1. **More frozen contract files in `src/lib/contracts/`** (all WP0C-owned, §14.2 "src/lib/contracts/**"):
   - `i18n.ts`: `Plural`, `Widen`, `Dict`, `I18nKey` from the §11.1 code block, plus `TextKey`/`PluralKey`,
     `ShortcutLabelKey` (`shortcuts.*` only), `ErrorKey`, `PLURAL_CATEGORIES`. The frozen `ar/index.ts` needs `Dict`, so it
     cannot live in the non-frozen `i18n/index.ts` (which re-exports it).
   - `shortcuts.ts`: `ShortcutDef`, `ShortcutGroup`, `ShortcutScope`, `SHORTCUT_GROUPS` (§7.7), so the six shortcut files
     owned by five packages import one frozen type. `ShortcutDef.keys` documents a `Ctrl+` prefix for macOS `Mod+Ctrl+f`.
   - `stores.ts`: the §7.9 `Store` interface and the cross-package value types `ResolvedTheme`, `Dock`, `Tone`,
     `ToastOptions`, `ContextMenuTarget`.
   - `settings.ts`: `defaultSettings()` (the TS twin of `Settings::default()`, unit-tested against
     `crates/quran-types/tests/data/settings_default.json`) and `SETTING_LIMITS` (quran-types `limits`). Used by the
     settings store before bootstrap and by the mock.
   - `Placeholder.svelte`: the labelled box of §14.2 (`data-placeholder`, `data-owner`), used by every placeholder.
2. **`components.ts` declares props beyond §7.9** for every component one package renders inside another package's
   component: `RenditionStack` (WP8b), `GlyphLayer` (WP8a, bindable `element`), `HighlightLayer`/`A11yLayer` (WP8d),
   page furniture (`PageFrame`, `RunningHead`, `PageFooter`, `MarginMarkers`, `MarginMarks`: `PageFurnitureProps`),
   `HeaderLine`/`BasmalaLine`, `SurahCartouche` (also used by WP11a's `SurahCard`), `CollectionsPicker`/`TagPicker`
   (WP11d, used by WP11c), `NoteEditorProps` (= `OverlayProps['note-editor']` + `compact`, for WP11b's Notes tab, §9.7),
   and `OverlayComponentProps<K>`. `WordBox`/`Rect` live here; `layout.ts` re-exports them. Components used only inside
   their own package are prop-less placeholders whose owner defines the props.
3. **i18n typing.** `t(key: TextKey)` and `tp(key: PluralKey)` instead of `I18nKey` for both (both are subsets of
   `I18nKey`), so passing a plural to `t` or a string to `tp` is a compile error. A dictionary group with both `one` and
   `other` keys is a plural by definition (documented on `Plural`).
4. **Frozen dictionaries beyond the §11.1 seed.** `common` adds `appName`, `copied`, `stop`, `open`, `back`, `next`,
   `previous`, `done`, `skip`, `dismiss`, `clear`, `reset`, `more`, `on`, `off`, `yes`, `no`, `page`, `juz`, `hizb`,
   `surah`, `ayah`, `pageNumber`, `juzNumber`, `hizbNumber`, `meccan`, `medinan` and the plurals `ayahCount`, `pageCount`.
   `shortcuts` adds `groups.*` (sheet headings), `keys.*` (spelled-out key names for `format()`) and `or`. `errors` keys are
   the snake_case `AppError` kinds (`errors.not_found`), matching "errors.<AppError kind>". Every §10.1 row has a label
   (80 labels; `Shift+F10` is under `study.contextMenu`, `Mod+z`/`Mod+Shift+z` under `app.undo`/`app.redo`).
5. **Settings store `reset` clash.** §7.3 gives the settings store a `reset()` that resets the settings, but §7.9 makes
   `reset()` the store contract (back to pre-`init` state). The settings action is `resetToDefaults()`.
6. **Sanitiser policy.** The DOMPurify allow-list adds `mark` (needed for `SearchHit.snippet`, §5.6, rendered through
   `SafeHtml`). An `a` without a valid `data-ref` is unwrapped; `data-ref` must match `^\d{1,3}:\d{1,3}(-\d{1,3})?$` and
   sit on `a`, `data-fn` must match `s:a:n` (any Unicode digits for `n`, e.g. Bengali) and sit on `sup`. A private
   DOMPurify instance carries the hooks. Extra exports: `renderSafeFragment`, `renderSafeHtml`, `parseRef`.
7. **IPC wrapper (`ipc/index.ts`).** `call()` also turns a *rejected* promise into an `IpcError('internal')` (the generated
   `typedError` rethrows `Error`s, e.g. when there is no IPC) and a malformed error object into `internal`. Extra exports:
   `APP_ERROR_KINDS`, `AppErrorKind`, `isIpcError`, `toAppError`, `toIpcError`, `isFontRel`, `Res`,
   `IpcError.toAppError()`. `fontBytes` rejects paths outside the §6.2 font routes before any IPC and maps mock HTTP
   failures to `not_found`/`io`. `__MOCK_IPC__` is not redeclared there (WP0D's `env.d.ts` declares it globally).
8. **Mock event bus (`mock/runtime.ts`).** `mockIPC(fallback, { shouldMockEvents: false })`, with `plugin:event|listen`,
   `unlisten`, `emit` and `emit_to` handled in the fallback: @tauri-apps/api 2.12.2's built-in event mock removes
   listeners by `args.id` while `unlisten` sends `eventId`, so unlistened handlers stayed registered and every later
   emit logged "Couldn't find callback id" (a unit test covers it). Also answered: `plugin:window|is_*` → `false`,
   `plugin:webview|*` → `null`.
9. **Mock state (`mock/state.ts`).** Adds a `search` slice (search history, owned by `search.ts`; §5.17 lists no slice for
   it), `user.trash` (tombstones for `*_restore`), id counters, deep merge of stored values over defaults (a new field
   keeps its default), `?mockReset` to start clean, and `state.firstRun` (= no settings stored yet). `installMockRuntime`
   exposes `window.__QD_MOCK__` (`state`, `fixtures`, `listeners`, `reset()`), mock builds only. The mock's `AppInfo` has
   `protocolBase: '/__packs/'` (§5.17 URLs) and `testMode` from `?qdtest`.
10. **Synthetic data (`mock/synthetic.ts`).** Instead of a purely invented index, it embeds Tanzil `quran-data.xml`
    metadata (© Tanzil.info, CC BY 3.0, the source D6 already uses; attribution in the file): the real surah table, juz,
    hizb, rub and manzil starts, the 15 sajdas and Tanzil's 604 page starts (the V1 list, used for all three layouts). Words
    stay placeholders (`كلمة`, end marker U+06DD + Arabic-Indic digits), with invented per-ayah counts that fill each page
    (≈ 9 words per line, 5 on the opening pages, instead of §4.6's flat "15 lines × 8 words"), so synthetic word ids are not
    core.db's 83,665. `syntheticPage()` also works on a fixture index (real ids and per-ayah word counts) for pages outside
    the fixture list. `glyph = text` for every style.
11. **Handler stubs with working bodies** where the shell or WP0E needs them: `app.ts` (bootstrap assembly), `settings.ts`
    (get/set/reset with a `Settings::validated()` twin and `settings-changed`), `mushaf_get_pages` (2–8 ms delay),
    `quran_get_ayahs`, both font commands (hafs `ready`, QCF `unavailable`), audio subscribe/snapshot/reciters/timings,
    packs list/subscribe/items/usage/updates, the read-side user and memo commands, `position_set`, search history. All
    others return `Unsupported("not implemented: <cmd> (browser mock)")`; every handler file is handed over (§5.17 owners).
12. **`main.ts`** loads the Hafs font and the bootstrap in parallel (§7.1 lists them one after the other); both are still
    awaited before mounting. Any failure before mounting (including `initIpc()` outside Tauri) goes to
    `app.failBootstrap(e)` and the fatal screen; `markReady()` runs in both cases (it skips `window_ready` without IPC).
13. **Style files created for the import graph to resolve:** `src/app.css` and `src/styles/{tokens,base,fonts}.css` (WP7a;
    a subset of §9.2–§9.4, the §9.3 `.quran-text` utility, the §8.5 `qd-hafs` face and the §9.3 font imports) and
    `src/styles/mushaf/{page,lines,frame,highlights,spread,memo}.css` (comment-only, owners per §7.1). The frozen
    `styles/mushaf/index.css` uses plain `@import`s; each file wraps its rules in `@layer mushaf { … }` (declared in
    tokens.css).
14. **§9.5 primitives not created.** `src/components/ui/**` (except `SafeHtml.svelte`) is WP7b's outright, §9.5 is a design
    table rather than a frozen props contract, and every consumer package depends on WP7b. Stubs would have invented
    APIs (and `svelte/no-unused-props` rejects stubbed props).
15. **File names chosen for globbed entries:** `settings/sections/{Appearance, Mushaf, Translations, Audio, Memorization,
    Language, Keyboard, Storage, System, About}.svelte` (§7.5 section list) and `onboarding/steps/{Welcome, ReadingSetup,
    Summary, Keys}.svelte` (§9.7 steps). Shortcut files export `appShortcuts`, `navigationShortcuts`, `viewShortcuts`,
    `audioShortcuts`, `memorizeShortcuts`, `studyShortcuts` (`readonly ShortcutDef[]`).
16. **Placeholders that work** beyond a labelled box, so `pnpm dev:web` shows a usable shell: the L0 stores (bootstrap
    data, settings round trip and `<html>` effects, `i18n.locale` derived from `settings.value.uiLanguage`, quran lookups,
    overlay stack, view and pane toggles), `pages` (fetch and cache), `reader` (§7.8 restore, viewport fit with `fitLayout`
    transcribed from §8.2, visible pages), `MushafView`/`MushafPage` (a §8.3/§8.4-style page in the Hafs font with a bounded
    line-fit), `IndexPanel` (surah list that navigates), `TitleBar`, `NavRail`, `Sidebar`, `OverlayHost` (typed
    `OverlayProps[kind]` switch), `FatalScreen`, `PlayerDock`, and `src/lib/util/*` (WP7c). Their owners replace them.
17. **`metrics.ts` owner:** §7.1 says WP8a, §14.3 says WP8b; the file header names WP8b (the ownership list wins).

## Requests

- **Lead:** fold 1–5 into §7.7/§7.9/§11.1 (contracts location, `t`/`tp` key types, `resetToDefaults`); add `mark` to the
  §2.5.6/§7.6 webview allow-list text (6); resolve the `metrics.ts` owner (17); note the @tauri-apps/api mock bug (8).
- **WP0E/WP7c:** the L0 stores already hold working minimums (16); keep the exported names and the `Store` contract.
  `OverlayHost` should keep the typed `top.kind` switch so each overlay stays checked against `OverlayProps`. The
  svelte-sonner `Toaster` is not mounted yet; `ui.toast()` only queues `ui.toasts`.
- **WP7a:** replace `tokens.css`, `base.css`, `fonts.css` and `app.css` wholesale; keep the `@layer` order (the Mushaf
  files rely on `@layer mushaf`) and the import of `styles/mushaf/index.css`. `pnpm lint:css` cannot run until
  `scripts/check-logical-css.mjs` exists; WP0C's physical properties are all in Mushaf geometry and marked
  `/* physical-ok */`.
- **WP8a:** §4.6 wants a visible "synthetic" badge on synthetic pages, but `PageData` has no flag. `fixtures.hasPage(style,
  page)` tells the handler which pages are synthetic; WP8a decides how to surface it (e.g. a mock-only registry the
  renderer can read through a dev hook).
- **WP13a:** in the browser mock, `?qdtest` sets `AppInfo.testMode` and `?mockReset` clears the mock state;
  `window.__QD_MOCK__` gives scenarios direct access to the state slices.
