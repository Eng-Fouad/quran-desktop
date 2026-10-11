# rust-data-search

# Rust data layer and Arabic search for Quran Desktop (checked live on 2026-10-10)

All samples are in `R = C:\Users\fouad\AppData\Local\Temp\claude\C--Users-fouad-AppData-Roaming-Claude-scratch-workspaces-6463bc05-45c5-4361-9291-b022ebeed68b-4fedef61-7d08-4bf3-95d0-ddab25699856-scratch-2026-10-09-5aa8bc\ba4e4a3a-7c3b-4454-bc64-bdcdd225f47a\scratchpad\research\rust-data-search\`. The test scripts are in `...\scratchpad\s\`. These are `fts_ar_test.mjs`, `fts_ar_test2.mjs`, `fts_tr_test.mjs` and `build_proto.mjs`.

The experiments ran with `node:sqlite` on Node 26.3.0, which embeds **SQLite 3.53.1**. That is the same C engine, one patch level below the SQLite inside rusqlite 0.40.2 (3.53.2). The real Quran text came from the Quran.com v4 API. Cargo is not installed on this machine, so none of the Rust code below was compiled.

## 0. Decisions in short
1. **Use rusqlite 0.40.2 with the `bundled` feature.** It bundles SQLite 3.53.2, and its build script compiles in FTS5, FTS3, JSON1, RTREE, STAT4 and DBSTAT.
   - Do **not** add sqlx or tauri-plugin-sql. Both libraries claim the native `sqlite3` link (`links = "sqlite3"`), and their version ranges for `libsqlite3-sys` cannot match rusqlite 0.40's (0.38.x), so Cargo will refuse to build.
2. **Core DB.** Ship it **uncompressed** as a Tauri resource and open it in place.
   - Open with `file:///…/core.db?mode=ro&immutable=1` and the flags READ_ONLY | URI | NO_MUTEX.
   - Serve reads from an r2d2 pool of 2–4 connections.
   - The installer compresses it anyway: Tauri's NSIS default is LZMA.
3. **User DB.** Use one read-write connection in `Mutex<Connection>`.
   - Settings: WAL, `synchronous=NORMAL`, `busy_timeout`, foreign keys on.
   - Manage schema changes with rusqlite_migration 2.6.0.
   - Call all DB work from **async** Tauri commands inside `spawn_blocking`. Plain (non-async) commands run on the main thread.
4. **Arabic search.** Never rely on an FTS5 tokenizer to handle Arabic.
   - At build time, store normalized copies of the **Imla'i (simple-spelling) text**. Do not index the Uthmani text.
   - Normalize the user's query in Rust with the same function, and index with plain `unicode61`.
   - The tests showed that `unicode61` splits Arabic words at every haraka, and that Uthmani spelling does not match what users type.
5. **Translations.** Use one downloaded SQLite file per translation, each with an external-content FTS5 table.
   - English: porter stemmer. Other Latin, Cyrillic or Greek scripts: `unicode61 remove_diacritics 2`.
   - Urdu, Persian and other Arabic-script languages: pre-normalize, as for the Quran text.
   - Substring mode, Chinese/Japanese/Korean, Thai and 2-character queries: a plain linear scan takes about 1 ms. A trigram index is optional.

## 1. Versions (crates.io API, 2026-10-10)
| Crate | Latest | Released | License | Notes |
|---|---|---|---|---|
| rusqlite | **0.40.2** | 2026-08-08 | MIT | depends on libsqlite3-sys 0.38.2; default features = `cache`, `ffi-sqlite-wasm-rs` |
| libsqlite3-sys | **0.38.2** | 2026-08-08 | MIT | bundled `SQLITE_VERSION "3.53.2"`; `links = "sqlite3"` |
| SQLite upstream | 3.54.0 | 2026-10-09 | public domain | rusqlite does not yet bundle it |
| r2d2 / r2d2_sqlite | 0.8.10 / **0.35.0** | 2022-06-21 / 2026-07-06 | MIT/Apache / MIT | r2d2_sqlite requires rusqlite ^0.40; has `with_flags` and `with_init` |
| deadpool-sqlite | 0.14.0 | 2026-08-26 | MIT OR Apache-2.0 | MSRV 1.95; `Config{path,pool}`; async `interact` |
| tokio-rusqlite | 0.8.0 | 2026-09-06 | MIT | requires rusqlite ^0.40.1 |
| async-sqlite | 0.6.0 | 2026-05-27 | MIT | MSRV 1.95 |
| rusqlite_migration | **2.6.0** | 2026-05-28 | Apache-2.0 | MSRV 1.95; tracks the version in `user_version` |
| refinery | 0.10.0 | 2026-10-02 | MIT | alternative migration tool (heavier) |
| serde_rusqlite | 0.43.0 | 2026-05-27 | MIT/Apache | requires rusqlite ^0.40 |
| sqlx | 0.9.0 | 2026-05-21 | MIT/Apache | sqlx-sqlite needs libsqlite3-sys **>=0.30.1, <0.38.0** |
| tauri-plugin-sql | 2.5.0 | – | – | depends on sqlx **^0.8**, which needs libsqlite3-sys ^0.30.1 |
| zstd | 0.14.1 | **2026-10-09** | **BSD-3-Clause** (0.13.3 was MIT) | `zstd::stream::{decode_all, copy_decode}` |
| ruzstd | 0.9.0 | 2026-07-26 | MIT | pure-Rust decoder (`decoding::StreamingDecoder`) |
| unicode-normalization | 0.1.25 | 2025-10-30 | MIT/Apache | NFKC normalization |
| rust-stemmers | 1.2.0 | 2019-11-17 | MIT/BSD-3 | `Algorithm::Arabic`, English, French, German, Russian, Turkish, … (no Indonesian) |
| fst / strsim / nucleo-matcher | 0.4.7 / 0.11.1 / 0.3.1 | – | – / MIT / **MPL-2.0** | fuzzy-matching building blocks |
| uuid / fsrs | 1.27.0 / 6.6.2 | – | MIT/Apache / BSD-3 | UUIDv7 ids; FSRS spaced-repetition scheduler for memorization |
| tauri | 2.12.2 | 2026-10-09 | Apache/MIT | MSRV 1.90 |

Stable Rust is **1.99.0** (channel dated 2026-10-01), so the 1.95 minimum required by several crates is fine.

## 2. What `bundled` actually compiles (libsqlite3-sys v0.40.2 `build.rs`, lines 152–167)
`-DSQLITE_CORE -DSQLITE_DEFAULT_FOREIGN_KEYS=1 -DSQLITE_ENABLE_API_ARMOR -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_DBSTAT_VTAB -DSQLITE_ENABLE_FTS3 -DSQLITE_ENABLE_FTS3_PARENTHESIS -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_JSON1 -DSQLITE_ENABLE_LOAD_EXTENSION=1 -DSQLITE_ENABLE_MEMORY_MANAGEMENT -DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_STAT4 -DSQLITE_SOUNDEX -DSQLITE_THREADSAFE=1 -DSQLITE_USE_URI -DHAVE_USLEEP=1 -DHAVE_ISNAN`

- **Foreign keys are on by default** in the bundled build.
- You can add your own compile flags through the `LIBSQLITE3_FLAGS` environment variable. It accepts `-D…`, `-U…` or `SQLITE_…` entries. One option is to set it in `.cargo/config.toml` under `[env]`, for example `LIBSQLITE3_FLAGS = "-DSQLITE_DQS=0 -DSQLITE_DEFAULT_MEMSTATUS=0"`.
- `SQLITE_MAX_VARIABLE_NUMBER`, `SQLITE_MAX_EXPR_DEPTH` and `SQLITE_MAX_COLUMN` can also be set as environment variables.
- The amalgamation defaults `SQLITE_DEFAULT_MMAP_SIZE` to 0, so memory-mapped I/O is **off unless you set `PRAGMA mmap_size`**.

