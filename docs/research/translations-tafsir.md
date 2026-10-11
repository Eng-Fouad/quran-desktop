# translations-tafsir

## TL;DR
- **The Quran.com v4 API still answers without auth, but it is a legacy service.** `https://api.quran.com/api/v4/...` returns HTTP 200, and every response carries the header `x-qf-origin: qf-nonfaceing-data-legacy-api-quran`. The replacement is the **Quran Foundation (QF) Content API** at `https://apis.quran.foundation/content/api/v4`. It uses the OAuth2 client-credentials flow, sends the `x-auth-token` and `x-client-id` headers, and the docs say the secret is **backend-only**. The QF Developer Terms (last updated 2026-10-04) have two consequences for us:
  - QF content may be cached for at most **1 week**, unless it was obtained through the **Content Sync API** (`/resources/sync` + `/resources/snapshots/{group}/{id}`).
  - The synced copy must be re-synced at least every 7 days, and prepackaged bundles are not allowed.
- **The Clear Quran (Khattab, QC id 131) is gone.** `/quran/translations/131` returns `{"translations":[]}`. QF's own updates page says it was removed at the copyright holder's request. QUL states that Furqaan Institute holds the exclusive license.
- **Whole-Quran translation dump (verified):** `GET /api/v4/quran/translations/{id}?fields=verse_key&foot_notes=true` returns all 6,236 verses in one call, with footnote bodies embedded. Without `fields=verse_key` each row has only `resource_id` and `text`, so the order is implicit.
- **There is no whole-Quran tafsir dump.** `/api/v4/quran/tafsirs/{id}` always returns an empty list, with or without filters. Use `/api/v4/tafsirs/{id}/by_chapter/{ch}?per_page=300` 114 times.
- **License-clean file sources:**
  - **QuranEnc** gives explicit permission to republish under conditions. It ships a versioned list API and per-translation SQLite files with footnotes.
  - **Tanzil** allows non-commercial use only and requires a link back if you use more than three translations. It has no footnotes.
  - **fawazahmed0/quran-api** (Unlicense code) and **spa5k/tafsir_api** (MIT code) are convenient, but their content inherits the upstream copyrights, and I found data-fidelity problems in both.

## 1. Quran.com API v4 (legacy, no auth) — verified endpoints

| Purpose | URL | Notes (observed) |
|---|---|---|
| Translation list | `GET https://api.quran.com/api/v4/resources/translations[?language=ur]` | Returns `{translations:[{id,name,author_name,slug,language_name,translated_name:{name,language_name}}]}`. **126 entries**, about 25.5 KB. `slug` is often `""`. `?language=` only localizes `translated_name`. |
| Full translation | `GET /api/v4/quran/translations/{id}?fields=verse_key&foot_notes=true` | Returns `{translations:[{resource_id,verse_key,text,foot_notes:{"<fnId>":"<html>"}}],meta:{translation_name,author_name,filters}}`. Saheeh (20): **1,492,722 B raw / 387,842 B gzip**, 6,236 rows, 1,612 verses with footnotes, 1,903 footnotes. No pagination. Also accepts `chapter_number=`, `juz_number=` etc. for chunked download. |
| Single footnote | `GET /api/v4/foot_notes/{id}` | Returns `{"foot_note":{"id","text","language_name"}}`. |
| Translation info | `GET /api/v4/resources/translations/{id}/info` | Returns `{"info":{"id":20,"info":""}}` (empty). |
| Tafsir list | `GET /api/v4/resources/tafsirs` | 20 entries, same fields as the translation list. |
| Tafsir by chapter | `GET /api/v4/tafsirs/{id}/by_chapter/{ch}?per_page=300` | Returns `{tafsirs:[{id,resource_id,verse_key,language_id,text,slug}],pagination:{per_page,current_page,next_page,total_pages,total_records}}`. The default `per_page` is 10. `per_page=300` and `1000` were accepted (this is not documented, so keep a pagination loop). **Grouped verses:** the first verse of a group carries the HTML and the rest have `text:""` (for example 2:49 has text and 2:50 is empty). |
| Tafsir by ayah | `GET /api/v4/tafsirs/{id}/by_ayah/{s:a}` | Returns `{tafsir:{verses:{"2:49":{id},"2:50":{id}},resource_id,resource_name,language_id,slug,translated_name,text}}`. The `verses` map lists the group members. |
| Whole-Quran tafsir | `GET /api/v4/quran/tafsirs/{id}` | **Broken:** returns `{"tafsirs":[]}` even with `chapter_number`, `juz_number`, `verse_key` or `page_number`. |
| Word-by-word | `GET /api/v4/verses/by_chapter/{ch}?words=true&language={iso}&word_fields=text_uthmani,text_imlaei_simple&per_page=300` | Each word has `{id,position,audio_url:"wbw/001_001_001.mp3",char_type_name:"word"/"end",text_uthmani,text_imlaei_simple,location:"1:1:1",page_number,line_number,text,translation:{text,language_name},transliteration:{text,language_name:"english"}}`. Whole Quran in English: **25,401,308 B raw / 2,567,264 B gzip** over 114 requests. |
| WBW languages | `GET /api/v4/resources/word_by_word_translations` | ids: 59 en, 104/129 ur, 100 id, 99 bn, 555 tr, 552 fa, 551 hi, 554 ta, 549 inh. Any other `language=` value **silently falls back to English** (tested on all 71 languages). Transliteration is English only. |
| Languages | `GET /api/v4/resources/languages` | 71 languages: `{id,name,iso_code,native_name,direction,translations_count,translated_name}`. |

