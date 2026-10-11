# frontend-ux

## Frontend stack and UX benchmark for Quran Desktop (checked live on 2026-10-10)

### 1. Pinned stack: npm `latest` versions, peer dependencies checked, `npm install --dry-run` clean (no ERESOLVE, no peer warnings)

| Package | Pin | Notes |
|---|---|---|
| svelte | **5.57.2** | Runes. `Spring`/`Tween` classes since 5.8; `prefersReducedMotion` and `MediaQuery` since 5.7; `{@attach}` since 5.29; `createContext` since 5.40. Using `await` inside components is still experimental (`compilerOptions.experimental.async`, since 5.36). |
| @sveltejs/vite-plugin-svelte | **7.3.1** | Peers: vite ^8, svelte ^5.46.4. Node ^20.19 / ^22.12 / >=24. |
| vite | **8.3.4** | Builds with Rolldown, transforms and minifies with Oxc, minifies CSS with Lightning CSS. Default `build.target` is `'baseline-widely-available'` = chrome111 / firefox114 / safari16.4. |
| typescript | **~6.0.3** (do NOT use 7.0.2) | svelte-check 4.7.6 peers `^5 \|\| ^6`. typescript-eslint 8.71.1 peers `>=4.8.4 <6.1.0`. TS 7 only works through svelte-check's `--tsgo` flag plus an npm alias. The create-tauri-app and create-vite templates both pin `~6.0.x`. |
| svelte-check | **4.7.6** | |
| @tsconfig/svelte | 5.0.8 | |
| vitest | **5.0.3** | Node ^22.12 / ^24 / >=26 |
| @vitest/browser-playwright + playwright | 5.0.3 + 1.64.0 | Run component tests in **chromium and webkit**. WebKit stands in for WKWebView and WebKitGTK. |
| vitest-browser-svelte | 3.1.0 | `import { render } from 'vitest-browser-svelte'` |
| @testing-library/svelte (+jsdom 30.1.2, @testing-library/jest-dom 7.0.1) | 5.4.2 | For DOM-only unit tests. jsdom 30 needs Node ^22.22.2 / ^24.15 / >=26. |
| bits-ui | **2.19.5** | Peers svelte ^5.33 and `@internationalized/date` ^3.8.1 (add 3.12.4). Headless and Svelte 5 native. |
| @lucide/svelte | **1.54.0** | Peer svelte ^5; `sideEffects:false`; per-icon import `@lucide/svelte/icons/<name>`. `lucide-svelte` (1.0.1) is **deprecated** on npm ("use @lucide/svelte"). |
| virtua | **0.53.3** (`virtua/svelte`) | Runes-native (`$props`, snippets). Exports VList, Virtualizer, WindowVirtualizer, VGrid, VMasonry. Supports dynamic sizes, `scrollToIndex` (with smooth), `shift`, horizontal scrolling and RTL. Needs `moduleResolution: bundler`. |
| @tanstack/svelte-virtual | 3.13.40 (avoid) | Still built with Svelte 4 and returns `Readable` stores (`createVirtualizer`). Works in Svelte 5 but is not runes-native. |
| cmdk-sv | 0.0.19 (avoid) | GitHub repo **archived**: "Deprecated by the Command component in Bits UI". |
| paneforge | 1.0.2 | Resizable panes (peer svelte ^5.29) |
| runed | 0.37.1 | Optional peers @sveltejs/kit and zod. bits-ui and others pull their own runed versions, so a few copies get installed. |
| svelte-sonner | 1.2.1 | Toasts |
| @inlang/paraglide-js | 2.26.0 | Compile-time i18n with a Vite plugin. **`setLocale()` reloads the document by default**: use `setLocale(l,{reload:false})` plus `{#key locale}`. |
| tailwindcss / @tailwindcss/vite | 4.3.3 / 4.3.3 | Peer vite ^5–^8. Works, but not recommended (see below). |
| @tauri-apps/api / @tauri-apps/cli | 2.12.2 / 2.12.1 | |
| Lint and format | eslint 10.12.0, @eslint/js 10.0.1, typescript-eslint 8.71.1, eslint-plugin-svelte 3.23.1, prettier 3.9.9, prettier-plugin-svelte 4.1.1, globals 17.13.0 | |
| Fonts (all OFL-1.1, v5.3.0) | @fontsource-variable/inter, noto-sans-arabic, noto-naskh-arabic, literata; @fontsource/amiri-quran; @fontsource/opendyslexic | |

Other details:
- **Package manager and Node:** pnpm latest is 12.10.1. Local Node is v26.3.0.
- **Draft package.json:** `proposed-package.json` in the research folder.
- **svelte.config.js:** the create-vite svelte-ts template ships it as `export default {}`. Svelte 5 handles type-only TypeScript natively. Enums and constructor parameter properties still need `vitePreprocess`.
- **Tauri Vite guide:** it still recommends `build.target: safari13` on non-Windows. **Don't copy that.** Keep Vite 8's default, or set `['chrome111','safari16.4']`, and raise `bundle.macOS.minimumSystemVersion` from its default `"10.13"` (suggest "13.3", the Safari 16.4 WebKit).
- **Linux WebKitGTK today:** Ubuntu 24.04 has 2.52.6, Ubuntu 22.04 has 2.50.4, Debian 12 has 2.50.6, Debian 13 has 2.54.0.

