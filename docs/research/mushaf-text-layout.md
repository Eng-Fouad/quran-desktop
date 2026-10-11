# mushaf-text-layout

## Bottom line
1. **Don't build the bundled core DB from Quran.com or Quran Foundation (QF) API responses.** The legacy API at `https://api.quran.com/api/v4` still answers without auth (checked live 2026-10-10). However, the QF Developer Terms (last updated 2026-10-04) cover Quran text and metadata ("QF Content"). They forbid caching QF Content for more than 1 week, and they forbid shipping "a prepackaged database or build-time bundle of QF Content". The one exception is Content Sync, which needs auth and a re-sync at least every 7 days. Font files and Mushaf images may be bundled if you keep an active Developer Console account and credit QF.
2. **Best layout and glyph source: QUL (qul.tarteel.ai).** It has exactly the data we need: a `pages` line table with `line_type` (`ayah`, `surah_name`, `basmallah`) and `is_centered`, and word-by-word scripts whose word ids include the ayah-end markers. The catch: every QUL download needs a free account login. I checked this in the page HTML and in the source: `ResourcesController before_action :authenticate_user!, only: [:download]`. So a person has to download the files once. I did not create an account.
3. **No-login fallback.** QUL publishes a Postgres dev dump at `https://static-cdn.tarteel.ai/qul/mini-dumps/mini_quran_dev.sql.zip`. It is 201,979,245 B zipped, 868,007,723 B unzipped, last modified 28 Jul 2025. It has `words` (code_v1, code_v2, text_qpc_hafs, word_index, line_v2, v2_page…), `mushaf_words` (per-mushaf page and line), `mushaf_pages`, `chapters` (with v1/v2/v4 chapter glyph codes), `verses` (juz, hizb, rub, manzil, ruku, sajdah, page), and juzs, hizbs, rub_el_hizbs, manzils, rukus. It **lacks** `mushaf_line_alignments`, so line types and centring would have to be derived.
4. **Tanzil.** Use it for licence-clean metadata (CC BY 3.0, `quran-data.xml`, direct download) and as a cross-check. Its 604 page starts match quran_android's `MadaniDataSource` arrays exactly (0 differences).
5. **quran_android** works from page images, not fonts. Its data (`quran.ar.uthmani.v2.db` plus `ayahinfo_{width}.db` pixel boxes, and line-by-line PNGs) can't be reused for font rendering. Its Arabic text does match QPC Hafs.

## 1. Quran.com API v4 (legacy) — still public
| Check | Result |
|---|---|
| `GET https://api.quran.com/api/v4/chapters` | 200, no auth. Headers: `access-control-allow-origin: *`, `Cache-Control: public, max-age=691200`, `x-qf-origin: qf-nonfaceing-data-legacy-api-quran`, Cloudflare HIT. No rate-limit headers. |
| `GET /verses/by_page/1?words=true&word_fields=code_v1,code_v2,text_uthmani,text_qpc_hafs,line_number,page_number,v1_page,v2_page&per_page=50` | 200. Returns `{verses:[{id,verse_number,verse_key,hizb_number,rub_el_hizb_number,ruku_number,manzil_number,sajdah_number,page_number,juz_number,words:[{id,position,audio_url,char_type_name('word'/'end'),code_v1,code_v2,text_uthmani,text_qpc_hafs,line_number,v1_page,v2_page,page_number,text,translation{text,language_name},transliteration{...}}]}],pagination:{per_page,current_page,next_page,total_pages,total_records}}` |
| Word `id` | Internal and **not sequential**: 1:1:1 is 1 but 1:2:1 is 1130. You can't use it as a word index. |
| `line_number` | Equals `line_v2` (default mushaf=1, QCF V2 1421H). `line_v1` (V1 1405H) differs often: page 600 has 76 of 94 words on different lines; pages 3, 50, 100 and 300 differ on 3, 15, 5 and 16 words. `v1_page == v2_page` on every page sampled. |
| `/quran/verses/code_v2?page_number=1` | 200. `/juzs` returns 60 entries (duplicate juz rows). `/pages/lookup` is 404 on the legacy host. |
| New API | `https://apis.quran.foundation/content/api/v4/*` returns 400 `{"message":"The request is missing required headers or is invalid"}` without `x-auth-token` and `x-client-id`. Tokens come from `POST https://oauth2.quran.foundation/oauth2/token` (client_credentials, `scope=content`). Prelive pair: `apis-prelive.quran.foundation` / `prelive-oauth2.quran.foundation`. No sunset date is published for the legacy host. |
| Mushaf ids (QF docs) | 1 QCF_V2, 2 QCF_V1, 3 IndoPak, 4 Uthmani Hafs, 5 KFGQPC Hafs, 6 IndoPak 15-line, 7 IndoPak 16-line, 11 Tajweed, 19 QCF Tajweed V4 |
| Font CDN (all returned 200) | `https://verses.quran.foundation/fonts/quran/hafs/v2/woff2/p{1..604}.woff2` (p1 is 40,956 B), `/v1/woff2/p{N}.woff2` (p1 is 15,328 B), `/v4/colrv1/woff2/p{N}.woff2`, `/v4/ot-svg/{light,dark,sepia}/woff2/p{N}.woff2`, `/uthmanic_hafs/UthmanicHafs1Ver18.woff2` (87,760 B). `.ttf` and `.woff` variants exist. |
| Content Sync groups | `quran_core`, `mushafs`, `translations`, `word_by_word_translations`, `word_by_word_transliterations`, `tafsirs`, `recitations`, `chapter_recitations`, `articles`. Endpoints: `GET /resources/sync?bootstrap=true&resources=...&per_page=100`, `GET /resources/snapshots/{group}/{id}`, `GET /resources/sync?sync_token=...`. |

