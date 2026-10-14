//! Highlight invariants under random edits: a seeded sequence of set / clear / delete /
//! restore calls is replayed against a per-ayah colour model. After every call the live rows must be exactly the maximal
//! same-colour runs of the model: no two rows overlap, and same-colour rows never touch.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use quran_core::UserDb;
use quran_types::{Highlight, HighlightColor, HighlightInput, TagInput, TaggableKind};
use support::user::{T0, TempUserDb};

const COLORS: [HighlightColor; 5] = [
    HighlightColor::Yellow,
    HighlightColor::Green,
    HighlightColor::Blue,
    HighlightColor::Red,
    HighlightColor::Purple,
];

/// Ayahs `1..=SPAN` are edited, so ranges collide often.
const SPAN: u32 = 48;

/// xorshift64: deterministic and dependency-free.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: u32) -> u32 {
        u32::try_from(self.next() % u64::from(n)).unwrap()
    }

    /// A range inside `1..=SPAN`: mostly short, sometimes long.
    fn range(&mut self) -> (u32, u32) {
        let from = 1 + self.below(SPAN);
        let len = if self.below(5) == 0 {
            self.below(SPAN)
        } else {
            self.below(4)
        };
        (from, (from + len).min(SPAN))
    }
}

/// The colour of each ayah `0..=SPAN` (index 0 unused).
type Model = Vec<Option<HighlightColor>>;

fn paint(model: &mut Model, from: u32, to: u32, color: Option<HighlightColor>) {
    for a in from..=to {
        model[a as usize] = color;
    }
}

/// Maximal same-colour runs of the model.
fn runs(model: &Model) -> Vec<(u32, u32, HighlightColor)> {
    let mut out: Vec<(u32, u32, HighlightColor)> = Vec::new();
    for a in 1..=SPAN {
        let Some(color) = model[a as usize] else {
            continue;
        };
        match out.last_mut() {
            Some(last) if last.1 + 1 == a && last.2 == color => last.1 = a,
            _ => out.push((a, a, color)),
        }
    }
    out
}

fn live(db: &UserDb) -> Vec<(u32, u32, HighlightColor)> {
    db.highlights_list(None)
        .unwrap()
        .into_iter()
        .map(|h| (h.from_ayah_id, h.to_ayah_id, h.color))
        .collect()
}