Response headers: `Cache-Control: public, max-age=604800` (list) or `691200` (dump), `access-control-allow-origin: *`, served through Cloudflare + Varnish. No rate-limit headers appeared, and 8 parallel × 114 requests all returned 200.

### Footnote and markup variants (scanned across 27 full dumps)
- **Usual form:** `<sup foot_note=195932>1</sup>`, with the attribute value unquoted.
- **Bridges (149):** the value is quoted, `<sup foot_note="79577" class="qiraat">1</sup>`. The same translation also uses:
  - `<span class="h">` for highlighted text.
  - `<i class="s">(of God) </i>` for supplied words.
  - `<a class="sup"><sup>sg </sup></a>` for grammatical number markers. These are **not footnotes**.
- **Footnote bodies can contain HTML:**
  - `<b class="h">`, `<span class="h">` and `<sup>`.
  - Verse links such as `<a href="2:255">`, `href="/2:255"` and `href="2:255-257"`. Junagarhi has 938 of these.
- **Malformed data exists.** QC 134 (Indonesian King Fahad Complex) at 1:2 has `<sup foot_note=682<sup foot_note=209772>2</sup>2>1</sup>`.

### Full-dump sizes (raw bytes, `fields=verse_key&foot_notes=true`)

| id | Translation | Size | Footnotes |
|---|---|---|---|
| 20 | Saheeh International | 1.49 MB | 1,903 |
| 85 | Abdel Haleem | 1.19 MB | 1 |
| 19 | Pickthall | 1.23 MB | 0 |
| 22 | Yusuf Ali | 1.30 MB | 0 |
| 203 | Hilali & Khan | 1.97 MB | 759 |
| 149 | Bridges | 1.72 MB | 1,931 |
| 84 | Taqi Usmani | 1.30 MB | 0 |
| 95 | Maududi (en) | 5.45 MB | 5,921 |
| 57 | Transliteration | 1.00 MB | 0 |
| 234 | Jalandhari | 1.82 MB | 0 |
| 54 | Junagarhi | 8.40 MB | 11,737 |
| 97 | Tafheem (ur) | 12.32 MB | 6,079 |
| 33 | Indonesian Ministry | 1.66 MB | 826 |
| 134 | Indonesian King Fahad Complex | 1.85 MB | 1,610 |
| 77 | Diyanet | 1.40 MB | 0 |
| 52 | Elmalili | 1.31 MB | 0 |
| 31 | Hamidullah | 1.52 MB | 987 |
| 779 | Rashid Maash | 1.65 MB | 1,599 |
| 136 | Montada (fr) | 1.51 MB | 610 |
| 83 | Isa Garcia | 1.53 MB | 1,142 |
| 199 | Noor International (es) | 1.80 MB | 1,092 |
| 161 | Taisirul Quran | 2.65 MB | 0 |
| 163 | Mujibur Rahman | 2.57 MB | 0 |
| 213 | Abu Bakr Zakaria (bn) | 2.59 MB | 0 |
| 45 | Kuliev | 1.82 MB | 0 |
| 79 | Abu Adel | 3.17 MB | 0 |
| 27 | Bubenheim | 1.34 MB | 0 |
| 208 | Abu Reda | 1.34 MB | 0 |

Tafsir totals (114 × `by_chapter?per_page=300`, raw): Ibn Kathir en (169) **11.76 MB**, Muyassar (16) **2.63 MB**, Sa'di ar (91) **7.56 MB**, Ma'arif (168) **12.29 MB**.

Tafsir HTML seen in the data:
- Ibn Kathir: `h1`, `h2`, `p`, `div`, `strong`, `span style=...`.
- Muyassar: `<span class="green">`.
- Sa'di: `<span class="arabic qpc-hafs brown">` for Quran quotes.

## 2. Resource IDs (Quran.com legacy / QF)

**English:**
- 20 Saheeh International (`en-sahih-international`)
- 85 M.A.S. Abdel Haleem (`en-haleem`)
- 19 Pickthall (`quran.en.pickthall`)
- 22 Yusuf Ali (`quran.en.yusufali`)
- 203 Hilali & Khan
- 149 Bridges (Fadel Soliman)
- 84 Taqi Usmani
- 95 Maududi
- 57 Transliteration
- **131 Clear Quran is NOT available** (empty response, not in the list)

