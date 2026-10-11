# audio-sources

## Recommendation in brief
- **Primary gapless + timing source:** the Quran.com QDC audio API. It lists 14 chapter reciters, and every verse has word-level segments.
  - Timings: `GET https://api.qurancdn.com/api/qdc/audio/reciters/{id}/audio_files?chapter={n}&segments=true`
  - Audio: served from `download.quranicaudio.com` (BunnyCDN). HTTP 206 Range requests work, and `Access-Control-Allow-Origin: *` is set.
- **Secondary source, for reciters QDC lacks (Maher Al-Muaiqly, Saad Al-Ghamdi):** QUL (Tarteel) at `GET https://qul.tarteel.ai/api/v1/audio/surah_segments/{id}?surah={n}&per_page=300`.
  - This endpoint is undocumented; the QUL web UI uses it.
  - Its audio is on `audio-cdn.tarteel.ai` (Cloudflare). Range requests work (206), but no CORS header is sent.
- **Gapped (per-ayah) fallback:** EveryAyah at `https://everyayah.com/data/{folder}/{SSS}{AAA}.mp3`, mirrored at `https://mirrors.quranicaudio.com/everyayah/...`.
  - These are byte-identical to `verses.quran.com/...` and `audio-cdn.tarteel.ai/quran/{slug}/...`.
  - Per-ayah word segments come from `api.quran.com/api/v4/recitations/{id}/by_chapter/{n}?fields=segments&per_page=300`.
- **Golden rule: timings belong to one specific audio file.** The same reciter has different files on `qdc/`, `quran/` and the Tarteel CDN, each with different offsets. For example, Afasy surah 1 is 46.49 s on `qdc/` and 51.9 s on `quran/`. Store `(audio_url, content_length)` together with each timing set and re-check them.

## 1. Quran.com / QDC API (verified live)

| Endpoint | Result | Key fields |
|---|---|---|
| `GET https://api.quran.com/api/v4/resources/recitations?language=en` | 200 | `recitations[{id, reciter_name, style, translated_name{name,language_name}}]`. 12 ids: 1 AbdulBaset Mujawwad, 2 AbdulBaset Murattal, 3 Sudais, 4 Shatri, 5 Rifai, 6 Husary, 7 Afasy, 8 Minshawi Mujawwad, 9 Minshawi Murattal, 10 Shuraym, 11 Tablawi, 12 Husary Muallim |
| `GET /api/v4/resources/chapter_reciters` | **503 Varnish**, on both api.quran.com and api.qurancdn.com, 4 attempts | Use the QDC list below instead |
| `GET https://api.qurancdn.com/api/qdc/audio/reciters?locale=en` (also works on api.quran.com) | 200 | `reciters[{id, reciter_id, name, translated_name, style{name,language_name,description}, qirat{name,language_name}}]`. 14 ids: 97 Dussary, 2, 3, 4, 5, 6, 10, 161 Tunaiji, 1, 7, 9, 12 Husary Muallim, 168 Minshawi kids, 173 Afasy "streaming" |
| `GET https://api.qurancdn.com/api/qdc/audio/reciters/{id}/audio_files?chapter={n}&segments=true` | 200 | `audio_files[{id, chapter_id, file_size(float bytes), format, audio_url, duration(ms, rounded to whole seconds), verse_timings[{verse_key, timestamp_from, timestamp_to, duration, segments[[word_pos(1-based), start_ms, end_ms]]}]}]` |
| Same endpoint without `chapter` | 200 | All 114 files: `{id, chapter_id, file_size, format, audio_url, duration}` |
| `GET https://api.quran.com/api/v4/chapter_recitations/{id}/{n}?segments=true` | 200 | `audio_file{id, chapter_id, file_size, format, audio_url, timestamps[...same verse shape...]}`. The array is named `timestamps`, not `verse_timings` |
| `GET https://api.quran.com/api/v4/recitations/{id}/by_chapter/{n}?per_page=300&fields=segments` | 200 | `audio_files[{verse_key, url, segments[[w_start0, w_end_excl, start_ms, end_ms]], duration(s), format, id}]`, plus `pagination{per_page(default 10), current_page, next_page, total_pages, total_records}` |
| `GET /api/v4/verses/by_chapter/{n}?audio={id}` | 200 | `verses[].audio{url, segments}` |