## 2. QUL — resource ids (checked live)
**Layouts** (`/resources/mushaf-layout/{id}`): 10 = KFGQPC V2 (1421H), 15 = KFGQPC V1 (1405H), 19 = KFGQPC V4 (1441H), 21 = Digital Khatt (V2 1421H), and several Indopak layouts (8, 11, 12, 236, 313, 571), 570 Qatar, 569 SVG.

**Word-by-word scripts** (`/resources/quran-script/{id}`): 61 QPC V2 glyph, 57 QPC V1 glyph, 47 V4 tajweed glyphs, 312 KFGQPC Hafs, 58 QPC Hafs tajweed, 56 Uthmani, 53 Uthmani simple, 54 Imlaei, 60 Imlaei simple, 55 Indopak, 59 Indopak Nastaleeq, 48 Digital Khatt v2. Ayah-by-ayah versions: 80 V2, 81 V1, 86 QPC Hafs, 88 Uthmani, 82 Uthmani simple.

**Metadata** (`/resources/quran-metadata/{id}`): 70 surah names, 69 ayah, 68 juz, 67 hizb, 63 rub, 66 manzil, 65 ruku, 64 sajda. Surah-name JSON fields: `id, name, name_simple, name_arabic, revelation_order, revelation_place, verses_count, bismillah_pre`.

**Fonts** (`/resources/font/{id}`): 238 QPC V1, 249 QPC V2, 240 QPC V4 Tajweed, 245 QPC Hafs, 455, 456 and 457 surah-name fonts, 458 surah header font, 459 juz name font.

**Layout SQLite schema** (from source `lib/exporter/export_mushaf_layout.rb`):
- `pages(page_number INTEGER, line_number INTEGER, line_type TEXT['ayah'|'surah_name'|'basmallah'], is_centered INTEGER, first_word_id INTEGER, last_word_id INTEGER, surah_number INTEGER)`
- `info(name, number_of_pages, lines_per_page, font_name)`
- Columns that don't apply to a line are written as **''**, not NULL.
- `surah_number` is set only on `surah_name` lines. `basmallah` lines have no surah.
- `is_centered` is forced true for surah_name and basmallah lines.

**Word-script SQLite** (from the exporter source): `words(id INTEGER /*word_index*/, location TEXT 's:a:w', surah, ayah, word, text)`. The site's Help text calls these columns `word_index` and `word_key`, so the importer should accept both names.

Word ids are 1..N in Mushaf order **and include the ayah-end markers**: on page 1, ayah 1:1 is words 1–5 and ayah 1:7 ends at 36.

QUL's exporter assigns mushaf ids 1, 4, 5, 10, 11, 12 and 20 to `qpc_v2_layout`. That means **QPC Hafs Unicode (mushaf 5) shares the V2 line layout.**