**Recommended `Cargo.toml`:**
```toml
rusqlite = { version = "0.40.2", features = ["bundled", "functions", "backup", "serde_json", "collation", "hooks"] }
r2d2 = "0.8.10"
r2d2_sqlite = "0.35.0"
rusqlite_migration = "2.6.0"
unicode-normalization = "0.1.25"
url = "2.5.8"
uuid = { version = "1.27.0", features = ["v7"] }
# optional
rust-stemmers = "1.2.0"   # stemmed shadow columns for translations
zstd = "0.14.1"           # only for downloaded packs / embedded blobs
```
- If you set `default-features = false`, add `"cache"` back. Without it you lose `prepare_cached`.
- The `serialize` feature adds `deserialize_bytes(schema, &'static [u8])`. That opens a database straight from `include_bytes!` as read-only.
- The `fallible_uint` feature gates `ToSql` for `u64`/`usize`. Store ids as `i64`.

### rusqlite or sqlx for this app
| | rusqlite 0.40 | sqlx 0.9 (sqlite) |
|---|---|---|
| Programming model | synchronous; `Connection` is `Send`, not `Sync` | async; each connection runs on its own worker thread with channels |
| FTS5 extras (custom functions, fts5vocab, `serialize`, `backup`, hooks) | first-class APIs | limited |
| Compile-time checked SQL | no | yes, but needs `DATABASE_URL` or offline `.sqlx` |
| Bundled SQLite | 3.53.2 via libsqlite3-sys 0.38 | libsqlite3-sys < 0.38, so it **conflicts** with rusqlite 0.40 |
| Fit for a desktop app with a read-mostly bundled DB | **best** | extra async machinery with no benefit |

### Connection strategy
- **Core DB.** Use an r2d2 pool with `max_size` = `available_parallelism().clamp(2, 4)`.
  - Open read-only with the immutable URI.
  - Per-connection setup (`with_init`): `PRAGMA query_only=1; PRAGMA mmap_size=268435456; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY;`, then register custom SQL functions.
  - Immutable mode skips all file locking and change detection, so parallel readers never contend.
- **User DB.** Use one `Mutex<Connection>`. Writes are tiny, so one writer means no `SQLITE_BUSY`.
  - WAL with `synchronous=NORMAL`. The SQLite docs say this cannot corrupt the database, but it can lose the most recent commits on power failure.
  - Run `PRAGMA optimize=0x10002` at open and `PRAGMA optimize` periodically. This is what the SQLite docs advise for long-lived connections.
  - tokio-rusqlite 0.8 is a reasonable alternative.
- **Content packs.** Open each pack read-only, without `immutable`, and close it before replacing the file. Windows cannot rename over an open file.
  - Avoid ATTACHing many packs to one connection. The limit is `SQLITE_MAX_ATTACHED`: 10 by default, at most 125.
- **Tauri.** Plain commands run on the main thread unless written as `#[tauri::command(async)]`. Make DB commands `async` and do the work in `tauri::async_runtime::spawn_blocking`.

```rust
use rusqlite::{functions::FunctionFlags, Connection, OpenFlags};
use r2d2_sqlite::SqliteConnectionManager;
use std::{path::Path, sync::{Arc, Mutex}, time::Duration};
pub type CorePool = r2d2::Pool<SqliteConnectionManager>;
pub struct Db { pub core: CorePool, pub user: Mutex<Connection> }

fn ro_immutable_uri(p: &Path) -> anyhow::Result<String> {
    // e.g. file:///C:/Program%20Files/Quran%20Desktop/data/core.db?mode=ro&immutable=1
    let mut u = url::Url::from_file_path(p).map_err(|_| anyhow::anyhow!("path must be absolute"))?;
    u.set_query(Some("mode=ro&immutable=1"));
    Ok(u.to_string())
}
pub fn open_core(p: &Path) -> anyhow::Result<CorePool> {
    let mgr = SqliteConnectionManager::file(ro_immutable_uri(p)?)
        .with_flags(OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .with_init(|c| {
            c.execute_batch("PRAGMA query_only=1; PRAGMA mmap_size=268435456; PRAGMA cache_size=-8192; PRAGMA temp_store=MEMORY;")?;
            register_fns(c)
        });
    let n = std::thread::available_parallelism().map_or(2, |n| n.get()).clamp(2, 4) as u32;
    Ok(r2d2::Pool::builder().max_size(n).build(mgr)?)
}
pub fn open_user(p: &Path) -> anyhow::Result<Connection> {
    let mut c = Connection::open(p)?; // default flags = READ_WRITE|CREATE|NO_MUTEX|URI
    c.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
    c.pragma_update(None, "synchronous", "NORMAL")?;
    c.pragma_update(None, "foreign_keys", "ON")?;
    c.busy_timeout(Duration::from_secs(5))?;
    register_fns(&c)?;
    crate::db::migrations::MIGRATIONS.to_latest(&mut c)?;
    c.execute_batch("PRAGMA optimize=0x10002;")?;
    Ok(c)
}
fn register_fns(c: &Connection) -> rusqlite::Result<()> {
    c.create_scalar_function("ar_norm", 1, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| Ok(crate::search::normalize_ar(&ctx.get::<String>(0)?, crate::search::Level::Loose)))
}
// setup:
// let core = app.path().resolve("data/core.db", tauri::path::BaseDirectory::Resource)?;
// let dir = app.path().app_data_dir()?; std::fs::create_dir_all(&dir)?;
// app.manage(Arc::new(Db { core: open_core(&core)?, user: Mutex::new(open_user(&dir.join("user.db"))?) }));
#[tauri::command]
async fn search_quran(db: tauri::State<'_, Arc<Db>>, q: String, limit: u32) -> Result<Vec<AyahHit>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let c = db.core.get().map_err(|e| e.to_string())?;
        crate::search::search_ayahs(&c, &q, limit).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}
```

## 3. Core DB: compress or not? (measured)
The prototype was built from the real Quran.com data: 6,236 ayahs; Uthmani and Imla'i text at both ayah and word level; per-word V2 glyph codes; a 604×15 line table.

| Variant | Raw | zstd -19 | zstd -3 | gzip -9 | zstd decompress time |
|---|---|---|---|---|---|
| without FTS | 9.11 MB | 2.09 MB | 2.90 MB | 2.90 MB | 14 ms |
| with Arabic FTS (2 columns, detail=full) | 9.82 MB | 2.40 MB | 3.25 MB | 3.24 MB | 15 ms |
| plus tajweed-markup text | 14.61 MB | 2.62 MB | 3.76 MB | 3.65 MB | 27 ms |

(Source: `core-db-size-prototype.json`.) The real Quran has 77,429 words.

**Recommendation: ship the core DB uncompressed in `bundle.resources` and open it in place.**
- Every installer format already compresses it: NSIS defaults to `"lzma"` (Tauri schema 2.12.2), and DMG, AppImage and deb are compressed formats too. Download size stays about 2–3 MB either way.
- Decompressing on first run means a 2.4 MB compressed copy plus a 10 MB copy in the app data folder. It also needs version-mismatch handling after updates.
- Opening in place picks up the new DB automatically when the app updates.
- `immutable=1` creates no `-wal`, `-shm` or `-journal` files. That matters because Program Files, a signed macOS `.app` and an AppImage squashfs mount are all read-only.
- Use zstd only for downloadable packs, or if you embed the DB in the binary.

Path details:
- `Url::from_file_path` produces a `file:///C:/…` URI, which SQLite accepts. A Node equivalent was tested on Windows: it opened, writes were refused, and no sidecar files appeared.
- Encode `?` as `%3f`, `#` as `%23`, and `%` as `%25`.
- Keep DB paths under 260 characters. The Windows layer in SQLite uses `SQLITE_WIN32_MAX_PATH_CHARS (MAX_PATH)`. In testing, a read-write open failed once the `-journal` path reached 260 characters.

## 4. Arabic search

### 4.1 What the tokenizer tests showed (`fts5-arabic-tokenizer-test-output.txt`)
- **SQLite docs:** `unicode61` treats the categories `L* N* Co` as token characters, and `remove_diacritics` strips diacritics from **Latin script only**.
- **Test on ayah 1:1 (Uthmani):**
  - `unicode61`, with or without `remove_diacritics 2`, produced the tokens `["ب","ح","س","ـ","م","ن","ه","يم","ٱلر","ٱلل"]`. Harakat (category Mn) act as **separators**, so words are shredded.
  - `categories 'L* N* Co Mn'` keeps whole words but **keeps the marks**, so a search only matches if the user types the exact diacritics.
  - `trigram remove_diacritics 1` does **not** strip Arabic marks. Searching `"الرحيم"` returned 0 hits.