**URL normalisation for the v4 per-ayah endpoint**
- A relative `url` (for example `Alafasy/mp3/001001.mp3`) gets the prefix `https://verses.quran.com/`. The alternative host `https://audio.qurancdn.com/` serves the same bytes.
- A URL starting with `//` (ids 6, 11 and 12, for example `//mirrors.quranicaudio.com/everyayah/Husary_64kbps/...`) gets the prefix `https:`.

**Data quirks you must sanitise**
- `file_size` is unreliable. Husary chapter 2 reports 2048 but the real file is 95,778,386 bytes; Afasy chapter 1 reports 839,808 but the CDN serves 793,327. Use the HTTP `Content-Length` instead.
- File-level `duration` is rounded to whole seconds.
- Verse `duration` is negative for whole reciters (ids 2, 4, 5, 6 and 8). The official docs say this "may be negative in legacy data".
- There are malformed segments such as `[1]` and `[2]` (Afasy 1:3) and float times (`0.0`, id 8).
- Some word segments start up to 200 ms before the verse's `timestamp_from`.
- Word positions go backwards whenever the reciter repeats words (waqf/ibtida). Maher 2:17 is `[1..9,6..12,10..17]`. **Pick the active word by time, not by word index.**
- Gaps between ayahs are normal for ids 5, 10 and 97 (`timestamp_to` is less than the next `timestamp_from`).
- Sudais (id 3) has a junk row with `chapter_id: null` and `audio_url: null`.
- Shuraym (id 10) uses zero-padded filenames (`001.mp3`).
- Dussary (id 97) URLs contain a double slash (`yasser_ad-dussary//001.mp3`); both forms resolve.
- The QDC reciter id **8** (unlisted) returns `qdc/siddiq_al-minshawi/mujawwad/{nnn}.mp3`, which **404s**.
- QDC also accepts unlisted QuranicAudio qari ids (13 Ghamdi, 159 Maher, 11, 19). These return **ayah-level only** timings (`segments: []`) for the `download.quranicaudio.com/quran/...` files.

