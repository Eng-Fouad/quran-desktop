-- user.db migration 1. Append-only: later changes go in 0002_*.sql.
CREATE TABLE setting (
  key        TEXT PRIMARY KEY,                    -- Rust field name (snake_case) from SETTING_FIELDS, NOT the camelCase IPC name
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE collection (
  id TEXT PRIMARY KEY,                            -- UUIDv7
  name TEXT NOT NULL, color TEXT, sort_key INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;

CREATE TABLE bookmark (
  id         TEXT PRIMARY KEY,                    -- UUIDv7
  kind       TEXT NOT NULL CHECK (kind IN ('ayah','page')),
  ayah_id    INTEGER NOT NULL CHECK (ayah_id BETWEEN 1 AND 6236),  -- page kind: first ayah on that page
  mushaf_id  INTEGER CHECK (mushaf_id IN (1,2,19)),                -- page kind only
  page       INTEGER CHECK (page BETWEEN 1 AND 604),               -- page kind only
  label      TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  CHECK ((kind = 'page') = (page IS NOT NULL AND mushaf_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX bookmark_ayah_u ON bookmark(ayah_id) WHERE kind = 'ayah' AND deleted_at IS NULL;
CREATE UNIQUE INDEX bookmark_page_u ON bookmark(mushaf_id, page) WHERE kind = 'page' AND deleted_at IS NULL;
CREATE INDEX bookmark_created ON bookmark(created_at) WHERE deleted_at IS NULL;

CREATE TABLE collection_item (
  collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
  bookmark_id   TEXT NOT NULL REFERENCES bookmark(id) ON DELETE CASCADE,
  sort_key      INTEGER NOT NULL DEFAULT 0,
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (collection_id, bookmark_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX collection_item_bookmark ON collection_item(bookmark_id);

CREATE TABLE reading_bookmark (                   -- the single movable "reading bookmark"
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ayah_id INTEGER NOT NULL, mushaf_id INTEGER NOT NULL, page INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE highlight (
  id           TEXT PRIMARY KEY,
  from_ayah_id INTEGER NOT NULL CHECK (from_ayah_id BETWEEN 1 AND 6236),
  to_ayah_id   INTEGER NOT NULL CHECK (to_ayah_id BETWEEN from_ayah_id AND 6236),
  color        TEXT NOT NULL CHECK (color IN ('yellow','green','blue','red','purple')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;
CREATE INDEX highlight_range ON highlight(from_ayah_id, to_ayah_id) WHERE deleted_at IS NULL;

CREATE TABLE note (
  rid          INTEGER PRIMARY KEY,               -- explicit rowid for external-content FTS (VACUUM-safe)
  id           TEXT NOT NULL UNIQUE,              -- UUIDv7
  from_ayah_id INTEGER NOT NULL CHECK (from_ayah_id BETWEEN 1 AND 6236),
  to_ayah_id   INTEGER NOT NULL CHECK (to_ayah_id BETWEEN from_ayah_id AND 6236),
  title        TEXT,
  body         TEXT NOT NULL,                     -- Markdown subset
  body_search  TEXT NOT NULL,                     -- fold_latin(normalize_ar(coalesce(title,'')||' '||body, Loose))
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;
CREATE INDEX note_range ON note(from_ayah_id, to_ayah_id) WHERE deleted_at IS NULL;
CREATE VIRTUAL TABLE note_fts USING fts5(body_search, content='note', content_rowid='rid',
                                         tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER note_ai AFTER INSERT ON note BEGIN
  INSERT INTO note_fts(rowid, body_search) VALUES (new.rid, new.body_search); END;
CREATE TRIGGER note_ad AFTER DELETE ON note BEGIN
  INSERT INTO note_fts(note_fts, rowid, body_search) VALUES ('delete', old.rid, old.body_search); END;
CREATE TRIGGER note_au AFTER UPDATE OF body_search ON note BEGIN
  INSERT INTO note_fts(note_fts, rowid, body_search) VALUES ('delete', old.rid, old.body_search);
  INSERT INTO note_fts(rowid, body_search) VALUES (new.rid, new.body_search); END;

CREATE TABLE tag (
  id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, color TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;
CREATE UNIQUE INDEX tag_name_u ON tag(name) WHERE deleted_at IS NULL;
CREATE TABLE item_tag (
  tag_id    TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('bookmark','note','highlight')),
  item_id   TEXT NOT NULL,
  PRIMARY KEY (tag_id, item_kind, item_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX item_tag_item ON item_tag(item_kind, item_id);

CREATE TABLE reading_position (
  context    TEXT PRIMARY KEY CHECK (context IN ('mushaf','translation','audio')),
  mushaf_id  INTEGER, page INTEGER, ayah_id INTEGER NOT NULL, scroll_px INTEGER,
  updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE history_entry (
  id        INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  mode      TEXT NOT NULL CHECK (mode IN ('read','listen','memorize')),
  mushaf_id INTEGER, page INTEGER, ayah_id INTEGER NOT NULL,
  dwell_s   INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX history_at ON history_entry(at);

CREATE TABLE search_history (
  query TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (json_valid(scope)),  -- serde JSON of SearchScope, e.g. {"type":"quran"}
  last_used_at INTEGER NOT NULL, use_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (query, scope)
) STRICT, WITHOUT ROWID;

CREATE TABLE memo_ayah (
  ayah_id          INTEGER PRIMARY KEY CHECK (ayah_id BETWEEN 1 AND 6236),
  status           TEXT NOT NULL CHECK (status IN ('new','learning','memorized','review')),
  strength         INTEGER NOT NULL DEFAULT 0 CHECK (strength BETWEEN 0 AND 5),
  reviews          INTEGER NOT NULL DEFAULT 0,
  lapses           INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at INTEGER, due_at INTEGER,
  updated_at       INTEGER NOT NULL
) STRICT;
CREATE INDEX memo_due ON memo_ayah(due_at) WHERE status IN ('learning','review');

CREATE TABLE memo_test (
  id INTEGER PRIMARY KEY,
  from_ayah_id INTEGER NOT NULL, to_ayah_id INTEGER NOT NULL, start_ayah_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  reveals INTEGER, mistakes INTEGER, rating INTEGER CHECK (rating BETWEEN 1 AND 4)
) STRICT;

CREATE TABLE loop_preset (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, reciter_id INTEGER,
  from_ayah_id INTEGER NOT NULL, to_ayah_id INTEGER NOT NULL,
  ayah_repeat INTEGER NOT NULL DEFAULT 1, range_repeat INTEGER NOT NULL DEFAULT 1,
  gap_json TEXT NOT NULL DEFAULT '{"type":"none"}' CHECK (json_valid(gap_json)),
  speed_pct INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE installed_pack (
  pack_id         TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  version         TEXT NOT NULL,
  path            TEXT,                           -- relative to packs/; NULL for cache-backed packs
  status          TEXT NOT NULL CHECK (status IN ('installed','partial','paused','failed','removing')),
  bytes           INTEGER NOT NULL DEFAULT 0,
  items_total     INTEGER NOT NULL DEFAULT 0,
  items_present   INTEGER NOT NULL DEFAULT 0,
  sha256          TEXT, source_version TEXT,
  installed_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_checked_at INTEGER
) STRICT, WITHOUT ROWID;

CREATE TABLE pack_item (
  pack_id      TEXT NOT NULL,
  item         TEXT NOT NULL,                     -- 'p262' | '002' | 'ch18' | 'file:qcf-surah-header.woff2'
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 1 CHECK (pinned IN (0,1)),   -- 0 = evictable stream cache
  fetched_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (pack_id, item)
) STRICT, WITHOUT ROWID;
CREATE INDEX pack_item_lru ON pack_item(pinned, last_used_at);
