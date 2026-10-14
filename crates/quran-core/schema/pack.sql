-- Pack DB DDL (format 1). PackDbWriter substitutes <T> with the pack's FTS5 tokenizer.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
-- keys: format ('1'), pack_id, kind ('translation'|'tafsir'), lang, dir ('ltr'|'rtl'), name, author, source,
--       source_version, licence, attribution, tokenizer, normalizer_version, created_at, source_sha256
CREATE TABLE entry (
  ayah_id    INTEGER PRIMARY KEY CHECK (ayah_id BETWEEN 1 AND 6236),  -- first ayah of the range; explicit rowid
  to_ayah_id INTEGER NOT NULL CHECK (to_ayah_id >= ayah_id),          -- = ayah_id for translations
  html  TEXT NOT NULL,                            -- sanitised (ammonia policy)
  plain TEXT NOT NULL,                            -- tags stripped, footnote markers removed
  fold  TEXT NOT NULL                             -- tokenizer input (see below)
) STRICT;
CREATE TABLE footnote (
  id TEXT PRIMARY KEY,                            -- "{s}:{a}:{n}" (QuranEnc) or upstream id
  ayah_id INTEGER NOT NULL, marker TEXT NOT NULL, html TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX footnote_ayah ON footnote(ayah_id);
-- created unless tokenizer = like_fallback; <T> substituted by PackDbWriter:
CREATE VIRTUAL TABLE entry_fts USING fts5(fold, content='entry', content_rowid='ayah_id', tokenize='<T>');