### 2. Tailwind v4 or hand-written CSS
**Recommendation: hand-written CSS with design tokens.** Use CSS custom properties, `@layer`, logical properties, Svelte scoped `<style>`, and a `data-theme` attribute on `<html>`. Reasons:
- Tailwind's own compatibility page recommends avoiding Svelte `<style>` blocks (you'd need `@reference` in each one). This UI is mostly bespoke typographic components: Mushaf lines, frames, the player and the panes.
- Tailwind v4 needs Safari 16.4+, which is the same baseline as Vite 8, so that's no advantage.
- Four themes plus contrast and forced-colors handling are easier to manage as semantic tokens.
- A draft token file (light paper, sepia, night, OLED black, high-contrast, motion and spacing) is in `proposed-tokens.css`.

If the team still wants utilities, Tailwind 4.3.3 is technically compatible. It has `rtl:`/`ltr:`, `motion-reduce:`, `contrast-more:`, `forced-colors:` variants and `@custom-variant` for `data-theme` dark mode.

### 3. Components, command palette, motion
- **bits-ui 2.19.5 ships:** Menubar, ContextMenu, Toolbar, Tooltip, Popover, Dialog, AlertDialog, Command, Slider (with ticks), ScrollArea, Tabs, ToggleGroup, Select, Combobox, Meter, Progress, Switch, Collapsible and VisuallyHidden.
- **Command palette:** put `Command.Root` inside `Dialog.Content`.
  - Use the custom `filter(value, search, keywords) => 0..1` to normalize Arabic: strip U+064B–U+0652, U+0670 and tatweel U+0640; map أإآٱ→ا, ى→ي, ة→ه. Put Latin, Arabic and number aliases in `keywords`.
  - **`vimBindings` defaults to true** (ctrl+n/j/p/k move the selection). If Ctrl+K also opens/closes the palette, set `vimBindings={false}` or handle the toggle in a window-level capture listener.
- **Motion:** `svelte/motion` has `new Spring(v,{stiffness,damping,precision})`, `Spring.of(fn)`, `new Tween(v,{duration,easing,delay,interpolate})` and `.target` / `.current` / `set()`. Use Spring to glide the word-highlight box between word rectangles.
  - The docs don't say `svelte/transition` (fade, fly, slide, scale, blur, crossfade, draw) honors reduced motion. Wrap transitions with `duration: prefersReducedMotion.current ? 0 : d`.
  - View Transitions (Chrome 111, Safari 18) can cross-fade page turns, with a fallback.
- **Motion tokens:** use the Fluent 2 values (`@fluentui/tokens`). Durations 50/100/150/200/250/300/400/500 ms. Curves: easyEase `cubic-bezier(0.33,0,0.67,1)`, decelerateMax `(0.1,0.9,0.2,1)`, accelerateMax `(0.9,0.1,1,0.2)`, decelerateMid `(0,0,0,1)`.

### 4. Quran font facts that affect the design (fonts inspected with fontTools)
- **QCF page fonts from quran.com:** URL template `https://quran.com/fonts/quran/hafs/{v1|v2|v4/colrv1|v4/ot-svg/{theme}}/{woff2|woff|ttf}/p{page}.{ext}`. All return HTTP 200. Sizes for p1 woff2: v1 15 KB, v2 41 KB, v4 colrv1 27 KB, v4 ot-svg dark 103 KB.
  - quran.com loads them with the FontFace API under the family name `p{page}-v{n}`, with the `local(QCF_P001 | QCF2001 | QCF4_P001)` names as a first try.
- **The QCF V4 "colrv1" files are actually COLR v0 + CPAL, with 6 palettes of 16 entries.** COLR v0 has been supported since Safari 11, and `font-palette` / `@font-palette-values` / `override-colors` since Safari 15.4, Chrome 101 and Firefox 107. So tajweed colours and theme palettes work in WebView2, WKWebView and (very likely) WebKitGTK. COLRv1 proper is **not** supported in Safari (caniuse: 27.2 = n).
  - Palettes: **0** light tajweed, **1** dark tajweed (white ink), **2** sepia tajweed, **3** light monochrome, **4** dark monochrome, **5** sepia monochrome. Indices 10–12 hold the marker/ornament colours.
  - quran.com uses `@font-palette-values --Light/--Dark/--Sepia { font-family:'p{N}-v4'; base-palette:0/1/2 }`.
  - Palettes 3–5 give a "tajweed off" mode for free.
  - `var()` is not valid inside `@font-palette-values`, so generate those rules from JS with literal colours.
