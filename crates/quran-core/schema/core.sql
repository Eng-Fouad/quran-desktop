-- core.db DDL (CORE_SCHEMA_VERSION = 1). Frozen contract.
PRAGMA page_size = 4096;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
-- keys: schema_version, normalizer_version, source ('qul'|'qdc'), source_manifest_sha256, tanzil_sha256,
--       built_at (RFC 3339 UTC), builder (xtask version), ayah_count, word_count, licence_note

CREATE TABLE mushaf (
  id             INTEGER PRIMARY KEY,            -- 1 = v2 (1421H), 2 = v1 (1405H), 19 = v4 (1441H tajweed)
  code           TEXT NOT NULL UNIQUE CHECK (code IN ('v2','v1','v4')),
  name           TEXT NOT NULL,
  pages          INTEGER NOT NULL,               -- 604
  lines_per_page INTEGER NOT NULL,               -- 15
  glyph_column   TEXT NOT NULL CHECK (glyph_column IN ('code_v1','code_v2'))  -- v4 uses code_v2 (FACT C4)
) STRICT;

CREATE TABLE surah (
  id               INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 114),
  name_ar          TEXT NOT NULL,                -- الفاتحة
  name_simple      TEXT NOT NULL,                -- Al-Fatihah   (ASCII transliteration)
  name_complex     TEXT NOT NULL,                -- Al-Fātiĥah   (transliteration with diacritics)
  name_en          TEXT NOT NULL,                -- The Opener   (meaning; Tanzil `ename`)
  revelation_place TEXT NOT NULL CHECK (revelation_place IN ('makkah','madinah')),
  revelation_order INTEGER NOT NULL,
  ayah_count       INTEGER NOT NULL,
  first_ayah_id    INTEGER NOT NULL,
  rukus            INTEGER NOT NULL,
  bismillah_pre    INTEGER NOT NULL CHECK (bismillah_pre IN (0,1)),   -- 0 for surahs 1 and 9
  header_cp        INTEGER                       -- QCF_SurahHeader code point (surah 1 = 0xFC45); NULL if map absent
) STRICT;

CREATE TABLE juz    (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 30),  first_ayah_id INTEGER NOT NULL, last_ayah_id INTEGER NOT NULL) STRICT;
CREATE TABLE hizb   (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 60),  first_ayah_id INTEGER NOT NULL, last_ayah_id INTEGER NOT NULL) STRICT;
CREATE TABLE rub    (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 240), first_ayah_id INTEGER NOT NULL, last_ayah_id INTEGER NOT NULL) STRICT;
CREATE TABLE manzil (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 7),   first_ayah_id INTEGER NOT NULL, last_ayah_id INTEGER NOT NULL) STRICT;
-- Sources per field: juz/hizb/manzil = Tanzil (hard cross-check); rub = mushaf source (allowlisted Tanzil diff);
-- ruku and sajda = Tanzil only.
CREATE TABLE ruku   (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 556), surah INTEGER NOT NULL,
                     first_ayah_id INTEGER NOT NULL, last_ayah_id INTEGER NOT NULL) STRICT;
CREATE TABLE sajda  (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 15), ayah_id INTEGER NOT NULL UNIQUE,
                     kind TEXT NOT NULL CHECK (kind IN ('recommended','obligatory'))) STRICT;