**Urdu:** 234 Jalandhari, 54 Junagarhi, 97 Maududi (Tafheem), 819 Wahiduddin Khan, 158 Bayan-ul-Quran (Israr Ahmad), 151 Mahmud al-Hasan / Tafsir-e-Usmani, 156 Fi Zilal, 831 Maududi (Roman Urdu).

**Indonesian:** 33 Ministry of Religious Affairs, 134 King Fahad Complex, 141 Sabiq.

**Turkish:** 77 Diyanet, 52 Elmalili Hamdi Yazir, 112 Shaban Britch, 124 Muslim Shahin, 210 Dar Al-Salam.

**French:** 31 Hamidullah, 779 Rashid Maash, 136 Montada.

**Spanish:** 83 Isa Garcia, 140 Montada, 199 Noor International.

**Bengali:** 161 Taisirul Quran, 163 Mujibur Rahman, 162 Rawai al-Bayan, 213 Abu Bakr Zakaria.

**Russian:** 45 Kuliev, 79 Abu Adel, 78 Ministry of Awqaf.

**German:** 27 Bubenheim & Elyas, 208 Abu Reda.

**Tafsir:**
- 169 Ibn Kathir (Abridged, en, slug `en-tafisr-ibn-kathir`, sic)
- 14 Ibn Kathir (ar)
- 16 Tafsir Muyassar (ar)
- 91 Al-Sa'di (ar), 170 Al-Sa'di (ru)
- 168 Ma'arif al-Qur'an (en)
- 15 Tabari, 90 Qurtubi, 93 Wasit, 94 Baghawi
- 817 Tazkirul Quran (en), 818 (ur)
- 160 Ibn Kathir (ur), 157 Fi Zilal (ur), 159 Bayan ul Quran (ur)
- 164, 165, 166, 381 (bn)
- 804 Kurdish
- **Al-Jalalayn is NOT on Quran.com.** Use Tanzil `ar.jalalayn`, spa5k `ar-tafsir-al-jalalayn` (QUL 523) or `tafsir-al-jalalayn` (en, QUL 573), or fawaz `ara-jalaladdinalmah`.

## 3. Quran Foundation Content API (authenticated) — the compliant way to get QF content offline
- **Hosts:** prod `https://apis.quran.foundation/content/api/v4` (auth `https://oauth2.quran.foundation/oauth2/token`, `grant_type=client_credentials`, `scope=content`). Prelive `https://apis-prelive.quran.foundation` with `https://prelive-oauth2.quran.foundation`; prelive data covers only surahs 1–2.
- **Auth:** tokens last 3600 s and there is no refresh token. Credentials come from `https://dev-console.quran.foundation/projects`, and production use needs approval. The docs say a browser or mobile app "must not embed a Content API client_secret". An unauthenticated call returns `400 {"type":"invalid_request"}` (verified).
- **Sync:** `GET /resources/sync?bootstrap=true&resources=translations:20;tafsirs:169;word_by_word_translations:59&per_page=100`.
  - Follow `next_page_url` until `has_more=false`, then store `next_sync_token`.
  - Later calls use `?sync_token=...&resources=<same filter>`.
  - Mutation types: `RESOURCE_CREATE` and `RESOURCE_INVALIDATE` mean fetch `snapshot_url` and replace; `RESOURCE_DELETE`; `ROW_CREATE` and `ROW_UPDATE` are upserts by `record_type` + `record_key`; `ROW_DELETE`; `RESOURCE_UPDATE` is only a freshness marker.
- **Snapshot:** `GET /resources/snapshots/{group}/{id}` returns `{resource_group,resource_id,resource_content_id,schema_version,sync_sequence,records}`.
  - Translation record: `{id,resource_content_id,verse_key,text,foot_notes}`.
  - Tafsir record: `{id,resource_content_id,resource_id,verse_id,verse_key,group_verse_key_from,group_verse_key_to,group_verses_count,start_verse_id,end_verse_id,text}`.
- **Syncable groups:** `quran_core`, `mushafs`, `translations`, `word_by_word_translations`, `word_by_word_transliterations`, `tafsirs`, `recitations`, `chapter_recitations`, `articles`.

## 4. File sources that need no API

**QuranEnc**
- List: `GET https://quranenc.com/api/v1/translations/list[/{iso}][?localization=xx]` returns 76 entries with `{key,direction,language_iso_code,version,last_update(unix),title,description,file,database_url,database_uncompressed_url,pdf_url,epub_url,...}`.
- Sura: `GET /api/v1/translation/sura/{key}/{sura}` returns `{result:[{id,sura,aya,arabic_text,translation,footnotes}]}`.
- Aya: `GET /api/v1/translation/aya/{key}/{s}/{a}`.
- SQLite: `https://quranenc.com/downloads/sqlite/{key}.zip` or `.sqlite` (english_saheeh: 518,866 B zip / 1,245,184 B). Table `translations(id,sura,aya,translation,footnotes)`.
  - The SQLite text is prefixed `"(1) "` and footnote lines look like `"[2]- ..."`. The API returns `"[2] ..."` without the prefix.
  - Markers can be non-Latin digits, for example Bengali `[১]`.