fn tombstoned(db: &UserDb) -> Vec<String> {
    db.with(|c| {
        let mut stmt =
            c.prepare("SELECT id FROM highlight WHERE deleted_at IS NOT NULL ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(rows)
    })
    .unwrap()
}

/// The stored range and colour of any row (live or not).
fn stored(db: &UserDb, id: &str) -> (u32, u32, HighlightColor) {
    let (from, to, color): (u32, u32, String) = db
        .with(|c| {
            Ok(c.query_row(
                "SELECT from_ayah_id, to_ayah_id, color FROM highlight WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .unwrap();
    let color = serde_json::from_value(serde_json::Value::String(color)).unwrap();
    (from, to, color)
}

fn replay(seed: u64, steps: usize) {
    let t = TempUserDb::at(T0);
    let db = &t.db;
    let mut rng = Rng(seed);
    let mut model: Model = vec![None; SPAN as usize + 1];
    for step in 0..steps {
        let op = rng.below(100);
        let what = if op < 60 {
            let (from, to) = rng.range();
            let color = COLORS[rng.below(5) as usize];
            let h = db
                .highlight_set(&HighlightInput {
                    from_ayah_id: from,
                    to_ayah_id: to,
                    color,
                })
                .unwrap();
            assert!(
                h.from_ayah_id <= from && h.to_ayah_id >= to && h.color == color,
                "step {step}: set {from}..={to} {color:?} returned {h:?}"
            );
            paint(&mut model, from, to, Some(color));
            format!("set {from}..={to} {color:?}")
        } else if op < 75 {
            let (from, to) = rng.range();
            let before: Vec<(u32, u32, HighlightColor)> = live(db)
                .into_iter()
                .filter(|&(f, t, _)| f <= to && t >= from)
                .collect();
            let removed: Vec<(u32, u32, HighlightColor)> = db
                .highlight_clear_range(from, to)
                .unwrap()
                .into_iter()
                .map(|h| (h.from_ayah_id, h.to_ayah_id, h.color))
                .collect();
            assert_eq!(
                removed, before,
                "step {step}: clear returns the rows as they were"
            );
            paint(&mut model, from, to, None);
            format!("clear {from}..={to}")
        } else if op < 85 {
            let rows = db.highlights_list(None).unwrap();
            if rows.is_empty() {
                continue;
            }
            let victim = &rows[rng.below(u32::try_from(rows.len()).unwrap()) as usize];
            assert_eq!(&db.highlight_delete(&victim.id).unwrap(), victim);
            paint(&mut model, victim.from_ayah_id, victim.to_ayah_id, None);
            format!("delete {}..={}", victim.from_ayah_id, victim.to_ayah_id)
        } else {
            let dead = tombstoned(db);
            if dead.is_empty() {
                continue;
            }
            let id = &dead[rng.below(u32::try_from(dead.len()).unwrap()) as usize];
            let (from, to, color) = stored(db, id);
            let back = db.highlight_restore(id).unwrap();
            assert_eq!(&back.id, id, "step {step}: restore keeps the id");
            assert!(back.from_ayah_id <= from && back.to_ayah_id >= to);
            paint(&mut model, from, to, Some(color));
            format!("restore {from}..={to} {color:?}")
        };
        assert_eq!(live(db), runs(&model), "seed {seed}, step {step}: {what}");
    }
}

#[test]
fn random_edits_keep_the_rows_canonical() {
    for seed in [0x9E37_79B9_7F4A_7C15, 42, 0xDEAD_BEEF, 7_777_777] {
        replay(seed, 300);
    }
}

#[test]
fn tags_follow_their_highlight_through_splits_merges_and_restores() {
    let t = TempUserDb::at(T0);
    let db = &t.db;
    let tag = db
        .tag_upsert(&TagInput {
            id: None,
            name: "dua".into(),
            color: None,
        })
        .unwrap();
    let set = |from, to, color| -> Highlight {
        db.highlight_set(&HighlightInput {
            from_ayah_id: from,
            to_ayah_id: to,
            color,
        })
        .unwrap()
    };
    let h = set(100, 120, HighlightColor::Green);
    db.item_tags_set(
        TaggableKind::Highlight,
        &h.id,
        std::slice::from_ref(&tag.id),
    )
    .unwrap();
    set(110, 110, HighlightColor::Red);
    let rows = db.highlights_list(Some(HighlightColor::Green)).unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.tag_ids == [tag.id.as_str()]));
    // Painting the gap green merges both halves back into the original row, tags intact.
    let merged = set(110, 110, HighlightColor::Green);
    assert_eq!(merged.id, h.id);
    assert_eq!((merged.from_ayah_id, merged.to_ayah_id), (100, 120));
    assert_eq!(merged.tag_ids, [tag.id.as_str()]);
    assert_eq!(
        db.tags_list().unwrap()[0].usage_count,
        1,
        "one live highlight"
    );
    // Delete + restore keeps the tags.
    db.highlight_delete(&h.id).unwrap();
    assert_eq!(db.tags_list().unwrap()[0].usage_count, 0);
    let back = db.highlight_restore(&h.id).unwrap();
    assert_eq!(back.tag_ids, [tag.id.as_str()]);
}

#[test]
fn highlights_survive_a_reopen() {
    let t = TempUserDb::new();
    t.db.highlight_set(&HighlightInput {
        from_ayah_id: 1,
        to_ayah_id: 7,
        color: HighlightColor::Yellow,
    })
    .unwrap();
    t.db.highlight_set(&HighlightInput {
        from_ayah_id: 3,
        to_ayah_id: 4,
        color: HighlightColor::Blue,
    })
    .unwrap();
    let before = t.db.highlights_list(None).unwrap();
    assert_eq!(before.len(), 3);
    assert_eq!(t.reopen().highlights_list(None).unwrap(), before);
}
