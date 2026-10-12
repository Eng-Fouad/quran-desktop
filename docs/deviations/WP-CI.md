# WP-CI deviations (continuous integration)

Owned: `.github/workflows/ci.yml`, `.github/actions/**`, `scripts/check-artifacts.mjs` (plus its test, deviation 1).
WP-CI owns no i18n dictionary, so it adds no en/ar strings.

## What exists

| File | Role |
|---|---|
| `.github/workflows/ci.yml` | The §13.3 jobs `lint`, `test-rust` (3 OSes), `test-web`, `test-core`, `build` (3 OSes), plus `ci-result`. |
| `.github/actions/setup/` | Shared setup (§13.3): pnpm from `packageManager`, Node 22 with the pnpm store cache, frozen install, apt line, Rust from `rust-toolchain.toml`, rust-cache, the KFGQPC font cached by `hashFiles('xtask/assets.lock')` and verified against the lock (`verify-assets.mjs`), `pnpm build`. |
| `.github/actions/core/` | core.db in the job: data/cache restore (private only), `build-core --source qdc`, `assert-core.mjs` (> 1 MiB, core tables, `meta.source`), `verify-core --report`, data/cache save (private + push to the default branch). |
| `.github/actions/upload/` | The only `actions/upload-artifact` use: runs `scripts/check-artifacts.mjs` on exactly the same paths first. |
| `.github/actions/scrub/` | Last step of the core-building jobs (`if: always()`): removes core.db, fixtures, data/cache, data/dev-packs, `target/*/data/core.db*` and `target/**/bundle/` before the caching actions' post-job steps. |
| `.github/actions/drift-check/` | Git-free drift check (LEAD decision 1 style) for `cargo xtask licenses` → `src/lib/about/thirdparty.json`. |
| `.github/actions/size-check/` | This OS's installers around the placeholder core.db, their contents and the §13.6 budgets (§13.3, §13.6); `size-check.mjs rustflags` gives the release builds' RUSTFLAGS (deviation 11). |
| `.github/actions/policy/` | Structural checks on `.github/**` that keep the licensing rules in place (deviation 4). |
| `.github/actions/tsconfig.json` | Strict type-check of all CI tooling (`// @ts-check` JavaScript): `pnpm exec tsc -p .github/actions/tsconfig.json`. |
| `scripts/check-artifacts.mjs` | The licensing guard (deviation 2). |
| `*.test.mjs` | `node --test scripts/check-artifacts.test.mjs .github/actions/*/*.test.mjs` (47 tests: guard 21, policy 9, drift 6, size 4, assets 3, assert-core 2, scrub 2). |

## Deviations from ARCHITECTURE.md

1. **One extra file outside the owned paths: `scripts/check-artifacts.test.mjs`.** It is the test of the owned script, next
   to it. vitest's projects only include `src/**`, so it runs on `node:test`, as WP13a's harness tests do. No other package
   writes it. The other CI tests live in the owned `.github/actions/*/`.