- Keys:
  - en: `english_saheeh` (Noor International, v1.1.2, includes footnotes), `english_rwwad`, `english_hilali_khan`
  - ur: `urdu_junagarhi`
  - id: `indonesian_affairs`, `indonesian_complex`, `indonesian_sabiq`
  - tr: `turkish_rwwad`, `turkish_shaban`, `turkish_shahin`
  - fr: `french_rashid`, `french_montada`
  - es: `spanish_garcia`, `spanish_montada_eu`, `spanish_montada_latin`
  - de: `german_bubenheim`, `german_rwwad`
  - hi: `hindi_omari`; fa: `persian_ih`
  - **Unlisted but responding:** `bengali_zakaria`, `russian_rwwad`, `malay_basumayyah`, `arabic_moyassar`. `russian_kuliev` returns 404.
- Terms allow republishing on these conditions: no changes, credit the publisher and QuranEnc.com, state the version, keep the transcript info, update to the latest version, and no inappropriate ads.

**Tanzil**
- Download: `https://tanzil.net/trans/?transID={id}&type={txt|txt-2|xml|sql|zekr}`. `txt-2` is `sura|aya|text` and ends with a `#` comment trailer containing Name, Translator, Language, ID, Last Update and Source.
- IDs: `en.sahih` (2011, **no footnotes**, "Allah" without macron), `en.pickthall`, `en.yusufali`, `en.hilali`, `en.transliteration`, `ur.jalandhry`, `ur.junagarhi`, `ur.maududi`, `id.indonesian`, `tr.diyanet`, `fr.hamidullah`, `es.garcia`, `bn.bengali`, `bn.hoque`, `ru.kuliev`, `de.bubenheim`, `de.aburida`.
- Arabic tafsir as per-ayah lines: **`ar.jalalayn`** (1.94 MB) and **`ar.muyassar`** (2.54 MB).
- Terms: non-commercial use only, a link back if you use more than three translations, and no redistribution of the list.

**fawazahmed0/quran-api** (Unlicense, 492 editions, branch `1`, no tags)
- Endpoints: `https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions.json`, `/editions/{name}.json` (or `.min.json`), `/editions/{name}/{ch}.json`, `/editions/{name}/{ch}/{v}.json`, plus `/juzs/`, `/pages/`, `/rukus/`, `/manzils/`, `/maqras/` and `/info.json`.
- Edition keys use underscores; URLs use hyphens. Use the `link` field.
- Full file shape is `{quran:[{chapter,verse,text}]}`, 1.07 MB raw / 262 KB gzip.
- **Fidelity problems:**
  - Trailing punctuation is stripped.
  - No footnotes.
  - It carries Clear Quran (`eng-mustafakhattaba`/`g`) and Abdel Haleem with **no source listed**. Do not use those two.

**spa5k/tafsir_api** (MIT code, 123 editions, tags up to v1.2.2)
- `https://cdn.jsdelivr.net/gh/spa5k/tafsir_api@main/tafsir/editions.json` lists `[{id,slug,name,author_name,language_name,source}]`. Per chapter: `/tafsir/{slug}/{surah}.json` returns `[{surah,ayah,text}]`. Per ayah: `/tafsir/{slug}/{surah}/{ayah}.json`.
- On jsDelivr, pin an exact tag (the README warns that moved tags serve stale files). Mirrors: fastly/gcore.jsdelivr.net, rawcdn.githack.com, raw.githubusercontent.com.
- Text is plain with `\n`. `en-tafisr-ibn-kathir/2.json` is 2.49 MB.
- **Data mismatch:** `ar-tafsir-muyassar` 1:1 differs from QC tafsir 16 at 1:1 (1:2 matches).

**AlQuran.cloud**
- `https://api.alquran.cloud/v1/edition?format=text&type=translation` lists 118 translations.
- `https://api.alquran.cloud/v1/quran/{edition}` returns surahs[].ayahs[] with `{number,text,numberInSurah,juz,manzil,page,ruku,hizbQuarter,sajda}`. en.sahih is 1.61 MB and uses Tanzil text.

**QUL** (qul.tarteel.ai): Clear Quran is 426, Saheeh 193, Pickthall 145, Yusuf Ali 124, Abdul Haleem 154. It offers JSON and SQLite in four footnote formats (tags `{t,f}`, inline `[[..]]`, chunks, simple). **Downloads require sign-in** (`/users/sign_in?modal=true`), so it is usable only in a manual, build-time step.

