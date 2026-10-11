# WP9a deviations (player store and dock)

Delivered:
- **Store** `src/lib/stores/player.svelte.ts`: the snapshot and the 30 Hz tick channel, rAF interpolation, word
  timings and the active word, the resume candidate (§7.8), every transport command of §7.3, failures, the `audio`
  reading position, speed and volume reaching the engine, recitation announcements.
- **Dock** `src/components/player/**`: `PlayerDock` (bar, compact, idle pill, collapsed pill, error pill),
  `SideDockCard`, `Transport`, `AyahScrubber` (+ `scrubber.ts`, pure geometry), `TimeReadout`, `RepeatPopover`,
  `SpeedPopover`, `ReciterPicker`, `PlayerMore`, plus two new files: `DockError.svelte` (the §9.8 error state shared by
  both placements) and `dock.svelte.ts` (monogram, labels, idle offer, live repeat badge, collapsed state, key hints).
- **Shortcuts** `src/lib/shortcuts/audio.ts`: the fourteen §10.1 audio rows, `idleTarget()` and the reference-counted
  `registerAudioShortcuts()`.
- **Mock** `src/lib/ipc/mock/handlers/audio.ts`: a simulated engine (planner, statuses, clock, repeats, gaps, A-B,
  skips, seeks, streaming and caching, offline, no output device).
- **Dictionaries** `src/lib/i18n/{en,ar}/player.ts` (Arabic plurals with all six categories).
- **Scenarios** `tests/e2e/scenarios/{S16, S17}.mjs`.

Tests:
- **Unit** (`vitest --project unit`, 60 tests):
  - `src/lib/stores/player.test.ts` (26): `interpolate` (speed, clamps, stale ayah end), `activeWordAt` with repeated
    and backward positions and inter-word gaps, the helpers; and the store on the mock engine: play → interpolation →
    active word, word-object reuse, tick jitter vs real jumps, backward positions in the timings, the engine-word
    fallback and the basmala, `cycleRepeat`, repeat ×3 with a ×1 gap, `abMark` (A, short, B, wrap, clear), speed and
    volume and mute, Space's idle target, stop → resume candidate → Space resumes, the natural end, the 7-day rule,
    offline, Retry, `setReciter` mid-play, next/prev/seekAyah/nudge.
  - `src/lib/ipc/mock/handlers/audio.test.ts` (21): validation, planning and the basmala rule, stop-at units, statuses,
    clock and ticks, flushes, end vs stop, the persisted idle snapshot, repeats, gaps, range passes, A-B, skips, seeks
    while loading, offline, the skipped basmala, stream caching and the reciters' counts, buffering, no output device,
    offline timings, `audio-ayah-changed` once per ayah.
  - `src/components/player/player.test.ts` (8): tick density (per ayah, per ten, per page), tall labelled ticks
    without collisions, lookups and Shift-snapping, the monogram.
  - `src/lib/shortcuts/audio.test.ts` (5): every chord on US keys and the Arabic-layout `code` fallback, global scope
    and the audio group, reference-counted registration, `idleTarget`.
- **Browser** (`vitest --project browser src/components/player`, 13 tests in `player.browser.test.ts`, real `App` on
  the mock): idle pill → bar morph and the §9.7 bar geometry; Space plays/pauses and Space on a focused dock button
  presses it (§7.7); the scrubber slider keys (±5 s, PageUp) never turn the page; track click and Shift-snap; the repeat
  popover sets ×3 live with the "1/3" badge; arrow keys in the speed slider change the speed, not the page (§7.7); the
  reciter picker filters by an Arabic name and chooses with Enter; the 272×120 side card; the narrow bar (monogram,
  one-line readout, no labels, no overlap); the Arabic UI keeps transport, scrubber and times left to right; collapse
  and expand; the resume pill and forgetting it; the offline copy with "Download when online".

## Deviations from ARCHITECTURE.md

1. **Who registers the audio shortcuts.** The player store is L2 and must not import the reader (§7.2), yet Space with
   nothing loaded plays "the selection, else the first ayah of the visible page" (§10.1). So `audio.ts` decides that
   target (`idleTarget()`, which reads the reader) and hands it to `player.toggle(idleTarget)`, and the definitions
   are registered by the dock while it is mounted: `registerAudioShortcuts()` in `PlayerDock`/`SideDockCard`
   `onMount`, reference-counted, so switching placement never drops them. A dock is mounted in every view (§7.4).