**Basmala in gapless files.** The 112:1 timings for ids 7, 2, 6, 9 and 3 start word 1 at 0 ms, and the Afasy surah 112 file is only 13 s long. That strongly suggests the `qdc/` files have no basmala, so the app must play a separate basmala clip for surahs 2–114 except 9. I inferred this from the timings and did not listen to the audio. The `quran/` files on QuranicAudio often do have a pre-roll (isti'adha and/or basmala): Maher 1:1 starts at 7490 ms and Husary 112:1 at 7928 ms.

**Hosts (HEAD and Range checked)**
- `download.quranicaudio.com` (BunnyCDN)
  - `Accept-Ranges: bytes`; a `Range` request returned 206 with `Content-Range: bytes 1000-1999/793327`.
  - `Access-Control-Allow-Origin: *`; `Cache-Control: max-age=25600000`.
  - `download.quranicaudio.org` serves the same bytes. quran_android's `UrlUtil.fallbackUrl` swaps `.com` for `.org`.
- `verses.quran.com`, `audio.qurancdn.com` and `mirrors.quranicaudio.com`: BunnyCDN, Range supported, CORS `*`.
- `audio-cdn.tarteel.ai`: Cloudflare, 206 confirmed, **no** CORS header.

**Official API status.** The current Quran Foundation Content API is `https://apis.quran.foundation/content/api/v4/...`.
- Without the `x-auth-token` and `x-client-id` headers it returns `400 invalid_request`.
- It uses OAuth2 client credentials (`https://oauth2.quran.foundation/oauth2/token`, `scope=content`).
- The docs say a client secret must not be embedded in a browser or mobile app, so a desktop app would need its own backend proxy.
- The legacy hosts `api.quran.com/api/v4` and `api.qurancdn.com/api/qdc` still answer 200 without auth today.

## 2. QuranicAudio.com
- `GET https://quranicaudio.com/api/qaris` returns 177 qaris with fields `{id, name, arabic_name, relative_path, file_formats, section_id, home, description, torrent_filename, torrent_info_hash, torrent_seeders, torrent_leechers}`.
- `GET /api/sections` returns 4 sections: 1 Recitations, 2 Haramain Taraweeh, 3 Non-Hafs, 4 With Translations.
- `GET /api/surahs` returns `{id, ayah, bismillah_pre, revelation_order, revelation_place, pages[2], name{complex,simple,english,arabic}}`.
- `GET /api/qaris/{id}/audio_files/mp3` returns `[{id, qari_id, surah_id, file_name:"001.mp3", extension, stream_count, download_count, format{size, bit_rate, duration(s, as string), ...}, metadata{...}, recitation_id}]`.
- `/api/qaris/{id}` and `/api/qaris/{id}/audio_files` return the HTML SPA, not JSON.
- Surah MP3 template: `https://download.quranicaudio.com/quran/{relative_path}{NNN}.mp3`. Examples: `mishaari_raashid_al_3afaasee/`, `sa3d_al-ghaamidi/complete/`, `maher_almu3aiqly/year1440/`, `yasser_ad-dussary/`.
- QuranicAudio itself has **no timings**.
- Its audio-file ids match QDC ids (911 is Afasy surah 1 in both).

## 3. EveryAyah
- Template: `https://everyayah.com/data/{subfolder}/{SSS}{AAA}.mp3`. The mirror is `https://mirrors.quranicaudio.com/everyayah/{subfolder}/...`, but some folders are missing there: `MaherAlMuaiqly128kbps` and `Nasser_Alqatami_128kbps` both 404.
- Catalog: `https://everyayah.com/data/recitations.js`. It is a JSON object with `ayahCount[114]` plus keys `"1"`..`"79"`, each `{subfolder, name, bitrate}`.
- Folders confirmed with `002255.mp3` returning 200:
  - Alafasy_128kbps
  - Abdul_Basit_Murattal_192kbps
  - Abdul_Basit_Mujawwad_128kbps
  - Husary_128kbps
  - Minshawy_Murattal_128kbps
  - Abdurrahmaan_As-Sudais_192kbps
  - Saood_ash-Shuraym_128kbps
  - MaherAlMuaiqly128kbps
  - Ghamadi_40kbps (the only bitrate available for Ghamdi)
  - Abu_Bakr_Ash-Shaatree_128kbps
  - Yasser_Ad-Dussary_128kbps
  - Hani_Rifai_192kbps
  - Muhammad_Jibreel_128kbps
  - Nasser_Alqatami_128kbps
  - Minshawy_Mujawwad_192kbps
  - Husary_Muallim_128kbps
  - khalefa_al_tunaiji_64kbps
- `https://everyayah.com/data/timings_files/` holds old split-point zips. They are (C) VerseByVerseQuran.com, require a link-back, and the disclaimer warns they are not 100% accurate. Do not use them.

## 4. quran_android (GPL-3.0, HEAD 1883553 on 2026-10-07, 3.6.4-p2)
- **Model:** `Qari(id, nameResource, url, opusUrl, path, hasGaplessAlternative, db)`. A qari is gapless when `db != null`.
  - Gapless URL: `url + "%03d.mp3"`. Gapped URL: `url + "%03d%03d.mp3"`.
- **Timing DB location:** `MadaniPageProvider.getAudioDatabasesBaseUrl()` gives `https://android.quran.com/data/databases/audio/{db}.zip`. That 301-redirects to `https://files.quran.app/hafs/databases/audio/{db}.zip`, and the zip contains `{db}.db`.
- **Schema (`SuraTimingDatabaseHandler`):**
  - `timings(sura INT, ayah INT, time INT ms [, words TEXT when schema_version >= 2])`
  - `properties(property, value)` with keys `version`, `schema_version` and `wbw`
  - `ayah=0` is the start of the pre-roll (basmala/isti'adha); `ayah=999` is the end of the surah.
  - `words` is formatted `"pos:startMs:endMs,..."` with 1-based positions.
- **DBs inspected:**
  - `minshawi_murattal`: version 4, schema 2, wbw=1, 6359 rows.
  - `husary`: version 4, 6354 rows, no words.
  - `mishari_alafasy`: version 6, no words.
  - Their timings match the QuranicAudio `quran/` files, not the `qdc/` files. Husary's 2:999 is 11,956,190 ms against a file length of 11,957.35 s.
- **More DBs** that exist by probing (206 response): `shuraym`, `sudais_murattal`, `shatri`, `hani_rifai`, `minshawi_mujawwad`, `qatami`, `husary_muallim`. Which audio files they pair with is unverified, because the full qari list is not in the open-source repo; only 3 qaris ship there.
- **Update manifest:** `https://quran.app/data/audio_updates.php?revision=N` returns `{current_revision: 40, updates[{path, database_version, files[{filename, md5}]}]}` with 72 sets. It shows that QuranicAudio files get patched over time.
- **Playback logic:**
  - Seek to `timings[ayah]`, or to `timings[0]` when starting at ayah 1.
  - Poll the player position to detect ayah changes, with a 150 ms hysteresis.
  - When `999` is passed, move to the next surah.
  - The current word is `indexOfLast(start <= pos)`. The next check is scheduled at the next word's start divided by playback speed, clamped to 50–10000 ms.
  - In gapped mode, the basmala (`001001`) plays before ayah 1 of every surah except 1 and 9.

## 5. Curated reciters (gapless = timing source plus file; gapped = fallback)

| Reciter | Best gapless + timing | Audio template (`{n}` = 1..114, `{nnn}` = zero-padded) | Words | Gapped fallback |
|---|---|---|---|---|
| Mishary Alafasy | QDC 7 | `download.quranicaudio.com/qdc/mishari_al_afasy/murattal/{n}.mp3` | yes | EveryAyah `Alafasy_128kbps`; v4 id 7 |
| Abdul Basit (Murattal) | QDC 2 | `.../qdc/abdul_baset/murattal/{n}.mp3` | yes | `Abdul_Basit_Murattal_192kbps`; v4 id 2 |
| Abdul Basit (Mujawwad) | QDC 1 | `.../qdc/abdul_baset/mujawwad/{n}.mp3` | yes | `Abdul_Basit_Mujawwad_128kbps`; v4 id 1 |
| Al-Husary | QDC 6 | `.../qdc/khalil_al_husary/murattal/{n}.mp3` | yes | `Husary_128kbps`; v4 id 6 |
| Al-Minshawi (Murattal) | QDC 9 | `.../qdc/siddiq_minshawi/murattal/{n}.mp3` | yes | `Minshawy_Murattal_128kbps`; v4 id 9 |
| As-Sudais | QDC 3 | `.../qdc/abdurrahmaan_as_sudais/murattal/{n}.mp3` | yes | `Abdurrahmaan_As-Sudais_192kbps`; v4 id 3 |
| Ash-Shuraim | QDC 10 | `.../qdc/saud_ash-shuraym/murattal/{nnn}.mp3` | yes | `Saood_ash-Shuraym_128kbps`; v4 id 10 |
| Maher Al-Muaiqly | QUL surah 65 | `audio-cdn.tarteel.ai/quran/surah/maherAlMuaiqly/murattal/mp3/{nnn}.mp3`. Alternative: QUL 159 with `download.quranicaudio.com/quran/maher_almu3aiqly/year1440/{nnn}.mp3` | yes | `MaherAlMuaiqly128kbps` (everyayah.com only) |
| Saad Al-Ghamdi | QUL surah 13 | `audio-cdn.tarteel.ai/quran/surah/ghamadi/murattal/mp3/{nnn}.mp3`. Alternative: QDC 13, ayah-level only, with `.../quran/sa3d_al-ghaamidi/complete/{nnn}.mp3` | yes | `Ghamadi_40kbps` |
| Abu Bakr Ash-Shaatree | QDC 4 | `.../qdc/abu_bakr_shatri/murattal/{n}.mp3` | yes | `Abu_Bakr_Ash-Shaatree_128kbps`; v4 id 4 |
| Yasser Ad-Dussary | QDC 97 | `.../quran/yasser_ad-dussary/{nnn}.mp3`. Alternative: QUL 174 on the Tarteel CDN | yes | `Yasser_Ad-Dussary_128kbps` |
| Hani Ar-Rifai | QDC 5 | `.../qdc/hani_ar_rifai/murattal/{n}.mp3` | yes | `Hani_Rifai_192kbps`; v4 id 5 |

- All gapless templates in the table were checked with HEAD on chapters 1 and 114.
- Extras:
  - Minshawi Mujawwad: QUL 8, `audio-cdn.tarteel.ai/quran/surah/minshawy/mujawwad/mp3/{nnn}.mp3`.
  - Husary Muallim: QDC 12.
  - Khalifa Al-Tunaiji: QDC 161.
- QUL's Hani Rifai surah URLs (id 5) all **404**.
- Full-Quran download sizes estimated from QDC `file_size` sums: Afasy about 1.7 GB / 29.5 h, Abdul Basit Mujawwad about 3.5 GB / 58.6 h, Shuraim about 1.05 GB.
- The audio formats are mixed: MPEG-1 44.1 kHz CBR 128k, MPEG-2 22.05 kHz 64k (Husary `qdc/` chapter 1), and Xing VBR (Afasy `qdc/` chapter 1).

## 6. QUL (Tarteel) details
- Resource pages `https://qul.tarteel.ai/resources/recitation/{resId}` carry a `data-recitation` attribute with the API id. Surah ids and ayah ids are **separate namespaces**.
- Surah ids found: 7 Afasy, 2, 1, 6, 9, 8, 3, 4, 10, 13 Ghamdi, 65 and 159 Maher, 174 and 97 Dussary, 169 Jibreel (ayah-level only), 104 Qatami (ayah-level only), 12, 161, 164 Husary Mujawwad.
- Ayah endpoint: `GET /api/v1/audio/ayah_segments/{id}?surah={n}&per_page=..&page=..` returns `{segments:{'s:a':{audio_url, segments[[w0, w1_excl, start_ms, end_ms]]}}}`.
  - Ayah ids: 13 Maher, 19 Ghamdi, 18 Afasy, 26 Dussary, 24 Minshawi, 25 Shuraim, 15 and 14 Abdul Basit, 16 Sudais, 17 Shatri.
  - Sudais id 3 returns **string-typed** numbers.
  - The QUL docs describe 3-element segments, but the ayah endpoint returns 4-element arrays.
- QUL's official JSON/SQLite downloads require signing in to an account.

## 7. Licensing and terms
- **QuranicAudio** (about page): MP3s are free for personal use, and commercial use is not allowed because many files come from publishers. It does not grant redistribution rights.
- **Quran Foundation Developer Terms** (last updated 2026-10-04):
  - QF Content (which includes audio) may be displayed inside an app but must not be sold, sublicensed or redistributed.
  - It must not be cached for **more than 1 week** unless it comes through the Content Sync APIs. The `recitations` and `chapter_recitations` sync groups include audio files and timing segments, and require a re-sync at least every 7 days.
  - A prepackaged or bundled database of QF Content is **not** allowed; fonts and Mushaf images are the exception.
  - The terms say "Recitation metadata and audio URLs are distinct from the underlying recordings".
  - The apps must provide a privacy policy and terms of use.
- **QUL FAQ:** commercial use is allowed, subject to each resource's license, which varies; some resources need attribution.
- **EveryAyah timings:** VerseByVerseQuran.com, link-back required.
- **quran_android** is GPL-3.0. Use its schema and algorithm as reference only and do not copy code. Its timing DBs carry no stated license.

## Facts
- [V] GET https://api.quran.com/api/v4/resources/recitations?language=en returns 12 ayah recitations (ids 1-12) with fields id, reciter_name, style, translated_name{name,language_name} — curl; saved recitations_v4.json
- [V] GET /api/v4/resources/chapter_reciters returns HTTP 503 (Varnish) on both api.quran.com and api.qurancdn.com; QDC equivalent https://api.qurancdn.com/api/qdc/audio/reciters?locale=en returns 14 reciters (97,2,3,4,5,6,10,161,1,7,9,12,168,173) — curl x4 (503); saved qdc_audio_reciters.json
- [V] QDC audio_files?chapter=N&segments=true returns audio_files[{id,chapter_id,file_size,format,audio_url,duration(ms),verse_timings[{verse_key,timestamp_from,timestamp_to,duration,segments[[word_pos,start_ms,end_ms]]}]}] — curl https://api.qurancdn.com/api/qdc/audio/reciters/7/audio_files?chapter=1&segments=true; saved qdc_audio_files_7_ch1_segments.json, qdc_audio_files_7_ch2_segments.json
- [V] v4 /api/v4/chapter_recitations/{id}/{ch}?segments=true returns audio_file with 'timestamps' array (same per-verse shape); /api/v4/chapter_recitations/{id} lists 114 files — curl; saved chapter_recitations_7_1_segments.json, chapter_recitations_7_all.json
- [V] v4 /api/v4/recitations/{id}/by_chapter/{ch}?fields=segments returns per-ayah url (relative to verses.quran.com or protocol-relative //mirrors.quranicaudio.com) and segments as 4-tuples [w_start0,w_end_excl,start_ms,end_ms]; per_page=300 accepted — curl; saved v4_recitations_7_by_chapter_1_fields_segments.json, v4_verses_by_chapter_1_audio7.json
- [V] download.quranicaudio.com supports HTTP Range (206 + Content-Range), Accept-Ranges: bytes, Access-Control-Allow-Origin: *, served by BunnyCDN; download.quranicaudio.org mirrors identical bytes — curl -I and Range request; saved range_headers_quranicaudio_afasy1.txt
- [V] verses.quran.com, audio.qurancdn.com, everyayah.com/data, mirrors.quranicaudio.com/everyayah and audio-cdn.tarteel.ai/quran/{slug}/ serve byte-identical per-ayah files (same Content-Length) with Accept-Ranges: bytes — curl -I on 001001.mp3 and 002255.mp3 across hosts
- [V] audio-cdn.tarteel.ai supports Range (206) but sends no Access-Control-Allow-Origin header — curl -I and Range request on ghamadi/murattal/mp3/001.mp3
- [V] QDC file_size is unreliable (Husary ch2 API=2048 vs real 95,778,386; Afasy ch1 API=839,808 vs real 793,327) — QDC API vs curl -I Content-Length
- [V] QDC timings contain malformed segments ([1],[2]), negative verse durations (ids 2,4,5,6,8), word positions that go backwards on repeats, and a null chapter row for id 3 — node validation script over QDC ch2 for 13 ids; Sudais listing
- [V] QDC reciter id 8 (Minshawi Mujawwad, unlisted) returns audio_url qdc/siddiq_al-minshawi/mujawwad/{nnn}.mp3 which 404s; QUL id 8 Tarteel URLs work — curl -I on ch1 and ch114
- [V] QDC accepts unlisted QuranicAudio qari ids (13 Ghamdi, 159 Maher, 11, 19) and returns ayah-level timings with empty segments for download.quranicaudio.com/quran/... files — curl; saved qdc_audio_files_13_ghamdi_ch1_ayah_level.json
- [?] QDC qdc/ chapter files contain no basmala before ayah 1 (112:1 word 1 starts at 0 ms for ids 7,2,6,9,3) — inferred from timing data only; audio not listened to
- [V] QuranicAudio API: /api/qaris (177 qaris; fields id,name,arabic_name,relative_path,file_formats,section_id,home,description,torrent_*), /api/sections, /api/surahs, /api/qaris/{id}/audio_files/mp3; surah URL template https://download.quranicaudio.com/quran/{relative_path}{NNN}.mp3 — curl; saved quranicaudio_api_qaris.json, quranicaudio_api_qari5_audio_files_mp3.json
- [V] EveryAyah catalog https://everyayah.com/data/recitations.js is JSON with ayahCount[114] and 79 entries {subfolder,name,bitrate}; per-ayah template https://everyayah.com/data/{subfolder}/{SSS}{AAA}.mp3 — curl; saved everyayah_recitations.js, everyayah_data_dir_listing.html
- [V] MaherAlMuaiqly128kbps and Nasser_Alqatami_128kbps are missing on mirrors.quranicaudio.com/everyayah (404) but present on everyayah.com — curl -I 002255.mp3
- [V] quran_android timing DB URL: https://android.quran.com/data/databases/audio/{db}.zip which 301-redirects to https://files.quran.app/hafs/databases/audio/{db}.zip; schema timings(sura,ayah,time[,words]) + properties(property,value); ayah 0 = pre-roll, ayah 999 = end of surah; words='pos:start:end,...' — git clone quran_android (MadaniPageProvider.kt, AudioPresenter.kt, SuraTimingDatabaseHandler.kt, TimingRepository.kt, AudioService.kt) plus sqlite3 on downloaded DBs; saved quran_android_timingdb_*_schema_and_sample.txt
- [V] quran_android DBs minshawi_murattal (v4, schema 2, wbw), husary (v4), mishari_alafasy (v6), shuraym exist; sudais_murattal, shatri, hani_rifai, minshawi_mujawwad, qatami, husary_muallim also exist (206); their audio pairing is unverified — curl -I/-r 0-0 on files.quran.app
- [V] quran_android timing DBs match download.quranicaudio.com/quran/... files (Husary 2:999=11,956,190 ms vs file 11,957.35 s; Afasy 2:999=7,540,402 ms vs 7,554.9 s), not the qdc/ files — sqlite3 query vs quranicaudio /api/qaris/{id}/audio_files/mp3 durations
- [V] quran_android audio update manifest https://quran.app/data/audio_updates.php?revision=0 returns {current_revision:40, updates[{path,database_version,files[{filename,md5}]}]} with 72 sets — curl; saved quran_app_audio_updates_rev40.json
- [V] QUL undocumented API: /api/v1/audio/surah_segments/{id}?surah=N&per_page=M returns {audio{url,duration,audio_size},segments{'s:a':{time_from,time_to,duration,segments[[pos,start,end]]}}}; /api/v1/audio/ayah_segments/{id} returns 4-tuple segments (Sudais id 3 uses strings) — found in the QUL JS bundle and called with curl; saved qul_surah_segments_159_maher_s1.json, qul_surah_segments_13_ghamdi_s1.json, qul_ayah_segments_19_ghamdi_s1.json, qul_ayah_segments_3_sudais_s1_string_typed.json
- [V] QUL Hani Rifai surah audio (id 5) points to audio-cdn.tarteel.ai/quran/surah/haniarRifai/murattal/mp3/{nnn}.mp3 which 404s — curl -I on 001, 002, 003, 050, 114
- [V] QUL official JSON/SQLite downloads require account sign-in — resource page 405 HTML: download buttons point to /users/sign_in modal
- [V] Quran Foundation Content API (apis.quran.foundation/content/api/v4) requires OAuth2 client credentials; unauthenticated call returns 400 invalid_request; client_secret must not be embedded in browser or mobile apps — curl; api-docs.quran.foundation/docs/quickstart/
- [V] QF Developer Terms (updated 2026-10-04): QF Content including audio must not be redistributed and must not be cached longer than 1 week unless via Content Sync (re-sync at least every 7 days); prepackaged bundles are not allowed except fonts and Mushaf images — https://api-docs.quran.foundation/legal/developer-terms/ and /docs/tutorials/content-sync/getting-started/
- [V] QuranicAudio.com about page: MP3s are free for personal use; commercial use is prohibited — https://quranicaudio.com/about
- [V] QUL FAQ: commercial use is allowed subject to each resource's license; some resources need attribution — https://qul.tarteel.ai/faq
- [V] EveryAyah timings_files are (C) VerseByVerseQuran.com, require a link-back, and are not 100% accurate — saved everyayah_timings_disclaimer.txt
- [?] Tarteel general terms of service and any audio-CDN usage terms — https://www.tarteel.ai/terms is rendered by JavaScript; curl got no readable text

## Recommendations
- Use the QDC API as the primary gapless + word-timing source for Afasy(7), AbdulBaset Murattal(2)/Mujawwad(1), Husary(6), Minshawi(9), Sudais(3), Shuraim(10), Shatri(4), Dussary(97), Rifai(5), Husary Muallim(12) and Tunaiji(161). Use QUL surah ids 65 (Maher) and 13 (Ghamdi) for the reciters QDC does not cover with word timings.
- Model a timing set as {reciter_key, audio_url, expected_content_length, source, fetched_at, verses[{ayah, from_ms, to_ms, words[[pos, start, end]]}]} and never reuse timings across different files of the same reciter (qdc/ vs quran/ vs Tarteel CDN differ).
- Write a build-time catalog generator (Rust or Node script) that, for each reciter, pulls all 114 audio_url values plus timings, HEAD-checks every URL (records Content-Length and Last-Modified), drops rows with null chapter_id, and fails on 404s. Ship only the small catalog (URLs, sizes, durations) if legal review allows; otherwise fetch timings at runtime.
- Sanitise timings on ingest: drop segments whose length is not 3, coerce strings and floats to integers, take abs() of or recompute negative durations, clamp word segments to the ayah range, sort segments by start time, and find the active word by time (binary search) rather than by index, because repeats make positions go backwards.
- Handle basmala explicitly: treat [0, first ayah timestamp_from) as pre-roll. For qdc/ files, which have no basmala (inferred), play the same reciter's EveryAyah 001001.mp3 before surahs 2-114 except 9. In gapped mode, always play 001001 before ayah 1 except for surahs 1 and 9.
- Play audio from Rust (symphonia decode + cpal/rodio output) and derive position from decoded sample count. That keeps highlight sync and seeking accurate on VBR/Xing and MPEG-2 22.05 kHz files, avoids differing behaviour across WebView2, WKWebView and WebKitGTK, and sidesteps the missing CORS header on audio-cdn.tarteel.ai. Stream with HTTP Range requests (supported by all hosts) and cache to disk for offline use.
- Use host fallback chains: download.quranicaudio.com -> download.quranicaudio.org; everyayah.com/data -> mirrors.quranicaudio.com/everyayah -> verses.quran.com (where a v4 path exists) -> audio-cdn.tarteel.ai/quran/{slug}.
- Port quran_android's sync behaviour, not its code (it is GPL-3.0): a 150 ms hysteresis before changing ayah, an end-of-surah sentinel, and scheduling the next word update at (next word start - position) / speed, clamped to 50-10000 ms.
- Get a legal and product decision before shipping: register a Quran Foundation developer app (OAuth client credentials behind a small backend proxy) or rely on the legacy unauthenticated endpoints. If using QF data offline, implement Content Sync with a 7-day refresh and do not bundle QF timing data in the installer.
- Show an attribution/credits screen (Quran Foundation, QuranicAudio, EveryAyah, QUL/Tarteel), and keep downloaded audio inside the app's private storage with no export or share-file feature, so the app does not redistribute files.

## Risks
- Licensing: QuranicAudio says its MP3s are free for personal use but not commercial use, and many recordings are publisher-owned. Quran Foundation terms forbid redistribution and caching beyond 7 days except via Content Sync. A free, non-commercial app streaming and caching per user is the lowest-risk model, but none of these sources grants explicit redistribution rights for the recordings.
- Legacy unauthenticated endpoints (api.quran.com/api/v4, api.qurancdn.com/api/qdc) work today, but the official API now requires OAuth and the docs warn of deprecations (typically 30 days' notice). /resources/chapter_reciters is already returning 503.
- The QUL /api/v1/audio/* endpoints are undocumented internal UI endpoints and may change or be rate-limited without notice. QUL's official downloads require an account.
- Data quality: QDC and QUL timings include malformed and negative values, repeated word positions and broken audio URLs (QDC id 8, QUL id 5). Every catalog entry needs automated validation.
- Upstream files change: quran_android's audio_updates manifest shows QuranicAudio files being replaced (md5 changes), which silently invalidates any timing set paired with the old file. Detect this with Content-Length/ETag checks.
- Seek accuracy: mixed CBR/VBR (Xing) MP3s and MPEG-2 22.05 kHz files can make byte-based seeking in some webview media stacks drift by hundreds of milliseconds, which visibly breaks word highlighting.
- Storage: full-Quran gapless sets are about 1-3.5 GB per reciter (Afasy about 1.7 GB, Abdul Basit Mujawwad about 3.5 GB), so downloads need to be per surah and on demand, with disk-usage management.
- The audio pairing of quran_android timing DBs other than husary, minshawi_murattal and mishari_alafasy was inferred from naming and the update manifest, not verified.
