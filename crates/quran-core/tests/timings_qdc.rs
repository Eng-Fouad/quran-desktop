//! The QDC timing sanitiser and the timing round trip through content.db.
//!
//! The payloads are synthetic but reproduce every defect observed in real QDC responses: numbers as strings and floats,
//! `[1]`-style junk segments, words starting before their ayah, negative verse durations, repeated and backward word
//! positions, rows of other surahs, null chapter rows and ayah-level-only reciters. `real_qdc_files_sanitise_cleanly`
//! (ignored) runs the sanitiser over saved real responses.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use quran_core::timings::{QdcFileInfo, is_word_level, qdc_file_info};
use quran_core::{
    ContentDb, CoreError, SanitizeReport, StoredTimings, TimedAyah, TimingFile, WordSeg,
    sanitize_qdc,
};
use serde_json::{Value, json};

fn w(pos: u16, start_ms: u32, end_ms: u32) -> WordSeg {
    WordSeg {
        pos,
        start_ms,
        end_ms,
    }
}

fn file(chapter: Value, rows: Value) -> Value {
    json!({
        "id": 9001, "chapter_id": chapter, "file_size": 812_345.0, "format": "mp3",
        "audio_url": "https://download.quranicaudio.com/qdc/reciter/murattal/1.mp3", "duration": 46000,
        "verse_timings": rows
    })
}

/// Seven ayahs of surah 1 with every known defect.
fn messy_fatiha() -> Value {
    file(
        json!(1),
        json!([
            {"verse_key": "1:1", "timestamp_from": 0, "timestamp_to": 6000, "duration": 6000,
             "segments": [[1, 0, 500], [2, 500, 1400], [3, 1400, 2500], [4, 2500, 5800]]},
            // The first word starts before the ayah.
            {"verse_key": "1:2", "timestamp_from": 6000, "timestamp_to": 11600, "duration": 5600,
             "segments": [[1, 5940, 7000], [2, 7000, 7900], [3, 7900, 8500], [4, 8500, 11500]]},
            // Junk one-element segments.
            {"verse_key": "1:3", "timestamp_from": 11600, "timestamp_to": 16300, "duration": 4700,
             "segments": [[1, 11550, 12800], [1], [2, 12800, 16200], [2], [1]]},
            // A negative duration and string/float numbers.
            {"verse_key": "1:4", "timestamp_from": "16300", "timestamp_to": 16100, "duration": -200,
             "segments": [[1, "16300", "17000"], [2, 17000.4, 17600], [3, 17600, 20800]]},
            // A repeated phrase: positions go backwards, starts arrive unsorted.
            {"verse_key": "1:5", "timestamp_from": 20900, "timestamp_to": 27600, "duration": 6700,
             "segments": [[1, 20900, 21800], [3, 22600, 23700], [2, 21800, 22600], [2, 23700, 24500],
                          [3, 24500, 27500]]},
            // A word past the end and one entirely after the ayah.
            {"verse_key": "1:6", "timestamp_from": 27600, "timestamp_to": 33200, "duration": 5600,
             "segments": [[1, 27600, 28300], [2, 28300, 29200], [3, 29200, 33900], [4, 34000, 35000]]},
            // Position 0 is not a word.
            {"verse_key": "1:7", "timestamp_from": 33200, "timestamp_to": 46400, "duration": 13200,
             "segments": [[1, 33200, 34000], [2, 34000, 35000], [0, 40000, 41000], [3, 35000, 46300]]},
            // Rows that are not this surah's.
            {"verse_key": "2:1", "timestamp_from": 0, "timestamp_to": 10, "segments": [[1, 0, 10]]},
            {"verse_key": null, "timestamp_from": 0, "timestamp_to": 10, "segments": []}
        ]),
    )
}