## 5. Recommended strategy
1. **Our own catalog.** Host `catalog.json` ourselves (for example on GitHub Pages). Each resource lists a stable local id, kind, lang, dir, name, author, size, license/attribution text, and an **ordered list of sources** (each with URL template, parser, expected sha256 or version). The app never hard-codes upstream IDs. When upstream changes, we fix the catalog, not the app.
2. **Source priority for translations:**
   - (a) QuranEnc when a key exists. It is license-clean, versioned, and includes footnotes. Download the `.zip` SQLite and check updates through `version`/`last_update`.
   - (b) QF Content Sync through a small Cloudflare Worker that holds the client secret and proxies only `/resources/sync` and `/resources/snapshots/*`. The app must re-sync at least every 7 days when online, as the terms require. Use this for QF-only items: Abdel Haleem, Bridges, Ma'arif, Ibn Kathir abridged, WBW.
   - (c) Tanzil for classic, public-domain-era texts (Pickthall, Yusuf Ali, Kuliev, Muhiuddin Khan, Jalalayn, Muyassar). Fetch straight from tanzil.net at runtime; do not mirror.
   - (d) Legacy `api.quran.com` only as a dev or emergency fallback. It is legacy, and its terms limit caching.
   - (e) Never ship copyrighted texts without permission: Clear Quran, and Abdel Haleem/OUP unless it comes via QF.
3. **Tafsir:** QF Sync, or legacy `by_chapter` with 8 parallel requests and per-chapter progress, for 169, 168, 91 and 16. Tanzil for `ar.jalalayn` and `ar.muyassar`. spa5k only with per-edition QA. Store groups as ranges.
4. **Storage:** a separate `content.sqlite` next to the read-only bundled core DB (ATTACH it).
   - Tables:
     - `resource(id, kind, source, source_key, version, lang, direction, name, author, license_note, installed_at, updated_at, sha256)`
     - `translation_text(id INTEGER PRIMARY KEY = resource_id*100000 + ayah_gid, resource_id, sura, ayah, text /*sanitized html*/, plain, UNIQUE(resource_id, sura, ayah))`
     - `translation_footnote(resource_id, footnote_id TEXT, sura, ayah, marker, text, PRIMARY KEY(resource_id, footnote_id)) WITHOUT ROWID`
     - `tafsir_entry(resource_id, entry_id, from_gid, to_gid, html, plain)`, indexed on `(resource_id, from_gid, to_gid)`
   - Full-text search uses an **external-content FTS5** table: `CREATE VIRTUAL TABLE translation_fts USING fts5(plain, content='translation_text', content_rowid='id', tokenize="unicode61 remove_diacritics 2")`, kept in step with AFTER INSERT/DELETE triggers.
   - Prototype result: Saheeh with footnotes and the index is **2.90 MB**. The variant that stores the text twice was 4.17 MB. "allah" matches "Allāh".
   - **The unicode61 and trigram tokenizers do NOT fold Arabic harakat or alef forms** (tested on SQLite 3.53.1). Index a normalized column instead: strip U+0610–061A, U+064B–065F, U+0670, U+06D6–06ED and U+0640; map أإآٱ→ا, ى→ي, ة→ه. Apply the same normalization to the query.
   - rusqlite 0.40.2 / libsqlite3-sys 0.38.2 with feature `bundled` compiles `-DSQLITE_ENABLE_FTS5`.
5. **Footnote rendering:**
   - At import, normalize every source to `<sup class="fn" data-fn="{id}">{marker}</sup>`.
     - QC/QF: the regex `<sup\s+foot_note="?(\d+)"?[^>]*>([^<]*)</sup>`, plus the qiraat class.
     - QuranEnc: `\[(\p{Nd}+)\]` in the text, with footnote lines split on `^\[(\p{Nd}+)\]-?\s*`. Synthetic id is `{s}:{a}:{n}`. Strip the leading `(n) `.
   - Sanitize once in Rust with **ammonia 4.x** (4.2.1 on crates.io). Allowlist: `p, h2–h4, b, strong, i, em, span.h/.s/.green/.arabic, sup, br, ul/ol/li, a[href]`. Drop `style`. Rewrite `href` values matching `^/?\d+:\d+(-\d+)?$` to internal navigation and remove other links. Re-sanitize in the webview with DOMPurify 3.4.16.
   - In the UI, clicking or hovering a marker opens a popover. Offer an "expand footnotes under ayah" toggle. Show the qiraat type as a badge, render Bridges `.s` words muted, and show the `sg`/`pl` markers as muted superscripts rather than footnotes. Copy and share use `plain`.
6. **Download UX:** show the size before downloading (numbers above). Stream into a temp DB, verify the row count is 6,236 for translations, then swap atomically. Keep each source's version for update checks, show credits on an About/Credits screen, and link back to Tanzil.