- **Unicode categories:**
  - Tatweel U+0640, small waw U+06E5 and small yeh U+06E6 are **Lm (letters)**, so `unicode61` keeps them as token characters.
  - U+06DD is Cf; U+06DE ۞ and U+06E9 ۩ are So; everything else in U+0610–061A, U+064B–065F, U+0670, U+06D6–06ED and U+08D3–08FF is Mn.
- **Conclusion:** normalize in Rust, store the normalized text, and normalize the query identically. A custom FTS5 tokenizer is possible: libsqlite3-sys exposes the `fts5_api` and `fts5_tokenizer_v2` structs, but rusqlite has no safe wrapper. It is not needed.

### 4.2 Uthmani or Imla'i text (`fts5-arabic-imlaei-vs-uthmani-output.txt`)
After the same normalization, the Uthmani text reads `العلمين`, `ملك`, `الكتب`, `الصلوه`, `ابرهم`. The Imla'i text reads `العالمين`, `مالك`, `الكتاب`, `الصلاه`, `ابراهيم`.

Searching surahs 1–2:

| Query | Imla'i column hits | Uthmani column hits |
|---|---|---|
| العالمين | 5 | 0 |
| الكتاب | 23 | 0 |
| الصلاة | 6 | 0 |
| القرآن | 1 | 0 |
| إبراهيم | 12 | 0 |

So index the **Imla'i** text and keep Uthmani for display only.

**Word mapping trap:**
- In 25 of 293 ayahs (surahs 1–2), splitting the text on spaces gives different word counts for Uthmani and Imla'i. For example, Uthmani `يَـٰٓأَيُّهَا` is one word, while Imla'i writes `يَا أَيُّهَا` as two.
- Map words through word-level data instead. The Quran.com `/api/v4/verses/by_key/2:21?words=true&word_fields=text_uthmani,text_imlaei,text_imlaei_simple,code_v2` response has `text_imlaei: "يَا أَيُّهَا"` and `text_imlaei_simple: "يا ايها"` for position 1.
- QUL and the morphology data use the same `s:a:w` locations.

### 4.3 Normalization spec (Rust `normalize_ar(s, Level)`)
| Step | Code points | Action | Level |
|---|---|---|---|
| 0 | whole string | **NFKC**: folds presentation forms (ﷲ becomes الله) and composes ا+U+0653 to آ, ا+U+0654 to أ, و+U+0654 to ؤ, ي+U+0654 to ئ | all |
| 1 | U+0610–061A, U+064B–065F (tashkeel, plus maddah and hamza marks U+0653–0655), U+0670 superscript alef, U+06D6–06ED (waqf/annotation marks, small letters, ۝ ۞ ۩), U+08D3–08FF (incl. open tanween U+08F0–08F2), U+0640 tatweel, invisible characters U+200B–200F, U+202A–202E, U+2066–2069, U+FEFF | delete | all |
| 2 | أ U+0623, إ U+0625, آ U+0622, ٱ U+0671, ٲ U+0672, ٳ U+0673 | → ا U+0627 | all |
| 3 | ى U+0649, ی U+06CC | → ي U+064A | all |
| 4 | ک U+06A9 → ك; ہ U+06C1 and ھ U+06BE → ه; ۃ U+06C3 → ة | Persian/Urdu letter forms | all |
| 5 | ة U+0629 → ه U+0647 | optional | Loose |
| 6 | ؤ → و, ئ → ي | optional | Loose |
| 7 | ء U+0621 → delete, so شيء and شئ both become شي | optional | Loose |
| 8 | Arabic-Indic digits U+0660–0669 and U+06F0–06F9 → ASCII; punctuation → space; collapse spaces | | all |

- This is a superset of Lucene's `ArabicNormalizer`, which folds آ/أ/إ to ا, ة to ه, ى to ي and removes harakat and tatweel. Lucene does **not** handle ٱ or the Quranic marks.
- Store **two FTS columns**: `strict` (steps 0–4 and 8) for exact-letter search, and `loose` (all steps) as the default.

```rust
use unicode_normalization::UnicodeNormalization;
#[derive(Clone, Copy, PartialEq)] pub enum Level { Strict, Loose }
pub fn normalize_ar(s: &str, lvl: Level) -> String {
    let mut out = String::with_capacity(s.len()); let mut sp = true;
    for ch in s.nfkc() {
        let c = ch as u32;
        if matches!(c, 0x0610..=0x061A | 0x064B..=0x065F | 0x0670 | 0x06D6..=0x06ED | 0x08D3..=0x08FF | 0x0640
                     | 0x200B..=0x200F | 0x202A..=0x202E | 0x2066..=0x2069 | 0xFEFF) { continue; }
        let m = match ch {
            'أ' | 'إ' | 'آ' | 'ٱ' | 'ٲ' | 'ٳ' => 'ا', 'ى' | 'ی' => 'ي', 'ک' => 'ك', 'ہ' | 'ھ' => 'ه', 'ۃ' => 'ة',
            '٠'..='٩' => char::from(b'0' + (c - 0x0660) as u8), '۰'..='۹' => char::from(b'0' + (c - 0x06F0) as u8),
            _ => ch,
        };
        let m = if lvl == Level::Loose { match m { 'ة' => 'ه', 'ؤ' => 'و', 'ئ' => 'ي', 'ء' => continue, x => x } } else { m };
        if m.is_whitespace() || (m.is_ascii_punctuation()) || matches!(m, '،' | '؛' | '؟' | '۔') {
            if !sp { out.push(' '); sp = true; } continue;
        }
        out.push(m); sp = false;
    }
    if out.ends_with(' ') { out.pop(); } out
}
```

### 4.4 Core-DB search DDL, built at DB-build time and shipped read-only
```sql
CREATE TABLE ayah (
  id INTEGER PRIMARY KEY,                 -- 1..6236 (Hafs order)
  surah INTEGER NOT NULL, ayah INTEGER NOT NULL, page INTEGER NOT NULL,
  juz INTEGER NOT NULL, hizb INTEGER NOT NULL, rub INTEGER NOT NULL,
  text_uthmani TEXT NOT NULL, text_imlaei TEXT NOT NULL,
  norm_strict TEXT NOT NULL, norm_loose TEXT NOT NULL,  -- from text_imlaei; norm_loose also serves LIKE substring mode
  UNIQUE (surah, ayah)) STRICT;
CREATE TABLE word (
  id INTEGER PRIMARY KEY, ayah_id INTEGER NOT NULL REFERENCES ayah(id), position INTEGER NOT NULL,
  kind INTEGER NOT NULL,                  -- 1 word, 2 ayah-end marker
  text_uthmani TEXT NOT NULL, text_imlaei TEXT, norm_loose TEXT,  -- may contain a space ("يا ايها")
  translit_skel TEXT, glyph_v2 TEXT, page INTEGER NOT NULL, line INTEGER NOT NULL,
  UNIQUE (ayah_id, position)) STRICT;
CREATE VIRTUAL TABLE ayah_fts USING fts5(loose, strict, content='', tokenize='unicode61');
INSERT INTO ayah_fts(rowid, loose, strict) SELECT id, norm_loose, norm_strict FROM ayah;
INSERT INTO ayah_fts(ayah_fts) VALUES('optimize');
PRAGMA journal_mode=DELETE; VACUUM;     -- ship as a rollback-journal DB (SQLite docs advise this for read-only media)
```

**Measured on the full Quran (`fts5-fullquran-experiments-output.txt`):**
- Index size: 0.44 MB contentless; 0.88 MB with `prefix='2 3'`; 1.28 MB as a trigram index.
- Query time: 0.014–0.078 ms. A prefix query (`"كتاب"*`) took 0.049 ms **without** a prefix index, so skip `prefix=`.
- Recall for كتاب: exact token 46 ayahs, prefix 66, trigram substring 232 (also catches الكتاب, بالكتاب, …).