2. **Space with nothing loaded** follows §10.1's order: the resume candidate, else the selection (a multi-ayah
   selection plays exactly that range; a single ayah plays from it to the stop-at unit), else the first ayah of the
   first visible page. The idle dock offers the same thing ("Resume Al-Kahf · 18:45" / "Play Al-Fatihah from 1:1"),
   so Space never does something the dock did not announce. With nothing else to play, Space replays the last play.

3. **Store API beyond §7.3** (additive; every §7.3 name and the wave-0 signatures are kept, including
   `playFrom(target, { stopAt?: AyahRef })`, which WP8c's surah popover uses):
   - State: `heard` (`{surah, ayah, ayahId}`, replaced only when it changes), `inGap`, `audioPosition`,
     `resumeDismissed`, `failure`.
   - Derived: `status`, `wantsPlay` (playing, loading or buffering: the transport shows Pause), `ayahSpan`,
     `reciter` (the playing one, else the setting), `speedPct` (the engine's while loaded, else the setting), `error`
     (`PlayerError {kind: offline | output | other, error, surah, reciterId}`).
   - Methods: `toggle(idleTarget?)`, `retry()`, `dismissError()`, `dismissResume()`, `clearAb()`,
     `refreshReciters()`, `timingsFor(reciter, surah)` (reactive read), `sample(now)` (the rAF step, also used by
     tests). `playFrom` options also take `to` (an id), `until` (a `StopAt`), repeats, gap and `startPaused`.
     `abMark()` returns the step taken, `speedStep()` the new speed, `cycleRepeat()` the new ayah repeat.
   - Module exports: `interpolate`, `activeWordAt`, `ayahTiming`, `nextAyahRepeat`, `clampSpeed`, `isActiveStatus`,
     `formatSpeed`, `formatClock`, `isolatedClock` and the constants.

4. **`currentAyahId` is `null` during the basmala.** The engine reports `current_ayah_id = 0` there (WP4c deviation
   9); `currentRef` keeps `{surah, ayah: 0}` (WP8c's `BasmalaLine` reads it), and `currentAyahId` means "the ayah being
   recited", so no consumer has to special-case 0.

5. **Interpolation details (§7.3).**
   - The upper bound is `max(tick.fileMs, ayahEnd + 250)`: a stale ayah end (the state event of a new ayah not
     received yet) never pulls the position back below the tick.
   - Within one flush generation a step back of less than 120 ms is tick jitter and is absorbed; a larger one (a
     repeat, an A-B wrap, a seek without a flush) passes through.
   - Paused, buffering, in a gap or in a hidden document there is no extrapolation: each tick (or state event) sets
     the position.
   - The active word is found by time in the timings (`activeWordAt`); when the surah's timings are not loaded (or
     cannot be, offline) the engine's own `wordPos` from the tick is used. The `ActiveWord` object is reused while the
     word is the same, so the highlight layer re-runs per word, not per frame.

6. **Settings and the engine.** `speedPct` and `volumePct` are settings; an effect in the store sends them to the
   engine whenever they differ from what it last sent. So a change from the dock, the shortcuts, the palette or
   Settings is heard at once in the mock as in the real app (where `settings_set` → `apply_settings` sends the same
   value again, a no-op in the engine, WP4c deviation 11). Mute is session state: the engine's volume is 0 and the
   setting is kept. Repeat and gap changes from the dock apply to the loaded play and become the defaults of the next
   one; the options of `playRange` (the action bar, presets) are for that play only. Speed changes from the slider are
   applied when the drag ends (one flush, D15).

7. **The `audio` reading position** (§7.8 reads it; no package writes it). The player store writes
   `{context: 'audio', layout, page, ayahId}`: debounced 1 s after each heard ayah, at once at a stop (the ayah heard
   last) and at the natural end of a play (the ayah after the range, so "Resume" continues; at the end of the Quran
   the candidate is dropped). The candidate updates in the store immediately, so the idle dock offers it right after
   a stop.

8. **Failures resolve.** `playFrom`/`playRange` never reject: a rejected `audio_play` and an engine `error` status
   both land in `player.error`, which the dock shows with the §9.8 copy and Retry or "Download when online" (a job for
   that surah that waits for the network, WP12a). The zen dock is revealed for it (`ui.pokeDock`). Callers that
   `.catch(ui.toastError)` therefore never double-report.

9. **Dock details §9.7 leaves open.**
   - **Idle pill**: 380 × 52 px (radius 26), "▶ <offer> / <reciter>", the reciter's monogram at the inline end opens
     the picker, and an × forgets the resume point (until the next position is written).
   - **Collapsed pill**: the collapse chevron minimises the bar to a 280 × 44 pill (play/pause, where, the ayah's
     progress, expand); remembered per viewer (`localStorage['qd-dock-collapsed']`). The side card does not collapse.
   - **Error pill**: 640 px wide, the message may wrap to two lines.
   - The modes morph (inline size, block size, radius over `--dur-gentle`, content fading in); nothing under reduced
     motion.
   - **Under 600 px** the cells also give a little (gaps 8 px, the 36 px play button of the card), so the scrubber
     keeps ≥ 72 px at the 560 px minimum.
   - **More** is a popover panel, not a menu, because it holds a slider and switches: stop-at, volume with mute,
     follow-along, word highlight (an extra switch), the A-B loop with its key, download this surah (with its size, or
     "downloading"/"downloaded"), and Stop.
   - Popovers open 8 px clear of the bar's edge; the side card's popovers anchor to the card itself.
   - The idle and error states of the side card keep its 272 × 120 size and reciter row.

10. **Scrubber details.**
    - Labels: only every tenth ayah's ticks are tall and labelled (as specified); the label step is uniform (10, 20,
      50, 100 or 200, the smallest that is ~30 px apart on average), collisions are skipped, and labels within 8 px of
      a track end are left out. In page-boundary mode there are no tall ticks.
    - The repeat bracket covers the ayah while ayahs repeat, else the range while the range repeats; an A-B loop is a
      bracket with A and B flags (a pending A is a hollow flag).
    - Click and drag preview the target and seek on release (one flush); seeks stay inside the playing range;
      Home/End go to the range's first and last ayah.
    - The slider's `aria-valuenow`/`valuemax` are whole seconds and its value text changes once a second, so the
      accessibility tree is not updated every frame.
    - During the basmala the timeline is the coming surah's file at 0 (the basmala plays from surah 1's file).