#[test]
fn messy_payload_is_repaired_per_the_rules() {
    let (ayahs, report) = sanitize_qdc(&messy_fatiha(), 7).unwrap();
    assert_eq!(
        report,
        SanitizeReport {
            // 1:3 junk ×3, 1:6 word after the ayah, 1:7 position 0.
            dropped_segments: 5,
            // 1:4: "16300" (timestamp), "16300", "17000", 17000.4.
            coerced_values: 4,
            // 1:2 and 1:3 first words, the 1:4 end repair, 1:6 ×2.
            clamped: 5,
            // 1:5 words re-sorted.
            reordered: 1,
        }
    );
    assert!(is_word_level(&ayahs));
    assert_eq!(
        ayahs.iter().map(|a| a.ayah).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6, 7]
    );

    assert_eq!(
        ayahs[1].words[0],
        w(1, 6000, 7000),
        "clamped to the ayah start"
    );
    assert_eq!(ayahs[2].words, [w(1, 11600, 12800), w(2, 12800, 16200)]);
    assert_eq!(
        (ayahs[3].from_ms, ayahs[3].to_ms),
        (16300, 20900),
        "to < from repaired from the next ayah"
    );
    assert_eq!(
        ayahs[3].words,
        [w(1, 16300, 17000), w(2, 17000, 17600), w(3, 17600, 20800)]
    );
    assert_eq!(
        ayahs[4].words,
        [
            w(1, 20900, 21800),
            w(2, 21800, 22600),
            w(3, 22600, 23700),
            w(2, 23700, 24500),
            w(3, 24500, 27500)
        ],
        "sorted by time; the repeated positions are kept"
    );
    assert_eq!(
        ayahs[5].words,
        [w(1, 27600, 28300), w(2, 28300, 29200), w(3, 29200, 33200)]
    );
    assert_eq!(
        ayahs[6].words.iter().map(|x| x.pos).collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert_eq!(ayahs[6].to_ms, 46400);
}

#[test]
fn file_info_reads_the_header_fields() {
    assert_eq!(
        qdc_file_info(&messy_fatiha()).unwrap(),
        QdcFileInfo {
            chapter_id: 1,
            audio_url: "https://download.quranicaudio.com/qdc/reciter/murattal/1.mp3".into(),
            duration_ms: Some(46_000),
        }
    );
}

fn ayah_level(chapter: u32, n: u32) -> Value {
    let rows: Vec<Value> = (1..=n)
        .map(|a| {
            json!({"verse_key": format!("{chapter}:{a}"), "timestamp_from": (a - 1) * 1000,
                   "timestamp_to": a * 1000, "duration": 1000, "segments": []})
        })
        .collect();
    file(json!(chapter), Value::Array(rows))
}

#[test]
fn ayah_level_reciters_keep_their_ayah_timings() {
    let (ayahs, report) = sanitize_qdc(&ayah_level(112, 4), 4).unwrap();
    assert!(report.is_clean(), "{report:?}");
    assert!(!is_word_level(&ayahs));
    assert!(ayahs.iter().all(|a| a.words.is_empty()));
    assert_eq!(
        ayahs[3],
        TimedAyah {
            ayah: 4,
            from_ms: 3000,
            to_ms: 4000,
            words: vec![]
        }
    );
}

#[test]
fn partial_word_timings_fall_back_to_ayah_level() {
    let mut payload = ayah_level(112, 4);
    let rows = payload["verse_timings"].as_array_mut().unwrap();
    for (i, row) in rows.iter_mut().enumerate().take(3) {
        let from = u32::try_from(i).unwrap() * 1000;
        row["segments"] = json!([[1, from, from + 400], [2, from + 400, from + 900]]);
    }
    let (ayahs, report) = sanitize_qdc(&payload, 4).unwrap();
    assert!(!is_word_level(&ayahs), "112:4 has no word segment");
    assert!(ayahs.iter().all(|a| a.words.is_empty()));
    assert_eq!(
        report.dropped_segments, 6,
        "every word of the demoted file is counted"
    );
}

#[test]
fn rows_out_of_order_are_sorted() {
    let mut payload = ayah_level(113, 5);
    payload["verse_timings"].as_array_mut().unwrap().reverse();
    let (ayahs, report) = sanitize_qdc(&payload, 5).unwrap();
    assert_eq!(report.reordered, 1);
    assert_eq!(
        ayahs.iter().map(|a| a.ayah).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5]
    );
}

#[test]
fn negative_durations_without_a_later_neighbour_get_one_millisecond() {
    let payload = file(
        json!(114),
        json!([
            {"verse_key": "114:1", "timestamp_from": 0, "timestamp_to": 900},
            {"verse_key": "114:2", "timestamp_from": 900, "timestamp_to": 100},
            {"verse_key": "114:3", "timestamp_from": 900, "timestamp_to": 1800},
            {"verse_key": "114:4", "timestamp_from": 1800, "timestamp_to": 2700},
            {"verse_key": "114:5", "timestamp_from": 2700, "timestamp_to": 3600},
            {"verse_key": "114:6", "timestamp_from": 3600, "timestamp_to": -5}
        ]),
    );
    let (ayahs, report) = sanitize_qdc(&payload, 6).unwrap();
    // 114:2's next ayah does not start later; 114:6 is the last ayah (its -5 was coerced to 0 first).
    assert_eq!((ayahs[1].from_ms, ayahs[1].to_ms), (900, 901));
    assert_eq!((ayahs[5].from_ms, ayahs[5].to_ms), (3600, 3601));
    assert_eq!(report.clamped, 2);
    assert_eq!(report.coerced_values, 1);
}

