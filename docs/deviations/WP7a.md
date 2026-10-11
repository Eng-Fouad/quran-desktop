# WP7a deviations (tokens and base styles)

Delivered: `src/styles/tokens.css` (§9.1–§9.4 complete, incl. high contrast dark, the six accents, the derived highlight
fills, the preference overrides and the translucency rule), `src/styles/base.css` (reset, element defaults, the §9.4 focus
ring, the §9.3 `.quran-text` guard, utilities), `src/styles/fonts.css`, `src/app.css`, `src/styles/tokens.test.ts` (the
§9.2 contrast test and the §8.7 composites, 582 cases) and `scripts/check-logical-css.mjs` (`pnpm lint:css`).
WP7a has no i18n domain (§11.1), so there are no strings to add.

## Deviations from ARCHITECTURE.md

### 1. §9.2 values corrected so the table's own contrast rules hold

The contrast test (§9.2) fails on several table values as written. Each correction below is the **smallest** step of the
original colour towards black (light themes) or white (dark themes), in 0.1 % steps, that passes; hue is kept. All ratios
are WCAG 2 on composited, opaque backgrounds, computed by `src/styles/token-harness.ts` (cross-checked against Chromium by
`tokens.browser.test.ts`).

| Token | Theme | §9.2 value | Failing pair (ratio) | Shipped | New worst ratio |
|---|---|---|---|---|---|
| `--border-input` | paper | #908876 | on `--surface-sunken` (2.80 < 3) | **#8a8371** | 3.01 |
| `--border-input` | sepia | #8b7b61 | on sunken (2.79), on chrome (2.84) | **#85755d** | 3.03 |
| `--border-input` | black | #606060 | on raised (2.88), on overlay (2.91) | **#636363** | 3.01 |
| `--text-muted` | black | #8f8a80 | on hover over raised (4.26 < 4.5) | **#938f85** | 4.53 |
| `--accent-text` | sepia × blue | #235e9f | on sunken (4.48 < 4.5: the table's own method) | **#215794** | 4.52 |

The last row shows that even the documented method ("darkened until ≥ 4.5:1 on `--surface-sunken`") was off by 0.02 for
one value. The other text corrections come from deviation 2.

### 2. The darkest text surface is hover over the chrome, not sunken