### 4.5 Query building and highlighting
- **Escaping:** wrap every token in double quotes and double any embedded quotes (FTS5 string rule). Implicit AND between tokens.
- **Search-as-you-type:** add `*` to the last token.
- **Phrase search:** when the user types `"…"`, pass it through as an FTS phrase.
- **Proximity:** `NEAR("a" "b", 5)`.
- **Column choice:** prefix the query with `loose : (…)` or `strict : (…)`. This syntax was checked against the docs.
- **Ranking:** use `ORDER BY rank`. Set per-column weights once with `INSERT INTO ayah_fts(ayah_fts, rank) VALUES('rank','bm25(…)')`.

```rust
pub fn build_match(user: &str, col: &str, prefix_last: bool) -> Option<String> {
    let n = normalize_ar(user, if col == "strict" { Level::Strict } else { Level::Loose });
    let t: Vec<&str> = n.split(' ').filter(|s| !s.is_empty()).collect();
    if t.is_empty() { return None; }
    let body = t.iter().enumerate().map(|(i, s)| {
        let q = format!("\"{}\"", s.replace('"', "\"\""));
        if prefix_last && i + 1 == t.len() { q + "*" } else { q }
    }).collect::<Vec<_>>().join(" ");
    Some(format!("{col} : ({body})"))
}
// SQL: WITH h AS (SELECT rowid id, rank FROM ayah_fts WHERE ayah_fts MATCH ?1 ORDER BY rank LIMIT ?2)
//      SELECT a.id,a.surah,a.ayah,a.page,h.rank FROM h JOIN ayah a USING(id) ORDER BY h.rank;
```

Highlighting on the Mushaf: for each hit, run `SELECT position, norm_loose FROM word WHERE ayah_id=? AND kind=1`, split each `norm_loose` on spaces, and mark positions whose token equals a query term (or starts with it, for prefix search). Then highlight those word ids in the glyph renderer. The contentless table cannot run `snippet()`/`highlight()`, and they are not needed.

### 4.6 Root and lemma search: sources and licenses
- **Quranic Arabic Corpus v0.4** (corpus.quran.com/download/).
  - License: **GNU GPL** (license.jsp shows GPL v3), plus its own terms: "Permission is granted to copy and distribute verbatim copies of this file, but CHANGING IT IS NOT ALLOWED". You must credit the source and link to http://corpus.quran.com.
  - The download asks for an e-mail address.
- **QUL** (qul.tarteel.ai/resources/morphology) offers 6 SQLite downloads: Word root, Word stem, Word lemma, Ayah root, Ayah stem, Ayah lemma.
  - Documented schemas:
    - `roots(id, arabic_trilateral, english_trilateral, words_count, uniq_words_count)` with `word_roots(root_id, word_location)`, where locations look like `2:3:5`.
    - `lemmas(id, text, text_clean, words_count, uniq_words_count)` with `word_lemmas(lemma_id, word_location)`.
    - `stems(id, text, text_clean, words_count, uniq_words_count)` with `word_stems(stem_id, location)`.
    - Ayah-level stem: `(ayah_key, text)`.
  - Downloads need a (free) sign-in.
  - QUL's credits list "Dr. Kais Dukes – original digitized Quran morphology data", so treat the data as derived from the corpus and bound by its terms. QUL's FAQ says to check each resource's license.
- **mustafa0x/quran-morphology** (GitHub): a fork of corpus v0.4 with many root and lemma fixes and the Buckwalter transliteration converted to Arabic script.
  - Line format: `s:a:w:seg<TAB>form<TAB>POS<TAB>ROOT:…|LEM:…`.
  - Counts: **77,429 words, 130,030 segments, 1,657 roots, 4,793 lemmas**.
  - There is no license file; it inherits the corpus terms. Last push 2022-04-18.
- **Plan:** offer root/lemma search as an **optional downloadable pack**.
  - Table `word_root(word_id INTEGER, root_id INTEGER)` plus `root(id, letters, letters_norm, count)`.
  - A query becomes root → words → ayahs. Highlight the exact words.
  - Show attribution and the link in the app. Get a legal check before bundling.

### 4.7 Fuzzy and transliteration search
- **Typos:** there are 14,650 distinct normalized Imla'i tokens (out of 77,797). Create a TEMP `fts5vocab(main, ayah_fts, 'row')` table, which works even on a read-only DB, or a precomputed `vocab` table. Expand each query token to the vocabulary terms within Levenshtein distance 1 (2 for tokens of 6+ letters) using `strsim`, and OR them together. Checking the whole vocabulary that way takes only milliseconds.
- **Light stemming:** a Snowball Arabic stemmer (tested with the JS port of the same algorithm) maps الكتاب, بالكتاب and كتابه to كتاب, and يومنون to يومن. It has errors, though: والصلاه became والصل. If used, put stems in an optional third `stem` column with lower weight. Alfanous, an LGPLv3+ Quran search engine, uses this pipeline: normalization, stopwords, synonyms, Snowball Arabic stemming, then Levenshtein.
- **Transliteration:**
  - Quran.com word data has a `transliteration.text` per word, e.g. `bis'mi`, `l-lahi`, `l-raḥmāni`.
  - Translation resource 57 is a full verse-level transliteration ("Bismi Allahi arrahmani arraheem").
  - Index a *consonant skeleton*: lowercase, `remove_diacritics`, drop `-` and `'` and the vowels a/e/i/o/u, collapse doubled letters. For example, rahman becomes rhmn. Apply the same skeleton to the query. Use a trigram index or a LIKE scan.
- **Command palette (Ctrl+K):** use nucleo-matcher 0.3.1 (MPL-2.0) or a simple subsequence matcher over surah names and commands.

## 5. Translation search (measured, `fts5-fullquran-experiments-output.txt`, `fts5-translation-build-time.txt`, `substring-scan-vs-trigram-bench.txt`)
- **Index sizes** (Saheeh International, 0.96 MB of plain text): `unicode61` 0.57 MB, `porter` 0.55 MB, `trigram` 2.63 MB.
- **Build time** (insert + rebuild + optimize, 6,236 rows): **12 ms, 14 ms and 54 ms** respectively. Build the index on the device after download; no need to ship prebuilt indexes.
- **Recall:**
  - English `porter`: "believe" 233 → **677** ayahs; "mercy" 144 → 304.
  - `remove_diacritics 2`: "allah" matches "Allāh" (2,023 ayahs); French "misericordieux" matches "Miséricordieux" (171).
