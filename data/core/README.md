# The release `core.db`

`data/core/core.db` is the `core.db` every release ships (LEAD 29). A person builds it once from the QUL exports and
commits it. CI never rebuilds it: `release.yml` copies it into `src-tauri/resources/`, asserts it and runs
`verify-core` against the release commit.

- **Only a QUL build goes here.** Build it with `pnpm core:release` (`cargo xtask build-core --source qul --out
  data/core/core.db`) from the files described in [`../sources/README.md`](../sources/README.md). CI refuses any other
  committed database and any `core.db` here whose `meta.source` is not `qul`. Never copy the development (qdc)
  `core.db` from `src-tauri/resources/`: it is derived from the Quran Foundation API and must not be distributed.
- **Rebuild it when the code needs it.** The app refuses a `core.db` whose `meta.schema_version` or
  `meta.normalizer_version` differs from the build's (`CORE_SCHEMA_VERSION`, `NORMALIZER_VERSION` in
  `crates/quran-core`), and CI's `verify-core` on this file fails first. A change to `core.sql`, to the Arabic search
  normaliser or to what `build-core` writes therefore means building it again from the same QUL files and committing
  the new file.
- **Licence.** The file is data, not code, and is not covered by the GPL. Its Mushaf layouts, glyph codes and text come
  from QUL (Tarteel), originating with the King Fahd Glorious Qur'an Printing Complex; its division data comes from
  Tanzil (CC BY 3.0). `meta.licence_note` inside the file carries the attribution, and About credits each source.
  Committing it publishes it, so the QUL permission (docs/RELEASE_CHECKLIST.md, blocker 1) applies to it as it does
  to a release.