#[test]
fn invalid_files_are_corrupt() {
    let corrupt = |payload: &Value, n: u32| {
        let err = sanitize_qdc(payload, n)
            .err()
            .unwrap_or_else(|| panic!("accepted {payload}"));
        assert!(matches!(err, CoreError::Corrupt(_)), "{err}");
        err.to_string()
    };
    let base = ayah_level(112, 4);
    let edit = |f: &dyn Fn(&mut Value)| {
        let mut p = base.clone();
        f(&mut p);
        p
    };
    // Sudais' junk row: null chapter and URL.
    corrupt(&edit(&|p| p["chapter_id"] = Value::Null), 4);
    corrupt(&edit(&|p| p["audio_url"] = Value::Null), 4);
    corrupt(&edit(&|p| p["verse_timings"] = json!({})), 4);
    corrupt(
        &edit(&|p| {
            p.as_object_mut().unwrap().remove("verse_timings");
        }),
        4,
    );
    // A missing ayah, a duplicate, an extra one, a row of another surah only.
    let missing = corrupt(
        &edit(&|p| {
            p["verse_timings"].as_array_mut().unwrap().remove(2);
        }),
        4,
    );
    assert!(missing.contains("[1, 2, 4]"), "{missing}");
    corrupt(
        &edit(&|p| {
            let r = p["verse_timings"][0].clone();
            p["verse_timings"].as_array_mut().unwrap().push(r);
        }),
        4,
    );
    corrupt(&base, 3);
    corrupt(&edit(&|p| p["chapter_id"] = json!(113)), 4);
    // Decreasing starts, and timestamps that are not numbers.
    corrupt(
        &edit(&|p| p["verse_timings"][2]["timestamp_from"] = json!(500)),
        4,
    );
    corrupt(
        &edit(&|p| p["verse_timings"][1]["timestamp_to"] = json!("soon")),
        4,
    );
    corrupt(
        &edit(&|p| {
            p["verse_timings"][1]
                .as_object_mut()
                .unwrap()
                .remove("timestamp_from");
        }),
        4,
    );
    // The argument itself.
    assert!(matches!(
        sanitize_qdc(&base, 0),
        Err(CoreError::InvalidArgument(_))
    ));
}

#[test]
fn sanitised_timings_round_trip_through_content_db() {
    let dir = tempfile::tempdir().unwrap();
    let db = ContentDb::open(&dir.path().join("content.db")).unwrap();
    let payload = messy_fatiha();
    let info = qdc_file_info(&payload).unwrap();
    let (ayahs, _) = sanitize_qdc(&payload, 7).unwrap();
    let stored = StoredTimings {
        file: TimingFile {
            reciter_id: 7,
            surah: info.chapter_id,
            audio_url: info.audio_url,
            content_length: Some(839_808),
            duration_ms: info.duration_ms,
            source: "qdc".into(),
            fetched_at_ms: 1_760_000_000_000,
            etag: Some("\"abc\"".into()),
            payload_sha256: "00ff".into(),
        },
        word_level: is_word_level(&ayahs),
        ayahs,
    };
    db.timings_put(&stored, false).unwrap();
    let back = db.timings_get(7, 1).unwrap().unwrap();
    assert_eq!(back, stored);
    let dto = back.to_dto();
    assert_eq!(
        dto.duration_ms, 46_400,
        "the timeline outlasts QDC's rounded file duration"
    );
    assert!(dto.word_level);
    assert_eq!(
        dto.ayahs[4].words.iter().map(|x| x.pos).collect::<Vec<_>>(),
        [1, 2, 3, 2, 3]
    );
}

/// xorshift64*: a deterministic generator for the robustness test (no extra dependency).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
    /// A number in one of the shapes QDC sends, sometimes wrong.
    fn number(&mut self, v: i64) -> Value {
        match self.below(20) {
            0 => json!(v.to_string()),
            1 => json!(v as f64 + 0.4),
            2 => json!(-v),
            3 => Value::Null,
            4 => json!("x"),
            _ => json!(v),
        }
    }
    /// An ayah timestamp: usually well formed (a broken one rejects the whole file).
    fn timestamp(&mut self, v: i64) -> Value {
        if self.chance(20) {
            self.number(v)
        } else {
            json!(v)
        }
    }
}