- **Urdu (translation 234):** 905 ayahs contain harakat. Raw `"الله"` gave 54 hits; after normalization it gave **139**, because of ہ/ه folding and mark stripping. **Normalize every Arabic-script translation.**
- **Trigram:**
  - Needs SQLite ≥ 3.34.0 (2020-12-01) and queries of at least 3 characters.
  - With `detail=column` or `detail=none`, a MATCH token longer than 3 characters fails with "fts5: phrase queries are not supported (detail!=full)".
  - A linear scan over one translation takes ~0.9 ms with `LIKE '%merc%'` and 1.35 ms with `instr(lower())`, versus 0.19 ms with a trigram index. **Skip the trigram index.** Use a stored `text_fold` column (lowercased in Rust and stripped of diacritics; SQLite's `lower()` only folds ASCII) with LIKE for substring mode, Chinese/Japanese/Korean and Thai.
- **Markup:** Quran.com translation text contains `<sup foot_note=NNN>1</sup>`. Strip it into `text_plain` and keep footnotes in their own table.

**Per-pack DDL (`packs/translation-<id>.db`):**
```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID; -- resource_id,name,author,lang,dir,source,license,version,sha256
CREATE TABLE tr(ayah_id INTEGER PRIMARY KEY, text_html TEXT NOT NULL, text_plain TEXT NOT NULL, text_fold TEXT NOT NULL) STRICT;
CREATE TABLE footnote(id INTEGER PRIMARY KEY, ayah_id INTEGER NOT NULL, text TEXT NOT NULL) STRICT;
CREATE VIRTUAL TABLE tr_fts USING fts5(text_plain, content='tr', content_rowid='ayah_id',
  tokenize='porter unicode61 remove_diacritics 2');   -- en; others: 'unicode61 remove_diacritics 2'
INSERT INTO tr_fts(tr_fts) VALUES('rebuild'); INSERT INTO tr_fts(tr_fts) VALUES('optimize');
-- query: SELECT rowid AS ayah_id, snippet(tr_fts,0,'<mark>','</mark>','…',12) FROM tr_fts WHERE tr_fts MATCH ? ORDER BY rank LIMIT 50;
```
- Select `rowid`, not `ayah_id`, from the FTS table: `ayah_id` raised "no such column" in testing.
- For Arabic-script packs, index a normalized column, e.g. `text_norm` with `content='tr'`.
- Optional stemmed shadow column for French, German, Spanish, Russian, Turkish, etc. via rust-stemmers.

## 6. User DB (`user.db`) design
Design rules:
- STRICT tables (SQLite 3.37+).
- Ids are UUIDv7 strings, ready for future sync. Every table has `created_at`/`updated_at` in epoch milliseconds and a `deleted_at` tombstone.
- References to Quran positions use the stable global `ayah_id` (1..6236) plus surah/ayah.
- Settings are stored as JSON values (JSON1 is compiled in).
- **Any table backing an external-content FTS index must have an explicit `INTEGER PRIMARY KEY`.** `VACUUM` may renumber rowids in tables without one, which corrupts the FTS mapping (confirmed in the SQLite docs).

```sql
-- migrations/0001_init.sql
CREATE TABLE collection(id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, sort_key REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)), deleted_at INTEGER) STRICT;
CREATE TABLE bookmark(id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ayah','range','page','surah')),
  surah INTEGER NOT NULL CHECK (surah BETWEEN 1 AND 114), ayah_from INTEGER NOT NULL DEFAULT 1, ayah_to INTEGER,
  ayah_id INTEGER NOT NULL CHECK (ayah_id BETWEEN 1 AND 6236),
  page INTEGER, mushaf_id INTEGER,                         -- page bookmarks are layout-specific
  collection_id TEXT REFERENCES collection(id) ON DELETE SET NULL, label TEXT, color TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER) STRICT;
CREATE INDEX bookmark_ayah ON bookmark(ayah_id) WHERE deleted_at IS NULL;
CREATE INDEX bookmark_coll ON bookmark(collection_id, created_at) WHERE deleted_at IS NULL;
CREATE TABLE tag(id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, color TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER) STRICT;
CREATE TABLE note(rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
  surah INTEGER NOT NULL, ayah_id_from INTEGER NOT NULL, ayah_id_to INTEGER NOT NULL,
  word_from INTEGER, word_to INTEGER,                      -- optional word-level anchor
  body TEXT NOT NULL,                                      -- Markdown, displayed
  body_search TEXT NOT NULL,                               -- Rust: normalize_ar + lowercase (multilingual)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER) STRICT;
CREATE INDEX note_range ON note(ayah_id_from, ayah_id_to) WHERE deleted_at IS NULL;
CREATE VIRTUAL TABLE note_fts USING fts5(body_search, content='note', content_rowid='rid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER note_ai AFTER INSERT ON note BEGIN INSERT INTO note_fts(rowid, body_search) VALUES (new.rid, new.body_search); END;
CREATE TRIGGER note_ad AFTER DELETE ON note BEGIN INSERT INTO note_fts(note_fts, rowid, body_search) VALUES('delete', old.rid, old.body_search); END;
CREATE TRIGGER note_au AFTER UPDATE OF body_search ON note BEGIN
  INSERT INTO note_fts(note_fts, rowid, body_search) VALUES('delete', old.rid, old.body_search);
  INSERT INTO note_fts(rowid, body_search) VALUES (new.rid, new.body_search); END;
CREATE TABLE item_tag(tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('bookmark','note')), item_id TEXT NOT NULL,
  PRIMARY KEY(tag_id, item_kind, item_id)) STRICT, WITHOUT ROWID;
CREATE INDEX item_tag_item ON item_tag(item_kind, item_id);
CREATE TABLE reading_position(context TEXT PRIMARY KEY,   -- 'mushaf:<id>', 'translation', 'audio'
  surah INTEGER NOT NULL, ayah INTEGER NOT NULL, ayah_id INTEGER NOT NULL, page INTEGER, mushaf_id INTEGER,
  scroll_offset REAL, updated_at INTEGER NOT NULL) STRICT, WITHOUT ROWID;
CREATE TABLE reading_session(id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('read','listen','memorize','review')),
  start_ayah_id INTEGER NOT NULL, end_ayah_id INTEGER NOT NULL,
  pages_viewed INTEGER NOT NULL DEFAULT 0, active_seconds INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX reading_session_time ON reading_session(started_at);
CREATE TABLE ayah_progress(ayah_id INTEGER PRIMARY KEY CHECK (ayah_id BETWEEN 1 AND 6236),
  first_read_at INTEGER NOT NULL, last_read_at INTEGER NOT NULL, read_count INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE khatmah(id TEXT PRIMARY KEY, name TEXT, started_at INTEGER NOT NULL, target_days INTEGER,
  completed_at INTEGER, deleted_at INTEGER) STRICT;
CREATE TABLE hifz_item(id INTEGER PRIMARY KEY, ayah_id_from INTEGER NOT NULL, ayah_id_to INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('learning','memorized','review','suspended')),
  stability REAL, difficulty REAL, due_at INTEGER, last_review_at INTEGER,          -- FSRS state (fsrs 6.6.2)
  reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE INDEX hifz_due ON hifz_item(due_at) WHERE status IN ('learning','review');
CREATE TABLE hifz_review(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES hifz_item(id) ON DELETE CASCADE,
  reviewed_at INTEGER NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4), mistakes INTEGER, duration_ms INTEGER) STRICT;
CREATE TABLE loop_preset(id INTEGER PRIMARY KEY, name TEXT NOT NULL, reciter_id INTEGER,
  ayah_id_from INTEGER NOT NULL, ayah_id_to INTEGER NOT NULL, ayah_repeat INTEGER NOT NULL DEFAULT 1,
  range_repeat INTEGER NOT NULL DEFAULT 1, a_ms INTEGER, b_ms INTEGER, speed REAL NOT NULL DEFAULT 1.0,
  gap_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE setting(key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK (json_valid(value)), updated_at INTEGER NOT NULL) STRICT, WITHOUT ROWID;
CREATE TABLE search_history(query TEXT NOT NULL, scope TEXT NOT NULL, last_used_at INTEGER NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(query, scope)) STRICT, WITHOUT ROWID;
CREATE TABLE installed_resource(kind TEXT NOT NULL CHECK (kind IN ('translation','tafsir','recitation','timing','font','morphology')),
  resource_id TEXT NOT NULL, version TEXT NOT NULL, file_path TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  installed_at INTEGER NOT NULL, last_used_at INTEGER, PRIMARY KEY(kind, resource_id)) STRICT, WITHOUT ROWID;
```

**Migrations** (rusqlite_migration 2.6.0; documented API: `Migrations::{new, from_slice, from_directory, to_latest, to_version, current_version, pending_migrations, validate}`, `M::{up, up_with_hook, down, comment, foreign_key_check}`):
```rust
use rusqlite_migration::{Migrations, M};
pub const MIGRATIONS: Migrations<'static> = Migrations::from_slice(&[
    M::up(include_str!("../migrations/0001_init.sql")),
    // M::up(include_str!("../migrations/0002_….sql")).foreign_key_check(),
]);
#[test] fn migrations_valid() { assert!(MIGRATIONS.validate().is_ok()); }
```
- The crate stores the schema version in `PRAGMA user_version`. Nothing else may write that pragma.
- Set PRAGMAs outside migrations.
- **Backup:** use `VACUUM INTO 'file'` for a compact export, or the `backup` feature for online copies. Also offer a JSON export for portability.

## Facts
- [V] rusqlite latest stable is 0.40.2 (published 2026-08-08, MIT); it depends on libsqlite3-sys 0.38.2 — curl -A quran-desktop-research https://crates.io/api/v1/crates/rusqlite and /libsqlite3-sys; https://raw.githubusercontent.com/rusqlite/rusqlite/v0.40.2/Cargo.toml (saved crate-rusqlite.json, rusqlite-v0.40.2-Cargo.toml)
- [V] rusqlite 0.40.2's bundled SQLite is 3.53.2 (#define SQLITE_VERSION "3.53.2"); 0.40.0 moved to 3.53.1 and 0.39.0 to 3.51.3 — https://raw.githubusercontent.com/rusqlite/rusqlite/v0.40.2/libsqlite3-sys/sqlite3/sqlite3.h line 149; GitHub release pages v0.40.0 and v0.39.0 (saved bundled-sqlite-version-v0.40.2.txt, rusqlite-release-notes-0.39-0.40.txt)
- [V] The latest upstream SQLite is 3.54.0 (2026-10-09); rusqlite does not bundle it yet — https://www.sqlite.org/changes.html (saved sqlite-changes-excerpts.txt)
- [V] The libsqlite3-sys bundled build compiles with -DSQLITE_ENABLE_FTS5, -DSQLITE_ENABLE_FTS3, -DSQLITE_ENABLE_FTS3_PARENTHESIS, -DSQLITE_ENABLE_JSON1, RTREE, STAT4, DBSTAT_VTAB, COLUMN_METADATA, API_ARMOR, LOAD_EXTENSION=1, SOUNDEX, THREADSAFE=1, USE_URI and DEFAULT_FOREIGN_KEYS=1 — https://raw.githubusercontent.com/rusqlite/rusqlite/v0.40.2/libsqlite3-sys/build.rs lines 152-167 (saved libsqlite3-sys-v0.40.2-build.rs)
- [V] The LIBSQLITE3_FLAGS environment variable adds extra -D/-U/SQLITE_* compile flags to the bundled build; SQLITE_MAX_VARIABLE_NUMBER, SQLITE_MAX_EXPR_DEPTH and SQLITE_MAX_COLUMN can also be set via environment variables — libsqlite3-sys v0.40.2 build.rs lines ~305-330
- [V] rusqlite 0.40.2 features: bundled implies modern_sqlite; default = ["cache", "ffi-sqlite-wasm-rs"]; functions, backup, blob, collation, hooks, serialize, vtab, window, trace, limits and fallible_uint are plain features; serde_json, chrono, time, jiff, uuid and url are optional dependencies — rusqlite-v0.40.2-Cargo.toml [features]/[dependencies]
- [V] rusqlite OpenFlags::default() = READ_WRITE | CREATE | NO_MUTEX | URI; Connection is Send but not Sync — https://raw.githubusercontent.com/rusqlite/rusqlite/v0.40.2/src/lib.rs (OpenFlags docs and Default impl)
- [V] The rusqlite serialize feature provides deserialize_bytes(schema, &'static [u8]) (read-only), deserialize_read_exact(schema, reader, sz, read_only) and serialize() — https://raw.githubusercontent.com/rusqlite/rusqlite/v0.40.2/src/serialize.rs
- [V] rusqlite has no FTS5 tokenizer API (no fts5 module in src/), but libsqlite3-sys bundled bindings expose fts5_api, fts5_tokenizer_v2 and FTS5_TOKENIZE_QUERY — GitHub tree API for rusqlite v0.40.2; libsqlite3-sys/sqlite3/bindgen_bundled_version.rs grep
- [V] sqlx 0.9.0 (2026-05-21) sqlx-sqlite needs libsqlite3-sys >=0.30.1, <0.38.0; tauri-plugin-sql 2.5.0 needs sqlx ^0.8 (sqlx-sqlite 0.8.6 needs libsqlite3-sys ^0.30.1). Both conflict with rusqlite 0.40 (libsqlite3-sys 0.38.2, links="sqlite3") — crates.io /crates/sqlx-sqlite/0.9.0/dependencies, /tauri-plugin-sql/2.5.0/dependencies, /sqlx-sqlite/0.8.6/dependencies; sqlx v0.9.0 sqlx-sqlite/Cargo.toml; libsqlite3-sys Cargo.toml links line
- [V] sqlx 0.9.0 'sqlite' feature = sqlite-bundled + sqlite-deserialize + sqlite-load-extension + sqlite-unlock-notify; MSRV 1.94 — https://raw.githubusercontent.com/launchbadge/sqlx/v0.9.0/Cargo.toml; crates.io versions
- [V] r2d2_sqlite 0.35.0 (2026-07-06) requires rusqlite ^0.40 and has SqliteConnectionManager::{file, memory, with_flags, with_init}; r2d2 is 0.8.10 (2022-06-21) — crates.io API; https://docs.rs/r2d2_sqlite/0.35.0/r2d2_sqlite/struct.SqliteConnectionManager.html
- [V] deadpool-sqlite 0.14.0 (2026-08-26, MSRV 1.95) requires rusqlite ^0.40.0, Config has only path and pool fields; tokio-rusqlite 0.8.0 requires rusqlite ^0.40.1; async-sqlite is 0.6.0 — crates.io API and dependencies endpoints; docs.rs deadpool_sqlite Config page
- [V] rusqlite_migration 2.6.0 (2026-05-28, Apache-2.0, MSRV 1.95) requires rusqlite ^0.40.0, stores state in user_version, and exposes Migrations::{new, from_slice, from_directory, to_latest, to_version, current_version, pending_migrations, validate} and M::{up, up_with_hook, down, comment, foreign_key_check} — crates.io API; docs.rs/rusqlite_migration/2.6.0 struct pages; README (saved rusqlite_migration-README.md)
- [V] Current stable Rust is 1.99.0 (channel-rust-stable.toml date 2026-10-01) — curl -r 0-200000 https://static.rust-lang.org/dist/channel-rust-stable.toml
- [V] The zstd crate is 0.14.1 (2026-10-09) with license BSD-3-Clause (0.13.3 was MIT) and has stream::{decode_all, copy_decode, encode_all}; ruzstd 0.9.0 is a pure-Rust MIT decoder — crates.io API; https://raw.githubusercontent.com/gyscos/zstd-rs/main/Cargo.toml; docs.rs zstd 0.14.1 and ruzstd 0.9.0 indexes
- [V] The prototype core DB (6236 ayahs, ayah- and word-level Uthmani and Imla'i text, V2 glyph codes, 604x15 line table) is 9.11 MB raw (9.82 MB with Arabic FTS). It compresses to 2.09/2.40 MB with zstd -19 and 2.90/3.24 MB with gzip -9, and zstd decompression takes about 15 ms — node build_proto.mjs with real Quran.com v4 data; output saved core-db-size-prototype.json
- [V] Tauri 2 NSIS installer compression defaults to "lzma" (options zlib, bzip2, lzma, none); config schema version 2.12.2; tauri crate 2.12.2 — https://schema.tauri.app/config/2 (saved tauri-schema-nsis-compression.json); crates.io tauri
- [V] Tauri resources are resolved in Rust with app.path().resolve("path", BaseDirectory::Resource) — https://v2.tauri.app/develop/resources/
- [V] In Tauri 2, commands without the async keyword run on the main thread unless declared #[tauri::command(async)]; async commands run via async_runtime::spawn — https://v2.tauri.app/develop/calling-rust/
- [V] SQLite URI immutable=1 opens the file read-only and skips all locking and change detection; on Windows a URI is built by converting backslashes to slashes and prefixing '/' before the drive letter, with ? and # percent-encoded — https://www.sqlite.org/uri.html (saved sqlite-uri-excerpt.txt)
- [V] Opening a DB as file:///C:/...?mode=ro&immutable=1 on Windows works, creates no -journal/-wal/-shm files and refuses writes ('attempt to write a readonly database') — node:sqlite (SQLite 3.53.1) test with pathToFileURL in this session
- [V] SQLite's Windows layer limits paths to MAX_PATH (SQLITE_WIN32_MAX_PATH_CHARS = MAX_PATH); writes failed with 'unable to open database file' once the -journal path reached 260 characters — grep of libsqlite3-sys v0.40.2 sqlite3.c (line ~48899); reproduced failures in this session
- [V] Since SQLite 3.22.0 a read-only WAL database can be read only if the -shm/-wal files exist, the directory is writable, or it is opened with immutable; the docs advise journal_mode=DELETE for read-only media — https://www.sqlite.org/wal.html section 5 (saved sqlite-wal-readonly-excerpt.txt)
- [V] SQLITE_DEFAULT_MMAP_SIZE is 0 by default (SQLITE_MAX_MMAP_SIZE 0x7fff0000), so mmap must be enabled with PRAGMA mmap_size — libsqlite3-sys v0.40.2 sqlite3.c grep; node:sqlite PRAGMA mmap_size returned 0; pragma.html
- [V] The SQLite docs say WAL with synchronous=NORMAL is safe from corruption but loses durability, and long-lived connections should run PRAGMA optimize=0x10002 at open, then PRAGMA optimize periodically — https://www.sqlite.org/pragma.html (saved sqlite-pragma-excerpts.txt)
- [V] In FTS5 unicode61, remove_diacritics (0/1/2) removes diacritics from Latin-script characters only; the default token categories are 'L* N* Co', and everything else is a separator — https://www.sqlite.org/fts5.html section 4.3.1 (saved sqlite-fts5-tokenizers-excerpt.txt)
- [V] unicode61 (with or without remove_diacritics 2) splits Uthmani Arabic at harakat, giving tokens for 1:1 such as "ب","س","م","ـ"; categories 'L* N* Co Mn' keeps the marks inside tokens; trigram remove_diacritics 1 does not strip Arabic harakat (0 hits for الرحيم) — node:sqlite 3.53.1 experiment (saved fts5-arabic-tokenizer-test-output.txt)
- [V] Tatweel U+0640, U+06E5 (small waw) and U+06E6 (small yeh) are Lm, U+06DD is Cf, U+06DE and U+06E9 are So, and the rest of U+0610-061A, U+064B-065F, U+0670, U+06D6-06ED and U+08D3-08FF are Mn — Node ICU \p{..} classification (saved arabic-mark-categories.txt)
- [V] After normalization, Uthmani spelling (العلمين, ملك, الكتب, الصلوه) does not match what users type, while Imla'i text does (العالمين 5/0, الكتاب 23/0, الصلاة 6/0, القرآن 1/0, إبراهيم 12/0 hits Imla'i/Uthmani in surahs 1-2) — node:sqlite experiment on Quran.com v4 /quran/verses/uthmani and /imlaei (saved fts5-arabic-imlaei-vs-uthmani-output.txt)
- [V] Quran.com v4 word-level data keeps vocative يا with the next word as one word (2:21:1 text_imlaei 'يَا أَيُّهَا', text_imlaei_simple 'يا ايها'); 25 of 293 ayahs in surahs 1-2 have different whitespace word counts between Uthmani and Imla'i — https://api.quran.com/api/v4/verses/by_key/2:21?words=true&word_fields=text_uthmani,text_imlaei,text_imlaei_simple,code_v2,... (saved qurancom-v4-words-2_21.json)
- [V] The FTS5 trigram tokenizer was added in SQLite 3.34.0 (2020-12-01); substrings shorter than 3 characters match nothing; with detail=column a MATCH with a token longer than 3 characters fails with 'fts5: phrase queries are not supported (detail!=full)' — https://www.sqlite.org/changes.html (3.34.0 block); fts5.html 4.3.4; reproduced error in substring-scan-vs-trigram-bench.txt
- [V] Full-Quran normalized Arabic FTS5 contentless index measured 0.44 MB (unicode61), 0.88 MB with prefix='2 3' and 1.28 MB as trigram; queries took 0.014-0.078 ms; a prefix query without a prefix index took 0.049 ms — fts_tr_test.mjs (saved fts5-fullquran-experiments-output.txt)
- [V] Saheeh International FTS indexes measured unicode61 0.57 MB, porter 0.55 MB and trigram 2.63 MB, with build+optimize times of 12, 14 and 54 ms; porter raised 'believe' hits from 233 to 677; remove_diacritics 2 matched 'allah' to 'Allāh' (2023) and 'misericordieux' to 'Miséricordieux' (171) — fts_tr_test.mjs and inline build-time test (saved fts5-fullquran-experiments-output.txt, fts5-translation-build-time.txt)
- [V] Urdu translation 234 has Arabic-script harakat in 905 ayahs; raw indexing found 54 hits for الله versus 139 after normalization — fts5-fullquran-experiments-output.txt
- [V] A linear substring scan over one translation (6236 rows) takes about 0.9 ms (LIKE) and 1.35 ms (instr(lower())), versus 0.19 ms with a trigram index — saved substring-scan-vs-trigram-bench.txt
- [V] Quran.com translation text contains footnote markup like <sup foot_note=195932>1</sup> — https://api.quran.com/api/v4/quran/translations/20
- [V] FTS5 query strings use double quotes with embedded quotes doubled; column filters work on parenthesized expressions ('col : (...)', '{a b} : ...'); rank can be configured with INSERT INTO ft(ft, rank) VALUES('rank','bm25(10.0, 5.0)') — https://www.sqlite.org/fts5.html sections 3.1, 3.6 and 6.11 (saved sqlite-fts5-query-and-content-excerpt.txt)
- [V] FTS5 contentless-delete tables exist since 3.43.0; fts5_tokenizer_v2 and locale=1 since 3.47.0 — fts5.html; changes.html
- [V] VACUUM may change the ROWIDs of tables without an explicit INTEGER PRIMARY KEY, which affects external-content FTS — https://www.sqlite.org/lang_vacuum.html (saved sqlite-vacuum-rowid-excerpt.txt)
- [V] SQLITE_MAX_ATTACHED defaults to 10 and cannot exceed 125; STRICT tables require SQLite 3.37.0+ — https://www.sqlite.org/limits.html; https://www.sqlite.org/stricttables.html
- [V] A STRICT INTEGER column with DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)) works and stores integer epoch milliseconds — node:sqlite 3.53.1 test in this session
- [V] Quranic Arabic Corpus v0.4 morphology is under the GNU GPL (license page shows GPLv3) with extra terms: verbatim copies only, 'CHANGING IT IS NOT ALLOWED', source must be credited with a link to corpus.quran.com; the download requires an e-mail address — https://corpus.quran.com/download/ and https://corpus.quran.com/license.jsp
- [V] QUL offers 6 morphology SQLite resources (Word root, Word stem, Word lemma, Ayah root, Ayah stem, Ayah lemma) with documented schemas roots/word_roots(root_id, word_location), lemmas/word_lemmas(lemma_id, word_location) and stems/word_stems(stem_id, location); downloads require sign-in; QUL credits Dr. Kais Dukes for the original morphology data — https://qul.tarteel.ai/resources/morphology, /resources/morphology/75, /76, /77, /481, /credits, /faq
- [?] The schema column names of QUL morphology SQLite files match their documentation — Only the documentation pages were read; files were not downloaded because sign-in is required
- [V] mustafa0x/quran-morphology is a fork of corpus v0.4 with no license in GitHub metadata (last push 2022-04-18); it contains 77,429 words, 130,030 segments, 1,657 distinct roots and 4,793 distinct lemmas — GitHub API repo metadata; streamed quran-morphology.txt and counted (saved mustafa0x-quran-morphology-README.md, -head.txt)
- [V] rust-stemmers 1.2.0 (2019-11-17) has Algorithm::Arabic — https://raw.githubusercontent.com/CurrySoftware/rust-stemmers/master/src/lib.rs
- [?] The Snowball Arabic stemmer maps الكتاب/بالكتاب/كتابه to كتاب and يومنون to يومن, but turns والصلاه into والصل — Tested with npm snowball-stemmers@0.6.0 (JS port of the same Snowball algorithm), not with the Rust crate (saved snowball-arabic-stem-samples.txt)
- [V] Lucene ArabicNormalizer folds آ/أ/إ to ا, ة to ه and ى to ي and removes harakat U+064B-U+0652 and tatweel — https://raw.githubusercontent.com/apache/lucene/main/lucene/analysis/common/src/java/org/apache/lucene/analysis/ar/ArabicNormalizer.java (saved lucene-ArabicNormalizer.java)
- [V] Alfanous (LGPLv3+) fuzzy search pipeline: normalization, stop-word removal, synonym expansion, Snowball Arabic stemming, plus Levenshtein matching on an unvocalized field — https://raw.githubusercontent.com/Alfanous-team/alfanous/master/README.md
- [V] The normalized Imla'i Quran text has 77,797 tokens and 14,650 distinct tokens (vocabulary size for fuzzy expansion) — node computation over Quran.com /quran/verses/imlaei in this session
- [V] Quran.com word data includes transliteration.text (e.g. 'bis\'mi', 'l-lahi', 'l-raḥmāni'), and translation resource 57 is a verse-level transliteration — https://api.quran.com/api/v4/verses/by_key/1:1?words=true (saved qurancom-v4-words-1_1-translit.json); /api/v4/quran/translations/57?chapter_number=1
- [?] url::Url::from_file_path on Windows produces file:///C:/... with percent-encoding that SQLite accepts via SQLITE_OPEN_URI — Only the Node equivalent (pathToFileURL) was tested; the Rust url crate was not compiled because cargo is unavailable here
- [?] The Rust code sketches (rusqlite 0.40 / r2d2_sqlite 0.35 / rusqlite_migration 2.6 APIs) compile as written — Signatures were checked against v0.40.2 source and docs.rs method lists (pragma_update, pragma_update_and_check, create_scalar_function, open_with_flags, with_flags, with_init, from_slice); not compiled because cargo is not installed
- [?] rusqlite 0.40.2 MSRV — crates.io metadata has no rust_version for rusqlite 0.40.2; not determined

