-- content.db DDL (applied as migration 1). Frozen contract.
CREATE TABLE timing_file (
  reciter_id INTEGER NOT NULL, surah INTEGER NOT NULL,
  audio_url TEXT NOT NULL, content_length INTEGER, duration_ms INTEGER,
  word_level INTEGER NOT NULL CHECK (word_level IN (0,1)),
  source TEXT NOT NULL,                           -- 'qdc'
  fetched_at INTEGER NOT NULL, etag TEXT, payload_sha256 TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),   -- 1 while the matching audio file is pinned (and surah 1)
  PRIMARY KEY (reciter_id, surah)
) STRICT, WITHOUT ROWID;
CREATE TABLE timing_ayah (
  reciter_id INTEGER NOT NULL, surah INTEGER NOT NULL, ayah INTEGER NOT NULL,
  from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL,
  words BLOB NOT NULL,                            -- pack_words(): LE u16 pos, u32 start_ms, u32 end_ms; sorted by start
  PRIMARY KEY (reciter_id, surah, ayah)
) STRICT, WITHOUT ROWID;
CREATE TABLE wbw (
  pack_id TEXT NOT NULL, word_id INTEGER NOT NULL, translation TEXT, transliteration TEXT,
  PRIMARY KEY (pack_id, word_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE tafsir_entry (
  pack_id TEXT NOT NULL, from_ayah_id INTEGER NOT NULL, to_ayah_id INTEGER NOT NULL, html TEXT NOT NULL,
  PRIMARY KEY (pack_id, from_ayah_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE content_chapter (                    -- presence + revalidation stamps for wbw/tafsir chapters
  pack_id TEXT NOT NULL, surah INTEGER NOT NULL, fetched_at INTEGER NOT NULL, sha256 TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),   -- 1 when the pack is installed (scope All)
  PRIMARY KEY (pack_id, surah)
) STRICT, WITHOUT ROWID;
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at INTEGER NOT NULL) STRICT, WITHOUT ROWID; -- disposable
