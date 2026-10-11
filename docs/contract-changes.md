# Contract changes

The IPC contract (`crates/quran-types`, the command signatures in `src-tauri/src/commands/*`, the generated
`src/lib/ipc/bindings.ts`) and the frozen frontend contract files (`src/lib/contracts/*`, `src/lib/ipc/index.ts`,
`src/lib/ipc/mock/fixtures.ts`, the frozen `common`, `shortcuts` and `errors` dictionaries) changed only through these
entries after the wave-0 freeze (ARCHITECTURE §14.2). Every change is additive: no command, field or key was renamed or
removed, and an older frontend keeps working against a newer backend.

A contract change regenerates `bindings.ts` (`pnpm bindings`), keeps `pnpm bindings:check` green, gives every new command
a browser-mock handler (`mockCommands satisfies Api` makes a missing one a `pnpm check` error), and appends an entry here.

| Date | Change | Kind | Why | Record |
|---|---|---|---|---|
| 2026-10-10 | `userBackupRestore(srcPath: string) → null` (`commands/user_study.rs`) | command | §9.8's "Restore from backup…" had no command. The file is verified first; the current library is kept as a backup; afterwards `settings-changed`, `user-data-changed` (all kinds) and `packs-changed` are emitted. | WP2b request, INTEGRATION "Rust integration" |
| 2026-10-10 | `windowSetCaption(visible: boolean) → null` (`commands/app.rs`) | command | Windows 11's Snap Layouts target over the maximise button must disappear while zen or a modal hides the title bar. Default visible. | WP6b request, INTEGRATION "Rust integration" |
| 2026-10-10 | `common.appFullName`; `common.appName` is now "Quran" / "قرآن" | frozen dictionary | The identity change (LEAD 16). | INTEGRATION "Identity sweep" |
| 2026-10-10 | `FixtureManifest.queries` typed `{ slug: string; request: SearchRequest }[]` (was `string[]`) | frozen mock type | The Rust fixture manifest always wrote objects. | WP1b, WP10b requests; INTEGRATION "Frontend integration" |
| 2026-10-10 | `shortcuts.memorize.mistake` | frozen dictionary | The memorisation M key became a registry definition (it appears in the shortcut sheet and beats the global mute during a self-test). | WP9b request, INTEGRATION "Frontend integration" |
| 2026-10-10 | `src/lib/contracts/Placeholder.svelte` deleted | frozen component | No component used it once the wave bridges were removed. | INTEGRATION "Frontend integration" |
| 2026-10-10 | `PlayRequest.record?: boolean` (serde default `true`) | DTO field | `false` marks a preview (the onboarding's ▶ 1:1): no listen history, never replayed by "play with nothing loaded". | LEAD 20, INTEGRATION "Integration gate 2" |
| 2026-10-11 | Event `quit-requested` (`QuitRequested`, payload `null`; `events.quitRequested`) | event | WebView2 tears the page down without `pagehide`, so a debounced write of the last second before a quit was lost (the reading position after a turn, the recitation's position, the history dwell, a note draft). Rust hides the window and asks; the page saves (`app.beforeQuit`) and calls `app_quit`; Rust exits anyway after 1.5 s. The mock emits it when the window closes. | LEAD 23, INTEGRATION "Integration final gate" |
| 2026-10-11 | `Settings.ornateHeaders: boolean` (Rust `ornate_headers: OnByDefault`, default `true`; absent ⇒ `true`) | DTO field | Owner request: "Ornate surah headers" can be turned off for every style (it was a Hafs-only onboarding option, and a QCF style always fetched and drew `decor`). It gates both the fetching and the drawing of the decor ornaments. `OnByDefault` instead of `#[serde(default)]`, which specta-serde exports as an optional field; `bindings.ts` keeps a required `boolean`, the mock's defaults (`defaultSettings()`) and the Rust snapshot carry it, and an older frontend's `settings_set` without it still deserialises. The `mushafStyle` default stays `hafs`: only a first-run onboarding preselects `qcf_v2`. | Owner 2026-10-11, INTEGRATION "Owner feedback 2026-10-11 (onboarding)" |
| 2026-10-11 | `MushafPageProps.ornaments?: boolean` (`src/lib/contracts/components.ts`; `PageContext.ornaments`) | frozen frontend contract | The onboarding's Mushaf preview draws the ornaments as ticked before the choice is saved. Default: the `ornateHeaders` setting. | Owner 2026-10-11, WP12c 22 |

Not contract changes (no DTO, command or event changed; listed because they change what an existing error kind can carry):
`CoreError::NewerSchema` (maps to `database`), `PackError::Timeout` (maps to `network`), `AudioError::FileMismatch`
(`network`) and `AudioError::Cancelled` (`cancelled`). See IMPLEMENTATION_NOTES §3.4, §5.3 and §7.2.

Declined (reasoned in INTEGRATION.md): a `search_history` `UserDataKind`, a `position_list` command, a dedicated error kind
for a restore blocked by another program's lock.