/// Random payloads with every defect: the sanitiser never panics, and what it accepts satisfies the invariants the
/// audio engine relies on.
#[test]
fn random_payloads_never_break_the_invariants() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut accepted = 0;
    for _ in 0..3000 {
        let n = u32::try_from(rng.below(12) + 1).unwrap();
        let mut rows = Vec::new();
        let mut t: i64 = 0;
        for a in 1..=n {
            let len = i64::try_from(rng.below(5000)).unwrap() - 300;
            let mut segments = Vec::new();
            for p in 1..=rng.below(6) {
                if rng.chance(10) {
                    segments.push(json!([p]));
                    continue;
                }
                let s = t + i64::try_from(rng.below(5200)).unwrap() - 200;
                let e = s + i64::try_from(rng.below(2000)).unwrap() - 100;
                segments.push(json!([
                    rng.number(i64::try_from(p).unwrap()),
                    rng.number(s),
                    rng.number(e)
                ]));
            }
            let key = if rng.chance(3) {
                format!("{}:{a}", n + 1)
            } else {
                format!("1:{a}")
            };
            rows.push(json!({"verse_key": key, "timestamp_from": rng.timestamp(t), "timestamp_to": rng.timestamp(t + len),
                             "segments": segments}));
            if rng.chance(4) {
                rows.push(
                    json!({"verse_key": format!("1:{a}"), "timestamp_from": t, "timestamp_to": t}),
                );
            }
            t += len.max(0);
        }
        if rng.chance(20) {
            let i = usize::try_from(rng.below(u64::from(n))).unwrap();
            rows.swap(0, i);
        }
        let payload = file(json!(1), Value::Array(rows));
        let Ok((ayahs, _)) = sanitize_qdc(&payload, n) else {
            continue;
        };
        accepted += 1;
        assert_eq!(
            ayahs.iter().map(|a| a.ayah).collect::<Vec<_>>(),
            (1..=n).collect::<Vec<_>>()
        );
        assert!(ayahs.windows(2).all(|p| p[0].from_ms <= p[1].from_ms));
        let any_words = ayahs.iter().any(|a| !a.words.is_empty());
        assert_eq!(
            any_words,
            is_word_level(&ayahs),
            "all ayahs have words, or none"
        );
        for a in &ayahs {
            assert!(a.to_ms >= a.from_ms);
            assert!(a.words.windows(2).all(|p| p[0].start_ms <= p[1].start_ms));
            for x in &a.words {
                assert!(x.pos >= 1);
                assert!(
                    a.from_ms <= x.start_ms && x.start_ms < x.end_ms && x.end_ms <= a.to_ms,
                    "{a:?}"
                );
            }
        }
    }
    assert!(
        accepted > 300,
        "only {accepted} payloads were accepted: the generator is too hostile"
    );
}

/// Saved real QDC `audio_files?chapter=N&segments=true` responses (`QD_QDC_TIMINGS_DIR=<dir of *.json>`): every file
/// sanitises, with only the known repairs.
#[test]
#[ignore = "needs QD_QDC_TIMINGS_DIR with saved QDC responses (QF content is never committed)"]
fn real_qdc_files_sanitise_cleanly() {
    // `cargo test -p quran-core -- --ignored` (CI's test-core) runs every ignored test, and saved QDC responses exist
    // only where a developer placed them: without them there is nothing to check.
    let Some(dir) = std::env::var_os("QD_QDC_TIMINGS_DIR") else {
        eprintln!(
            "SKIPPED real_qdc_files_sanitise_cleanly: set QD_QDC_TIMINGS_DIR to a folder of saved responses"
        );
        return;
    };
    let mut checked = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let json: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let Some(files) = json.get("audio_files").and_then(Value::as_array) else {
            continue;
        };
        for f in files {
            if f.get("verse_timings").is_none() {
                continue;
            }
            let info = qdc_file_info(f).unwrap();
            let count =
                quran_core::content_db::geometry::surah_ayah_count(info.chapter_id).unwrap();
            let (ayahs, report) =
                sanitize_qdc(f, count).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            assert_eq!(ayahs.len(), usize::try_from(count).unwrap());
            println!(
                "{} surah {}: word_level={} {report:?}",
                path.file_name().unwrap().to_string_lossy(),
                info.chapter_id,
                is_word_level(&ayahs)
            );
            checked += 1;
        }
    }
    assert!(checked > 0, "no QDC audio files with verse_timings found");
}