## Recommendations
- Use rusqlite = { version = "0.40.2", features = ["bundled", "functions", "backup", "serde_json", "collation", "hooks"] }. Keep default features (they include 'cache'). Use i64 ids, because u64 ToSql is gated behind 'fallible_uint'.
- Do not add sqlx or tauri-plugin-sql to the dependency tree. They need libsqlite3-sys <0.38 / ^0.30, which conflicts with rusqlite 0.40 (links="sqlite3"). Expose data to the frontend through your own Tauri commands.
- Ship core.db uncompressed in bundle.resources and resolve it with app.path().resolve("data/core.db", BaseDirectory::Resource). Open it with url::Url::from_file_path(...) plus '?mode=ro&immutable=1' and flags READ_ONLY|URI|NO_MUTEX. Before shipping, run PRAGMA journal_mode=DELETE; VACUUM; ANALYZE.
- Serve core-DB reads from an r2d2_sqlite 0.35 pool of 2-4 connections. In with_init run: PRAGMA query_only=1; mmap_size=268435456; cache_size=-8192; temp_store=MEMORY; then register the ar_norm() function.
- Open the user DB as a single Mutex<Connection>: WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout 5s, PRAGMA optimize=0x10002 at open and PRAGMA optimize periodically. Apply schema changes with rusqlite_migration 2.6.0 (Migrations::from_slice + include_str!) and test with validate().
- Make every DB-touching Tauri command async and run the SQLite work inside tauri::async_runtime::spawn_blocking. Plain commands run on the main thread.
- Build all search indexes offline in a Rust build-data step (xtask) that is also the single source of normalize_ar(). The app must normalize queries with exactly the same function, so put it in a shared crate and add golden tests with real ayahs (e.g. 1:1, 2:2, 2:3, 2:21, 2:185).
- Index the Imla'i (simple-spelling) text in two FTS5 contentless columns: loose (full folding) and strict (letters preserved), with tokenize='unicode61'. Use Uthmani text only for display. Map hits to Mushaf words through the word table (per-word norm_loose), never by splitting ayah text on spaces.
- Escape the user query: quote each token and double embedded quotes; add * to the last token for search-as-you-type; use a 'loose : (...)' column filter and ORDER BY rank. Do not add prefix indexes: prefix queries already take ~0.05 ms without them.
- Support substring/'contains' mode with a LIKE scan over the stored norm_loose or text_fold column (~1 ms per 6236 rows) instead of shipping trigram indexes. A trigram index (detail=full only) is optional if you want sub-ms substring search.
- Give each translation its own downloaded DB file with an external-content FTS5 table built on device after download (~12-55 ms). Use 'porter unicode61 remove_diacritics 2' for English, 'unicode61 remove_diacritics 2' for other Latin/Cyrillic/Greek scripts, Arabic-script normalization for Urdu/Persian/Pashto/Kurdish and similar, and LIKE fallback for Chinese/Japanese/Korean/Thai/Khmer and queries under 3 characters. Strip <sup foot_note> markup into a footnote table.
- Add typo tolerance by expanding query tokens against the 14,650-term vocabulary (a TEMP fts5vocab table or a precomputed vocab table) with strsim Levenshtein ≤1-2. Optionally add a lower-weight 'stem' column using rust-stemmers Arabic, accepting that it sometimes mis-stems.
- Make root/lemma search an optional downloadable 'morphology' pack built from QUL (sign-in required) or the corpus/mustafa0x data. Show attribution and a link to corpus.quran.com, and get a license review because of the GPL plus verbatim-copy terms.
- Make transliteration search match word-level transliteration (Quran.com words API transliteration.text) reduced to a lowercase consonant skeleton without diacritics (rahman → rhmn), queried by LIKE or trigram.
- In the user DB use STRICT tables, UUIDv7 text ids plus created_at/updated_at/deleted_at for future sync, and global ayah_id 1..6236 with surah/ayah. Any table behind an external-content FTS index needs an explicit INTEGER PRIMARY KEY (VACUUM can renumber implicit rowids). Store settings as JSON (json_valid CHECK).
- Use zstd 0.14.1 (or pure-Rust ruzstd 0.9.0 for decode-only) only for downloadable packs or an include_bytes! embedded DB. Note the zstd crate's license changed to BSD-3-Clause in 0.14.x, so update third-party notices.

