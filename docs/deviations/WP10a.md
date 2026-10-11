# WP10a deviations (Quran index store, navigation and Go to)

Delivered:

- `src/lib/text/normalize.ts`: the TS twin of `normalize_ar` (`normalizeAr`, `foldLatin`, `tokens`) on the shared golden
  file `crates/quran-core/tests/data/normalize_vectors.json` (48 vectors, strict and loose, plus the Rust unit examples).
- `src/lib/text/refparse.ts` + `refparse.vectors.json` (68 vectors): §10.4, the target helpers and localised reasons.
- `src/lib/stores/quran.svelte.ts`: `surahMatches` (names + aliases), `rubRange`; the WP0E lookups are unchanged.
- `src/components/index/**`: `IndexPanel`, `SurahList`, `JuzList`, `HizbList`, `PageGrid`, `ContinueCard`, plus
  `Rosette.svelte` (the 8-point star number badge), `navigate.ts` (`openTarget`), `roving.ts` (list/grid keys),
  `format.ts` (`numRange`), `state.svelte.ts` (tab and filters), `testing/` (browser-test fixtures only).
- `src/components/dialogs/GoToDialog.svelte`; `src/lib/i18n/{en,ar}/navigation.ts` (64 keys, Arabic plurals complete).
- Tests: `normalize.test.ts`, `refparse.test.ts`, `quran.test.ts` (extended), `IndexPanel.browser.test.ts` (22),
  `GoToDialog.browser.test.ts` (11; it lives in `src/components/index/` so the package's browser acceptance runs it).

## Deviations from ARCHITECTURE.md

1. **Reference parser API (§10.4).** `parseReference(input, options?)` keeps WP0C's result shape and adds:
   - `options`: `names` (default true: surah-name matches and "name ayah" references) and `nameLimit` (default 5);
   - `ParseResult.source` (`ref` | `number` | `name`) and `ParseResult.issue` (`surah` | `ayah` | `range` | `page` |
     `juz` | `hizb`), the machine-readable twin of the localised `disabledReason` (the vectors check `issue`);
   - helpers `targetKey`, `targetAyahId`, `targetPage`, `describeTarget` (title + detail in the UI language),
     `limits`/`DEFAULT_LIMITS`, `issueReason`, `listSeparator`.
2. **Forms beyond the §10.4 table** (all in the vectors):
   - `2:` and `2.` → surah 2 (an ayah reference being typed);
   - `kahf 10`, `Al-Kahf:10`, `يس ١-١٢`, `[البقرة: ٢٥٥]` → ayahs of the best name match (`source: 'name'`);
   - pasted references: `(2:255)`, `— Al-Baqarah 2:255` (brackets, ornate brackets, guillemets and leading dashes are
     stripped; with a name in front, the numbers decide);
   - prefixes `pg`, `p.`, `para` (juz), the Arabic forms with the article (`الصفحة`, `الجزء`, `الحزب`, `السورة`) and with
     `ه` for `ة`; harakat, tatweel and bidi controls are ignored;
   - number fields take up to four digits, so `p 1000` or `2:1000` produce a disabled item with its reason instead of
     nothing; a bare number above 604 (or 0) gives a disabled page item.
3. **Surah-name matching (§10.4 "fuzzy", §7.3 "aliases").** core.db has no alias data, so the store carries
   `SURAH_ALIASES` (common alternative names in Latin and Arabic, e.g. Bara'ah, Bani Isra'il, Tabarak, Ad-Dahr, أم
   الكتاب, حم السجدة). Latin names are compared on a transliteration skeleton (doubled letters, `ee/oo/ou`,
   `th/dh/kh/gh/sh/ph`, `q/k`, `e/i`, `o/u`, `y/i`, `w/u`, a silent final `h`), so Tanzil's "Al-Faatiha"/"Yaseen" and
   Quran.com's "Al-Fātiĥah"/"Ya-Sin" match the same queries; Arabic names after `normalizeAr` loose with inner alefs
   dropped ("الرحمان" = "الرحمن", "طاها" = "طه"). Ranking: exact > prefix > substring > a 1-letter typo (2 from 7
   letters), typos only when nothing matches better; a literal match (as written) beats a skeleton-only one ("ka" →
   Al-Kahf before Qaf); core.db names beat aliases. Digit-only queries match nothing (numbers are references).
   `surahMatches(q, limit?)` takes an optional limit; `buildSurahKeys`, `rankSurahNames`, `editDistance` are exported
   for tests.
4. **normalize.ts.** WP0C fixed the names `normalizeAr(text, mode)` (`mode` now defaults to `'loose'`) and
   `foldLatin`. "Whitespace" is Rust's `White_Space` (U+0085 yes, U+FEFF no), not the JS `\s` class, and lower-casing
   is per code point (a final sigma stays σ), so both sides agree on every input. Extras: `tokens`, `isStripped`,
   `isWhiteSpace`, `asciiDigits`, `hasArabic`, `NORMALIZER_VERSION`.
5. **Index panel layout.** WP7c's `Sidebar` draws the heading ("Index" and the hide button), so the panel is the body
   only: the Continue card, then `Tabs` (Surahs · Juz · Hizb · Pages, filling the width). There is no separate Go to or
   "locate" button (no room beside four tabs at 240 px): the surah filter accepts references ("2:255", "p 262", "kahf
   10" offer a jump row), and a click on the open tab brings the current position back. The open tab is remembered in
   `localStorage` (`qd.index.tab`, a per-machine convenience; `Settings` has no field for it).
6. **SurahList (§9.7) details.**
   - In the Arabic UI the Arabic name leads (UI font, 500) with the transliteration beneath (core.db has no Arabic
     meanings); the inline-end column shows the sura-names glyph only when decor is loaded, else the meta alone.
   - **List separator.** In the Arabic UI the parts of every list line are joined with the Arabic comma ("مكية، ٢٨٦، ص
     ٢"; key `navigation.sep`), because " · " next to Arabic-Indic digits reads as the digit zero (٠). English keeps
     " · ".
   - The name is never truncated: its grid column is at least the name's width, and below a 270 px list the revelation
     place drops out of the meta (container query); the meaning and the meta ellipsise first.
   - The recitation dot (§9.7, §9.8) is filled for pinned (downloaded) surahs and half-tone for stream-cached ones, like
     the Downloads `SurahGrid`. When the current reciter's `packs.items` are not loaded, the list calls
     `packs.loadItems(packId)` once.
   - Typing a character on a focused row continues in the filter (type to filter); the page grid does the same with
     its finder.
   - The current surah is `reader.headSurah` (the running head's surah). The list opens with it centred and, while the
     user reads elsewhere (focus and pointer not in the list), re-centres it when it leaves the view.
7. **ContinueCard (§7.8 step 5).** The heading is "Continue reading" over "Al-Kahf 18:45 · p 297 · 3 days ago"; the
   spec's "Continue from reading bookmark" is the accessible name (it does not fit one line in a 240 px sidebar). It
   shows whenever the bookmark (mapped into the current layout) is more than two pages from every page on screen, not
   only right after startup, and its × hides it until the bookmark moves (session state).
8. **Additions beyond the §9.7 index.**
   - `HizbList`: hizbs grouped under juz headings, each row with ¼ ½ ¾ chips that open the rub starts (the ۞ marks);
     the hizb and quarter on screen are highlighted. The inline-end arrow walks into the chips.
   - `PageGrid`: grouped by juz (plain DOM, 604 buttons; `VirtualList`/`content-visibility` dropped because centring a
     page needs exact positions), the pages on screen filled with the accent, a gold corner fold where a surah begins
     (a dot read as ٠ beside Arabic digits), a ribbon on the reading bookmark's page, and a finder that takes any
     reference ("2:255" finds page 42; out of range shows the reason).
   - The surah context menu's "Surah info" is a popover anchored to the row (revelation place and order, ayahs, page
     and juz span, Play, Open): WP8c's `SurahInfoPopover` takes no props and belongs to the Mushaf header.
9. **GoToDialog.** The `bare` (palette-style) Dialog, 520 px, top 14 vh, faint backdrop; candidates from
   `parseReference` (up to 8, 6 names), out-of-range ones disabled with the reason; example chips when empty. A jump
   closes the dialog first and opens the target from `onCloseAutoFocus` (with a 450 ms fallback), so the focus trap
   never fights the reader moving focus to the ayah; page jumps keep the usual focus return (no ayah to focus).
10. **`openTarget` (`src/components/index/navigate.ts`).** Every target first shows the reader (`ui.setView`). Ayah:
    `goToAyah(id, { select: <range>, flash: true, focus })` then `reader.select(to, true)` for a range. Page:
    `goToPage(p, { push: true, transition: true })`. Surah/juz/hizb: `goToSurah/Juz/Hizb(n)`, or, for a jump that
    moves focus (Go to, Continue), `goToAyah(first, { flash: true, focus: true })` since those methods take no options.

## Requests

- **WP8e:** register `Mod+g` → `ui.open('goto', {})` in `navigation.ts` (§10.1); the Index relies on
  `goToAyah/goToPage/goToSurah/goToJuz/goToHizb/select` behaving as §7.3 says (they are wave-0 no-ops today, so the
  Index navigates only by page in the browser mock).
- **WP10c:** reuse `parseReference` (`{ names: false }` for the Go to provider when the Surahs provider uses
  `quran.surahMatches`), `describeTarget`, `targetKey`, `openTarget` (`$components/index/navigate`, `{ focus: true }`
  for palette jumps) and `Rosette` (`$components/index/Rosette.svelte`, the §9.7 "surah number in a rosette").
- **WP7b:** an empty `TextInput` with `dir="auto"` resolves to LTR, so its placeholder sits on the left in the Arabic
  UI. The Index and Go to inputs pass `dir={value === '' ? i18n.dir : 'auto'}`; consider doing that inside
  `TextInput`/`SearchInput`.
- **WP7c:** the title bar breadcrumb puts " · " between Arabic-Indic numbers ("الجزء ١٤ · ص ٢٦١"), where it reads as
  ٠; consider the Arabic comma (`navigation.sep`'s reasoning) or a wider separator in the Arabic UI.
- **WP11c:** the browser mock's `reading_bookmark_set` is still a stub; the Continue card was checked by setting
  `library.readingBookmark` directly.
- **WP12a:** the Index reads `packs.items.get(reciter.packId)` and calls `packs.loadItems(packId)` when it is missing;
  `loadItems` should fill the `items` map (and tolerate being called while a load is in flight).
- **WP9a / WP9b:** the surah menu calls `player.playRange(from, to)`, `memo.startHide(from, to)`,
  `memo.setStatus(from, to, 'memorized' | 'learning')` and `ui.open('self-test', { fromAyahId, toAyahId })`; rejected
  promises are shown with `ui.toastError`.
- **Lead:** fold deviations 1–10 into §7.3, §9.7 and §10.4 (the extra forms, the alias table, the skeleton matching,
  the Arabic list separator and the Index additions).
