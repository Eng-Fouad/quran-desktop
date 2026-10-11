//! Content transforms for packs (docs/ARCHITECTURE.md §2.5.6). Owner: WP5c.
//!
//! - [`html`]: the ammonia policy shared by translations, footnotes and tafsir (allowed tags and classes,
//!   `sup[data-fn]`, `a[data-ref]` rewritten from verse-reference hrefs, `h1` → `h2`, no `style`), and the `plain`
//!   text derivation.
//! - [`translation`]: QuranEnc `translations` rows → `PackEntryInput`/`FootnoteInput` (number prefixes, footnote
//!   markers and lines) → `PackDbWriter`.

pub mod html;
pub mod translation;