CREATE TABLE ayah (
  id            INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 6236),
  surah         INTEGER NOT NULL REFERENCES surah(id),
  ayah          INTEGER NOT NULL,
  juz           INTEGER NOT NULL,
  hizb          INTEGER NOT NULL,
  rub           INTEGER NOT NULL,
  manzil        INTEGER NOT NULL,
  ruku          INTEGER NOT NULL,
  sajda         INTEGER NOT NULL DEFAULT 0 CHECK (sajda IN (0,1,2)),  -- 0 none, 1 recommended, 2 obligatory
  flags         INTEGER NOT NULL DEFAULT 0,      -- bit0 rub start, bit1 hizb start (both from the mushaf-source rub, D6),
                                                 -- bit2 juz start, bit3 surah start
  first_word_id INTEGER NOT NULL,
  last_word_id  INTEGER NOT NULL,                -- the 'end' marker word
  text_hafs     TEXT NOT NULL,                   -- word.text_hafs joined by U+0020 (marker: U+06DD + Arabic-Indic digits);
                                                 -- display/copy only: NEVER split it to recover words (a word may contain
                                                 -- a space before ۩); per-word text always comes from `word` rows
  text_imlaei   TEXT NOT NULL,                   -- word.text_imlaei (non-end) joined by U+0020
  norm_loose    TEXT NOT NULL,                   -- normalize_ar(text_imlaei, Loose)
  norm_strict   TEXT NOT NULL,                   -- normalize_ar(text_imlaei, Strict)
  UNIQUE (surah, ayah)
) STRICT;

CREATE TABLE word (
  id          INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 83665),   -- canonical (surah, ayah, position) order
  ayah_id     INTEGER NOT NULL,
  surah       INTEGER NOT NULL,
  ayah        INTEGER NOT NULL,
  position    INTEGER NOT NULL,                  -- 1-based; the end marker is the last position
  is_end      INTEGER NOT NULL CHECK (is_end IN (0,1)),
  text_hafs   TEXT NOT NULL,                     -- QPC Hafs; end marker = U+06DD + Arabic-Indic digits (KFGQPC V30).
                                                 -- MAY contain U+0020 + U+06E9 (۩) inside ONE word: 38:24:32 'وَأَنَابَ ۩',
                                                 -- 22:77:11 'تُفۡلِحُونَ ۩' (9 of the 15 sajda words; G5b). Never split
                                                 -- text_hafs to recover words.
  text_imlaei TEXT,                              -- Imla'i simple; NULL for markers; may contain a space ("يا ايها", "واناب ۩")
  norm_loose  TEXT,                              -- normalize_ar(text_imlaei, Loose); NULL for markers
  code_v1     TEXT NOT NULL,                     -- 1–4 chars (FACT C5)
  code_v2     TEXT NOT NULL                      -- 1–4 chars (FACT C5); also used by v4
) STRICT;

CREATE TABLE page (
  mushaf_id     INTEGER NOT NULL REFERENCES mushaf(id),
  page          INTEGER NOT NULL CHECK (page BETWEEN 1 AND 604),
  first_word_id INTEGER NOT NULL,
  last_word_id  INTEGER NOT NULL,
  first_ayah_id INTEGER NOT NULL,
  last_ayah_id  INTEGER NOT NULL,
  PRIMARY KEY (mushaf_id, page)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX page_first_word ON page (mushaf_id, first_word_id);

CREATE TABLE line (
  mushaf_id     INTEGER NOT NULL,
  page          INTEGER NOT NULL,
  line          INTEGER NOT NULL CHECK (line BETWEEN 1 AND 15),
  kind          INTEGER NOT NULL CHECK (kind IN (0,1,2)),        -- 0 ayah, 1 surah_name, 2 basmallah
  centered      INTEGER NOT NULL CHECK (centered IN (0,1)),
  surah_id      INTEGER,                                         -- kinds 1,2: the surah being introduced
  first_word_id INTEGER,                                         -- kind 0 only
  last_word_id  INTEGER,
  PRIMARY KEY (mushaf_id, page, line),
  CHECK ((kind = 0 AND first_word_id IS NOT NULL AND last_word_id IS NOT NULL AND surah_id IS NULL)
      OR (kind IN (1,2) AND first_word_id IS NULL AND last_word_id IS NULL AND surah_id IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE vocab_loose (term TEXT PRIMARY KEY, doc_count INTEGER NOT NULL) STRICT, WITHOUT ROWID;

CREATE VIRTUAL TABLE ayah_fts USING fts5(loose, strict, content='', tokenize='unicode61');