- **QCF V2 page fonts** are monochrome glyf fonts with GSUB. Style them with plain `color`.
- **QUL "Surah header" font** (`https://static-cdn.tarteel.ai/qul/fonts/surah-names/surah-header/QCF_SurahHeader_COLOR-Regular.ttf`, 1.8 MB) is **monochrome despite "COLOR" in its name**, so it can be tinted per theme. Ligatures are named `surah-1`…`surah-114` (sample `ﱅ`). Its name table says "King Fahad Complex, All rights reserved", and the page fonts carry the same notice. License review is needed before bundling.
- **quran.com patterns worth copying conceptually** (their repo has **no license**, so don't copy code):
  - Show the Unicode `qpc_uthmani_hafs` text in a size-matched UthmanicHafs fallback until the page font loads, to avoid layout shift.
  - In V4, highlight a word with `color:transparent; text-shadow:0 0 var(--accent)`.
  - Intercept `copy` and swap the glyph codes for Uthmani text using `data-word-location="s:a:w"`.
  - Give each Mushaf line a fixed `inline-size` per font scale, with `direction:rtl`.
- **Line layout:** QUL layout rows have `line_type` ∈ {`ayah`, `surah_name`, `basmallah`} and `is_centered`. Justify non-centered lines with `display:flex; justify-content:space-between`.

### 5. UX benchmark: best ideas and pitfalls
**Quran.com web**
- **Reading modes:** `ReadingPreference` = `translation` (verse-by-verse), `reading` (Arabic page), `readingTranslation`.
- **Word-by-word:** shown `inline` or as a `tooltip` (hover delay 700 ms). Clicking a word plays that word's audio. Word-level audio highlighting.
- **Repeat modal:** single verse / range / full surah, with `repeatEachVerse`, `repeatRange` and `delayMultiplier` (the gap scales with the verse's length, which helps memorization).
- **Appearance:** themes light (#fff), sepia (#f8ebd5 bg, #fff7ea raised), dark (#1f2125). Font scale steps 1–10. Font choices `code_v1`, `code_v2`, `tajweed_v4`, `qpc_uthmani_hafs`, `text_indopak` (15/16 lines).
- **Keyboard:** Space plays/pauses, ←/→ go to the previous/next ayah. That's an LTR assumption.
- **Pitfall:** every clickable word gets `role=button tabIndex=0`, which means thousands of tab stops.

**quran_android** (GPL-3.0; data usually CC BY-NC-ND)
- **Play Store features:** crystal-clear Madani images, gapless audio, ayah bookmarks/tags/sharing, 15+ reciters with highlighting, search, night mode, custom repeat, 20+ translation languages.
- **Settings:**
  - Night mode with **text brightness 0–255 (default 255)** and **background brightness (default 0)**, plus a "New background" option (`page_background #FFF4CB`).
  - "Show page info" overlay (page, surah, juz). Marker popups when you reach a juz or hizb. Highlight bookmarked ayahs.
  - Dual-page mode in landscape. Quran page plus translation in dual mode. "Ayah before translation". Dyslexia-friendly translation font. Streaming vs download. Volume-key navigation.
- **Audio:** From/To, "Only play the above verses", "Play set of verses" and "Play each verse" (1/2/3 times or loop), playback speed.
- **Bookmarks:**
  - A movable reading bookmark with an undo snackbar ("Moved X to Y"). Collections and tags.
  - 5 highlight colours. Page overlays use 25%-alpha tints: selection #404694A6, audio #4046A646, note #40EBEB21, bookmark #40A4A4A4. Lists use darker colours: #f9a825, #2e7d32, #1565c0, #c62828, #6a1b9a.
  - Recent pages. Import/export, including CSV.

**Quran Companion** (Qt6, Waqf GPL, v1.5.2 released 2026-03-25)
- Two-page spread: **odd page on the right, even on the left**. Page header shows surah and juz; footer shows hizb, page number and rub. The rest of the UI is a plain toolbar.
- Issues reported by users:
  - Audio cuts or gaps between verses (#179, #13) and a crash during playback (#113).
  - Settings window doesn't fit with text scaling above 1 (#177). Last page not restored on Linux (#175).
  - Juz jump breaks when the juz starts mid-page (#71). Missing word (#95).
  - Requests: Ctrl+wheel zoom (#87), background downloads (#125), playback speed (#110), repeat for memorization (#78), tray (#142), copy (#132), custom colour scheme (#124), flashcards (#121), QCF V4 tajweed (#178), output-device list (#165).

**Tarteel** (v5.81.7)
- AI follow-along and voice search are free. Premium: mistake detection, hidden-verse "peek" mode, **Test Mode starting at random points** (5.81.1), goals, streaks and heatmaps.
- "Removed pauses between ayahs" (5.78.0).

**Ayah** (iOS, v28.0, 2025-03-20)
- Khatmah tracking, including "play audio to the end of the khatmah's day".
- Colourful bookmarks, starred verses, thematic highlights grouped by surah or colour, swipe-down search.
- Repeat counter shown on screen, quick speed control, remembers the last speed.

**Zekr** (Java/SWT, GPL-2.0, last version 1.1.0, site DNS dead)
- Root-based search, side-by-side translation comparison with search inside translations, plugin packs.

### 6. Desktop-first opportunities
1. **Two-page book spread.** Odd page on the right, even on the left. Fit to window height; Ctrl+wheel and Ctrl+± zoom with vector glyphs. Automatically drop to a single page below about 1100 px.
2. **Three-zone layout.** Navigation rail | Mushaf | resizable translation/tafsir pane (paneforge, 320–640 px). The pane follows the hovered, selected or playing ayah.
3. **Keyboard-first.** Ctrl+K palette (go to surah, page "p 262", ayah "2:255", juz "j 15", reciter, theme, search), a menubar (bits-ui Menubar or the native Tauri menu), and a "?" shortcut sheet.
4. **Hover and context menu.** Hover tooltips for word-by-word. Right-click on an ayah: play from here, repeat this ayah, A-B loop to here, bookmark, highlight colour, copy as Uthmani / simple / with translation / with reference, open tafsir, share as image.
5. **Memorization studio.** Shift-click to select an ayah range, repeat counts, delay multiplier, speed control, a hide/peek mode (blurred words revealed on hover or key), Tarteel-style random-start test, and a progress heatmap.
6. **System integration.** OS media controls, tray mini-player, an always-on-top mini player, a single-instance deep link `quran-desktop://2:255`, and a presentation/projector mode on a second monitor.
7. **Native chrome.** Mica/acrylic (Windows 11) or vibrancy (macOS) on the window chrome only, never under the page. `scrollBarStyle:"fluentOverlay"` on Windows (needs WebView2 ≥125.0.2535.41). `titleBarStyle:"Overlay"` on macOS.
8. **Instant offline start.** Render from the core database with the bundled font, then swap to QCF page fonts without layout shift. Preload ±2 pages and keep a least-recently-used cache of FontFace objects.

### 7. What makes the Mushaf look authentic, and the visual system
- **Paper:** cream paper (#FDF8EC paper theme; quran_android uses #FFF4CB) with soft warm shadows.
- **Page frame:** a thin double-rule frame in muted gold (#B08D57) with a teal-green accent (#2F6B5E). Draw it as SVG with `stroke="currentColor"` so it follows the theme.
- **Surah header:** the QUL surah-header glyph, tinted to the frame colour, then a basmalah line.
- **Running heads and footer:** surah name on one side and juz on the other in small Naskh. Centred page number using Arabic-Indic digits: `Intl.NumberFormat('ar-u-nu-arab')`.
- **Margins:** rub/hizb marker ۞ (U+06DE) with a "ربع الحزب" label; sajdah ۩ (U+06E9) with a margin note.
- **Dark modes:**
  1. Night: warm off-white ink #E9E4D8 on #1A1C1F, using CPAL palette 1 for V4.
  2. OLED black: ink brightness slider, the same idea as quran_android's text-brightness setting.
  3. Sepia: CPAL palette 2.
  4. Never invert images. With fonts, recolouring is native.
- **Highlights:** behind the glyphs (a pseudo-element at 14–30% alpha), never by changing the glyph colour (except the V4 text-shadow trick), so diacritics stay readable.
- **Scales:**
  - UI type scale 1.2 on a 15 px base (11/12/13/15/18/22/28/36). Reading text 18 px × user factor; line-height 1.7 Latin, 2.0 Naskh.
  - Spacing on a 4 px grid. Radius 3 (page) / 6 / 10 / 14 / full.
  - Elevation: three shadow levels in light themes; borders instead of shadows in dark themes.

### 8. Accessibility and i18n
- **Direction:** `<html lang dir>` follows the UI language. The Mushaf container is always `lang="ar" dir="rtl"`. Each translation sets its own `lang`/`dir` (Urdu and Persian are RTL), with `dir="auto"` only as a fallback. Wrap verse keys and surah names in `<bdi>` or `unicode-bidi:isolate`. Use logical properties and `:dir()`.
- **Mirroring:** mirror navigation chevrons. **Don't mirror media transport icons or the playback scrubber** (Material bidi guidance, archived m1/m2 pages).
- **Arrow keys:** in the Mushaf, ← means next page and → means previous page whatever the UI language. Use dedicated keys for previous/next ayah.
- **Screen readers:** QCF glyphs are private-use codepoints and read as nothing.
  - Mark glyph runs `aria-hidden="true"` and add a visually hidden Unicode sibling (`lang="ar"`) with the ayah number.
  - Don't put `aria-label` on a plain span. ARIA 1.2 prohibits naming the `generic` role. Use `role="group"` or real text instead.
  - Label each page `<section aria-label="Page 262 · Al-Hijr">`.
  - Use a roving tabindex: one tab stop per page, arrow keys move between ayahs, Enter opens the ayah menu.
  - Add a polite live region for "Now playing 2:255", off by default during continuous playback.
- **Focus:** bits-ui dialogs trap focus and restore it. Return focus to the last ayah after the palette closes. Add a "Skip to Quran text" link. Visible 2 px focus ring.
- **Media queries:**
  - `prefers-reduced-motion`: Chrome 74, Safari 10.1.
  - `prefers-contrast`: Chrome 96, Safari 14.1.
  - `forced-colors`: Chrome 89, Safari 16. Map highlights to `Highlight` and ink to `CanvasText`.
- **Search highlighting:** use the CSS Custom Highlight API (Chrome 105, Safari 17.2, Firefox 140). It avoids changing the DOM.

### 9. Testing
Use Vitest 5 browser mode:

```ts
import { playwright } from '@vitest/browser-playwright'
// test.browser: { enabled: true, provider: playwright(), instances: [{ browser: 'chromium' }, { browser: 'webkit' }] }
```

Pair it with `vitest-browser-svelte` `render()`. Add visual-regression screenshots of pages 1, 2, 3, 262 and 604 in every theme.

## Facts
- [V] Latest npm versions: svelte 5.57.2, @sveltejs/vite-plugin-svelte 7.3.1, vite 8.3.4, typescript 7.0.2 (latest tag) / 6.0.3 (latest 6.x), svelte-check 4.7.6, vitest 5.0.3, @testing-library/svelte 5.4.2, tailwindcss 4.3.3, @tailwindcss/vite 4.3.3, @lucide/svelte 1.54.0, @tanstack/svelte-virtual 3.13.40, virtua 0.53.3, bits-ui 2.19.5, cmdk-sv 0.0.19, @tauri-apps/api 2.12.2, @tauri-apps/cli 2.12.1 — npm view <pkg> version (run 2026-10-10); saved research/frontend-ux/npm-versions.txt
- [V] svelte-check 4.7.6 peerDependencies typescript '^5.0.0 || ^6.0.0'; TS7 only via --tsgo/--tsgo-experimental-api with typescript@~6 plus @typescript/native@npm:typescript@7 alias — npm view svelte-check peerDependencies; https://unpkg.com/svelte-check@4.7.6/README.md saved as svelte-check-4.7.6-README.md
- [V] typescript-eslint 8.71.1 peer typescript '>=4.8.4 <6.1.0' (TypeScript 7 unsupported) — npm view typescript-eslint peerDependencies
- [V] create-tauri-app 4.7.5 svelte-ts template pins typescript ~6.0.3, vite ^8.0.16, @sveltejs/vite-plugin-svelte ^7.1.2, svelte ^5.56.3 (and uses SvelteKit); create-vite 9.2.1 svelte-ts template pins typescript ~6.0.2, vite ^8.3.0, svelte ^5.57.0, svelte-check ^4.7.6, svelte.config.js = export default {} — https://raw.githubusercontent.com/tauri-apps/create-tauri-app/dev/templates/template-svelte-ts/package.json.lte ; https://unpkg.com/create-vite@9.2.1/template-svelte-ts/package.json (saved create-vite-svelte-ts-package.json)
- [V] Proposed dependency set (proposed-package.json) resolves with npm install --dry-run without ERESOLVE or peer warnings (315 packages) — npm install --dry-run output saved as research/frontend-ux/npm-dryrun-install.txt
- [V] Vite 8 default build.target is 'baseline-widely-available' = ['chrome111','edge111','firefox114','safari16.4','ios16.4']; builds use Rolldown, Oxc is default minifier, Lightning CSS default cssMinify — https://vite.dev/config/build-options
- [V] Tauri v2 Vite guide recommends build.target chrome105 on Windows and safari13 elsewhere, devUrl http://localhost:5173, envPrefix VITE_ and TAURI_ENV_* — https://v2.tauri.app/start/frontend/vite/
- [V] Tauri bundle.macOS.minimumSystemVersion defaults to "10.13"; windowEffects supports mica/micaDark/micaLight/tabbed/acrylic/blur (Windows) and sidebar/underWindowBackground/hudWindow/popover/sheet/liquidGlass* (macOS), unsupported on Linux; titleBarStyle Visible/Transparent/Overlay (macOS); scrollBarStyle 'fluentOverlay' Windows-only needs WebView2 125.0.2535.41+; zoomHotkeysEnabled; backgroundThrottling macOS 14+/iOS 17+ — https://v2.tauri.app/reference/config/ (read with offsets 0 and 100000)
- [V] WebKitGTK (libwebkit2gtk-4.1-0) versions: Ubuntu 24.04 noble 2.52.6, Ubuntu 22.04 jammy 2.50.4, Ubuntu 25.10 2.52.3, Debian 12 bookworm 2.50.6, Debian 13 trixie 2.54.0 — https://packages.ubuntu.com/<suite>/libwebkit2gtk-4.1-0 and https://packages.debian.org/<suite>/libwebkit2gtk-4.1-0
- [V] lucide-svelte is deprecated on npm ('Package deprecated. Please use @lucide/svelte instead.'); @lucide/svelte 1.54.0 peers svelte ^5, sideEffects false, exports ./icons/* — npm view lucide-svelte deprecated; https://unpkg.com/@lucide/svelte@1.54.0/package.json
- [V] cmdk-sv GitHub repo is archived with description 'Deprecated by the Command component in Bits UI' — GitHub API https://api.github.com/repos/huntabyte/cmdk-sv (saved github-repos.txt)
- [V] @tanstack/svelte-virtual 3.13.40 is built with svelte ^4.2.20 devDependency and createVirtualizer returns a Readable store (not runes-native) — https://unpkg.com/@tanstack/svelte-virtual@3.13.40/package.json and dist/index.d.ts
- [V] virtua 0.53.3 exposes virtua/svelte (VList, Virtualizer, WindowVirtualizer, VGrid, VMasonry) written with Svelte 5 runes ($props/$state, children snippet), requires svelte >=5.0, supports RTL horizontal, dynamic sizes, reverse scroll, smooth scrollToIndex — https://unpkg.com/virtua@0.53.3/lib/svelte/index.d.ts, VList.svelte, README saved as virtua-0.53.3-README.md
- [V] bits-ui 2.19.5 includes Command (Root/Input/List/Viewport/Group/GroupHeading/GroupItems/Item/LinkItem/Empty/Loading/Separator) with filter(value, search, keywords)->0..1, shouldFilter, loop (default false), vimBindings (default true: ctrl+n/j/p/k), computeCommandScore export; plus Menubar, ContextMenu, Toolbar, Tooltip, Slider, ScrollArea, Dialog etc. — https://bits-ui.com/docs/components/command ; https://unpkg.com/bits-ui@2.19.5/dist/bits/?meta
- [V] svelte/motion exports Spring and Tween classes (since 5.8.0) with set()/target/current and static of(); prefersReducedMotion (MediaQuery, since 5.7.0); spring()/tweened() deprecated — https://svelte.dev/docs/svelte/svelte-motion
- [V] svelte/reactivity exports MediaQuery and createSubscriber (5.7.0), SvelteMap/SvelteSet/SvelteDate/SvelteURL/SvelteURLSearchParams; svelte exports createContext (5.40), settled (5.36), fork (5.42), getAbortSignal; {@attach} available since 5.29; await in components still experimental via compilerOptions.experimental.async (5.36+) — https://svelte.dev/docs/svelte/svelte-reactivity ; https://svelte.dev/docs/svelte/svelte ; https://svelte.dev/docs/svelte/@attach ; https://svelte.dev/docs/svelte/await-expressions
- [V] Svelte 5 natively supports type-only TypeScript; enums and constructor access-modifier initializers need vitePreprocess — https://svelte.dev/docs/svelte/typescript
- [V] svelte/transition functions (fade, fly, slide, scale, blur, crossfade, draw) — docs do not state automatic prefers-reduced-motion handling — https://svelte.dev/docs/svelte/svelte-transition
- [V] Tailwind v4 requires Chrome 111 / Safari 16.4 / Firefox 128 and recommends avoiding Svelte <style> blocks (need @reference for @apply); @theme namespaces generate utilities and CSS vars; rtl:/ltr:/motion-reduce:/contrast-more:/forced-colors: variants exist — https://tailwindcss.com/docs/compatibility ; https://tailwindcss.com/docs/theme ; https://tailwindcss.com/docs/hover-focus-and-other-states
- [V] QCF V4 tajweed page fonts served at quran.com/fonts/quran/hafs/v4/colrv1/... are COLR version 0 with CPAL 6 palettes x 16 entries (p1, p50, p604 checked); palette0 light tajweed (#000000 ink), 1 dark (#ffffff ink), 2 sepia, 3 light-mono, 4 dark-mono, 5 sepia-mono — fontTools inspection of https://quran.com/fonts/quran/hafs/v4/colrv1/ttf/p{1,50,604}.ttf; saved qcf-v4-cpal-palettes.txt (font files deleted afterwards)
- [V] quran.com uses @font-palette-values --Light/--Dark/--Sepia with base-palette 0/1/2 per page font family 'p{page}-v4' and font-palette on theme root; uses ot-svg/{theme} files only for Firefox dark mode — quran.com-frontend-next production: src/components/Verse/TajweedFontPalettes.tsx, src/utils/fontFaceHelper.ts, src/styles/themes/_*.scss (saved under research/frontend-ux/qdc/)
- [V] QCF font URL template: https://quran.com/fonts/quran/hafs/{v1|v2|v4/colrv1|v4/ot-svg/{theme}}/{woff2|woff|ttf}/p{page}.{ext}; p1 woff2 sizes v1 15328 B, v2 40956 B, v4 colrv1 27432 B, v4 ot-svg dark 102696 B — curl -sI on each URL (HTTP 200, font/woff2)
- [V] COLRv1 is not supported in Safari (caniuse colr-v1: Safari 27.2 = n); COLR v0 Safari 11+; CSS font-palette Safari 15.4/Chrome 101/Firefox 107; @font-palette-values override-colors Chrome 101/Safari 15.4/Firefox 107 — https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/colr-v1.json, colr.json, css-font-palette.json; MDN BCD css/at-rules/font-palette-values.json; saved caniuse-summary.txt
- [?] WebKitGTK support for COLRv1 (via Skia) is unknown — Web search found only WebKit bug 233496 / 2021 mailing list; no confirmation
- [V] QUL Surah header font (QCF_SurahHeader_COLOR-Regular.ttf, 1,832,408 bytes) is a monochrome glyf font (no COLR/CPAL/SVG), 121 cmap entries, name table copyright 'King Fahad Complex, All rights reserved'; ligatures surah-1..surah-114 — curl -sI + fontTools on https://static-cdn.tarteel.ai/qul/fonts/surah-names/surah-header/QCF_SurahHeader_COLOR-Regular.ttf ; https://qul.tarteel.ai/resources/font/458
- [V] QUL lists 22 font resources incl. Surah name v1/v2/v4, Surah header, Juz name font, QPC V1/V2/V4, QPC Hafs, Digital Khatt V1/V2 (variable), Indopak, Qira'at fonts; no license shown on the listing — https://qul.tarteel.ai/resources/font
- [V] QUL mushaf layout schema: pages table rows with page_number, line_number, line_type (ayah|surah_name|basmallah), is_centered, first_word_id, last_word_id, surah_number — https://qul.tarteel.ai/docs/mushaf-layout
- [V] quran.com ReadingPreference enum: translation, reading, readingTranslation; WordByWordDisplay inline|tooltip; QuranFont code_v1/code_v2/tajweed_v4/text_uthmani/text_indopak/qpc_uthmani_hafs/tajweed; MushafLines 15_lines/16_lines; max font step 10; side menu 24rem; tooltip hover delay 700ms — quran.com-frontend-next types/QuranReader.ts, src/styles/_constants.scss, src/components/dls/QuranWord/QuranWord.tsx (saved in qdc/)
- [V] quran.com: words get role='button' tabIndex=0 when clickable; copy handler replaces glyph text with Uthmani text using data-word-location; fallback shows qpcUthmaniHafs text in UthmanicHafs until page font loads; V4 highlight uses color:transparent + text-shadow; audio hotkeys space/right(NEXT_AYAH)/left(PREV_AYAH) — qdc/src__components__dls__QuranWord__QuranWord.tsx, onCopyQuranWords.ts, GlyphWord.tsx/.module.scss, AudioKeyboardListeners.tsx
- [V] quran.com repeat modal: RepetitionMode single/range/chapter with repeatRange, repeatEachVerse, delayMultiplier — https://raw.githubusercontent.com/quran/quran.com-frontend-next/production/src/components/AudioPlayer/RepeatAudioModal/RepeatAudioModal.tsx and SelectRepetitionMode.tsx
- [V] quran.com theme colors: light bg #fff text #272727; sepia bg #f8ebd5 elevated #fff7ea; dark bg #1f2125 text #e7e9ea; accent #2ca4ab — qdc/src__styles__themes___light.scss/_sepia.scss/_dark.scss
- [V] quran.com-frontend-next GitHub repo has no license declared — GitHub API repos/quran/quran.com-frontend-next (license null); saved github-repos.txt
- [V] quran_android Play Store features: Madani images, gapless audio, ayah bookmarking/tagging/sharing, 15+ recitations with highlighting, search, night mode, customizable repeat, translations/tafsir in 20+ languages — Play Store page scrape saved quran_android-playstore-description.txt
- [V] quran_android settings: night mode text brightness (default 255, max 255) and background brightness (default 0), New background, Show page info overlay, marker popups on juz/hizb, highlight bookmarks, dual page mode, split page+translation, ayah before translation, dyslexia-friendly font, streaming, download amount, volume key navigation — https://raw.githubusercontent.com/quran/quran_android/main/app/src/main/res/xml/quran_preferences.xml and values/strings.xml (saved)
- [V] quran_android audio options: From/To, 'Only play the above verses', 'Play set of verses', 'Play each verse' with 1/2/3 times/loop, playback speed; movable reading bookmark with undo; collections, tags, recent pages, import/export incl. CSV — quran_android values/strings.xml saved as quran_android-strings.xml
- [V] quran_android colors: page_background #FFF4CB, selection_highlight #404694A6, audio_highlight #4046A646, note_highlight #40EBEB21, bookmark_highlight #40A4A4A4, highlight list ramp #f9a825/#2e7d32/#1565c0/#c62828/#6a1b9a — https://raw.githubusercontent.com/quran/quran_android/main/app/src/main/res/values/colors.xml (saved)
- [V] quran_android is GPL-3.0; README says data typically CC BY-NC-ND and asks for non-profit use — GitHub API + README saved quran_android-README.md
- [V] Quran Companion: Qt >= 6.10, Waqf General Public License, latest release v1.5.2 (2026-03-25); features: dark theme, mushaf page or verse-by-verse, resizable page, player, recitation downloads, verse highlighting, translations/tafsir, search; two-page spread shows odd page on right, even on left — README saved quran-companion-README.md; GitHub releases API; screenshots two-pages.png/dark.png viewed (not kept)
- [V] Quran Companion issues include #179 gaps between verses, #177 settings window too big with text scaling, #175 last page not restored on Linux, #87 ctrl+scroll zoom, #71 juz jump when juz starts mid-page, #165 audio output devices, #124 custom colorscheme, #121 flashcards, #178 QCF V4 tajweed — GitHub issues API saved quran-companion-issues.txt
- [V] Tarteel iOS: latest 5.81.7; premium mistake detection, hidden verses/peeking, goals, streaks/heatmaps; free follow-along and voice search; 5.81.1 added Test Mode random start; 5.78.0 removed pauses between ayahs — https://apps.apple.com/us/app/-/id1391009396
- [V] Ayah iOS app v28.0 (2025-03-20): Madinah Mushaf latest edition, verse-by-verse highlighting with repeat, khatmah, colorful bookmarks, starred verses, thematic highlighting grouped by surah/color, swipe-down search, play to end of khatmah day — https://apps.apple.com/us/app/id706037876
- [?] Zekr: Java/SWT, GPL-2.0, latest 1.1.0; advanced/root search, multi-recitation, translation compare and search, plugin packs; zekr.org did not resolve — WebSearch (sourceforge/launchpad/manpages results); WebFetch zekr.org failed with EAI_AGAIN
- [V] Fluent 2 motion tokens: durations 50/100/150/200/250/300/400/500ms; curves easyEase cubic-bezier(0.33,0,0.67,1), decelerateMax (0.1,0.9,0.2,1), accelerateMax (0.9,0.1,1,0.2), decelerateMid (0,0,0,1) — https://unpkg.com/@fluentui/tokens@1.0.0-alpha.24/lib/global/durations.js and curves.js
- [V] ARIA 1.2 prohibits naming (aria-label/aria-labelledby) on role generic (plain span/div), caption, code, paragraph, presentation, etc. — https://www.w3.org/TR/wai-aria-1.2/ section 5.2.8.6
- [V] Feature support: forced-colors Chrome 89/Safari 16; prefers-contrast Chrome 96/Safari 14.1; CSS Custom Highlight API Chrome 105/Safari 17.2/Firefox 140; view-transitions Chrome 111/Safari 18; :dir() Chrome 120/Safari 16.4; logical props Safari 15; text-box-trim Chrome 133/Safari 18.2 — MDN BCD raw JSON + caniuse features-json; saved caniuse-summary.txt
- [?] Material bidi guidance: do not mirror media playback buttons and media progress indicators in RTL — WebSearch citing m1/m2 material.io bidirectionality pages and GTK issue 2469 (m2 page itself not readable via fetch)
- [V] Paraglide JS 2.26.0 setLocale() performs full document reload by default; {reload:false} escape hatch exists; Vite plugin paraglideVitePlugin; peer vite >=5, typescript >=5.6 — https://unpkg.com/@inlang/paraglide-js@2.26.0/README.md ; npm view peerDependencies
- [V] Vitest 5 browser mode config: import { playwright } from '@vitest/browser-playwright'; test.browser { enabled, provider: playwright(), instances: [{browser:'chromium'},{browser:'webkit'}] }; vitest-browser-svelte render() — https://vitest.dev/guide/browser/
- [V] All listed @fontsource packages (inter, noto-sans-arabic, noto-naskh-arabic, literata, amiri, amiri-quran, opendyslexic, ibm-plex-sans-arabic) are v5.3.0 and OFL-1.1 — npm view <pkg> version license
- [?] Classic Madani print colours (cream paper, green/gold border ornaments, surah-header cartouche) — no official King Fahd Complex spec found; token hex values in proposed-tokens.css are design proposals — WebSearch returned only retail listings (e.g. darussalam.uk 'cream paper ... green illuminated borders')

## Recommendations
- Pin: svelte 5.57.2, @sveltejs/vite-plugin-svelte 7.3.1, vite 8.3.4, typescript ~6.0.3 (NOT 7.x), svelte-check 4.7.6, @tsconfig/svelte 5.0.8, vitest 5.0.3 + @vitest/browser-playwright 5.0.3 + playwright 1.64.0 + vitest-browser-svelte 3.1.0, @testing-library/svelte 5.4.2 + jsdom 30.1.2, bits-ui 2.19.5 + @internationalized/date 3.12.4, @lucide/svelte 1.54.0, virtua 0.53.3, paneforge 1.0.2, svelte-sonner 1.2.1, @inlang/paraglide-js 2.26.0, @tauri-apps/api 2.12.2, @tauri-apps/cli 2.12.1 (see proposed-package.json; dry-run install is clean).
- Use hand-written CSS with semantic design tokens (proposed-tokens.css): @layer, CSS custom properties, logical properties, Svelte scoped styles and html[data-theme=paper|sepia|night|black]. Skip Tailwind v4: its docs advise against Svelte <style> blocks, and this UI is mostly bespoke typography.
- Do not copy the Tauri Vite guide's build.target 'safari13'. Keep Vite 8's default 'baseline-widely-available' (chrome111/safari16.4) and set bundle.macOS.minimumSystemVersion to about "13.3" instead of the default "10.13". Test on WebKitGTK 2.50+ (Ubuntu 22.04/24.04, Debian 12/13).
- Build the command palette with bits-ui Command inside Dialog (cmdk-sv is archived). Write a custom filter that normalizes Arabic (strip U+064B-0652, U+0670, U+0640; unify alef forms, ى→ي, ة→ه) and put multilingual surah aliases in keywords. Set vimBindings={false} or toggle Ctrl+K in a window capture listener.
- Use virtua/svelte VList for translation/verse-by-verse mode, search results and tafsir lists (dynamic heights, scrollToIndex). Show the Mushaf as a paged book (one or two pages) rather than a virtual list; optionally offer a continuous mode with VList and a fixed itemSize.
- QCF V4 tajweed: load per-page FontFace 'p{N}-v4'. Generate @font-palette-values from JS with literal colors: base-palette 0/1/2 for light/dark/sepia tajweed, 3/4/5 for tajweed-off monochrome. Switch with font-palette. COLR v0 renders in WebView2 and WKWebView.
- For page fonts: render bundled Hafs Unicode text first, size-matched to avoid layout shift, then swap to the page glyph font when document.fonts.load resolves. Preload ±2 pages and keep an LRU of FontFace objects. Intercept copy events to emit Unicode text with a configurable reference format.
- Two-page spread with odd page on the right and even on the left. In the Mushaf, ArrowLeft means next page and ArrowRight previous, regardless of UI language. Use separate keys for next/previous ayah. Do not mirror media transport icons or the seek bar.
- Accessibility: one tab stop per page with roving tabindex across ayahs. Keep glyph spans aria-hidden and add visually hidden Unicode Arabic text (lang=ar) plus the ayah number. Don't put aria-label on generic spans. Add a polite live region for now-playing (opt-in during continuous playback), a skip link, a 2px focus ring, and forced-colors/prefers-contrast overrides.
- Wrap every Svelte transition and Spring/Tween animation with prefersReducedMotion from svelte/motion (duration 0 / instant: true). Use Spring to glide the audio word highlight. Use View Transitions for page turns when available.
- Adopt the best competitor ideas: quran.com's three reading preferences, inline/tooltip word-by-word and delayMultiplier repeat; quran_android's night text/background brightness, page-info overlay, juz/hizb marker popups, movable reading bookmark with undo, and 5-colour highlights; Tarteel's hide/peek and random-start test mode; Ayah's khatmah plan and highlights grouped by colour/surah; Zekr's root search and translation comparison.
- Desktop-first extras: resizable translation/tafsir pane (paneforge), menubar plus Ctrl+K palette plus '?' shortcut sheet, right-click ayah context menu, Ctrl+wheel zoom, always-on-top mini player and tray, projector/presentation mode on a second monitor, quran-desktop://s:a deep links, Mica/vibrancy on window chrome only, and Windows scrollBarStyle 'fluentOverlay'.
- Use paraglide with setLocale(locale,{reload:false}) and re-render the app inside {#key locale}, or keep audio in the Rust core so a reload never interrupts playback.
- Run component and visual tests in Vitest browser mode on both chromium and webkit instances, with screenshot baselines for pages 1, 2, 3, 262 and 604 in each theme and both UI directions.

## Risks
- TypeScript 7.0.2 is npm 'latest', but svelte-check 4.7.6 and typescript-eslint 8.71.1 support only TS 5/6. Installing typescript@latest would break type-checking and linting.
- QCF page fonts and the QUL surah-header font carry 'King Fahad Complex, All rights reserved' in their name tables. Check redistribution and bundling rights before shipping or caching them, and don't hotlink quran.com's /fonts paths without permission.
- quran.com-frontend-next has no license, so its patterns can be studied but code must not be copied. quran_android is GPL-3.0 with mostly CC BY-NC-ND data.
- WebKitGTK rendering and performance (Arabic glyph fonts, font-palette, backdrop-filter, View Transitions) is the least verified target. COLRv1 on WebKitGTK is unconfirmed, but QCF V4 uses COLR v0, which reduces the risk.
- Vite 8's default target (safari16.4) means old macOS WebKit can't run the build. minimumSystemVersion must be raised to match, or the app may fail on old Macs.
- virtua is pre-1.0 (0.53.x), so the API can change between minor releases; pin exactly.
- Several runed versions get installed transitively (bits-ui, paneforge, svelte-sonner pin different ones), which adds a little bundle duplication.
- bits-ui Command vimBindings defaults to true, so Ctrl+K inside the palette moves the selection up and conflicts with a Ctrl+K toggle unless handled.
- paraglide's default setLocale reloads the webview. If audio playback lives in the webview it will stop; keep audio in Rust or use reload:false.
- On macOS 14+ the webview may throttle background timers. Drive ayah/word highlighting from Rust audio-position events rather than JS timers, or configure backgroundThrottling.
- Tokens and hex values for 'authentic Madani print' styling are design proposals. No official King Fahd Complex specification was found.
- Svelte transitions likely do not honor prefers-reduced-motion automatically (docs are silent), so every transition needs an explicit guard.