Sidebar rows (the surah index, search results, library panels) sit on `--surface-chrome` and hover with `--surface-hover`.
In sepia, that composite (#d9c9ac) is darker than `--surface-sunken`; in paper it equals hover over app. Muted meta text
("Meccan · 7 ayahs") and accent labels fell below 4.5:1 there. The test therefore also checks text on **hover over chrome**
and **overlay over app** (the dock floats over the canvas, not only over the page), and these values were re-derived with
the §9.2 method against the real darkest surface:

| Token | §9.2 | Shipped | | Token | §9.2 | Shipped |
|---|---|---|---|---|---|---|
| sepia `--text-muted` | #695a45 (4.10) | **#625441** | | paper accent-text teal | #1d7366 (4.45) | **#1d7265** |
| sepia accent-text teal | #1a675c (4.12) | **#186056** | | paper accent-text emerald | #1d7547 (4.46) | **#1d7447** |
| sepia accent-text emerald | #1a693f | **#18623b** | | paper accent-text rose | #af405d (4.43) | **#ad3f5c** |
| sepia accent-text blue | #235e9f | **#215794** | | paper accent-text amber | #8e5c0f (4.46) | **#8d5b0f** |
| sepia accent-text indigo | #4b4fae (4.27) | **#484ca7** | | paper accent-text blue / indigo | unchanged | |
| sepia accent-text rose | #9d3953 | **#93354e** | | | | |
| sepia accent-text amber | #7f530d | **#764d0c** | | | | |

Paper changes are invisible (one or two units per channel); sepia's are 3–7 % darker. Night, black and high contrast need
no change. `--text-faint` (disabled and decoration only) is checked at ≥ 3:1 on the non-hover surfaces: disabled items do
not hover.

### 3. Word highlight in night/black mixes 26 %, not 28 %

`--hl-word` = `color-mix(in srgb, var(--accent) calc(26% × k), var(--surface-page))` in night and black (`k` =
`--ink-alpha`, §8.7). At 28 % the ink on the amber word pill is 4.46:1 at ink 65 % (teal 4.60, as §8.6 says, but amber and
emerald are lighter). 26 % passes every accent at every ink level (amber 4.59 at 65 %). Light themes keep 28 %.

### 4. `prefers-contrast: more` keeps night/black ink at full brightness

§9.2 multiplies the highlight alphas by 1.6 under `prefers-contrast: more`. In night at ink 65 % that takes the glyphs below
4.5:1 on the yellow highlight (4.37), the search fill (4.35) and the word pill (3.65). Under that media query the ink
formula uses 1 instead of `--ink-alpha` (private `--_ink-level`), so every composite passes (the stronger fills are what a
"more contrast" user asked for; dimmed ink is not). The settings value is untouched; the V4 palette follows through the
`--ink` probe (§8.6). WP12b may want to note it next to the ink-brightness slider.

### 5. Tokens added beyond §9.2–§9.4

- `--accent-strong` in light themes (§9.2 gives it for dark only): the accent darkened 15 %.
- Status text and fills: `--danger-text`, `--success-text`, `--warning-text` (≥ 4.5:1 on every text surface and on their
  soft fills; as text, paper's success/warning and sepia's three status colours are only 3.3–4.0:1, so the §9.2 base
  colours stay for icons, borders and fills),
  `--danger-soft`, `--success-soft`, `--warning-soft` (12 %), `--danger-ink` (text on a `--danger` fill: white in light
  themes, #1f0b09 in dark ones, where white on #f2827a is 2.3:1).
- `--selection-bg` (native text selection, 24 % accent).
- Translucency rule (§9.4) as tokens: `--glass-fill` (= `--surface-overlay`, or `--surface-raised` when blur is not
  allowed), `--backdrop-dock: blur(24px) saturate(1.4)`, `--backdrop-palette: blur(20px) saturate(1.4)` (`none` when not
  allowed). Not allowed = `prefers-reduced-transparency: reduce`, `html[data-platform="linux"]` or forced colours.
- `--ink-alpha` default 0.88 (the settings default) so the page renders before the store writes it.
- `--weight-body|label|title` (400/500/600, §9.3 prose), `--leading-title` (1.25, Arabic 1.4), `--leading-nastaliq`
  (2.4), `--text-reading` (18px) and `--text-quran-reading` (28px), the §9.3 bases that `translationFontPct` multiplies.
- Private inputs prefixed `--_` (`--_accent-*`, `--_hl-*`, `--_user-hl-*-a`, `--_ink-level` in tokens.css,
  `--_icon-mirror` in base.css); never read or set outside `src/styles/`.

### 6. High contrast dark: values §9.2 does not list

`color-scheme: dark`; chrome, overlay and every surface #000000; `--surface-hover` rgb(255 255 255 / 0.14);
`--text-faint` #bdbdbd; frame, marker, ribbon and surah-header inks #ffffff; `--cartouche-fill` #000000; status colours
#ff8a80 / #7ee787 / #ffb74d; `--danger-ink` #000000; `--accent-strong` #ffd600; `--hl-search-solid` #ffb000 (the accent is
already #ffd600); dark user-highlight alphas. `--focus-ring-w` is 3px in both high-contrast variants (§9.4).

### 7. Cascade structure

- `tokens` has sub-layers `scale`, `theme`, `preference`, so a preference (reduced motion, more contrast, forced colours,
  reduced transparency) overrides every theme without specificity games.
- Reduced motion: the `--dur-*` tokens are 0 under `data-motion="reduce"`, and under the OS preference unless
  `data-motion="full"` (the user chose full motion). base.css also stops CSS animations and transitions that do not use
  the tokens (third-party widgets) with `0.01ms !important` (not `0`, so `transitionend`/`animationend` still fire) and
  turns view transitions off.
- `.quran-text` declares the §9.3 properties verbatim **with `!important`**: utilities sit below Svelte's unlayered scoped
  styles, so without it a component rule on the same element (`.ayah { letter-spacing: … }`) would silently win. The lint
  also rejects such declarations.
- `:lang(ar) { letter-spacing: 0 !important }` in base.css enforces §11.3 ("letter-spacing is never applied to Arabic
  text", none in the Arabic UI) for every component.
- With translucent chrome (`html[data-chrome="vibrant"]`) the root background is transparent, otherwise Mica could never
  show through `--surface-chrome`; the canvas, page and side pane paint their own opaque surfaces (WP7c already does).
- base.css extras: zero margins on text blocks, heading weights/sizes from the scale, `accent-color`, thin scrollbars in
  `--border-strong`, `user-select: none` on control labels, `img { -webkit-user-drag: none }`, `[hidden]` always hides,
  `font-synthesis-weight: none` on the UI (every face ships its weights). Utilities: `.sr-only`, `.sr-only-focusable`,
  `.icon-dir`, `.tabular-nums`, `.truncate` (UI text only), `.user-text` (`unicode-bidi: plaintext`, §11.3).
- **`.icon-dir` does not use `:dir(rtl)`** (§9.5 says "mirror under `:dir(rtl)`"). The production build's CSS target
  (Vite 8 `baseline-widely-available` = chrome111, where `:dir()` is unsupported) rewrites `:dir(rtl)` into
  `:is(:lang(ae), :lang(ar), :lang(fa), :lang(he), …)`: found by inspecting the built CSS. That mirrors icons inside any
  `lang="ar"` content in the English UI, in production only. Instead `[dir='rtl']`/`[dir='ltr']` set an inherited
  `--_icon-mirror` (`-1 1` / `none`) and `.icon-dir { scale: var(--_icon-mirror, none) }`: the nearest `dir` attribute
  decides, which is exactly what `:dir()` means, and `scale` composes with component transforms. The lint rejects `:dir()`
  in every stylesheet for the same reason (deviation 8).

### 8. `check-logical-css.mjs` scope and rules

- Scans every `.css` and `.svelte` file under `src/` (§11.3 names `src/components/**` and `src/styles/**`; `App.svelte`
  and `app.css` mirror too). Arguments narrow it to files or directories; `--json` prints machine-readable results.
- Beyond the §11.3 list it rejects `float`/`clear`/`text-align-last`/`justify-*` `left|right`, `scroll-margin|padding-left|
  right`, the physical radius corners, four-value `margin`/`padding`/`inset`/`scroll-*`/`border-width|style|color` whose
  left and right values differ, and `border-radius` whose left and right corners differ. Each message names the logical
  replacement.
- `:dir()` selectors are rejected (production rewrites them into a `:lang()` list; see deviation 7).
- Svelte: `<style>` blocks (nesting, `@media`, `@layer`, `@keyframes`, `:global()`), `style="…"` attributes (Svelte
  expressions included) and `style:prop` directives; `<script>` is skipped.
- Exemption: a comment starting with `physical-ok` on any line of the declaration; in markup also `<!-- physical-ok -->`
  on the line above the element (a tag cannot hold a CSS comment for `style:` directives).
- Quran text: on selectors containing `.quran-text` or `.mp-glyphs` (and elements carrying those classes) it rejects
  `font-weight`, `font-style`, `font-synthesis`, `letter-spacing`, `word-spacing`, `text-transform` unless neutral (400 /
  normal / none / 0) and the `font` shorthand. "`[lang="ar"]` Quran classes" is read as: on Arabic selectors (`:lang(ar)`,
  `[lang=ar]`, not inside `:not()`), a non-zero `letter-spacing` is rejected (§11.3); `font-weight` stays allowed there
  because UI Arabic may be bold. Quran-text violations cannot be exempted with `physical-ok`.

### 9. Files created beyond the §14.3 list (all under WP7a's `src/styles/`)

- `src/styles/token-harness.ts`: the parser/resolver/contrast harness the §9.2 test uses; §8.7 says WP8d "extends the same
  harness", so it is a module rather than test-local code. Test support only (nothing in the app imports it).
- `src/styles/tokens.browser.test.ts`: loads tokens.css into Chromium and requires the harness to compute what the browser
  computes (29 colour tokens × 21 contexts, plus durations and the Arabic type column).
- `src/styles/base.browser.test.ts`: base.css in Chromium against unlayered component rules (`.quran-text`, the Arabic
  letter-spacing guard, `[hidden]`), `.icon-dir` by `dir` attribute vs language, reduced motion, the transparent root under
  vibrant chrome, the Arabic type column and the focus ring.
- `src/styles/check-logical-css.test.ts`: runs the lint CLI on fixtures (17 cases).
- Unit tests read CSS with `readFileSync` (`?raw` CSS imports are empty in the unit project, where vitest does not process
  CSS); the browser test uses `?raw`, which works there.

## Requests

- **WP7c (settings store / app store):** set `html[data-platform]` to `app.platform` (`windows|macos|linux`) in
  `applyEffects()` (or `app.init`). The translucency tokens key off `data-platform="linux"`; until it is set, Linux gets the
  blur. Also: set `data-chrome="vibrant"` only once `window_set_chrome` has succeeded (and drop it on error). With
  vibrant chrome the root is transparent; if the effect is not applied on a transparent window (e.g. Windows 10 has no
  Mica), the title bar would composite over nothing.
- **WP6b:** `window_set_chrome` should return an error when the requested effect cannot be applied, so the request above
  can react.
- **WP9a (scrubber, §9.7):** draw the ayah ticks in `--text-muted` at **100 %**, not 70 %. At 70 % the ticks are 2.4–3.6:1
  against the track in every theme (fails §9.2's "ticks ≥ 3:1"); at 100 % they are 3.7–6.1:1 (tested). Use `--glass-fill`
  + `--backdrop-dock` for the dock (§9.4 translucency rule) instead of `--surface-overlay` + a literal blur.
- **WP10c:** the palette container uses `--glass-fill` + `--backdrop-palette`.
- **WP7b:** `Badge` tones and other status text use `--{danger,success,warning}-text` on `--{…}-soft`; the `danger` Button
  uses `--danger` with `--danger-ink`. Placeholders already get `--text-muted` from base.css. Directional icons
  (chevrons, arrows) take `class="icon-dir"`; do not write `:dir()` in component CSS (`pnpm lint:css` rejects it).
- **WP8d:** the harness is `src/styles/token-harness.ts` (`parseTokens(css).resolve({ attrs, media, inline })`, `color()`,
  `over`, `stack`, `contrast`); tokens.test.ts already asserts ink ≥ 4.5:1 on page + every single fill for all themes ×
  accents × ink 65/88/100 × contrast. The user-highlight **solid bars** are yours to check: in night/black some are
  below 3:1 against the page (e.g. `--user-hl-purple-solid` #6a1b9a on #1a1c1f ≈ 1.8:1).
- **WP12b:** under `prefers-contrast: more`, the ink-brightness setting has no effect in night/black (deviation 4).
- **Lead:** fold deviations 1–8 into §9.2–§9.4 and §11.3: the corrected values, the extra test surfaces (hover over
  chrome, overlay over app) and the accent-text method stated against hover over chrome, the 26 % dark word pill, the
  full-ink rule under more contrast, the added tokens, the high-contrast-dark values, `.quran-text !important` and the
  lint rules; and §9.7's tick opacity (WP9a request).