**Preview checks:**
- Pages 1–2 have 8 lines, all centred.
- Page 187 (surah 9) has a surah_name line and no basmallah.
- Page 604 has 3 surah_name and 3 basmallah lines, plus centred short lines at surah ends.
- The V1 and V2 line breaks differ on page 604.

**Licensing:** the QUL code repo is MIT. The per-resource copyright endpoint returns "We don't have copyright information for this resource" for layouts and scripts. The FAQ says commercial use is OK but to check each resource's licence. QUL has no API.

## 3. Tanzil
- **Licence** (https://tanzil.net/docs/Text_License): "Creative Commons Attribution 3.0". Verbatim copies only; changing the text is not allowed. You must state the source (Tanzil Project) and link to tanzil.net. The copyright notice must be included in derived files. Latest text is v1.1 (Feb 2021).
- **Download form:** GET `https://tanzil.net/pub/download/index.php`. Parameters:
  - `quranType` ∈ simple | simple-plain | simple-min | simple-clean | uthmani | uthmani-min
  - `outType` ∈ txt | txt-2 | xml | sql
  - flags `marks`, `sajdah`, `rub`, `alef`, `tatweel`, `laa`, `stanween`
  - `agree=true` is required. I did not submit it, because that would accept the terms on the user's behalf.
- **Metadata:** `https://tanzil.net/res/text/metadata/quran-data.xml` (77,234 B, direct link, `license="cc-by"`). It contains 114 `sura` (index, ayas, start, name, tname, ename, type Meccan/Medinan, order, rukus), 30 `juz`, 240 `quarter` (inside `<hizbs>`), 7 `manzil`, 556 `ruku`, 604 `page` and 15 `sajda` (type recommended/obligatory). A compact JS version is at `/res/text/metadata/quran-data.js`.
- Tanzil's Uthmani text is encoded for fonts like me_quran. For the KFGQPC Uthmanic Hafs font, use QPC Hafs text (`text_qpc_hafs`, which uses U+06E1 for sukun).

## 4. quran_android (GPL-3.0)
- `MadaniPageProvider` uses base URL `https://android.quran.com/data`, which redirects to `https://files.quran.app/hafs/...`.
- **Arabic DB:** `databases/quran.ar.uthmani.v2.db.zip` (1,413,910 B zip; 5,198,848 B db).
  - Tables: `arabic_text(sura, ayah, text)` (6,236 rows), `share_text`, FTS3 `verses`, and `properties` (schema_version=3, text_version=3).
  - The text equals the API's `text_qpc_hafs` for 51 of 54 ayahs checked. The 3 differences are 102:3–5, where the API has a tatweel in كـَلَّا.
- **Ayah info:** `databases/ayahinfo/ayahinfo_{width}.zip` (1024 width: 2,220,186 B). It holds `glyphs(glyph_id, page_number, line_number, sura_number, ayah_number, position, min_x, max_x, min_y, max_y)` with 88,246 rows of image pixel boxes.
- **Line-by-line:** per-line PNGs at `{images}/{page}/{line}.png`, plus SQLDelight tables `ayah_glyphs(page, line, sura, ayah, glyph_position, left, right, glyph_type)`, `ayah_highlights`, `ayah_markers(code_point, center_x, center_y)` and `sura_headers`. All image-based, so none of it is reusable for font rendering.
- **Older V1 source:** `quran/quran.com-images` `sql/02-database.sql` (15.5 MB) has `glyph_page_line.line_type ENUM('sura-header','bismillah','ayah-text')` for V1 fonts. GitHub reports no licence; the README says the code is GPL and the fonts belong to KFGQPC.

## 5. Recommended build pipeline
Write a build script, e.g. `scripts/build-core-db.mjs` using `node:sqlite` (SQLite 3.53.1 with FTS5 is available in Node 26), or a Rust `xtask` with rusqlite.

**Inputs**, committed under `data/sources/` with a SHA-256 manifest and attribution text:
- **(a) Words.** QUL quran-script 61 (code_v2), 57 (code_v1), 312 (QPC Hafs Unicode text for the bundled font, copy and share), and 53 or 60 (simple text as the search seed). Join on `id` = word_index and check that `location` is identical across all four.
- **(b) Lines.** QUL mushaf-layout 10 (V2 1421H). It drives both V2 page fonts and the bundled Hafs font. Add 15 (V1) optionally, and 19 (V4) later.
  - Normalise '' to NULL.
  - Give basmallah lines the surah of the following ayah line.
  - Store kind as 0 = ayah, 1 = surah_name, 2 = basmallah.
- **(c) Metadata.**
  - Surahs: QUL 70 (ar, simple, complex names; place; order; ayah count; bismillah_pre).
  - Juz, hizb, rub, manzil, ruku, sajda: QUL 68, 67, 63, 66, 65, 64. Cross-check against Tanzil `quran-data.xml`: page starts, quarters, the 15 sajdas and their types, ayah counts.
  - Derive each surah's page start and juz page from the layout.
  - English surah meaning: Tanzil `ename`.

**Validation in CI:**
- 6,236 ayahs; per-surah counts match Tanzil.
- Word ids are contiguous, and each id appears in exactly one ayah line per layout.
- 604 pages with at most 15 lines each.
- 114 surah_name lines and 112 basmallah lines (none for Al-Fatiha or At-Tawbah).
- Layout page starts match Tanzil's.

**Proposed output schema:**
```sql
meta(key PK, value)
surah(id PK, name_ar, name_simple, name_complex, name_en, revelation_place, revelation_order, ayah_count, bismillah_pre, page_start)
ayah(id PK 1..6236, surah, ayah, page, juz, hizb, rub, manzil, ruku, sajda_type, first_word_id, last_word_id, text_search)
word(id PK = QUL word_index, ayah_id, position, is_end, text_hafs, code_v1, code_v2)
line(mushaf_id, page, line, kind, centered, first_word_id, last_word_id, surah_id, PRIMARY KEY(mushaf_id, page, line)) WITHOUT ROWID
ayah_fts USING fts5(text_search, content='ayah', content_rowid='id')  -- pre-normalised Arabic
```

**Size, measured on a prototype** with real ayah text and synthetic glyph codes (83,664 word rows):
- 8.13 MB raw, 2.88 MB gzip-9, 2.15 MB zstd-19.
- Breakdown: word table 3.99 MB, ayah table 2.43 MB, word(ayah_id) index 0.89 MB, two layouts 0.38 MB, FTS5 0.43 MB.
- Dropping the word(ayah_id) index (use the first/last word ranges instead) and any ayah-level copy of the text brings it to about 6 MB raw, roughly 1.8–2.2 MB zstd.

Sources: https://api-docs.quran.foundation/docs/quickstart/migration/ , https://api-docs.quran.foundation/legal/developer-terms/ , https://api-docs.quran.foundation/docs/tutorials/content-sync/getting-started/ , https://api-docs.quran.foundation/docs/tutorials/fonts/font-rendering/ , https://api-docs.quran.foundation/docs/tutorials/fonts/page-layout/ , https://qul.tarteel.ai/resources , https://qul.tarteel.ai/docs/project-setup , https://github.com/TarteelAI/quranic-universal-library , https://tanzil.net/docs/Text_License , https://tanzil.net/docs/Quran_Metadata , https://github.com/quran/quran_android , https://github.com/quran/quran.com-images

## Facts
- [V] The legacy API GET https://api.quran.com/api/v4/chapters returns 200 with no auth. It sends access-control-allow-origin:*, Cache-Control: public, max-age=691200 and x-qf-origin: qf-nonfaceing-data-legacy-api-quran. No rate-limit headers are present. — curl -sS -I https://api.quran.com/api/v4/chapters; saved research/mushaf-text-layout/chapters.headers.txt, chapters.json, live_probes.txt
- [V] GET /api/v4/verses/by_page/1?words=true&word_fields=code_v1,code_v2,text_uthmani,text_qpc_hafs,line_number,page_number,v1_page,v2_page&per_page=50 returns 200. The shape is {verses:[{id,verse_number,verse_key,hizb_number,rub_el_hizb_number,ruku_number,manzil_number,sajdah_number,page_number,juz_number,words:[{id,position,audio_url,char_type_name,code_v1,code_v2,text_uthmani,text_qpc_hafs,line_number,v1_page,v2_page,page_number,text,translation,transliteration}]}],pagination:{...}}. — saved research/mushaf-text-layout/verses_by_page_1.json and verses_by_page_1.headers.txt
- [V] The API's word 'id' is internal and not sequential (1:2:1 has id 1130), so it can't serve as a word index. The API also exposes no word_index field. — verses_by_page_1.json; /verses/by_key/114:6?word_fields=word_index returned no word_index
- [V] The API's line_number equals line_v2 (V2 1421H layout). line_v1 (V1 1405H) differs on many words: page 600 has 76 of 94 words on different lines, pages 50 and 300 have 15 and 16. v1_page equals v2_page on all sampled pages. — pages 3, 50, 100, 300, 600 fetched with word_fields=line_v1,line_v2; saved page600_line_v1_vs_v2.json, pg_50.json, pg_600.json
- [V] The authenticated Content API at https://apis.quran.foundation/content/api/v4/chapters (and the prelive host) returns 400 'The request is missing required headers or is invalid' without x-auth-token and x-client-id. — curl; saved qf_apis_noauth_400.json, live_probes.txt
- [V] The QF auth setup is client_credentials with scope=content. Token URL: https://oauth2.quran.foundation/oauth2/token (prelive: https://prelive-oauth2.quran.foundation). API base: https://apis.quran.foundation (prelive: https://apis-prelive.quran.foundation). The docs give no sunset date for api.quran.com. — WebFetch https://api-docs.quran.foundation/docs/quickstart/migration/
- [V] The QF Developer Terms (last updated 2026-10-04) define QF Content to include Quran text and metadata. They forbid caching or storing it for more than 1 week unless it comes through Content Sync (which needs a re-sync every 7 days). They state that Content Sync does not authorize 'a prepackaged database or build-time bundle of QF Content'. Fonts and Mushaf images may be cached or bundled with an active Developer Console account and credit to QF, but not offered separately. — curl https://api-docs.quran.foundation/legal/developer-terms/ ; excerpt saved qf_developer_terms_excerpt.txt
- [V] The Content Sync resource groups are quran_core, mushafs, translations, word_by_word_translations, word_by_word_transliterations, tafsirs, recitations, chapter_recitations and articles. Endpoints: /resources/sync?bootstrap=true, /resources/snapshots/{group}/{id} and /resources/sync?sync_token=. — WebFetch https://api-docs.quran.foundation/docs/tutorials/content-sync/getting-started/
- [V] The QF font CDN templates return 200: https://verses.quran.foundation/fonts/quran/hafs/{v1|v2}/{woff2|woff|ttf}/p{N}.{ext}, /v4/colrv1/woff2/p{N}.woff2, /v4/ot-svg/{light|dark|sepia}/woff2/p{N}.woff2 and /uthmanic_hafs/UthmanicHafs1Ver18.woff2. Sizes: V2 p1 woff2 is 40,956 B, V1 p1 is 15,328 B, V2 p604 ttf is 163,044 B. — curl -I probes; saved live_probes.txt
- [V] QF mushaf ids: 1 QCF_V2, 2 QCF_V1, 3 IndoPak, 4 Uthmani Hafs, 5 KFGQPC Hafs, 6 IndoPak 15-line, 7 IndoPak 16-line, 11 Tajweed, 19 QCF Tajweed V4. — WebFetch https://api-docs.quran.foundation/docs/tutorials/fonts/page-layout/
- [V] QUL downloads (sqlite, json, docx) require a logged-in account. The download anchors point to /users/sign_in, and ResourcesController has before_action :authenticate_user!, only: [:download]. — https://qul.tarteel.ai/resources/mushaf-layout/15 HTML; raw app/controllers/resources_controller.rb saved as qul_src_app_controllers_resources_controller.rb
- [V] QUL resource ids. Layouts: 10 = KFGQPC V2 1421H, 15 = KFGQPC V1 1405H, 19 = KFGQPC V4 1441H. Word-by-word scripts: 61 QPC V2 glyph, 57 QPC V1 glyph, 47 V4 tajweed, 312 KFGQPC Hafs, 53 Uthmani simple, 60 Imlaei simple, 56 Uthmani. Metadata: 70 surah names, 69 ayah, 68 juz, 67 hizb, 63 rub, 66 manzil, 65 ruku, 64 sajda. — QUL resource listing pages; saved qul_catalog_and_metadata_help.txt
- [V] The QUL layout SQLite has pages(page_number, line_number, line_type 'ayah'|'surah_name'|'basmallah', is_centered INTEGER, first_word_id, last_word_id, surah_number) and info(name, number_of_pages, lines_per_page, font_name). Columns that don't apply are written as '' rather than NULL, and surah_number is set only on surah_name lines. — raw lib/exporter/export_mushaf_layout.rb (saved qul_src_lib_exporter_export_mushaf_layout.rb) plus the Help text on /resources/mushaf-layout/15 (saved qul_layout_15_page_text.txt). I could not inspect an actual downloaded file because that requires login.
- [V] The QUL word-script SQLite exporter writes words(id = word_index, location, surah, ayah, word, text). The site's Help text instead names the columns word_index, word_key, surah, ayah, text. — raw lib/exporter/export_quran_word_script.rb (saved) vs qul_layout_15_page_text.txt
- [V] QUL word ids are sequential in Mushaf order and include ayah-end markers: 1:1 is words 1–5 and 1:7 ends at word 36. — QUL mushaf-layout Help sample data (qul_layout_15_page_text.txt)
- [V] QUL's exporter maps mushaf ids 1, 4, 5, 10, 11, 12 and 20 to qpc_v2_layout, ids 2, 22 and 21 to qpc_v1_layout, and 19 to qpc_v4_layout. So QPC Hafs Unicode (mushaf 5) uses the V2 line layout. — raw lib/export_mushaf_layout.rb layout_name_ids (saved qul_src_lib_export_mushaf_layout.rb)
- [V] QUL layout previews show the following. Pages 1 and 2 have 8 lines, all centred, and page 2 has a basmallah line. Page 187 (surah 9) has a surah_name line and no basmallah. Page 604 has 3 surah_name and 3 basmallah lines plus centred lines at surah ends. V1 and V2 line breaks differ on page 604. — https://qul.tarteel.ai/resources/mushaf-layout/{10,15,19}?page=N; saved qul_layout_preview_summaries.txt
- [V] QUL's public dev dump https://static-cdn.tarteel.ai/qul/mini-dumps/mini_quran_dev.sql.zip needs no login. It is 201,979,245 B zipped and 868,007,723 B unzipped, last modified 28 Jul 2025. It contains words (code_v1, code_v2, text_qpc_hafs, word_index, line_v2, v2_page …), mushaf_words, mushaf_pages, mushafs, chapters (v1/v2/v4 chapter glyph codes), verses, juzs, hizbs, rub_el_hizbs, manzils and rukus. It does not contain mushaf_line_alignments, which lives in the CMS database. — curl -I; range request of the first 3 MB and last 64 KB, inflated, DDL extracted (saved qul_dump_ddl.sql); db/schema.rb and app/models/mushaf_line_alignment.rb read; https://qul.tarteel.ai/docs/project-setup
- [V] The QUL code repo (TarteelAI/quranic-universal-library) is MIT. The per-resource copyright endpoint returns 'We don't have copyright information for this resource' for layouts 10, 15, 19, scripts 57, 61, 312, 56 and metadata 70. The FAQ says commercial use is allowed but to check each resource's licence. — GitHub API repo metadata; https://qul.tarteel.ai/resources/{id}/copyright; https://qul.tarteel.ai/faq
- [V] QUL's per-resource word-script exporter does not apply the V1 special case for 38:24:32–33 (code_v1 'ﯩ' and 'ﯪﯫ', sajdah marker merged with the ayah marker). Only the combined exporter in lib/export_mushaf_layout.rb applies it. — Comparison of the two exporter sources (saved). The effect on actually downloaded files was not checked.
- [V] Tanzil's licence is Creative Commons Attribution 3.0. Only verbatim copies are allowed (changing the text is not); the source (Tanzil Project) must be stated with a link to tanzil.net; the notice must be included in derived files. Text v1.1 was released in Feb 2021. — https://tanzil.net/docs/Text_License and https://tanzil.net/download/ ; saved tanzil_license_and_download_form.txt
- [?] Tanzil text download URL template: https://tanzil.net/pub/download/index.php?quranType=uthmani&outType=txt-2&marks=true&sajdah=true&alef=true&tatweel=true&agree=true (quranType: simple|simple-plain|simple-min|simple-clean|uthmani|uthmani-min; outType: txt|txt-2|xml|sql). — Form structure read from https://tanzil.net/download/. The request was not executed because agree=true would accept Tanzil's Terms of Use on the user's behalf.
- [V] Tanzil metadata https://tanzil.net/res/text/metadata/quran-data.xml downloads directly (77,234 B, license='cc-by'). It holds 114 suras (name, tname, ename, type, order, rukus, ayas, start), 30 juz, 240 quarters, 7 manzils, 556 rukus, 604 pages and 15 sajdas typed recommended or obligatory. — curl; saved tanzil_quran-data.xml
- [V] Tanzil's 604 page starts match quran_android's MadaniDataSource suraForPage and ayahForPage arrays exactly (0 differences). They also match the API's first verse on pages 3, 50, 100, 300 and 600. — local compare script cmp_pages.js on tanzil_quran-data.xml and MadaniDataSource.kt; API page samples
- [V] quran_android's data host https://android.quran.com/data redirects to https://files.quran.app/hafs/... The Arabic DB is databases/quran.ar.uthmani.v2.db.zip (1,413,910 B; db 5,198,848 B) with tables arabic_text and share_text (6,236 rows each), an FTS3 verses table and properties (schema_version 3, text_version 3). The image coordinate DB is databases/ayahinfo/ayahinfo_{width}.zip with glyphs(page_number, line_number, sura_number, ayah_number, position, min_x, max_x, min_y, max_y): 88,246 rows at width 1024. — MadaniPageProvider.kt and QuranFileUtils.kt read; files downloaded and inspected with sqlite3; saved quran_android_dbs_schema.txt
- [V] quran_android's line-by-line mode renders per-line PNG images ({imagesDir}/{page}/{line}.png) with SQLDelight tables ayah_glyphs, ayah_highlights, ayah_markers and sura_headers. It is not usable as font-based layout data. — QuranLineByLinePresenter.kt and the .sq schemas; saved quran_android_linebyline_and_provider_src.txt
- [V] quran_android's arabic_text is QPC Hafs encoded (U+06E1 sukun) and matches the API's text_qpc_hafs for 51 of 54 ayahs checked. The 3 differences are 102:3–5, where the API has a tatweel in كـَلَّا. — local comparison on pages 1, 50, 342, 600
- [V] quran/quran.com-images sql/02-database.sql (15,509,119 B) contains a V1 glyph layout with glyph_page_line.line_type ENUM('sura-header','bismillah','ayah-text'). GitHub reports no licence; the README says the code is GPL and the fonts and pages belong to KFGQPC. — raw sql/01-schema.sql and README.md, HEAD of 02-database.sql
- [V] A prototype core DB (83,664 word rows, 6,236 ayahs, two 604×15 layouts, FTS5) measures 8,134,656 B raw, 2,880,902 B gzip-9 and 2,147,494 B zstd-19. — local build with proto_size.js (saved) and proto_size_result.json
- [?] The exact total of QUL word_index rows is about 83,664–83,668 (about 77,428–77,429 words plus 6,236 end markers). — Derived by splitting QPC Hafs ayah text on spaces; not confirmed against an actual QUL words file, which needs login.

## Recommendations
- Do not generate the bundled core DB from api.quran.com or apis.quran.foundation responses. The QF Developer Terms (2026-10-04) forbid caching for more than 7 days and forbid shipping a prepackaged database of QF Content. Use QF only for runtime on-demand assets. Fonts may be cached or bundled if we keep an active Developer Console account and show the credit 'Quran fonts provided by Quran Foundation'.
- Primary pipeline: the user (not the agent) creates a free QUL account and downloads these once, in SQLite format where available. Layouts: 10 (V2 1421H, required) and 15 (V1, optional). Word scripts: 61 (QPC V2 glyph), 57 (V1 glyph), 312 (KFGQPC Hafs Unicode), 53 or 60 (simple text for search). Metadata JSON: 70, 69, 68, 67, 63, 66, 65, 64. Commit them to data/sources/qul/ with a SHA-256 manifest, then build src-tauri/resources/core.sqlite(.zst) in CI with a deterministic script (node:sqlite or a Rust xtask with rusqlite).
- Use QUL layout 10 (V2) for both QCF V2 page-font rendering and the bundled Unicode QPC Hafs font. QUL maps mushaf 5 (KFGQPC Hafs) to the V2 layout. Keep V1 as an optional second mushaf, and never mix V1 glyph codes with V2 line numbers.
- Importer rules: convert '' to NULL. Fill surah_number on basmallah lines from the next ayah line. Map line_type to kind 0 = ayah, 1 = surah_name, 2 = basmallah. Accept both column names (id or word_index, location or word_key). Check that word ids are contiguous and that locations are identical across scripts 61, 57, 312 and 53.
- CI validation gates: 6,236 ayahs and per-surah counts equal to Tanzil; 604 pages with at most 15 lines; 114 surah_name and 112 basmallah lines per layout (none for 1 or 9); every word id covered exactly once by ayah lines; layout-derived page starts equal Tanzil's (Tanzil is already proven equal to quran_android's arrays).
- Use Tanzil quran-data.xml (CC BY 3.0, direct URL) as an independent cross-check for juz, quarter, manzil, ruku, sajda types and page starts, and for English surah meanings ('ename'). Show the Tanzil attribution and a link in the About screen.
- Schema: word(id PK = QUL word_index, ayah_id, position, is_end, text_hafs, code_v1, code_v2); line(mushaf_id, page, line, kind, centered, first_word_id, last_word_id, surah_id) WITHOUT ROWID; ayah(id 1..6236, surah, ayah, page, juz, hizb, rub, manzil, ruku, sajda_type, first_word_id, last_word_id, text_search) with an FTS5 index on pre-normalised text_search. Avoid a word(ayah_id) index by using the first/last word ranges. Expect about 6–8 MB raw and about 2–2.5 MB zstd.
- Fallback if no QUL account is possible: stream-parse the COPY blocks of the public mini_quran_dev.sql.zip (202 MB) for words, verses, chapters, mushaf_words (mushaf_id 1 and 2), juzs, hizbs, rub_el_hizbs, manzils and rukus. Derive line kinds from the empty lines before each surah's first ayah (surah_name, then basmallah unless the surah is 1 or 9). Treat centring as a heuristic: pages 1–2 are all centred, and other lines are centred when their measured natural width is well under the line width.
- Apply the V1 fix for 38:24:32–33 (code_v1 'ﯩ' and 'ﯪﯫ') if V1 glyph data comes from the per-resource script export or the dump.
- On Windows, avoid the very long scratchpad path for native tools: curl.exe and node fail on paths over 260 characters. Build in a short directory such as C:\qd-build.

