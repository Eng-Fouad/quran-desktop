# Vendored licence texts (`cargo xtask licenses`)

MIT, BSD, Apache-2.0, MPL-2.0 and the other licences the app ships under require their text (and the copyright notice)
to go with binary copies. `cargo xtask licenses` reads each shipped package's own licence files. It **fails** when a
package's files do not contain the text of every licence the app uses it under, so a gap in About ▸ Open-source licences
cannot come back unnoticed. The check reads the files' content, not their names: an SPDX metadata document
(`LICENSE.spdx`), a README excerpt or a bare copyright line is not a licence text.

Some packages publish no licence text, for example a crate that leaves its `LICENSE` out of the published crate. For
those, this directory holds reviewed files that stand in for the missing text:

```
xtask/licenses/<cargo|npm>/<package name>/      (npm scopes nest: npm/@tauri-apps/plugin-dialog/)
  source.toml     the reviewed versions, and where every file comes from
  <files>         the texts, verbatim except for trailing whitespace
```

`source.toml`:

```toml
versions = ["0.39.1"]          # the shipped versions these files were reviewed for (exact)

[[file]]
name = "LICENSE"               # a file in this directory
kind = "licence"               # stands in for the package's missing licence text
source = "https://github.com/<owner>/<repo>/blob/<the package's commit>/LICENSE"

[[file]]
name = "WebView2-SDK-LICENSE.txt"
kind = "notice"                # always added: a third-party component the package bundles
heading = "Microsoft WebView2 SDK 1.0.3800.47: …"   # optional first paragraph naming the component
source = "…"
```

## Adding or updating an entry

The command names the package, the directory to create and the licence it needs.

1. Find the commit the package was published from: `.cargo_vcs_info.json` in the crate, or the release tag in the
   repository.
2. Copy the repository's licence file **at that commit** for the licence the app uses (`used` in `thirdparty.json`).
   Copy only that licence: for `MIT OR Apache-2.0`, the MIT file.
3. If the repository has no licence file at all, use the canonical text from
   [spdx/license-list-data](https://github.com/spdx/license-list-data) (pin the tag). Fill its copyright line with the
   package's declared authors, or the project's contributors when it declares none, and say so in `source`.
4. Write `source.toml` with the exact shipped version and a `source` that a reviewer can open.

**After a version bump** the command fails until someone checks the upstream licence at the new version and updates
`versions` (and the files, if they changed). That check is the point of the review.

**Stale entries fail too.** This happens when a package starts shipping its own licence text, when a package is no
longer shipped, or when a listed version is no longer shipped. Delete or trim the entry. A `notice` stays for as long as
the package bundles the component.

## Notices

`webview2-com-sys` links `WebView2LoaderStatic.lib` from the Microsoft WebView2 SDK into the Windows exe. The SDK's
BSD-style licence requires that binary redistributions reproduce its copyright notice. The notice is
`cargo/webview2-com-sys/WebView2-SDK-LICENSE.txt`, which is the package's `LICENSE.txt`. Its `source.toml` records
the SDK version and the check that the crate's library is byte-identical to the SDK's.