## Risks
- Duplicate native SQLite links: any crate that brings sqlx or a different libsqlite3-sys major version (tauri-plugin-sql 2.5.0 → sqlx ^0.8 → libsqlite3-sys ^0.30) will fail to resolve against rusqlite 0.40. Watch for transitive dependencies.
- Windows path-length limit: SQLite's Windows file layer caps paths at MAX_PATH (260). This was reproduced here as 'unable to open database file' when the -journal path reached 260 characters. Portable installs in deep folders could break the user DB; keep data under the standard app data directory and test long Windows user names or folder paths.
- Using immutable=1 on a file that can change (e.g. a pack being replaced) can give wrong results or SQLITE_CORRUPT. Use it only for the bundled core DB, and close pack connections before replacing files (Windows cannot rename over open files).
- Search can silently miss results if the normalizer used to build the index differs from the one used at query time. Version the normalizer and store it in core.db meta; rebuild the FTS for user notes and translation packs when it changes.
- Loose folding (ة→ه, ؤ→و, ئ→ي, dropping ء) causes collisions (e.g. سأل/سال both become سال). Offer a strict/exact-letters toggle and rank exact matches higher.
- The Uthmani/Imla'i word-count mismatch (25 of 293 ayahs in surahs 1-2, e.g. يا أيها) means naive word splitting will misplace highlights. Word-level mapping must come from a word dataset with stable s:a:w locations.
- Licensing: the Quranic Arabic Corpus is GPL with additional 'verbatim, no changes' terms, and QUL morphology derives from it while QUL says to check each resource's license. The mustafa0x fork has no license file. Bundling morphology inside a proprietary app needs legal review; prefer an optional download with attribution.
- The Snowball Arabic stemmer makes mistakes (والصلاه → والصل); used naively it lowers precision. Keep stems in a lower-weight column or behind a 'broad match' option.
- Trigram indexes with detail=column/none reject MATCH tokens longer than 3 characters; the trigram tokenizer cannot match queries under 3 characters. Rely on LIKE fallback for short or Chinese/Japanese/Korean queries.
- The zstd crate 0.14.1 was published 2026-10-09 (one day before this check); prefer 0.14.0 or wait for it to settle. Its license changed from MIT to BSD-3-Clause between 0.13.x and 0.14.x.
- Several crates now require Rust 1.95 or newer (rusqlite_migration 2.6.0, deadpool-sqlite 0.14.0, serde_rusqlite 0.43.0); pin the toolchain in rust-toolchain.toml (stable is 1.99.0).
- All size and latency numbers were measured with Node's built-in SQLite 3.53.1, not a compiled Rust binary. The engine is the same so behaviour should carry over, but the Rust code sketches were not compiled because cargo is not installed in this environment.
- QUL morphology downloads need a sign-in; their schemas were confirmed from documentation pages only, not from the actual files.
