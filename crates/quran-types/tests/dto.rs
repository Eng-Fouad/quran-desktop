//! Contract tests for every DTO: serde round trips, the naming conventions on the wire, JSON shape
//! snapshots for the tagged enums, every unit-enum string, and the pure helpers.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fmt::Debug;

use quran_types::*;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

// ---------------------------------------------------------------------------------------------------------- helpers

fn is_camel_case(key: &str) -> bool {
    let mut chars = key.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase()) && chars.all(|c| c.is_ascii_alphanumeric())
}

fn is_snake_case(tag: &str) -> bool {
    let mut chars = tag.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Every object key on the wire is camelCase, every `type`/`kind` tag is snake_case, and no number is a float.
fn assert_wire_conventions(path: &str, v: &Value) {
    match v {
        Value::Object(map) => {
            for (k, child) in map {
                assert!(is_camel_case(k), "{path}: key `{k}` is not camelCase");
                if k == "type" || k == "kind" {
                    let tag = child.as_str().unwrap_or_default();
                    assert!(
                        is_snake_case(tag),
                        "{path}.{k}: tag `{tag}` is not snake_case"
                    );
                }
                assert_wire_conventions(&format!("{path}.{k}"), child);
            }
        }
        Value::Array(items) => {
            for (i, child) in items.iter().enumerate() {
                assert_wire_conventions(&format!("{path}[{i}]"), child);
            }
        }
        Value::Number(n) => assert!(n.is_u64() || n.is_i64(), "{path}: {n} is not an integer"),
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
}

/// Serialises, checks the wire conventions, deserialises and compares. Returns the JSON for shape assertions.
fn roundtrip<T: Serialize + DeserializeOwned + PartialEq + Debug>(value: &T) -> Value {
    let json = serde_json::to_value(value).unwrap();
    assert_wire_conventions(std::any::type_name::<T>(), &json);
    let back: T = serde_json::from_value(json.clone()).unwrap();
    assert_eq!(&back, value, "round trip changed the value");
    let text = serde_json::to_string(value).unwrap();
    let back: T = serde_json::from_str(&text).unwrap();
    assert_eq!(&back, value, "string round trip changed the value");
    json
}

/// Asserts the exact wire string of every listed unit-enum variant, both directions.
macro_rules! assert_unit_strings {
    ($($value:expr => $s:literal),+ $(,)?) => {{
        $(
            assert_eq!(serde_json::to_value($value).unwrap(), json!($s), "{:?}", $value);
            assert_eq!(serde_json::from_value::<_>(json!($s)).ok(), Some($value), "{}", $s);
        )+
    }};
}

fn s(v: &str) -> String {
    v.to_owned()
}

fn l10n() -> L10nText {
    L10nText {
        en: s("Mishary Alafasy"),
        ar: s("مشاري العفاسي"),
    }
}

fn ayah_ref(surah: u32, ayah: u32) -> AyahRef {
    AyahRef { surah, ayah }
}

// ------------------------------------------------------------------------------------------------- samples per module

fn sample_app_info() -> AppInfo {
    AppInfo {
        name: s("Quran"),
        version: s("0.1.0"),
        identifier: s("com.quran.labs.desktop"),
        platform: Platform::Windows,
        arch: s("x86_64"),
        os_version: s("10.0.26200"),
        os_locale: Some(s("ar-SA")),
        webview_version: s("141.0.3537.71"),
        data_dir: s("C:\\Users\\u\\AppData\\Local\\com.quran.labs.desktop"),
        log_dir: s("C:\\Users\\u\\AppData\\Local\\com.quran.labs.desktop\\logs"),
        protocol_base: s("http://quran.localhost/"),
        font_transport: FontTransport::Url,
        debug: true,
        test_mode: false,
        core: CoreDbInfo {
            schema_version: 1,
            normalizer_version: 1,
            source: s("qdc"),
            built_at: s("2026-10-10"),
        },
    }
}

fn sample_index() -> QuranIndex {
    QuranIndex {
        surahs: vec![SurahInfo {
            id: 1,
            name_ar: s("الفاتحة"),
            name_simple: s("Al-Fatihah"),
            name_complex: s("Al-Fātiĥah"),
            name_en: s("The Opener"),
            revelation_place: RevelationPlace::Makkah,
            revelation_order: 5,
            ayah_count: 7,
            first_ayah_id: 1,
            bismillah_pre: false,
            header_cp: Some(0xFC45),
        }],
        juz: vec![Division {
            id: 1,
            first_ayah_id: 1,
            last_ayah_id: 148,
        }],
        hizb: vec![Division {
            id: 1,
            first_ayah_id: 1,
            last_ayah_id: 74,
        }],
        rub: vec![Division {
            id: 1,
            first_ayah_id: 1,
            last_ayah_id: 32,
        }],
        manzil: vec![Division {
            id: 1,
            first_ayah_id: 1,
            last_ayah_id: 669,
        }],
        sajdas: vec![SajdaInfo {
            id: 1,
            ayah_id: 1160,
            kind: SajdaKind::Recommended,
        }],
        layouts: vec![LayoutInfo {
            layout: MushafLayout::V2,
            pages: 604,
            lines_per_page: 15,
            page_first_ayah: vec![1, 8],
            page_first_word: vec![1, 30],
        }],
        ayah_first_word: vec![1, 5, 10],
    }
}

fn sample_snapshot() -> AudioSnapshot {
    AudioSnapshot {
        status: PlaybackStatus::Playing,
        reciter_id: Some(7),
        current: Some(ayah_ref(2, 0)),
        current_ayah_id: None,
        range: Some(AyahRange {
            from: ayah_ref(2, 1),
            to: ayah_ref(2, 5),
        }),
        ayah_repeat: 3,
        ayah_repeat_left: 2,
        range_repeat: 0,
        range_repeat_left: 0,
        gap: GapSetting::Multiplier { pct: 100 },
        ab_loop: Some(AbLoop {
            a_ms: 1000,
            b_ms: 4000,
        }),
        speed_pct: 125,
        volume_pct: 80,
        file_ms: 12_345,
        file_duration_ms: 9_000_000,
        ayah_from_ms: 12_000,
        ayah_to_ms: 15_500,
        buffered_pct: 42,
        device: Some(s("Speakers (Realtek(R) Audio)")),
        basmala_skipped: false,
        error: Some(AppError::Audio(s("device lost"))),
    }
}

fn sample_pack_info() -> PackInfo {
    PackInfo {
        id: s("tr.en.saheeh"),
        kind: PackKind::Translation,
        title: L10nText {
            en: s("Saheeh International"),
            ar: s("صحيح الدولية"),
        },
        description: L10nText {
            en: s("English translation"),
            ar: s("ترجمة إنجليزية"),
        },
        language: Some(s("en")),
        direction: Some(TextDir::Ltr),
        version: s("1.1.0"),
        install_mode: InstallMode::Whole,
        requires: vec![s("decor")],
        size_kib: 1200,
        item_count: 1,
        recommended: true,
        revalidate_days: None,
        attribution: Attribution {
            text: L10nText {
                en: s("QuranEnc"),
                ar: s("موسوعة القرآن الكريم"),
            },
            url: s("https://quranenc.com"),
            licence: s("CC BY-NC-ND 4.0"),
        },
        state: PackState::UpdateAvailable {
            installed: s("1.0.0"),
            latest: s("1.1.0"),
        },
        installed_kib: 1100,
        job: Some(JobSnapshot {
            job_id: 3,
            pack_id: s("tr.en.saheeh"),
            phase: JobPhase::Downloading,
            received_kib: 600,
            total_kib: 1200,
            items_done: 0,
            items_total: 1,
            rate_kib_s: 2048,
            eta_s: Some(1),
            error: None,
        }),
    }
}

fn sample_bookmark() -> Bookmark {
    Bookmark {
        id: s("0192f3a0-7c1e-7cc0-8a51-3c6f1f0b7a11"),
        kind: BookmarkKind::Ayah,
        ayah_id: 262,
        surah: 2,
        ayah: 255,
        layout: Some(MushafLayout::V2),
        page: Some(42),
        label: Some(s("Ayat al-Kursi")),
        collection_ids: vec![s("c1")],
        tag_ids: vec![s("t1"), s("t2")],
        created_at: 1_760_000_000,
        updated_at: 1_760_000_100,
    }
}

// ---------------------------------------------------------------------------------------------------- round trips

#[test]
fn ids_and_meta_round_trip() {
    roundtrip(&ayah_ref(1, 1));
    roundtrip(&l10n());
    roundtrip(&sample_app_info());
    roundtrip(&StartupNotice::UserDbRecovered {
        quarantined_file: s("user.db.corrupt-1760000000000"),
    });
    roundtrip(&StartupNotice::ContentDbRecovered);
    roundtrip(&sample_index());
    roundtrip(&Bootstrap {
        app: sample_app_info(),
        index: sample_index(),
        settings: Settings::default(),
        first_run: true,
        positions: vec![ReadingPosition {
            context: PositionContext::Mushaf,
            layout: Some(MushafLayout::V2),
            page: Some(297),
            ayah_id: 2_000,
            scroll_px: None,
            updated_at: 1_760_000_000,
        }],
        reading_bookmark: Some(ReadingBookmark {
            ayah_id: 2_000,
            layout: MushafLayout::V1,
            page: 297,
            updated_at: 1_760_000_000,
        }),
        packs: vec![PackSummary {
            id: s("mushaf.v2"),
            kind: PackKind::MushafFonts,
            title: l10n(),
            language: None,
            state: PackState::Partial {
                items_present: 3,
                items_total: 604,
            },
        }],
        reciters: vec![ReciterInfo {
            id: 7,
            pack_id: s("audio.7"),
            name: l10n(),
            style: Some(L10nText {
                en: s("Murattal"),
                ar: s("مرتل"),
            }),
            word_level: true,
            size_kib: 1_000_000,
            downloaded_surahs: 3,
            cached_surahs: 10,
        }],
        decor: DecorStatus {
            installed: true,
            surah_header_url: Some(s(
                "http://quran.localhost/decor/qcf-surah-header.woff2?v=0a1b2c3d",
            )),
            quran_common_url: None,
            sura_names_url: None,
        },
        audio: sample_snapshot(),
        online: true,
        notices: vec![StartupNotice::ContentDbRecovered],
    });
}

#[test]
fn mushaf_and_text_round_trip() {
    let word = PageWord {
        id: 1,
        ayah_id: 1,
        surah: 1,
        ayah: 1,
        position: 1,
        is_end: false,
        glyph: s("\u{FC41}"),
        text: s("بِسْمِ"),
    };
    roundtrip(&PageData {
        layout: MushafLayout::V4,
        style: MushafStyle::QcfV4,
        page: 1,
        lines: vec![
            PageLine {
                line: 1,
                kind: LineKind::SurahName,
                centered: true,
                surah: Some(1),
                words: vec![],
            },
            PageLine {
                line: 2,
                kind: LineKind::Ayah,
                centered: true,
                surah: None,
                words: vec![word],
            },
        ],
        ayahs: vec![PageAyah {
            id: 1,
            surah: 1,
            ayah: 1,
            juz: 1,
            hizb: 1,
            rub: 1,
            sajda: Some(SajdaKind::Obligatory),
            flags: 0b11,
            first_word_id: 1,
            last_word_id: 5,
            starts_on_page: true,
            ends_on_page: true,
            line: 2,
        }],
        info: PageInfo {
            first_ayah_id: 1,
            last_ayah_id: 7,
            juz: 1,
            hizb: 1,
            head_surah: 1,
            surah_ids: vec![1],
        },
    });
    roundtrip(&PageFontStatus {
        style: MushafStyle::QcfV2,
        page: 262,
        availability: FontAvailability::Ready,
        family: s("qcf-v2-p262"),
        url: Some(s("http://quran.localhost/mushaf/v2/p262.woff2?v=deadbeef")),
        rel: Some(s("mushaf/v2/p262.woff2")),
        bytes: 31_000,
    });
    roundtrip(&AyahText {
        id: 262,
        surah: 2,
        ayah: 255,
        juz: 3,
        hizb: 5,
        rub: 17,
        sajda: None,
        flags: 0,
        page: 42,
        text_hafs: s("ٱللَّهُ لَآ إِلَٰهَ إِلَّا هُوَ"),
    });
    roundtrip(&CopyOptions {
        include_reference: true,
        reference_style: ReferenceStyle::Arabic,
        ayah_numbers: false,
        translation_pack_id: Some(s("tr.en.saheeh")),
    });
}

#[test]
fn search_and_content_round_trip() {
    let hit = SearchHit {
        ayah_id: 1,
        surah: 1,
        ayah: 1,
        page: 1,
        first_word_id: 1,
        words: vec![s("بِسْمِ"), s("ٱللَّهِ"), s("ٱلرَّحْمَٰنِ"), s("ٱلرَّحِيمِ"), s("١")],
        matched_word_ids: vec![3],
        snippet: None,
        note_id: None,
    };
    roundtrip(&SearchRequest {
        query: s("الرحمن"),
        scope: SearchScope::Translation {
            pack_id: s("tr.en.saheeh"),
        },
        mode: SearchMode::Smart,
        surah: Some(1),
        juz: None,
        limit: 500,
        layout: MushafLayout::V2,
    });
    roundtrip(&SearchResults {
        query: s("الرحمن"),
        normalized: s("الرحمن"),
        total: 57,
        truncated: false,
        took_ms: 3,
        groups: vec![SearchGroup {
            surah: 1,
            count: 1,
            hits: vec![hit],
        }],
        suggestions: vec![s("الرحيم")],
    });
    roundtrip(&SearchSuggestion {
        term: s("الرحمن"),
        count: 57,
    });
    roundtrip(&SearchHistoryEntry {
        query: s("mercy"),
        scope: SearchScope::Notes,
        last_used_at: 1,
        use_count: 2,
    });
    roundtrip(&TranslationRow {
        ayah_id: 1,
        items: vec![TranslationText {
            pack_id: s("tr.en.saheeh"),
            html: s("In the name of Allah<sup data-fn=\"1\">1</sup>"),
            footnotes: vec![Footnote {
                id: s("1"),
                marker: s("1"),
                html: s("Note"),
            }],
        }],
    });
    roundtrip(&TafsirEntry {
        pack_id: s("tafsir.ar.muyassar"),
        from_ayah_id: 1,
        to_ayah_id: 7,
        html: s("<p>…</p>"),
        lang: s("ar"),
        dir: TextDir::Rtl,
        fetched_at: Some(1_760_000_000),
        stale: true,
    });
    roundtrip(&WbwEntry {
        word_id: 1,
        text: s("بِسْمِ"),
        translation: Some(s("In (the) name")),
        transliteration: None,
    });
}

#[test]
fn audio_round_trip() {
    roundtrip(&PlayRequest {
        reciter_id: 7,
        from: ayah_ref(2, 255),
        to: None,
        stop_at: Some(StopAt::EndOfPage),
        layout: MushafLayout::V2,
        ayah_repeat: 0,
        range_repeat: 1,
        gap: GapSetting::Fixed { ms: 1500 },
        start_paused: true,
        record: false,
    });
    roundtrip(&sample_snapshot());
    roundtrip(&AudioTick {
        seq: 1,
        generation: 2,
        status: PlaybackStatus::Buffering,
        surah: 1,
        ayah: 0,
        ayah_id: 0,
        file_ms: 120,
        word_pos: 0,
        speed_pct: 100,
        in_gap: true,
        buffered_pct: 100,
    });
    roundtrip(&AyahChange {
        reciter_id: 7,
        surah: 1,
        ayah: 2,
        ayah_id: 2,
    });
    roundtrip(&SurahTimings {
        reciter_id: 7,
        surah: 1,
        duration_ms: 50_000,
        word_level: true,
        ayahs: vec![AyahTiming {
            ayah: 1,
            from_ms: 0,
            to_ms: 6_000,
            words: vec![WordTiming {
                pos: 1,
                start_ms: 0,
                end_ms: 900,
            }],
        }],
    });
    for target in [
        SeekTarget::Ayah { ayah_id: 8 },
        SeekTarget::FileMs { ms: 5 },
        SeekTarget::RelativeMs { delta_ms: -5000 },
    ] {
        roundtrip(&target);
    }
}

#[test]
fn packs_round_trip() {
    roundtrip(&sample_pack_info());
    roundtrip(&PackItemState {
        item: 2,
        pinned: true,
        queued: false,
        kib: 12_000,
    });
    roundtrip(&PackUpdate {
        pack_id: s("tr.en.saheeh"),
        installed: s("1"),
        latest: s("2"),
        size_kib: 1,
    });
    roundtrip(&DiskUsage {
        total_kib: 10,
        mushaf_kib: 1,
        decor_kib: 1,
        translation_kib: 1,
        tafsir_kib: 1,
        audio_pinned_kib: 1,
        audio_stream_kib: 1,
        content_db_kib: 1,
        user_db_kib: 1,
        data_dir: s("/home/u/.local/share/com.quran.labs.desktop"),
    });
    for scope in [
        InstallScope::All,
        InstallScope::Items {
            items: vec![1, 2, 114],
        },
    ] {
        roundtrip(&scope);
    }
    let failed = AppError::Integrity(s("sha256 mismatch"));
    for state in [
        PackState::NotInstalled,
        PackState::Partial {
            items_present: 1,
            items_total: 604,
        },
        PackState::Installed { version: s("1") },
        PackState::UpdateAvailable {
            installed: s("1"),
            latest: s("2"),
        },
        PackState::Paused {
            items_present: 1,
            items_total: 2,
        },
        PackState::Failed {
            error: failed.clone(),
        },
    ] {
        roundtrip(&state);
    }
    let (job_id, pack_id) = (1, s("audio.7"));
    for event in [
        DownloadEvent::Queued {
            job_id,
            pack_id: pack_id.clone(),
        },
        DownloadEvent::Started {
            job_id,
            pack_id: pack_id.clone(),
            total_kib: 1,
            items_total: 114,
        },
        DownloadEvent::Progress {
            job_id,
            pack_id: pack_id.clone(),
            received_kib: 1,
            total_kib: 2,
            items_done: 0,
            items_total: 114,
            rate_kib_s: 9,
            eta_s: None,
        },
        DownloadEvent::Verifying {
            job_id,
            pack_id: pack_id.clone(),
        },
        DownloadEvent::Installing {
            job_id,
            pack_id: pack_id.clone(),
        },
        DownloadEvent::Paused {
            job_id,
            pack_id: pack_id.clone(),
        },
        DownloadEvent::Completed {
            job_id,
            pack_id: pack_id.clone(),
        },
        DownloadEvent::Failed {
            job_id,
            pack_id: pack_id.clone(),
            error: failed.clone(),
        },
        DownloadEvent::Cancelled { job_id, pack_id },
    ] {
        roundtrip(&event);
    }
}

#[test]
fn user_round_trip() {
    let bookmark = sample_bookmark();
    roundtrip(&bookmark);
    roundtrip(&BookmarkInput {
        id: None,
        kind: BookmarkKind::Page,
        ayah_id: 1,
        layout: Some(MushafLayout::V2),
        page: Some(1),
        label: None,
        collection_ids: vec![],
        tag_ids: vec![],
    });
    roundtrip(&BookmarkFilter {
        kind: Some(BookmarkKind::Ayah),
        collection_id: None,
        tag_id: Some(s("t1")),
        surah: Some(2),
        limit: 100,
    });
    roundtrip(&BookmarkToggle {
        bookmark,
        active: false,
    });
    let rb = ReadingBookmark {
        ayah_id: 8,
        layout: MushafLayout::V2,
        page: 2,
        updated_at: 5,
    };
    roundtrip(&ReadingBookmarkInput {
        ayah_id: 8,
        layout: MushafLayout::V2,
        page: 2,
    });
    roundtrip(&ReadingBookmarkMove {
        previous: None,
        current: rb,
    });
    roundtrip(&ReadingBookmarkMove {
        previous: Some(rb),
        current: rb,
    });
    roundtrip(&Highlight {
        id: s("h1"),
        from_ayah_id: 1,
        to_ayah_id: 7,
        color: HighlightColor::Purple,
        tag_ids: vec![],
        created_at: 1,
        updated_at: 2,
    });
    roundtrip(&HighlightInput {
        from_ayah_id: 1,
        to_ayah_id: 1,
        color: HighlightColor::Yellow,
    });
    roundtrip(&Note {
        id: s("n1"),
        from_ayah_id: 1,
        to_ayah_id: 2,
        title: Some(s("Title")),
        body: s("Body with <b>markup</b> as text"),
        tag_ids: vec![s("t1")],
        created_at: 1,
        updated_at: 2,
    });
    roundtrip(&NoteInput {
        id: Some(s("n1")),
        from_ayah_id: 1,
        to_ayah_id: 2,
        title: None,
        body: s("b"),
        tag_ids: vec![],
    });
    roundtrip(&NoteFilter {
        from_ayah_id: Some(1),
        to_ayah_id: Some(7),
        tag_id: None,
        limit: 50,
    });
    roundtrip(&Collection {
        id: s("c1"),
        name: s("Favourites"),
        color: Some(s("teal")),
        item_count: 3,
        sort_key: -1,
        created_at: 1,
        updated_at: 1,
    });
    roundtrip(&CollectionInput {
        id: None,
        name: s("Du'a"),
        color: None,
        sort_key: 0,
    });
    roundtrip(&Tag {
        id: s("t1"),
        name: s("dua"),
        color: None,
        usage_count: 4,
    });
    roundtrip(&TagInput {
        id: None,
        name: s("dua"),
        color: Some(s("rose")),
    });
    roundtrip(&UserMarks {
        bookmarks: vec![AyahMark {
            ayah_id: 262,
            bookmark_id: s("b1"),
        }],
        page_bookmarks: vec![PageMark {
            page: 42,
            bookmark_id: s("b2"),
        }],
        highlights: vec![HighlightMark {
            id: s("h1"),
            from_ayah_id: 1,
            to_ayah_id: 2,
            color: HighlightColor::Green,
        }],
        notes: vec![NoteMark {
            id: s("n1"),
            from_ayah_id: 1,
            to_ayah_id: 1,
        }],
        reading_ayah_id: Some(262),
    });
    roundtrip(&HistoryInput {
        mode: HistoryMode::Listen,
        layout: None,
        page: None,
        ayah_id: 3,
        dwell_s: 4,
    });
    roundtrip(&HistoryEntry {
        id: 9,
        at: 1,
        mode: HistoryMode::Memorize,
        layout: Some(MushafLayout::V1),
        page: Some(3),
        ayah_id: 3,
        dwell_s: 60,
    });
    roundtrip(&MemoProgress {
        ayah_id: 1,
        status: MemoStatus::Review,
        strength: 5,
        reviews: 10,
        lapses: 1,
        last_reviewed_at: Some(1),
        due_at: Some(2),
    });
    roundtrip(&MemoReviewInput {
        from_ayah_id: 1,
        to_ayah_id: 7,
        rating: 3,
        mistakes: 0,
    });
    roundtrip(&MemoTest {
        id: 1,
        from_ayah_id: 1,
        to_ayah_id: 7,
        start_ayah_id: 4,
        started_at: 1,
        finished_at: None,
        reveals: None,
        mistakes: None,
        rating: None,
    });
    roundtrip(&MemoTestResult {
        id: 1,
        reveals: 2,
        mistakes: 1,
        rating: 2,
    });
    roundtrip(&LoopPreset {
        id: 1,
        name: s("Al-Mulk"),
        reciter_id: Some(7),
        from_ayah_id: 5242,
        to_ayah_id: 5271,
        ayah_repeat: 3,
        range_repeat: 2,
        gap: GapSetting::None,
        speed_pct: 90,
        created_at: 1,
        updated_at: 2,
    });
    roundtrip(&LoopPresetInput {
        id: None,
        name: s("x"),
        reciter_id: None,
        from_ayah_id: 1,
        to_ayah_id: 1,
        ayah_repeat: 1,
        range_repeat: 1,
        gap: GapSetting::Fixed { ms: 0 },
        speed_pct: 100,
    });
}

#[test]
fn settings_and_system_round_trip() {
    let settings = Settings {
        translations: vec![s("tr.en.saheeh"), s("tr.ur.junagarhi")],
        wbw_pack_id: Some(s("wbw.en")),
        gap: GapSetting::Fixed { ms: 500 },
        hints_seen: vec![s("page_turn")],
        ..Settings::default()
    };
    roundtrip(&settings);
    roundtrip(&ChromeAppearance {
        dark: true,
        effect: ChromeEffect::Off,
    });
    for target in [
        NavTarget::Ayah { ayah_id: 262 },
        NavTarget::Page { page: 604 },
        NavTarget::Surah { surah: 114 },
        NavTarget::View {
            view: AppView::Downloads,
        },
        NavTarget::Search {
            query: s("رحمة")
        },
    ] {
        roundtrip(&target);
    }
}

// ---------------------------------------------------------------------------------------- tagged-enum JSON shapes

#[test]
fn app_error_shape() {
    assert_eq!(
        serde_json::to_value(AppError::NotFound(s("core.db missing — run pnpm core:qdc"))).unwrap(),
        json!({ "kind": "not_found", "message": "core.db missing — run pnpm core:qdc" })
    );
    let all = [
        (AppError::NotFound(s("m")), "not_found"),
        (AppError::InvalidArgument(s("m")), "invalid_argument"),
        (AppError::Database(s("m")), "database"),
        (AppError::Io(s("m")), "io"),
        (AppError::Network(s("m")), "network"),
        (AppError::Offline(s("m")), "offline"),
        (AppError::Integrity(s("m")), "integrity"),
        (AppError::Cancelled(s("m")), "cancelled"),
        (AppError::Conflict(s("m")), "conflict"),
        (AppError::Audio(s("m")), "audio"),
        (AppError::Unsupported(s("m")), "unsupported"),
        (AppError::Internal(s("m")), "internal"),
    ];
    for (err, kind) in all {
        let json = roundtrip(&err);
        assert_eq!(json, json!({ "kind": kind, "message": "m" }));
        assert_eq!(err.kind(), kind);
        assert_eq!(err.message(), "m");
        assert!(err.to_string().ends_with(": m"), "{err}");
    }
    assert_eq!(
        AppError::InvalidArgument(s("page 0")).to_string(),
        "invalid argument: page 0"
    );
}

#[test]
fn gap_setting_shape() {
    assert_eq!(
        serde_json::to_value(GapSetting::None).unwrap(),
        json!({ "type": "none" })
    );
    assert_eq!(
        serde_json::to_value(GapSetting::Fixed { ms: 1500 }).unwrap(),
        json!({ "type": "fixed", "data": { "ms": 1500 } })
    );
    assert_eq!(
        serde_json::to_value(GapSetting::Multiplier { pct: 150 }).unwrap(),
        json!({ "type": "multiplier", "data": { "pct": 150 } })
    );
}

#[test]
fn pack_state_shape() {
    assert_eq!(
        serde_json::to_value(PackState::NotInstalled).unwrap(),
        json!({ "type": "not_installed" })
    );
    assert_eq!(
        serde_json::to_value(PackState::Partial {
            items_present: 3,
            items_total: 604
        })
        .unwrap(),
        json!({ "type": "partial", "data": { "itemsPresent": 3, "itemsTotal": 604 } })
    );
    assert_eq!(
        serde_json::to_value(PackState::UpdateAvailable {
            installed: s("1"),
            latest: s("2")
        })
        .unwrap(),
        json!({ "type": "update_available", "data": { "installed": "1", "latest": "2" } })
    );
    assert_eq!(
        serde_json::to_value(PackState::Failed {
            error: AppError::Offline(s("no network"))
        })
        .unwrap(),
        json!({ "type": "failed", "data": { "error": { "kind": "offline", "message": "no network" } } })
    );
}

#[test]
fn download_event_shape() {
    assert_eq!(
        serde_json::to_value(DownloadEvent::Progress {
            job_id: 4,
            pack_id: s("mushaf.v2"),
            received_kib: 10,
            total_kib: 20,
            items_done: 1,
            items_total: 2,
            rate_kib_s: 5,
            eta_s: None,
        })
        .unwrap(),
        json!({ "type": "progress", "data": {
            "jobId": 4, "packId": "mushaf.v2", "receivedKib": 10, "totalKib": 20, "itemsDone": 1, "itemsTotal": 2,
            "rateKibS": 5, "etaS": null } })
    );
    assert_eq!(
        serde_json::to_value(DownloadEvent::Failed {
            job_id: 4,
            pack_id: s("mushaf.v2"),
            error: AppError::Network(s("timeout")),
        })
        .unwrap(),
        json!({ "type": "failed", "data": { "jobId": 4, "packId": "mushaf.v2",
            "error": { "kind": "network", "message": "timeout" } } })
    );
}

#[test]
fn search_scope_shape() {
    assert_eq!(
        serde_json::to_value(SearchScope::Quran).unwrap(),
        json!({ "type": "quran" })
    );
    assert_eq!(
        serde_json::to_value(SearchScope::Notes).unwrap(),
        json!({ "type": "notes" })
    );
    assert_eq!(
        serde_json::to_value(SearchScope::Translation {
            pack_id: s("tr.en.saheeh")
        })
        .unwrap(),
        json!({ "type": "translation", "data": { "packId": "tr.en.saheeh" } })
    );
}

#[test]
fn startup_notice_shape() {
    assert_eq!(
        serde_json::to_value(StartupNotice::UserDbRecovered {
            quarantined_file: s("user.db.corrupt-1")
        })
        .unwrap(),
        json!({ "type": "user_db_recovered", "data": { "quarantinedFile": "user.db.corrupt-1" } })
    );
    assert_eq!(
        serde_json::to_value(StartupNotice::ContentDbRecovered).unwrap(),
        json!({ "type": "content_db_recovered" })
    );
}

#[test]
fn other_tagged_enum_shapes() {
    assert_eq!(
        serde_json::to_value(SeekTarget::RelativeMs { delta_ms: -5000 }).unwrap(),
        json!({ "type": "relative_ms", "data": { "deltaMs": -5000 } })
    );
    assert_eq!(
        serde_json::to_value(InstallScope::Items { items: vec![1, 2] }).unwrap(),
        json!({ "type": "items", "data": { "items": [1, 2] } })
    );
    assert_eq!(
        serde_json::to_value(InstallScope::All).unwrap(),
        json!({ "type": "all" })
    );
    assert_eq!(
        serde_json::to_value(NavTarget::View {
            view: AppView::Settings
        })
        .unwrap(),
        json!({ "type": "view", "data": { "view": "settings" } })
    );
    assert_eq!(
        serde_json::to_value(NavTarget::Ayah { ayah_id: 262 }).unwrap(),
        json!({ "type": "ayah", "data": { "ayahId": 262 } })
    );
}

#[test]
fn a_play_request_without_record_is_part_of_the_listening() {
    let wire = json!({
        "reciterId": 7,
        "from": { "surah": 1, "ayah": 1 },
        "to": null,
        "stopAt": null,
        "layout": "v2",
        "ayahRepeat": 1,
        "rangeRepeat": 1,
        "gap": { "type": "none" },
        "startPaused": false
    });
    let req: PlayRequest = serde_json::from_value(wire.clone()).unwrap();
    assert!(
        req.record,
        "an absent `record` is `true` (callers before the field)"
    );
    let mut preview = wire;
    preview["record"] = json!(false);
    let req: PlayRequest = serde_json::from_value(preview).unwrap();
    assert!(!req.record);
    assert_eq!(serde_json::to_value(&req).unwrap()["record"], json!(false));
}

#[test]
fn unknown_tags_are_rejected() {
    assert!(serde_json::from_value::<GapSetting>(json!({ "type": "random" })).is_err());
    assert!(serde_json::from_value::<AppError>(json!({ "kind": "boom", "message": "x" })).is_err());
    assert!(serde_json::from_value::<MushafStyle>(json!("qcfV2")).is_err());
    assert!(serde_json::from_value::<AyahRef>(json!({ "surah": 1 })).is_err());
}

// ------------------------------------------------------------------------------------------------ unit-enum strings

#[test]
fn unit_enum_strings() {
    assert_unit_strings!(
        MushafLayout::V2 => "v2", MushafLayout::V1 => "v1", MushafLayout::V4 => "v4",
        MushafStyle::Hafs => "hafs", MushafStyle::QcfV2 => "qcf_v2", MushafStyle::QcfV1 => "qcf_v1",
        MushafStyle::QcfV4 => "qcf_v4",
        TextDir::Ltr => "ltr", TextDir::Rtl => "rtl",
        Platform::Windows => "windows", Platform::Macos => "macos", Platform::Linux => "linux",
        RevelationPlace::Makkah => "makkah", RevelationPlace::Madinah => "madinah",
        SajdaKind::Recommended => "recommended", SajdaKind::Obligatory => "obligatory",
        FontTransport::Url => "url", FontTransport::Bytes => "bytes",
        LineKind::Ayah => "ayah", LineKind::SurahName => "surah_name", LineKind::Basmallah => "basmallah",
        FetchPriority::Interactive => "interactive", FetchPriority::Prefetch => "prefetch",
        FontAvailability::Ready => "ready", FontAvailability::Failed => "failed",
        FontAvailability::Unavailable => "unavailable",
        ReferenceStyle::Short => "short", ReferenceStyle::Long => "long", ReferenceStyle::Arabic => "arabic",
        SearchMode::Smart => "smart", SearchMode::Exact => "exact", SearchMode::Substring => "substring",
        PlaybackStatus::Idle => "idle", PlaybackStatus::Loading => "loading", PlaybackStatus::Buffering => "buffering",
        PlaybackStatus::Playing => "playing", PlaybackStatus::Paused => "paused", PlaybackStatus::Error => "error",
        SkipDirection::Next => "next", SkipDirection::Previous => "previous",
        StopAt::EndOfSurah => "end_of_surah", StopAt::EndOfPage => "end_of_page", StopAt::EndOfJuz => "end_of_juz",
        StopAt::EndOfQuran => "end_of_quran",
        PackKind::MushafFonts => "mushaf_fonts", PackKind::Decor => "decor", PackKind::Translation => "translation",
        PackKind::Tafsir => "tafsir", PackKind::Recitation => "recitation", PackKind::Wbw => "wbw",
        InstallMode::Whole => "whole", InstallMode::OnDemand => "on_demand",
        JobPhase::Queued => "queued", JobPhase::Downloading => "downloading", JobPhase::Verifying => "verifying",
        JobPhase::Installing => "installing", JobPhase::Paused => "paused", JobPhase::Completed => "completed",
        JobPhase::Failed => "failed", JobPhase::Cancelled => "cancelled",
        BookmarkKind::Ayah => "ayah", BookmarkKind::Page => "page",
        HighlightColor::Yellow => "yellow", HighlightColor::Green => "green", HighlightColor::Blue => "blue",
        HighlightColor::Red => "red", HighlightColor::Purple => "purple",
        TaggableKind::Bookmark => "bookmark", TaggableKind::Note => "note", TaggableKind::Highlight => "highlight",
        PositionContext::Mushaf => "mushaf", PositionContext::Translation => "translation",
        PositionContext::Audio => "audio",
        HistoryMode::Read => "read", HistoryMode::Listen => "listen", HistoryMode::Memorize => "memorize",
        MemoStatus::New => "new", MemoStatus::Learning => "learning", MemoStatus::Memorized => "memorized",
        MemoStatus::Review => "review",
        UserDataKind::Bookmarks => "bookmarks", UserDataKind::ReadingBookmark => "reading_bookmark",
        UserDataKind::Highlights => "highlights", UserDataKind::Notes => "notes",
        UserDataKind::Collections => "collections", UserDataKind::Tags => "tags",
        UserDataKind::Positions => "positions", UserDataKind::History => "history", UserDataKind::Memo => "memo",
        UserDataKind::Presets => "presets",
        ThemeMode::System => "system", ThemeMode::Paper => "paper", ThemeMode::Sepia => "sepia",
        ThemeMode::Night => "night", ThemeMode::Black => "black", ThemeMode::HighContrast => "high_contrast",
        DarkVariant::Night => "night", DarkVariant::Black => "black",
        LightVariant::Paper => "paper", LightVariant::Sepia => "sepia",
        Accent::Teal => "teal", Accent::Emerald => "emerald", Accent::Blue => "blue", Accent::Indigo => "indigo",
        Accent::Rose => "rose", Accent::Amber => "amber",
        UiLanguage::En => "en", UiLanguage::Ar => "ar",
        DigitStyle::Auto => "auto", DigitStyle::Latin => "latin", DigitStyle::ArabicIndic => "arabic_indic",
        MotionPref::System => "system", MotionPref::Reduce => "reduce", MotionPref::Full => "full",
        ChromeEffect::Auto => "auto", ChromeEffect::Off => "off",
        PageMode::Auto => "auto", PageMode::Single => "single", PageMode::Spread => "spread",
        ReadingMode::Mushaf => "mushaf", ReadingMode::Translation => "translation",
        SidePaneTab::Translation => "translation", SidePaneTab::Tafsir => "tafsir", SidePaneTab::Notes => "notes",
        SidePaneTab::Words => "words",
        SidePaneFollow::Selection => "selection", SidePaneFollow::SelectionOrAudio => "selection_or_audio",
        SidePaneFollow::Pinned => "pinned",
        SidebarTab::Index => "index", SidebarTab::Search => "search", SidebarTab::Bookmarks => "bookmarks",
        SidebarTab::Highlights => "highlights", SidebarTab::Notes => "notes", SidebarTab::History => "history",
        SidebarTab::Memorize => "memorize",
        MemoHideStyle::Blur => "blur", MemoHideStyle::Blank => "blank",
        AppView::Reader => "reader", AppView::Downloads => "downloads", AppView::Settings => "settings",
        AppView::About => "about",
    );
}

// ---------------------------------------------------------------------------------------------------- pure helpers

#[test]
fn layout_and_style_helpers() {
    for layout in MushafLayout::ALL {
        assert_eq!(MushafLayout::from_db_id(layout.db_id()), Some(layout));
    }
    assert_eq!(MushafLayout::V2.db_id(), 1);
    assert_eq!(MushafLayout::V1.db_id(), 2);
    assert_eq!(MushafLayout::V4.db_id(), 19);
    assert_eq!(MushafLayout::from_db_id(0), None);
    assert_eq!(MushafLayout::from_db_id(3), None);

    assert_eq!(MushafStyle::Hafs.layout(), MushafLayout::V2);
    assert_eq!(MushafStyle::QcfV2.layout(), MushafLayout::V2);
    assert_eq!(MushafStyle::QcfV1.layout(), MushafLayout::V1);
    assert_eq!(MushafStyle::QcfV4.layout(), MushafLayout::V4);
    assert_eq!(
        MushafStyle::ALL.map(MushafStyle::glyph_selector),
        [0, 2, 1, 2]
    );
}

#[test]
fn constants_and_platform() {
    assert_eq!(
        (AYAH_COUNT, WORD_COUNT, SURAH_COUNT, PAGE_COUNT, JUZ_COUNT),
        (6236, 83_665, 114, 604, 30)
    );
    let expected = if cfg!(windows) {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::Macos
    } else {
        Platform::Linux
    };
    assert_eq!(Platform::current(), expected);
}

#[test]
fn gap_clamped() {
    assert_eq!(GapSetting::None.clamped(), GapSetting::None);
    assert_eq!(
        GapSetting::Fixed { ms: 30_001 }.clamped(),
        GapSetting::Fixed { ms: 30_000 }
    );
    assert_eq!(
        GapSetting::Fixed { ms: 250 }.clamped(),
        GapSetting::Fixed { ms: 250 }
    );
    assert_eq!(
        GapSetting::Multiplier { pct: 1000 }.clamped(),
        GapSetting::Multiplier { pct: 300 }
    );
}
