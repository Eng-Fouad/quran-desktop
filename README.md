# Quran for Desktop

<p dir="rtl" lang="ar"><b>قرآن لسطح المكتب</b></p>

The Madani Mushaf on your desktop: the printed page, line for line, on a large screen, with recitation that follows
word by word, translations and tafsir, search, memorisation and a keyboard for everything. Offline-first, for Windows,
macOS and Linux.

> **Status:** in development, not yet released. The app is built to the identity of the
> [Quran.com](https://quran.com) project ([github.com/quran](https://github.com/quran)), which its author plans to
> contribute it to. That identity is **pending the approval of the quran organisation's maintainers**, and no public
> release uses it before that approval.

- [What it is](#what-it-is)
- [Feature tour](#feature-tour)
- [Screenshots](#screenshots)
- [Architecture](#architecture)
- [Build, run and test](#build-run-and-test)
- [Data sources and licensing](#data-sources-and-licensing)
- [Credits](#credits)
- [Licence](#licence)

## What it is

Quran for Desktop is a native desktop Quran reader that treats the screen like a beautifully printed Mushaf: the 604
pages of the Madani Mushaf drawn from the King Fahd Complex's own fonts, never from images, with the depth of a study
tool around them. It is a new application inspired by [quran_android](https://github.com/quran/quran_android), not a
port: no code is copied from it.

- **Product name** "Quran" (window, taskbar, installer, tray, media controls); **full name** "Quran for Desktop" (About,
  onboarding); Arabic **قرآن** / **قرآن لسطح المكتب**.
- **Identifier** `com.quran.labs.desktop`, mirroring quran_android's `com.quran.labs.androidquran`. It also names the
  data folder.
- **Icon:** the قرآن mark of quran_android, used under GPL-3.0 and credited in About.
- The repository, the Rust crates and the binary keep the working name `quran-desktop`.

## Feature tour

### Reading the Mushaf

- **The printed page, line for line.** Every page has the lines, line breaks and centred lines of the print, the page
  frame, the surah headers in their cartouches, the basmala lines, running heads (surah, juz, quarter) and the page
  number in Arabic-Indic digits. The margin carries the juz, hizb and quarter markers with their labels, and the sajda
  marks.
- **A book on a large screen.** Two-page spreads (odd page on the right) or a single page, chosen by the window size;
  fit to the window with zoom on top; a page rail to scrub through the 604 pages; held arrow keys flip through pages at
  the pace of a thumb.
- **Nothing jumps.** Fonts, decorations and data arrive without a single layout shift, and page turns animate only into
  pages that are ready to paint.
- **Hover, select, act.** Hover an ayah to tint it, click to select it, right-click for its menu; a small action bar
  offers play, bookmark, highlight, note, copy and tafsir. Copy gives proper Unicode Uthmani text with its reference.
- **Follow along.** While a recitation plays, the page turns with it, and a chip brings you back if you read elsewhere.

### Mushaf styles, including tajweed

- **Hafs** (always available, offline): the KFGQPC Hafs Unicode font that ships with the app, on the 1421H layout,
  fitted per spread.
- **QCF V2** (1421H) and **QCF V1** (1405H, its own layout): the King Fahd Complex's per-page fonts, which reproduce the
  print glyph for glyph.
- **QCF V4 tajweed**: the colour-coded tajweed rules from the font's own palettes, retinted for every theme and kept
  readable in high contrast.
- Page fonts download on demand (with the neighbouring pages prefetched) or all at once, and cross-fade in. Offline,
  a page shows the Hafs rendition until its font is there.

### Recitation with word sync

- **14 reciters** from Quran.com's QDC audio, with gapless surah files and **ayah and word timings**: the recited ayah is
  tinted and a pill glides from word to word.
- A native Rust audio engine: sample-accurate markers, the basmala before every surah that has one, repeat each ayah
  or the whole range (×N or ∞), an A-B loop, a pause between repeats, and **0.5× to 2× speed that keeps the pitch**.
- Plays from a page, an ayah, a surah, a selection or a saved loop preset; streams while caching, or downloads a reciter
  surah by surah for offline listening.
- **OS media controls** (Windows media flyout, macOS Now Playing, Linux MPRIS) and a tray mini-player. Closing the window
  while reciting can keep the recitation going in the tray.

### Memorisation

- **Hide** the words (blurred or blank) and reveal them word by word (`W`), ayah by ayah (`Shift+W`), or peek while
  holding `Q`.
- **Self-test** from a random start in a range: count hints and mistakes, then rate the recitation; a spaced-repetition
  schedule tells you what is due.
- A progress map of the whole Mushaf, page by page, and loop presets for recitation drills.

### Search

- Arabic search that ignores diacritics and letter variants (alef forms, hamza seats, ya, ta marbuta), with prefixes,
  phrases, a typo fallback ("did you mean"), exact and contains modes, and filters by surah or juz.
- Results grouped by surah with the matched words in context; opening one highlights the matched words on the page.
- Search in installed translations and in your notes too. Typing a reference (`2:255`) offers the jump instead.

### Translations, tafsir and word by word

- **Translation mode** (`T`): a verse-by-verse feed with up to five translations, footnotes as popovers or inline, and
  the recited verse kept in view.
- **Study pane** beside the page: translation, tafsir, notes and word-by-word tabs for the selected or recited ayah.
- 13 translations in 11 languages from QuranEnc, installed as packs and searchable; tafsir in Arabic and English; and
  word-by-word meanings in 8 languages. Quran.com's tafsir and word by word are fetched as you read and kept for
  offline use. Urdu can be set in Nastaliq.

### Bookmarks, highlights and notes

- Ayah and page bookmarks, a movable reading bookmark (a ribbon in the margin), five highlight colours, notes in a small
  Markdown with links to ayahs, collections and tags.
- Reading and listening history, the last position restored on launch, and **undo** for every change.
- A library backup and restore in Settings.

### Command palette and shortcuts

`Ctrl+K` (`⌘K` on macOS) opens the palette: type `2:255`, `p 262`, `j 15`, a surah name in Arabic, English or
transliteration, a command, a setting or a reciter (`>`, `#` and `@` narrow it). Everything has a key; `?` shows them
all. A few:

| Key                     | Action                      | Key                 | Action                       |
| ----------------------- | --------------------------- | ------------------- | ---------------------------- |
| `←` `→` / `PgDn` `PgUp` | Next / previous page        | `Space`             | Play or pause                |
| `↓` `↑` / `J` `K`       | Next / previous ayah        | `.` `,`             | Next / previous ayah (audio) |
| `Ctrl+G`                | Go to                       | `R` / `L`           | Repeat / A-B loop            |
| `Ctrl+F`                | Search                      | `[` `]`             | Slower / faster              |
| `B` / `Shift+B`         | Bookmark / reading bookmark | `E` / `Shift+E`     | Hide / self-test             |
| `1`–`5` / `0`           | Highlight / remove          | `T`                 | Translation mode             |
| `N`                     | Note                        | `Z`                 | Zen mode                     |
| `C`                     | Copy                        | `Ctrl+B` / `Ctrl+I` | Sidebar / study pane         |

`Ctrl` is `⌘` on macOS. The Arabic interface keeps the same keys; the page-turn arrows follow the book (← is the next
page).

### Themes, accessibility and the Arabic interface

- Paper, Sepia, Night, Black and High contrast (light and dark), or follow the system; six accent colours; the ink
  brightness of night pages; interface size from 80 % to 200 %.
- Keyboard-first with visible focus; a screen-reader layer that reads every ayah as text with its place; reduced motion,
  more contrast and forced colours honoured.
- A complete **Arabic interface**: mirrored right to left, Arabic-Indic digits and Arabic typefaces. The Mushaf is right
  to left in every language.

### Offline-first, on the desktop

- The Quran text, the three page layouts and the Hafs font ship with the app: it reads offline from the first launch.
  Everything else (page fonts, translations, tafsir, recitations) comes through a **Downloads** manager with pause,
  resume, disk usage and a cache limit, or is fetched as you read and kept.
- A "Work offline" switch, no account, no telemetry. Network use is always visible.
- A custom title bar (Mica and Snap Layouts on Windows 11), a tray, a single instance that restores its window,
  `quran-desktop://2:255` links, and a zen mode that leaves only the page.

## Screenshots

There are no screenshots in this repository on purpose: the project never commits Mushaf images (ARCHITECTURE §12.6),
and pages drawn from a development `core.db` show Quran Foundation data that may not be redistributed. Generate them on
your machine and keep them there. The visual QA scenarios render the app and write PNGs to `artifacts/shots/`
(gitignored):

```sh
pnpm core:qdc && pnpm fixtures && pnpm dev-packs     # local data for real pages (development only, never shared)
pnpm shots:web --only S03,S04,S09,S16,S19,S20,S21,S22,S24,S26,S27,S33
pnpm shots:web --list                                # every scenario with what it shows
```

| Scenario | Shows                                                    | Scenario | Shows                                      |
| -------- | -------------------------------------------------------- | -------- | ------------------------------------------ |
| S03      | The opening spread in Hafs: frame, medallion, cartouches | S21      | Translation mode with two translations     |
| S04      | The opening spread in QCF V2 with the decorated headers  | S22      | The study pane's tafsir tab in Arabic      |
| S09      | Page 50 in QCF V4 with the tajweed colours               | S24      | Settings in high contrast at 150 %         |
| S16      | A recitation paused mid-ayah: ayah and word highlight    | S26      | The Arabic interface, mirrored             |
| S19      | Search for الرحمن with results grouped by surah          | S27      | Memorisation: hidden words, three revealed |
| S20      | The command palette                                      | S33      | Bookmark, note and reading-bookmark marks  |

`pnpm shots:app` runs the same scenarios in the real app on Windows. [`docs/DEVELOPING.md`](docs/DEVELOPING.md) §7 has
every option.

## Architecture

A [Tauri 2](https://tauri.app) application: a Rust core and a Svelte 5 interface in the system webview (WebView2,
WKWebView, WebKitGTK). The two talk through a typed IPC contract that is generated from the Rust types, so the frontend
never hand-writes a message. Page fonts and other downloaded files reach the webview through the app's own `quran://`
protocol; audio never goes through the webview at all.

```
            Svelte 5 SPA in the webview  ◄── typed IPC (bindings.ts), events, channels, quran:// ──►  Rust process

  Crates (each arrow points from a crate to a crate it depends on):

  quran-types ◄── quran-core ◄── quran-packs ◄──┐
       ▲    ▲                                   ├── src-tauri ──► media-session
       │    └──────── quran-audio ◄─────────────┘
       └──────── xtask ──► quran-core, quran-packs
```

- **`crates/quran-types`**: the contract. Every DTO, the error model and the settings, with serde and specta derives;
  `src/lib/ipc/bindings.ts` is generated from it.
- **`crates/quran-core`**: Arabic normalisation and search (SQLite FTS5), the read-only `core.db` (text, layouts,
  glyph codes), the user library (`user.db`) and the content cache (`content.db`).
- **`crates/quran-audio`**: the audio engine. Planner, decode (symphonia), pitch-preserving WSOLA, resampling, cpal
  output, sample-accurate markers and streaming sources.
- **`crates/quran-packs`**: the pack catalog, resumable downloads with integrity checks, the installers for fonts,
  translations, tafsir, word by word and recitations, and the 7-day revalidation of Quran Foundation content.
- **`crates/media-session`**: OS media controls behind one API (SMTC on Windows, Now Playing on macOS, MPRIS on Linux).
- **`src-tauri`**: the thin app shell. Commands, startup, the `quran://` protocol, window chrome, tray, deep links and
  the glue to the crates above.
- **`xtask`**: developer tasks. Building and verifying `core.db` (18 data gates), browser-mock fixtures, the bundled
  font, licence notices and the catalog check.

Only `src-tauri` depends on Tauri, so every crate is tested headless. The frontend (`src/`) is a single-page app of rune
stores and components: the Mushaf renderer (`components/mushaf`, `lib/mushaf`), the player, search, palette,
translation, side pane, library, downloads, settings and onboarding, on a design system of tokens and primitives
(`styles/`, `components/ui`). A browser mock of the whole IPC lets the interface run and be tested in a normal browser.

The design is specified in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), read together with
[`docs/IMPLEMENTATION_NOTES.md`](docs/IMPLEMENTATION_NOTES.md), which records what the build changed. The product
decisions are in [`docs/BRIEF.md`](docs/BRIEF.md) and the verified facts behind them in
[`docs/research/FACT_SHEET.md`](docs/research/FACT_SHEET.md).

## Build, run and test

You need Node.js 22.12+, pnpm 10.24 (`corepack enable`) and Rust 1.99 (pinned by `rust-toolchain.toml`; rustup installs
it), plus the Tauri 2 prerequisites of your system:

- **Windows 10/11:** Microsoft C++ Build Tools ("Desktop development with C++") and WebView2 (preinstalled on Windows
  11). Clone into a short path and set a short `CARGO_TARGET_DIR` (for example `C:\qdt\t`): native tools fail near 260
  characters. In Git Bash, put `%USERPROFILE%\.cargo\bin` on `PATH`.
- **macOS 13.3+:** Xcode Command Line Tools.
- **Linux (Ubuntu 22.04+):**

  ```sh
  sudo apt-get install -y build-essential pkg-config curl wget file patchelf libwebkit2gtk-4.1-dev \
    libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libasound2-dev
  ```

Then:

```sh
pnpm i --frozen-lockfile
pnpm assets                              # the bundled KFGQPC Hafs font (downloaded and verified; offline, the committed copy)
pnpm dev:web                             # the interface in a browser against the IPC mock: http://localhost:1420
pnpm core:qdc                            # a development core.db from the Quran.com API (stays on your machine)
pnpm tauri build --debug --no-bundle     # the real app (or `pnpm app:dev` for live reload)
```

Tests and checks:

```sh
pnpm test                                # unit tests (vitest)
pnpm fixtures && pnpm test:browser       # component tests in a real browser (Edge on Windows)
cargo test --workspace                   # Rust tests (the audio tests never use the speakers)
pnpm check && pnpm lint && pnpm format:check && cargo lint
pnpm shots:web                           # visual scenarios in the browser mock
```

[`docs/DEVELOPING.md`](docs/DEVELOPING.md) is the full runbook: the data, every command and environment variable, the
QA drivers, private preview builds and the common failures. Releases are built by `.github/workflows/release.yml` from a
`v*` tag into a draft GitHub release, which a person publishes after
[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md).

## Data sources and licensing

The Quran text, layouts, fonts, translations, tafsir and recitations belong to their publishers and are used under
their own terms. The app credits each of them, with its licence, under **About**.

| Source                                                                             | What the app uses                                                             | How                                                                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [King Fahd Glorious Qur'an Printing Complex](https://qurancomplex.gov.sa) (KFGQPC) | The Madani Mushaf: the KFGQPC Hafs font, the QCF page fonts, the page layouts | The Hafs font ships unmodified under its licence; page fonts download on demand into the user's app data. |
| [Quranic Universal Library](https://qul.tarteel.ai) (QUL, Tarteel)                 | Layouts, glyph codes, text and metadata for the release `core.db`             | Release builds only, and only once written permission is recorded (below).                                |
| [Quran Foundation](https://quran.foundation) / [Quran.com](https://quran.com) APIs | Recitation timings, tafsir and word by word; development `core.db` builds     | Fetched per user and refreshed at least every 7 days (QF terms); never redistributed.                     |
| [Tanzil](https://tanzil.net)                                                       | Quran metadata (juz, hizb, manzil, ruku, sajda) as a cross-check              | CC BY 3.0, with attribution.                                                                              |
| [QuranEnc](https://quranenc.com)                                                   | Translations and At-Tafsir Al-Muyassar                                        | Installed unmodified with attribution; updates are offered as QuranEnc publishes them.                    |
| [QuranicAudio](https://quranicaudio.com)                                           | Recitation audio                                                              | Streamed and cached in the user's app data for personal use; never mirrored or exported.                  |
| Inter, Noto Naskh Arabic, IBM Plex Sans Arabic, Noto Nastaliq Urdu                 | Interface typefaces                                                           | SIL Open Font License 1.1.                                                                                |

Two rules follow from these terms, and the tooling enforces both:

- **A development `core.db` is never distributed.** `pnpm core:qdc` builds `core.db` from the Quran Foundation API for
  local development. That file, the fixtures made from it and the cached responses must never be committed, uploaded,
  attached or shared. `.gitignore` excludes them, CI's upload guard refuses them, and every installer build refuses a
  development `core.db` unless a private preview is requested explicitly.
- **A release needs QUL data and permission.** Release builds use `pnpm core:qul` from QUL exports placed by a person
  ([`data/sources/README.md`](data/sources/README.md)). QUL publishes no licence for this data, so no release ships until
  written permission from Tarteel/QUL (and ideally Quran Foundation) is recorded there.

## Credits

- **Quran.com and the quran_android contributors** for the app's name, identity and icon, and for the reader this app
  takes its inspiration from.
- **The King Fahd Glorious Qur'an Printing Complex** for the Madani Mushaf and its fonts.
- **Tarteel's Quranic Universal Library**, **Tanzil**, **QuranEnc**, **Quran Foundation** and **QuranicAudio** for the
  data and audio, and the reciters and translators whose work they carry.
- The open-source projects the app is built on, listed with their licence texts in the app under **About ▸ Open-source
  licences** (generated by `cargo xtask licenses`).

## Licence

Copyright © Quran for Desktop contributors.

Quran for Desktop is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License in
[`LICENSE`](LICENSE) for more details.

Third-party components keep their own licences: the open-source packages are listed with their licence texts in the
app (**About ▸ Open-source licences**), the KFGQPC Hafs font ships unmodified under the King Fahd Complex's end-user
licence (its copy in `xtask/assets/` too: it is not covered by the GPL), and the data and audio sources above are used
under their own terms.