2. **`check-artifacts.mjs` is stricter than the §13.3 list, and fails closed.**
   - **Every SQLite database is refused**, whatever its name or `meta.source`. §13.3 names "a `.db` … or any SQLite file
     whose `meta.source = 'qdc'`". A qul core.db is no better while the QUL permission is pending (§15.3). The guard
     still reads `meta.source` itself, with a small read-only SQLite file-format reader (no dependency, no `node:sqlite`).
     That is how it names the qdc core.db in the message: "QF-derived core.db built from the QDC API (meta.source =
     'qdc')".
   - **Content rules, not only names:**
     - SQLite by magic, so `innocent.bin` is caught;
     - raw QDC responses (`verse_key` + glyph or text fields; chapters) anywhere;
     - fixture-shaped JSON (PageData words, the fixture manifest, QuranIndex) outside a `fixtures/` tree;
     - PE, ELF and Mach-O executables (an NSIS installer is named as such);
     - font binaries, by extension or magic: QCF fonts may not be redistributed as an asset package, and the KFGQPC TTF
       is not mirrored (D23).
   - **Archives** are opened recursively, up to 4 levels: zip including ZIP64, tar (ustar, GNU long names, pax),
     tar.gz/tgz, gz and (with the xz tool, for the deb's data.tar.xz: WP13b.md item 9) xz. Anything it cannot inspect
     is refused:
     - 7z, rar, zstd and similar formats, and xz where the xz tool is missing;
     - encrypted or unsupported-method zip entries;
     - corrupt archives;
     - an entry that inflates to a size other than the one declared;
     - more than 512 MiB per entry or 2 GiB in total.
   - **`--private`** applies the private-repository rules. Databases and fixtures are then allowed and listed, so the
     §13.3 "core.db + fixtures/ as 1-day artifacts while private" upload can go through the guard at all. The flag is
     honoured only when `$GITHUB_EVENT_PATH` says `repository.private: true` and the visibility is not `public`. A public
     repository therefore cannot opt out, even by editing the workflow.
   - Not supported: `!exclude` patterns (exit 2). The guard checks exactly what will be uploaded.
   - Directories and symlink targets are walked, including hidden files, which is a superset of what upload-artifact
     takes.
   - A tree finding (`fixtures/`, `data/cache/`, `data/dev-packs/`, `target/**/bundle/`, `*.app/`) is reported once, at
     its top. It is never reported above the given input.
   - Inside GitHub Actions every refusal is also an `::error` annotation.

3. **Uploads go through one composite action.** `./.github/actions/upload` contains both the guard step and
   `actions/upload-artifact`. So "check-artifacts runs before every upload-artifact step" holds by construction, and
   the policy check (deviation 4) fails any other use of upload-artifact.

4. **More CI checks than the §13.3 table, all in `lint`.**
   - **`./.github/actions/policy`** checks seven things:
     - pinned-actions: every third-party `uses:` is pinned to a full commit SHA with a `# vX.Y.Z` comment, and docker
       images by digest;
     - guarded-uploads: upload-artifact appears only in the upload action, after its guard;
     - caches: no cache path names core.db, `*.db`, fixtures, dev-packs, `src-tauri/resources`, a bundle or `target/`,
       and data/cache only under `if: github.event.repository.private`;
     - fork-guard: in a `pull_request` workflow, every job that builds core.db has the fork guard;
     - triggers: no `pull_request_target` or `workflow_run`;
     - permissions: top-level permissions everywhere, and no write in `pull_request` workflows (a tag-only
       `release.yml` may grant job-level write);
     - icon: §9.9's "icon.png differs from the scaffold's hash", using the hash WP-Brand supplied.
   - **actionlint 1.7.12** (Docker image pinned by digest) with shellcheck at severity `warning`.
   - **The tooling tests and type-checks**: `node --test` over the CI tests and WP13a's harness tests, `tsc -p
     .github/actions/tsconfig.json` and `tsc -p tests/e2e/lib/tsconfig.json`. The last two run at WP13a's request.
   - **`ci-result`**: one job to require in branch protection. It passes when every job passed or was skipped, because
     `test-core` and `build` are skipped (not failed) for fork pull requests.

5. **Licences drift check (§14.3 deliverable).** The drift check runs in `test-web`, next to `pnpm bindings:check`, as
   `./.github/actions/drift-check` with `command: cargo xtask licenses`.
   - It is git-free and restores the committed file in every case: changed, created, deleted, or the generator failing
     or throwing.
   - It reports the first differing line with context and line counts.
   - CRLF and LF compare equal.

6. **Size check details (§13.3 `build`, Windows).**
   - **How core.db is measured.** It is compressed the way NSIS's `SetCompressor /SOLID lzma` stores it: LZMA with an
     8 MiB dictionary, by 7-Zip (`-m0=LZMA:d=8m -mx=9`) or by `xz --format=lzma --lzma1=preset=9e,dict=8MiB`. Locally,
     the current qdc core.db (12,521,472 B) compresses to 2,266,002 B (2.16 MiB) with xz.
   - **The budget is reported, not enforced.** §13.6's "8 MB" is read as 8 MiB, as WP0D read 6 MB for dist. The
     report goes to the job summary, and a budget overrun is a `::warning::`. The action's `enforce: 'true'` input turns
     it into a failure. WP13b owns the budgets (`scripts/size-budget.mjs`).
   - **The real core.db is moved back** (`if: always()`). The scrub then removes it and the bundle.

7. **Pinned actions.** Where a newer release was only days old, I chose the newest release at least about two weeks old
   (dates are of the pinned commits):

   | Action | Version | Commit | Date |
   |---|---|---|---|
   | actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | 2026-07-17 |
   | actions/setup-node | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` | 2026-07-14 |
   | pnpm/action-setup | v6.1.0 | `ea17c68df8912ef543352723c149a84f56e3d413` | 2026-09-04 |
   | Swatinem/rust-cache | v2.9.2 | `6323deb102c322ba6fcbdcafc7e3dddab59af2b6` | 2026-08-06 |
   | actions/cache (+ /restore, /save) | v6.1.0 | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` | 2026-06-23 |
   | actions/upload-artifact | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | 2026-04-10 |

   setup-node v7.1.0 and upload-artifact v7.0.2 (2026-10-08 and 2026-10-07) were too new.
   - Annotated tags (pnpm, rust-cache) are pinned to the commit they point to, not the tag object.
   - Every input used was checked against the pinned `action.yml`.
   - Checkout uses `persist-credentials: false`.

8. **Caching and triggers.**
   - **Triggers:** `push` (all branches, no tags), `pull_request` and `workflow_dispatch`. Superseded runs are
     cancelled only for pull requests.
   - **rust-cache** is saved only by pushes to the default branch (`save-if`). It never caches workspace crates; in the
     `target/` profile directories it keeps only dependency `build/`, `deps/` and `.fingerprint/`.
   - **data/cache:**
     - Its key is `qdc-raw-v1-w<7-day bucket>`, with the restore prefix `qdc-raw-v1-`.
     - xtask refetches any file older than 7 days (mtime; tar keeps it).
     - So a weekly save carries the refreshed copy.
     - It is restored only when private and saved only on a push to the default branch, as §13.3 requires.
   - **The KFGQPC font:**
     - It is cached as `public/fonts/*.ttf`, keyed by `hashFiles('xtask/assets.lock')`.
     - A restored copy is verified byte for byte against the lock (size + sha256) before `pnpm build`.
     - When the copy is missing or wrong, `cargo xtask fetch-assets` runs.
     - The setup input `fonts` takes three values:
       - `required` (`build`): a font that cannot be fetched fails the job.
       - `optional` (`lint`, `test-core`): it warns and continues, so a font-server outage does not fail linting.
       - `none` (`test-rust`, `test-web`).
   - **Playwright browsers** are cached in `test-core`, keyed by `pnpm-lock.yaml`.

9. **`QD_CORE_DB` is absolute in `test-core`** (`${{ github.workspace }}/src-tauri/resources/core.db`). cargo runs test
   binaries with the crate directory as the working directory, so the relative form in §13.3 depends on how each test
   resolves it.

10. **Not added: the brand-icon rebuild check** (`node assets/brand/tools/build.mjs --check --tolerance 8`, WP-Brand's
    optional suggestion). It re-renders the SVGs through whatever Edge the runner image ships, so it could fail on a
    docs-only PR whenever the image updates Edge. The default-icon hash is checked twice: in `pnpm test`
    (`brand.test.ts`) and by the policy check.

11. **The universal macOS app's installed footprint (§13.6, `build (macos-latest)` on pushes to main).** It measured
    35.52 MiB against 35 MiB: the `.app` (both architecture slices of the binary, each embedding `dist/`
    Brotli-compressed) plus the real core.db (12,521,472 B, qdc). The release profile was already as small as it goes
    (`opt-level = "z"`, fat LTO, one codegen unit, `strip`, `panic = "abort"`; rustfft and realfft at opt-level 3 cost
    8 KB, measured). Reduced instead, measured with link maps of both slices:
    - **SQLite without unused extensions** (`.cargo/config.toml` `[env] LIBSQLITE3_FLAGS`): FTS3/FTS4, R*Tree, dbstat,
      soundex() and extension loading, which libsqlite3-sys compiles in and SQLite registers at startup. Every
      full-text table is FTS5. −278 KB.
    - **reqwest without `charset`** (`[workspace.dependencies]`; see Requests): −333 KB. Nothing reads a non-UTF-8
      text body; `Cargo.lock` and `thirdparty.json` lose encoding_rs, core_detect, multiversion_no_op and simdutf8.
    - **The print-labels font as WOFF2** (`public/fonts/QuranPrintLabels.woff2`, from the generator): −33 KB here,
      −1.07 MiB of `dist/`.
    - **Cargo registry paths remapped in the release builds**: about 760 panic locations per slice carried
      `$CARGO_HOME/registry/src/index.crates.io-1949cf8c6b5b557f/`. `size-check.mjs rustflags` prints RUSTFLAGS with
      `--remap-path-prefix` for that directory (and for `registry/src/` as a fallback), so they read
      `tokio-1.53.2/src/…`. The size-check action and release.yml's tauri-action step build with it, on every OS.
      −115 KB here (x86_64 slice −55,968 B, arm64 −52,240 B).

    Built as CI builds it on main (`--target universal-apple-darwin`, ad-hoc signed, around the placeholder core.db),
    the footprint went from 35.48 MiB (37,206,459 B; CI measured 35.52) to 34.76 MiB (36,448,363 B), 0.24 MiB under,
    and the dmg from 17.74 to 17.33 MiB. Every platform's binary loses the same code, so NSIS, deb and AppImage only
    shrink.

    Not applied, for the lead: rustls on ring saves another 1,057,160 B here (measured; reqwest `rustls-no-provider`,
    `rustls/ring`, a provider installed before every client: `Http::new`, xtask, the quran-audio test client), but
    LEAD 22 keeps aws-lc-rs for X25519MLKEM768 (LEAD 22's 28 KB was the Windows installer, compressed; the universal
    app carries aws-lc twice, uncompressed). Measured and dropped: a newer target CPU for the x86_64 slice
    (`x86-64-v3`, +12 KB); LLVM's machine outliner on x86_64, which arm64 runs by default at opt-level z (−668 KB of
    code but +628 KB of unwind tables, −26 KB net, and not a default for that target). The x86_64 slice's code is 44 %
    larger than arm64's. The largest single differences are rustfft's SSE and AVX paths (811 KB against 337 KB; rubato
    turns on rustfft's default features) and aws-lc's x86 assembly (875 KB against 461 KB).

## Acceptance

GitHub Actions cannot run here. Local evidence for each item, and what remains CI-only, is in the WP-CI report and
summarised here:

- **"CI green on a docs-only PR"** is CI-only (`blocked-by:no-ci-runner`). Locally:
  - the workflow and the 7 composite actions parse (`yaml` 1.10 and `act -l`: 6 jobs, `ci-result` in stage 1);
  - the policy check passes;
  - prettier, eslint and the strict `tsc` are clean;
  - the 47 CI tooling tests and WP13a's 36 harness tests pass;
  - every command the jobs run resolves (`pnpm check:tooling`);
  - the guard, drift, size, assert-core, verify-assets and scrub steps were exercised on real data.

  Each job's command list was also run on this machine. Where a command regenerates or deletes files, it ran on the
  isolated copy `C:\qdt\WP-CI-copy`, with its own `pnpm install --frozen-lockfile --offline`:

  | Job | Passed | Failed, and whose |
  |---|---|---|
  | `lint` | `cargo lint`, `pnpm lint`, `pnpm lint:css`, `pnpm check`, `pnpm check:tooling`, `pnpm build && pnpm check:dist` | `cargo fmt --check` and `pnpm format:check` fail only on files other packages are editing right now. The set changed between retries (WP1b/WP5b search/packs files, later `src-tauri/src/{i18n,tray}.rs`; WP7b `src/components/ui/testing/*`). |
  | `test-web` | `pnpm test` (936 tests), `pnpm bindings:check`, the licences drift step | none |
  | `test-rust` (Windows) | every crate | WP1b's `commands::search` test (Requests) |
  | `test-core` | `build-core` (17/18 gates; see the WP3b note in Requests), assert-core, `export-fixtures`, the private-only guard on core.db + fixtures, `pnpm shots:web` (S07, S12 and smoke passed), the guard on the screenshot paths | the ignored WP1c test (Requests); `test:browser` 83/84, where the 1 failure is an in-progress `zz-debug.browser.test.ts` probe in `src/components/ui` |
  | `build` (Windows) | `QD_REQUIRE_CORE=1 pnpm tauri build --debug --no-bundle`. Without core.db, `QD_REQUIRE_CORE=1` fails the build as §5.15 requires. | — |

  The NSIS bundling inside the size check was not run locally. The tauri bundler would download
  `nsis_tauri_utils.dll`, and file downloads need the user's permission. Its aside/report/restore logic was run on
  copies with a synthetic installer.
- **"A DTO change without regenerated bindings fails `test-web`"** was shown on an isolated copy of the repository
  (`C:\qdt\WP-CI-copy`), so no shared file was touched:
  - `pnpm bindings:check` passes as is;
  - it passes after a docs-only change;
  - it exits 1 after a doc-comment change to a `quran-types` DTO, and the original `bindings.ts` is restored.
- **`node scripts/check-artifacts.mjs src-tauri/resources/core.db`** exits 1 on the qdc core.db with the QF-derived
  message.

## Requests

- **WP3c (`cargo xtask licenses`), a note rather than a request:** CI regenerates `thirdparty.json` on ubuntu-22.04 and
  compares it with the committed file (CRLF ignored), so the output must stay deterministic and platform-independent.
  WP3c's implementation already does both, using `--filter-platform` for each release target and `pnpm licenses
  --prod`. Checked on the isolated copy:
  - the drift step passes on the current output;
  - with one version edited in the committed file, it exits 1, prints the one-line diff and restores the file.
- **WP1c (`crates/quran-core/tests/timings_qdc.rs`): blocks `test-core`.**
  - §13.3's `cargo test -p quran-core -- --ignored` runs every ignored test.
  - `real_qdc_files_sanitise_cleanly` panics with "set QD_QDC_TIMINGS_DIR" when that variable is unset. CI never sets
    it, because QF responses are never committed or cached.
  - Please return early with a `SKIPPED` note when the variable is unset, as the core.db-based real-data tests do.
  - Until then, `test-core` fails.
  - I kept the §13.3 command rather than `--skip` the test by name in CI, which would also hide future regressions.
- **WP1b (`src-tauri/src/commands/search.rs`): `cargo test --workspace` fails (all `test-rust` legs).**
  - Measured on an isolated copy taken at 07:45.
  - `commands::search::tests::the_async_commands_run_on_the_blocking_pool` expects an empty query on
    `CoreDb::unavailable` to be answered without IO, but gets `NotFound("core.db missing — run pnpm core:qdc")`.
  - This happens with or without a real core.db. It may be work in progress.
- **WP3b (`verify-core` G15), to reduce flakiness:**
  - The first style timed (hafs) takes the cold-cache and scheduling spikes.
  - On this machine under load (16 concurrent rustc processes), hafs measured p99 8.1 ms with a 60.8 ms maximum, while
    qcf_v2 measured p99 1.4 ms right after it.
  - G15 decides `build-core` in CI on a 4-vCPU runner, so an untimed warm-up pass over the pages before timing would
    make it measure the query instead of the cache.
  - The other 17 gates pass on the in-job build.
- **WP13b (`release.yml`):**
  - Assert a release core.db with `node .github/actions/core/assert-core.mjs --source qul` (it checks > 1 MiB, the core
    tables and `meta.source`), then run `verify-core`.
  - Ship installers to the draft release through tauri-action. `check-artifacts.mjs` refuses bundles by design, and the
    policy allows `actions/upload-artifact` only inside `./.github/actions/upload`.
  - The policy also requires the following in `release.yml`:
    - tauri-action pinned to a commit SHA with a `# vX.Y.Z` comment;
    - top-level `permissions:`. Job-level `contents: write` is fine in a tag-only workflow.
  - `./.github/actions/size-check` takes `budget-mib` and `enforce` if the release job wants the same measurement.
- **WP0D (`docs/DEVELOPING.md`):** under tests, add:
  - `node --test scripts/check-artifacts.test.mjs .github/actions/*/*.test.mjs`;
  - `pnpm exec tsc -p .github/actions/tsconfig.json`;
  - the rule "run `node scripts/check-artifacts.mjs <paths>` before sharing any build output".
- **Lead:**
  - **Branch protection:** require the `CI result` check.
  - **Optional `package.json` scripts:** `"check:artifacts": "node scripts/check-artifacts.mjs"` and `"check:ci": "node
    .github/actions/policy/policy.mjs"`.
  - **ubuntu-22.04:** §13.3 pins this runner image for its glibc baseline. Watch GitHub's deprecation schedule for it.
  - **reqwest without `charset` (deviation 11):** agreed and recorded as LEAD 27.
  - **Headroom (deviation 11):** settled by the owner (LEAD 26): a universal macOS app's footprint is held to 40 MB,
    so it has about 5.2 MiB of room; single-architecture installs keep 35 MB.