11. **ReciterPicker counts** come from `ReciterInfo.downloadedSurahs`/`cachedSurahs` (`audio_list_reciters`,
    refreshed when the picker opens and on `packs-changed` for audio packs) instead of fourteen `packs_items` calls;
    the data is the same. A row shows its count only when something is on disk; the footer says "Streams as you
    listen" once. The word-timing badge is neutral (every QDC reciter has word timings, FACT C8; an accent badge on
    every row was noise).

12. **Monogram**: the initials of the first and last name, skipping Arabic articles (`Al-Husary` → H, so "MH"); the
    first Arabic letter in the Arabic UI.

13. **RepeatPopover**: steppers Off → ×2 … ×99 → ∞ with an ∞ toggle; gap seconds 0.5–30 s (step 0.5), multiplier
    ×0.25–×3 (step 0.25); the range field accepts an ayah or a range of one surah (`parseReference`, either digit
    set). Presets list `loop_preset_list`; applying one sets its reciter and speed and plays its range with its
    repeats and gap; "Save as preset" stores the current loop (`loop_preset_upsert`).

14. **Bidi of times (§11.3).** With Arabic-Indic digits, the separators between two times resolve right to left
    (Arabic numbers are AN), so "٠٠:٤٦ / ١٢:١٢" would display reversed even inside `direction: ltr`. Each time is
    therefore its own LTR isolate (`<bdi dir="ltr">`, or LRI…PDI in messages: `isolatedClock`). Other packages that
    show two numbers around a separator in Arabic digits meet the same rule.