## Risks
- Licensing gap: QUL publishes no explicit licence for its layout and glyph-code data (the copyright endpoint says it has no information). The data originates from Quran.com/QF and KFGQPC. It is widely used (quran_android, quran_ios), but before shipping we should get written confirmation from Tarteel/QUL (GitHub issue or Discord) and credit QUL, Quran.com/QF, KFGQPC and Tanzil in the app.
- QF Developer Terms apply to Quran text and metadata obtained from QF APIs, and the legacy api.quran.com is QF-operated (x-qf-origin header). Building the bundle or long-term caches from it would breach the 1-week caching rule and the no-prepackaged-bundle rule. The terms can also change (last change 2026-10-04).
- QUL downloads need a login, so the agent can't automate them. A human must download once, and the files must be versioned in the repo or a private release. Source updates (QUL emails corrections to people who downloaded) must be re-pulled by hand.
- Text drift between sources: QF/API QPC Hafs text now differs from quran_android's v3 text (tatweel in كـَلَّا, 102:3–5). Pin one source (QUL 312) and its hash, and never mix ayah-level text from one source with word-level text from another.
- V1 (1405H) and V2 (1421H) line breaks differ on many pages. Rendering code_v1 glyphs with V2 line numbers, or the reverse, produces broken lines.
- Tanzil forbids any change to its text. Normalised or simplified search text derived from Tanzil should stay internal to the search index and never be shown as Quran text. Prefer QUL simple text (53 or 60) as the search seed.
- Unverified: the exact word_index row count (about 83.66K) and the actual contents of QUL download files. Schemas came from exporter source and Help pages, and the Help pages disagree with the exporter on column names.
- The no-login fallback dump is 202 MB, dated July 2025, and lacks line alignment (line_type and is_centered), so derived centring would be heuristic.
- GitHub's unauthenticated API rate limit (60/hour) was exhausted during research. CI scripts that hit the GitHub API should authenticate.
