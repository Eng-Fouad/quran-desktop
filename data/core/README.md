# The release `core.db`

`data/core/core.db` is the `core.db` every release ships (LEAD 29, LEAD 30). A person builds it once and commits
it. CI never rebuilds it: `release.yml` copies it into `src-tauri/resources/`, asserts it and runs
`verify-core` against the release commit.

- **Only a release build goes here.** Build it with `pnpm core:release` (`cargo xtask build-core --source qdc
  --for-release --out data/core/core.db`): the Quran text, layouts and glyph codes from the Quran Foundation's QDC API,
  which QF permitted the app to redistribute (LEAD 30; the record is in
  [`../sources/README.md`](../sources/README.md)). Its licence note starts "Redistributed with the Quran Foundation's
  permission". A QUL build (`--source qul`) is the alternative, once Tarteel's permission is recorded. CI refuses any
  other committed database and any `core.db` here that is not a release build. Never copy the development `core.db`
  from `src-tauri/resources/`: its licence note says NEVER DISTRIBUTE, and every guard refuses it.
- **Same data as development.** `pnpm core:release` reads the same cached QDC responses as `pnpm core:qdc`; with
  `--offline` it reads only the cache. The 2026-10-13 build has every row of the tested development `core.db`; only
  `meta.built_at` and `meta.licence_note` differ.
- **Rebuild it when the code needs it.** The app refuses a `core.db` whose `meta.schema_version` or
  `meta.normalizer_version` differs from the build's (`CORE_SCHEMA_VERSION`, `NORMALIZER_VERSION` in
  `crates/quran-core`), and CI's `verify-core` on this file fails first. A change to `core.sql`, to the Arabic search
  normaliser or to what `build-core` writes therefore means building it again with `pnpm core:release` and
  committing the new file.
- **Licence.** The file is data, not code, and is not covered by the GPL. Its Mushaf layouts, glyph codes and text
  come from the Quran Foundation's QDC API, with its permission, originating with the King Fahd Glorious Qur'an
  Printing Complex; its division data comes from Tanzil (CC BY 3.0). `meta.licence_note` inside the file carries the
  attribution, and About credits each source.