15. **Announcements.** Every audio shortcut announces its effect politely ("Paused", "Speed 1.25×", "Repeat each ayah
    3 times", "Loop start set at 01:23", …), since the dock may be hidden in zen. With `announceRecitation` on, each
    heard ayah is announced ("Al-Baqarah 2:255").

16. **Mock** (beyond §5.17's "30 Hz from timings honouring `speedPct`"): the WP4c status machine and command
    semantics, a 120 ms load, held commands while loading, streaming at 2 MB/s with `buffering` when the position
    catches up and `recordStreamCached` (WP12a's request) when complete, offline failures and the skipped basmala,
    `?mockNoAudio` (no output device) and `?mockAudioRate=<KB/s>` (slow streams). A reload starts idle (the slice keeps
    only the idle snapshot); a snapshot seeded into the slice with an active status is adopted as a paused play
    (S36's fallback). The engine restarts when its slice is reset or reloaded (`?mockReset`, tests). Reciters come from
    `fixtures/packs/reciters.json` when exported (WP5a's request), with counts from the simulated disk. A failed play
    keeps its range in the snapshot.

17. **Ports**: shots and scenarios on 1736 (orchestrator range 1736–1739); §14.3 says 1520.

18. **S16 and S17 run in the browser mock only** (`mode: 'web'`): S16 seeks to a millisecond of the exported
    timings, and the real app has no recitation offline in a QA data dir.

## Requests

- **WP8e (MushafView)**: with `reader.dock === 'side'` the pages must stay clear of the 272 × 120 card (§8.2: centred in
  `canvasW − 288`). The wave-0 `MushafView` placeholder lets a 1920 × 1080 spread (sidebar closed) run under the card.
  Follow-along: `player.activeWord` (word id), else `player.currentAyahId`; during the basmala `currentAyahId` is
  `null` and `currentRef` is `{surah, ayah: 0}` (use that surah's ayah 1, §8.12).
- **WP11a (S36)**: a play started paused at 2:1 rests on the basmala (ayah 0), as in the real engine, so S36's check
  takes its fallback. To use the direct path, seek after the play: `qd.ipc('audioSeek', {type: 'ayah', data:
  {ayahId: 8}})` (the mock holds a seek sent while loading). The fallback still works: the mock adopts a seeded paused
  snapshot.
- **WP8f (S35)**: the resume pill is `[data-qd-dock][data-mode="idle"]` with "Resume <surah> · <ref>"; seed an
  `audio` position (`context: 'audio'`) in the `user` slice and reload.
- **WP9b**: `loop_preset_upsert` in the memo mock (the dock's "Save as preset" toasts `unsupported` until then);
  presets saved by the memo panel show up in the repeat popover.
- **WP12b (Settings › Audio)**: just update `speedPct`, `volumePct`, `ayahRepeat`, `rangeRepeat`, `gap`, `stopAt`;
  the player store sends speed and volume to the engine itself.
- **Lead**: fold deviations 1–16 into §7.3, §7.7, §7.8, §9.7, §9.8, §10.1 and §11.3.

## Verification (this machine, Windows 11; shots on port 1736)

| Command | Result |
|---|---|
| `pnpm exec vitest run --project unit src/lib/stores/player` | 26 passed |
| `pnpm exec vitest run --project browser src/components/player` | 13 passed (headless Edge) |
| `pnpm shots:web --serve 1736 --only S16,S17` | both passed, no page or console errors: `S16.png`, `S16-page.png`, `S16-dock.png`, `S17.png`, `S17-dock.png` in `artifacts/shots/web/` |
| `pnpm exec vitest run --project unit src/lib/stores/player src/components/player src/lib/shortcuts/audio src/lib/ipc/mock/handlers/audio` | 60 passed, three runs in a row |
| `pnpm check` | 0 errors, 0 warnings |
| `eslint` / `prettier --check` on the owned files | clean |
| `pnpm lint:css` | 0 violations |
| DoD grep `NotImplemented\|not implemented` on the owned paths | no match |

**Real app** (`pnpm tauri build --debug --no-bundle` into `C:\qdt\WP9a`, app-driver with `QD_AUDIO_SINK=null`, a
scratch scenario, never the speakers): `audio_list_reciters` lists 14 reciters; a play of 1:1–1:7 streams Afasy's real
timings and file into the null sink; after 1.75 s the store's interpolated position was 1,762 ms against the engine's
1,759 ms; the page showed the ayah fill and the word pill, the bar "1:1 · 00:01 / 00:46"; a stop turned the dock into
"Resume Al-Fatihah · 1:1". No console warning or error.