## Saved samples
All saved under `C:\Users\fouad\AppData\Local\Temp\claude\C--Users-fouad-AppData-Roaming-Claude-scratch-workspaces-6463bc05-45c5-4361-9291-b022ebeed68b-4fedef61-7d08-4bf3-95d0-ddab25699856-scratch-2026-10-09-5aa8bc\ba4e4a3a-7c3b-4454-bc64-bdcdd225f47a\scratchpad\research\translations-tafsir\` (see the saved_samples field).

## Facts
- [V] GET https://api.quran.com/api/v4/resources/translations returns 200 with 126 translations; fields id,name,author_name,slug,language_name,translated_name{name,language_name}; Clear Quran (131) is not in the list — curl https://api.quran.com/api/v4/resources/translations -> research/translations-tafsir/translations_list.json
- [V] api.quran.com is served as a legacy origin: response header x-qf-origin: qf-nonfaceing-data-legacy-api-quran; Cache-Control public max-age=604800 (list) / 691200 (dump); access-control-allow-origin: * — curl -sI ... -> headers_resources_translations.txt, headers_quran_translations_20.txt
- [V] GET /api/v4/quran/translations/131 (The Clear Quran) returns {"translations":[],...} on both api.quran.com and api.qurancdn.com/api/qdc — curl https://api.quran.com/api/v4/quran/translations/131 and https://api.qurancdn.com/api/qdc/quran/translations/131?chapter_number=1
- [V] QF updates page states the Clear Quran Translation and the Russian word-for-word translation were removed at the copyright holders' request — WebFetch https://api-docs.quran.foundation/docs/updates
- [V] QUL describes Furqaan Institute of Quranic Education as holding the exclusive license to publish and distribute The Clear Quran series — curl https://qul.tarteel.ai/resources/translation/426 (copyright notice text)
- [V] GET /api/v4/quran/translations/{id}?fields=verse_key&foot_notes=true returns all 6236 verses as {resource_id,verse_key,text,foot_notes{id:html}}; Saheeh (20) = 1,492,722 B raw / 387,842 B gzip; 1,903 footnotes. Without fields= each row has only resource_id+text — curl ...translations/20?fields=verse_key&foot_notes=true; sample quran_translations_20_ch1_fields_footnotes.json
- [V] Footnote markup is <sup foot_note=ID>n</sup> (unquoted) and in Bridges (149) <sup foot_note="ID" class="qiraat">; Bridges also uses <span class="h">, <i class="s">, <a class="sup"><sup>sg</sup></a>; footnote bodies contain <a href="2:255"> verse links — scan of 27 full dumps; sample quran_translations_149_bridges_markup_subset.json
- [V] QC translation 134 (Indonesian, King Fahad Complex) contains malformed nested sup markup at 1:2 — curl .../quran/translations/134?fields=verse_key&foot_notes=true
- [V] GET /api/v4/foot_notes/{id} returns {foot_note:{id,text,language_name}} — footnote_195932.json
- [V] GET /api/v4/resources/tafsirs returns 20 tafsirs incl. 169 Ibn Kathir (Abridged, en), 16 Muyassar (ar), 91 Al-Sa'di (ar), 170 Al-Sa'di (ru), 168 Ma'arif al-Qur'an (en), 14 Ibn Kathir (ar); no Jalalayn — tafsirs_list.json
- [V] /api/v4/quran/tafsirs/{id} returns an empty list regardless of chapter_number/juz_number/verse_key/page_number filters — curl https://api.quran.com/api/v4/quran/tafsirs/169?chapter_number=1 etc.
- [V] /api/v4/tafsirs/{id}/by_chapter/{ch} paginates (default per_page 10); per_page=300 and 1000 were accepted and returned all 286 records of chapter 2; grouped verses after the first have empty text — curl .../tafsirs/169/by_chapter/2?per_page=1000; tafsir_169_by_chapter_1.json
- [V] Total download sizes via 114 by_chapter calls: Ibn Kathir en 169 = 11,761,942 B; Muyassar 16 = 2,628,492 B; Sa'di 91 = 7,564,204 B; Ma'arif 168 = 12,291,889 B; all 200, no throttling at 8 parallel — xargs -P 8 curl loops
- [V] Word-by-word data via /api/v4/verses/by_chapter/{ch}?words=true&language=xx has translation{text,language_name} and transliteration{text,language_name:'english'}; WBW languages: en, ur, bn, tr, id, ta, fa, hi, inh; other languages fall back to English — words_by_chapter_1_en.json, words_by_key_1_2_ur.json, loop over 71 iso codes, word_by_word_translations_list.json
- [V] Whole-Quran English WBW download = 25,401,308 B raw / 2,567,264 B gzip over 114 requests — xargs curl loop with and without Accept-Encoding: gzip
- [V] QF Content API requires OAuth2 client credentials (scope=content), headers x-auth-token and x-client-id; prod https://apis.quran.foundation/content/api/v4; unauthenticated calls return 400 invalid_request — WebFetch api-docs.quran.foundation/docs/quickstart/migration/; curl https://apis.quran.foundation/content/api/v4/resources/translations
- [V] QF docs say a browser or mobile app must not embed a Content API client_secret; token lifetime 3600 s; credentials via dev-console.quran.foundation — WebFetch https://api-docs.quran.foundation/docs/quickstart
- [V] QF Developer Terms (last updated 2026-10-04) forbid caching QF Content longer than 1 week unless obtained via Content Sync; require next sync at least every 7 days; prepackaged bundles not authorized; redistribution needs a commercial license — qf_developer_terms_extracted.txt (from https://api-docs.quran.foundation/legal/developer-terms/)
- [V] Content Sync: GET /resources/sync (bootstrap=true, resources=group:id;..., sync_token, per_page) and GET /resources/snapshots/{group}/{id}; groups quran_core, mushafs, translations, word_by_word_translations, word_by_word_transliterations, tafsirs, recitations, chapter_recitations, articles; tafsir records carry group_verse_key_from/to and start/end_verse_id — qf_content_sync_getting_started_extracted.txt; WebFetch resources-snapshot doc
- [V] QuranEnc list API returns 76 translations with version, last_update and database_url (SQLite zip); english_saheeh v1.1.2 SQLite = 1,245,184 B (zip 518,866 B), schema translations(id,sura,aya,translation,footnotes) — quranenc_translations_list_all.json; quranenc_english_saheeh_sqlite_schema_and_rows.json
- [V] QuranEnc has unlisted but working keys: bengali_zakaria, russian_rwwad, malay_basumayyah, arabic_moyassar (russian_kuliev returns 404) — curl https://quranenc.com/api/v1/translation/sura/{key}/1
- [V] QuranEnc terms allow re-publishing with no modification, attribution to publisher and QuranEnc.com, the version number, the transcript info kept, updates to the latest version, and no inappropriate ads — WebFetch https://quranenc.com/en/home/api/
- [V] Tanzil download URL is https://tanzil.net/trans/?transID={id}&type={txt|txt-2|xml|sql|zekr}; en.sahih last updated April 24, 2011, no footnotes; ar.jalalayn and ar.muyassar are available as per-ayah files — tanzil_trans_page.html JS download_action; tanzil_en.sahih_txt-2_head_tail.txt; tanzil_ar.jalalayn_head_and_trailer.txt
- [V] Tanzil terms: non-commercial only; link back required when using more than three translations; redistributing the list not allowed without permission — text extracted from tanzil_trans_page.html
- [V] fawazahmed0/quran-api: Unlicense, 492 editions, URL https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/{name}[/{ch}[/{v}]].json; edition text strips trailing punctuation; includes eng-mustafakhattaba with no source — fawaz_editions_subset.json, fawaz_eng_ummmuhammad_ch1.json, GitHub API repos/fawazahmed0/quran-api
- [V] spa5k/tafsir_api: MIT, 123 editions, URL {base}/tafsir/{slug}/{surah}.json -> [{surah,ayah,text}]; README recommends pinning an exact tag (latest v1.2.2) because of jsDelivr caching — spa5k_tafsir_editions.json, spa5k_ar-tafsir-muyassar_1.json, README via raw.githubusercontent.com, GitHub tags API
- [V] spa5k ar-tafsir-muyassar 1:1 text differs from Quran.com tafsir 16 at 1:1 (1:2 matches) — spa5k_ar-tafsir-muyassar_1.json vs tafsir_16_by_ayah_1_1.json
- [V] QUL (qul.tarteel.ai) translation downloads (simple/footnote-tags/inline/chunks JSON+SQLite) require sign-in — curl https://qul.tarteel.ai/resources/translation/193; buttons point to /users/sign_in?modal=true
- [V] AlQuran.cloud: /v1/edition?format=text&type=translation lists 118 editions; /v1/quran/en.sahih returns full Quran (1.61 MB) — alqurancloud_editions_translation.json; curl https://api.alquran.cloud/v1/quran/en.sahih
- [V] FTS5 unicode61 remove_diacritics 2 folds Latin diacritics (allah matches Allāh), but neither unicode61 nor trigram folds Arabic harakat or alef variants — fts5_external_content_prototype.js and fts5_arabic_diacritics_test.js run with node:sqlite (SQLite 3.53.1)
- [V] External-content FTS5 schema for Saheeh with footnotes = 2,904,064 B database (vs 4,169,728 B when the text is stored twice) — fts5_external_content_prototype.js run on the full Saheeh dump
- [V] rusqlite 0.40.2 / libsqlite3-sys 0.38.2 are latest; the bundled build enables SQLITE_ENABLE_FTS5; ammonia 4.2.1; dompurify 3.4.16 — crates.io API, raw libsqlite3-sys/build.rs grep, npm view dompurify
- [?] Pickthall (1930) and Yusuf Ali (1934 original) are likely public domain in life+70 jurisdictions; Abdel Haleem is copyright Oxford University Press; Saheeh International is copyrighted by its publisher — From background knowledge; not checked live in this session

## Recommendations
- Ship a self-hosted catalog.json mapping app resource IDs to ordered source lists (QuranEnc > QF Content Sync via proxy > Tanzil > legacy api.quran.com), with size, version, sha256 and attribution; never hard-code upstream IDs in the app.
- Use QuranEnc SQLite (https://quranenc.com/downloads/sqlite/{key}.zip) as the primary source for every translation it covers, and check updates through version/last_update from /api/v1/translations/list.
- For QF-only content (Ibn Kathir 169, Ma'arif 168, Sa'di 91, Muyassar 16, Abdel Haleem 85, Bridges 149, WBW), register in the QF Developer Console and run a small Cloudflare Worker that holds client_id/secret and proxies only /resources/sync and /resources/snapshots/*. The app must re-sync every 7 days or less when online.
- Use Tanzil (https://tanzil.net/trans/?transID={id}&type=txt-2) for Pickthall, Yusuf Ali, Kuliev, Jalandhry, Muhiuddin Khan, ar.jalalayn and ar.muyassar. Download directly from tanzil.net at runtime, keep the app non-commercial, and add a link back to tanzil.net/trans in Credits.
- Keep legacy api.quran.com (/quran/translations/{id}?fields=verse_key&foot_notes=true and /tafsirs/{id}/by_chapter/{ch}?per_page=300) for development and as an emergency fallback only; always loop on pagination.next_page.
- Do not offer The Clear Quran unless a license is obtained from Furqaan Institute or QF. Never use fawazahmed0's eng-mustafakhattaba* or eng-abdelhaleem editions.
- Storage: content.sqlite attached to the core DB with tables resource, translation_text (rowid = resource_id*100000 + ayah_gid), translation_footnote, tafsir_entry(from_gid,to_gid); external-content FTS5 with tokenize='unicode61 remove_diacritics 2'; a separate normalized-Arabic column for tafsir and Arabic search.
- Normalize all footnote markup at import to <sup class="fn" data-fn="ID">n</sup>. Parse QuranEnc [n] markers with \p{Nd} for Bengali and Arabic digits, and strip the '(n) ' prefix. Sanitize with ammonia in Rust using an allowlist, rewrite verse-reference hrefs (2:255, /2:255, 2:255-257) to internal navigation, and render footnotes as popovers plus an optional inline list.
- Model tafsir as ranges: legacy by_chapter rows with empty text belong to the preceding non-empty row; QF snapshot rows give start/end_verse_id directly. Store the range once and map every ayah to it.
- Download pipeline: show the size first, download into a temp DB, validate 6,236 rows (or full range coverage for tafsir), swap atomically, record the source version, and support resume per chapter for tafsir/WBW (8 parallel requests worked without throttling).

## Risks
- api.quran.com is explicitly a legacy origin (x-qf-origin header) and QF has a migration guide; it could start requiring auth or be shut down without notice.
- The QF Developer Terms limit caching QF content to 1 week unless it comes through Content Sync, require a re-sync every 7 days, forbid prepackaged bundles, and require a backend to hold the secret. Whether the terms also bind legacy api.quran.com usage was not confirmed, but they define QF Content as anything returned by the APIs.
- QF production access requires approval in the Developer Console; prelive contains only surahs 1-2.
- Many translations are copyrighted (Clear Quran, likely Abdel Haleem/OUP, Saheeh International). Tanzil is non-commercial only. fawazahmed0 and spa5k redistribute third-party content under code licenses that do not cover that content.
- Data fidelity: fawazahmed0 strips trailing punctuation; spa5k Muyassar 1:1 does not match Quran.com; Tanzil en.sahih (2011) is an older revision than QuranEnc/QF (uses Allah instead of Allāh, has no footnotes).
- Markup is inconsistent and sometimes malformed (QC 134 nested sup); footnote bodies contain HTML and links, so a robust parser or sanitizer is mandatory.
- QuranEnc's list API is incomplete (some working keys are unlisted), so the catalog must be curated by hand.
- The per_page maximum is undocumented (values up to 1000 worked); the API may later enforce the limit of 50.
- WBW is available in only 9 languages and silently falls back to English; transliteration is English only.
- Some resources are large: Urdu Tafheem 12.3 MB, Junagarhi 8.4 MB, Ma'arif 12.3 MB and Ibn Kathir 11.8 MB raw JSON, so the UI must show sizes and support resume.
- SQLite FTS5 does not fold Arabic diacritics or alef forms; without a custom normalization column, Arabic tafsir search will miss matches.
- QUL downloads need a login and their data terms are not stated on the page, so QUL is only suitable for a manual build-time step after checking the terms.
