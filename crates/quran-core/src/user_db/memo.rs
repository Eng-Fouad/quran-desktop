//! Memorisation progress, the deterministic Leitner-style schedule (D25, §5.10) and self-tests. Owner: WP2b.
//!
//! **Schedule** ([`schedule_review`], applied to every ayah of a reviewed range; `s` is the strength before the review):
//!
//! | rating | new strength | lapses | due |
//! |---|---|---|---|
//! | 1 (again) | `max(s−2, 0)` | +1 | now + 10 min |
//! | 2 (hard) | `max(s, 1)` | | now + 1 day |
//! | 3 (good) | `min(s+1, 5)` | | now + 2^s days |
//! | 4 (easy) | `min(s+2, 5)` | | now + 2^(s+1) days |
//!
//! The stored status is `memorized` when the new strength is ≥ 4, else `learning`. When read, a `memorized` ayah whose
//! `due_at` has passed is returned as `review`. An ayah without a row is `new` with strength 0; `memo_progress`
//! returns stored rows only (sparse), while the mutating calls return one entry per ayah of their range.
//!
//! **Manual status** (`memo_set_status`): `new` deletes the rows (a full reset); `learning` caps the strength at 3 and
//! makes the ayahs due now; `memorized` raises the strength to at least 4 and schedules the next review like a "good"
//! answer at that strength; `review` makes the ayahs due now. Review counts and lapses are kept.

use std::collections::HashMap;

use quran_types::{MemoProgress, MemoReviewInput, MemoStatus, MemoTest, MemoTestResult};
use rusqlite::{OptionalExtension, Row, Transaction, params};

use super::{
    DAY_MS, UserDb, check_ayah, check_ayah_range, col_u32, ms_to_secs, opt_col_u32, opt_ms_to_secs,
};
use crate::{CoreError, Result};

/// Highest strength of the schedule.
pub const MAX_STRENGTH: u32 = 5;
/// Strength from which an ayah counts as memorised.
pub const MEMORIZED_STRENGTH: u32 = 4;
/// "Again": due in 10 minutes.
const AGAIN_MS: i64 = 10 * 60 * 1000;

/// One ayah's schedule state: a `memo_ayah` row without its ayah id, timestamps in Unix milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MemoSchedule {
    /// The stored status (`review` only after `memo_set_status(review)`; reads derive it for overdue ayahs).
    pub status: MemoStatus,
    /// 0..=5.
    pub strength: u32,
    pub reviews: u32,
    pub lapses: u32,
    pub last_reviewed_at: Option<i64>,
    pub due_at: Option<i64>,
}

impl MemoSchedule {
    /// An ayah that has never been reviewed (no row).
    pub const NEW: Self = Self {
        status: MemoStatus::New,
        strength: 0,
        reviews: 0,
        lapses: 0,
        last_reviewed_at: None,
        due_at: None,
    };

    /// The status a reader sees at `now_ms`: an overdue `memorized` ayah is `review`.
    #[must_use]
    pub fn effective_status(&self, now_ms: i64) -> MemoStatus {
        match (self.status, self.due_at) {
            (MemoStatus::Memorized, Some(due)) if due < now_ms => MemoStatus::Review,
            (status, _) => status,
        }
    }

    fn progress(&self, ayah_id: u32, now_ms: i64) -> MemoProgress {
        MemoProgress {
            ayah_id,
            status: self.effective_status(now_ms),
            strength: self.strength,
            reviews: self.reviews,
            lapses: self.lapses,
            last_reviewed_at: opt_ms_to_secs(self.last_reviewed_at),
            due_at: opt_ms_to_secs(self.due_at),
        }
    }
}

/// `2^exp` days in milliseconds (`exp` ≤ 6 here).
fn days_pow2(exp: u32) -> i64 {
    DAY_MS.saturating_mul(1_i64.checked_shl(exp.min(30)).unwrap_or(i64::MAX))
}

/// Applies one review with `rating` (1 again, 2 hard, 3 good, 4 easy) at `now_ms` (the §5.10 table).
///
/// # Errors
/// `InvalidArgument` for a rating outside 1..=4.
pub fn schedule_review(prev: MemoSchedule, rating: u32, now_ms: i64) -> Result<MemoSchedule> {
    let s = prev.strength.min(MAX_STRENGTH);
    let (strength, lapses, interval) = match rating {
        1 => (s.saturating_sub(2), prev.lapses.saturating_add(1), AGAIN_MS),
        2 => (s.max(1), prev.lapses, DAY_MS),
        3 => ((s + 1).min(MAX_STRENGTH), prev.lapses, days_pow2(s)),
        4 => ((s + 2).min(MAX_STRENGTH), prev.lapses, days_pow2(s + 1)),
        _ => {
            return Err(CoreError::InvalidArgument(format!(
                "rating {rating} is not 1..=4"
            )));
        }
    };
    Ok(MemoSchedule {
        status: if strength >= MEMORIZED_STRENGTH {
            MemoStatus::Memorized
        } else {
            MemoStatus::Learning
        },
        strength,
        reviews: prev.reviews.saturating_add(1),
        lapses,
        last_reviewed_at: Some(now_ms),
        due_at: Some(now_ms.saturating_add(interval)),
    })
}

/// The manual status change of `memo_set_status` (see the module docs); `None` means "delete the row".
fn schedule_set_status(
    prev: MemoSchedule,
    status: MemoStatus,
    now_ms: i64,
) -> Option<MemoSchedule> {
    let s = prev.strength.min(MAX_STRENGTH);
    match status {
        MemoStatus::New => None,
        MemoStatus::Learning => Some(MemoSchedule {
            status: MemoStatus::Learning,
            strength: s.min(MEMORIZED_STRENGTH - 1),
            due_at: Some(now_ms),
            ..prev
        }),
        MemoStatus::Memorized => {
            let strength = s.max(MEMORIZED_STRENGTH);
            Some(MemoSchedule {
                status: MemoStatus::Memorized,
                strength,
                due_at: Some(now_ms.saturating_add(days_pow2(strength))),
                ..prev
            })
        }
        MemoStatus::Review => Some(MemoSchedule {
            status: MemoStatus::Review,
            strength: s,
            due_at: Some(now_ms),
            ..prev
        }),
    }
}

const fn status_str(s: MemoStatus) -> &'static str {
    match s {
        MemoStatus::New => "new",
        MemoStatus::Learning => "learning",
        MemoStatus::Memorized => "memorized",
        MemoStatus::Review => "review",
    }
}

fn parse_status(s: &str) -> Result<MemoStatus> {
    Ok(match s {
        "new" => MemoStatus::New,
        "learning" => MemoStatus::Learning,
        "memorized" => MemoStatus::Memorized,
        "review" => MemoStatus::Review,
        other => return Err(CoreError::Corrupt(format!("memo_ayah.status = {other:?}"))),
    })
}

type RawMemo = (i64, String, i64, i64, i64, Option<i64>, Option<i64>);

fn raw_memo(r: &Row<'_>) -> rusqlite::Result<RawMemo> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
    ))
}

fn schedule_from_raw(raw: RawMemo) -> Result<(u32, MemoSchedule)> {
    let (ayah_id, status, strength, reviews, lapses, last_reviewed_at, due_at) = raw;
    Ok((
        col_u32(ayah_id, "memo_ayah.ayah_id")?,
        MemoSchedule {
            status: parse_status(&status)?,
            strength: col_u32(strength, "memo_ayah.strength")?,
            reviews: col_u32(reviews, "memo_ayah.reviews")?,
            lapses: col_u32(lapses, "memo_ayah.lapses")?,
            last_reviewed_at,
            due_at,
        },
    ))
}

/// Stored rows of `from..=to`, in ayah order.
fn load_range(c: &rusqlite::Connection, from: u32, to: u32) -> Result<Vec<(u32, MemoSchedule)>> {
    let mut stmt = c.prepare_cached(
        "SELECT ayah_id, status, strength, reviews, lapses, last_reviewed_at, due_at FROM memo_ayah
         WHERE ayah_id BETWEEN ?1 AND ?2 ORDER BY ayah_id",
    )?;
    let raws = stmt
        .query_map([from, to], raw_memo)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    raws.into_iter().map(schedule_from_raw).collect()
}

/// Applies `next(prev)` to every ayah of `from..=to` in one transaction (a `None` deletes the row) and returns one
/// entry per ayah.
fn update_range(
    tx: &Transaction<'_>,
    from: u32,
    to: u32,
    now_ms: i64,
    mut next: impl FnMut(MemoSchedule) -> Result<Option<MemoSchedule>>,
) -> Result<Vec<MemoProgress>> {
    let existing: HashMap<u32, MemoSchedule> = load_range(tx, from, to)?.into_iter().collect();
    let mut upsert = tx.prepare_cached(
        "INSERT INTO memo_ayah (ayah_id, status, strength, reviews, lapses, last_reviewed_at, due_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (ayah_id) DO UPDATE SET status = excluded.status, strength = excluded.strength,
           reviews = excluded.reviews, lapses = excluded.lapses, last_reviewed_at = excluded.last_reviewed_at,
           due_at = excluded.due_at, updated_at = excluded.updated_at",
    )?;
    let mut delete = tx.prepare_cached("DELETE FROM memo_ayah WHERE ayah_id = ?1")?;
    let mut out = Vec::with_capacity(usize::try_from(to - from + 1).unwrap_or(0));
    for ayah_id in from..=to {
        let prev = existing.get(&ayah_id).copied().unwrap_or(MemoSchedule::NEW);
        match next(prev)? {
            Some(s) => {
                upsert.execute(params![
                    ayah_id,
                    status_str(s.status),
                    s.strength,
                    s.reviews,
                    s.lapses,
                    s.last_reviewed_at,
                    s.due_at,
                    now_ms,
                ])?;
                out.push(s.progress(ayah_id, now_ms));
            }
            None => {
                if existing.contains_key(&ayah_id) {
                    delete.execute([ayah_id])?;
                }
                out.push(MemoSchedule::NEW.progress(ayah_id, now_ms));
            }
        }
    }
    Ok(out)
}

type RawTest = (
    i64,
    i64,
    i64,
    i64,
    i64,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
);

fn memo_test_row(r: &Row<'_>) -> rusqlite::Result<RawTest> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get(4)?,
        r.get(5)?,
        r.get(6)?,
        r.get(7)?,
        r.get(8)?,
    ))
}

fn load_test(c: &rusqlite::Connection, id: u32) -> Result<Option<MemoTest>> {
    let raw = c
        .prepare_cached(
            "SELECT id, from_ayah_id, to_ayah_id, start_ayah_id, started_at, finished_at, reveals, mistakes, rating
             FROM memo_test WHERE id = ?1",
        )?
        .query_row([id], memo_test_row)
        .optional()?;
    let Some((id, from, to, start, started_at, finished_at, reveals, mistakes, rating)) = raw
    else {
        return Ok(None);
    };
    Ok(Some(MemoTest {
        id: col_u32(id, "memo_test.id")?,
        from_ayah_id: col_u32(from, "memo_test.from_ayah_id")?,
        to_ayah_id: col_u32(to, "memo_test.to_ayah_id")?,
        start_ayah_id: col_u32(start, "memo_test.start_ayah_id")?,
        started_at: ms_to_secs(started_at),
        finished_at: opt_ms_to_secs(finished_at),
        reveals: opt_col_u32(reveals, "memo_test.reveals")?,
        mistakes: opt_col_u32(mistakes, "memo_test.mistakes")?,
        rating: opt_col_u32(rating, "memo_test.rating")?,
    }))
}

fn check_rating(rating: u32) -> Result<()> {
    if (1..=4).contains(&rating) {
        Ok(())
    } else {
        Err(CoreError::InvalidArgument(format!(
            "rating {rating} is not 1..=4"
        )))
    }
}

impl UserDb {
    /// Stored progress of `from..=to` in ayah order (sparse: ayahs without a row are `new`), with `review` derived for
    /// overdue memorised ayahs.
    pub fn memo_progress(&self, from: u32, to: u32) -> Result<Vec<MemoProgress>> {
        check_ayah_range(from, to)?;
        let now = self.now_ms();
        let rows = self.with(|c| load_range(c, from, to))?;
        Ok(rows
            .into_iter()
            .map(|(ayah_id, s)| s.progress(ayah_id, now))
            .collect())
    }

    /// Sets the status of every ayah of the range (see the module docs); returns one entry per ayah.
    pub fn memo_set_status(
        &self,
        from: u32,
        to: u32,
        status: MemoStatus,
    ) -> Result<Vec<MemoProgress>> {
        check_ayah_range(from, to)?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            update_range(tx, from, to, now, |prev| {
                Ok(schedule_set_status(prev, status, now))
            })
        })
    }

    /// Applies one review (§5.10 table) to every ayah of the range; returns one entry per ayah. `mistakes` is
    /// informational (the schedule uses the rating only).
    pub fn memo_review(&self, input: &MemoReviewInput) -> Result<Vec<MemoProgress>> {
        check_ayah_range(input.from_ayah_id, input.to_ayah_id)?;
        check_rating(input.rating)?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            update_range(tx, input.from_ayah_id, input.to_ayah_id, now, |prev| {
                schedule_review(prev, input.rating, now).map(Some)
            })
        })
    }

    /// `start_ayah` is chosen by the caller (the command picks it at random within `from..=to`).
    pub fn memo_test_start(&self, from: u32, to: u32, start_ayah: u32) -> Result<MemoTest> {
        check_ayah_range(from, to)?;
        check_ayah(start_ayah, "start ayah")?;
        if !(from..=to).contains(&start_ayah) {
            return Err(CoreError::InvalidArgument(format!(
                "start ayah {start_ayah} is outside {from}..={to}"
            )));
        }
        let now = self.now_ms();
        self.with_tx(|tx| {
            tx.prepare_cached(
                "INSERT INTO memo_test (from_ayah_id, to_ayah_id, start_ayah_id, started_at) VALUES (?1, ?2, ?3, ?4)",
            )?
            .execute(params![from, to, start_ayah, now])?;
            let id = col_u32(tx.last_insert_rowid(), "memo_test.id")?;
            load_test(tx, id)?.ok_or_else(|| CoreError::NotFound(format!("memo test {id}")))
        })
    }

    /// Records the result of a running test. A finished test cannot be finished again (`InvalidArgument`); an unknown
    /// id is `NotFound`. The schedule is not changed here (the UI rates the range with `memo_review`).
    pub fn memo_test_finish(&self, input: &MemoTestResult) -> Result<MemoTest> {
        check_rating(input.rating)?;
        let now = self.now_ms();
        self.with_tx(|tx| {
            let changed = tx
                .prepare_cached(
                    "UPDATE memo_test SET finished_at = ?2, reveals = ?3, mistakes = ?4, rating = ?5
                     WHERE id = ?1 AND finished_at IS NULL",
                )?
                .execute(params![input.id, now, input.reveals, input.mistakes, input.rating])?;
            match load_test(tx, input.id)? {
                Some(test) if changed > 0 => Ok(test),
                Some(_) => Err(CoreError::InvalidArgument(format!(
                    "memo test {} is already finished",
                    input.id
                ))),
                None => Err(CoreError::NotFound(format!("memo test {}", input.id))),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn temp_db() -> (tempfile::TempDir, UserDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = UserDb::open(&dir.path().join("user.db")).unwrap();
        db.set_test_clock(Some(T0));
        (dir, db)
    }

    fn with_strength(s: u32) -> MemoSchedule {
        MemoSchedule {
            status: MemoStatus::Learning,
            strength: s,
            reviews: 3,
            lapses: 1,
            ..MemoSchedule::NEW
        }
    }

    #[test]
    fn the_schedule_follows_the_table_for_every_strength() {
        for s in 0..=MAX_STRENGTH {
            let prev = with_strength(s);
            let again = schedule_review(prev, 1, T0).unwrap();
            assert_eq!(
                (again.strength, again.lapses, again.due_at),
                (s.saturating_sub(2), 2, Some(T0 + AGAIN_MS))
            );
            let hard = schedule_review(prev, 2, T0).unwrap();
            assert_eq!(
                (hard.strength, hard.lapses, hard.due_at),
                (s.max(1), 1, Some(T0 + DAY_MS))
            );
            let good = schedule_review(prev, 3, T0).unwrap();
            assert_eq!(
                (good.strength, good.due_at),
                ((s + 1).min(5), Some(T0 + DAY_MS * (1 << s)))
            );
            let easy = schedule_review(prev, 4, T0).unwrap();
            assert_eq!(
                (easy.strength, easy.due_at),
                ((s + 2).min(5), Some(T0 + DAY_MS * (1 << (s + 1))))
            );
            for next in [again, hard, good, easy] {
                assert_eq!(next.reviews, 4);
                assert_eq!(next.last_reviewed_at, Some(T0));
                let expected = if next.strength >= 4 {
                    MemoStatus::Memorized
                } else {
                    MemoStatus::Learning
                };
                assert_eq!(next.status, expected);
            }
        }
        assert!(matches!(
            schedule_review(MemoSchedule::NEW, 0, T0),
            Err(CoreError::InvalidArgument(_))
        ));
        assert!(matches!(
            schedule_review(MemoSchedule::NEW, 5, T0),
            Err(CoreError::InvalidArgument(_))
        ));
    }

    #[test]
    fn a_new_ayah_reaches_memorized_after_four_good_reviews() {
        let mut s = MemoSchedule::NEW;
        let mut now = T0;
        let mut intervals = Vec::new();
        for _ in 0..4 {
            s = schedule_review(s, 3, now).unwrap();
            intervals.push((s.due_at.unwrap() - now) / DAY_MS);
            now = s.due_at.unwrap();
        }
        assert_eq!(intervals, [1, 2, 4, 8]);
        assert_eq!((s.status, s.strength), (MemoStatus::Memorized, 4));
    }

    #[test]
    fn overdue_memorized_reads_as_review() {
        let s = MemoSchedule {
            status: MemoStatus::Memorized,
            due_at: Some(T0),
            ..with_strength(4)
        };
        assert_eq!(s.effective_status(T0), MemoStatus::Memorized);
        assert_eq!(s.effective_status(T0 + 1), MemoStatus::Review);
        let learning = MemoSchedule {
            due_at: Some(T0),
            ..with_strength(2)
        };
        assert_eq!(learning.effective_status(T0 + 1), MemoStatus::Learning);
    }

    #[test]
    fn review_writes_every_ayah_and_progress_is_sparse() {
        let (_dir, db) = temp_db();
        assert!(db.memo_progress(1, 7).unwrap().is_empty());
        let out = db
            .memo_review(&MemoReviewInput {
                from_ayah_id: 2,
                to_ayah_id: 4,
                rating: 3,
                mistakes: 1,
            })
            .unwrap();
        assert_eq!(out.iter().map(|p| p.ayah_id).collect::<Vec<_>>(), [2, 3, 4]);
        assert!(
            out.iter()
                .all(|p| p.status == MemoStatus::Learning && p.strength == 1 && p.reviews == 1)
        );
        assert_eq!(out[0].due_at, Some(1_700_000_000 + 86_400));
        assert_eq!(out[0].last_reviewed_at, Some(1_700_000_000));
        let progress = db.memo_progress(1, 7).unwrap();
        assert_eq!(progress, out);

        // Easy twice → strength 1 + 2 + 2 = 5 → memorized; overdue later → review.
        db.memo_review(&MemoReviewInput {
            from_ayah_id: 3,
            to_ayah_id: 3,
            rating: 4,
            mistakes: 0,
        })
        .unwrap();
        let p = db
            .memo_review(&MemoReviewInput {
                from_ayah_id: 3,
                to_ayah_id: 3,
                rating: 4,
                mistakes: 0,
            })
            .unwrap();
        assert_eq!(
            (p[0].status, p[0].strength, p[0].reviews),
            (MemoStatus::Memorized, 5, 3)
        );
        let due_ms = i64::from(p[0].due_at.unwrap()) * 1000;
        db.set_test_clock(Some(due_ms + 1_000));
        let later = db.memo_progress(3, 3).unwrap();
        assert_eq!(later[0].status, MemoStatus::Review);
    }

    #[test]
    fn set_status_resets_marks_and_flags() {
        let (_dir, db) = temp_db();
        db.memo_review(&MemoReviewInput {
            from_ayah_id: 1,
            to_ayah_id: 7,
            rating: 1,
            mistakes: 3,
        })
        .unwrap();
        let memorized = db.memo_set_status(1, 3, MemoStatus::Memorized).unwrap();
        assert!(
            memorized
                .iter()
                .all(|p| p.status == MemoStatus::Memorized && p.strength == 4 && p.lapses == 1)
        );
        assert_eq!(memorized[0].due_at, Some(1_700_000_000 + 16 * 86_400));
        let learning = db.memo_set_status(2, 2, MemoStatus::Learning).unwrap();
        assert_eq!(
            (learning[0].status, learning[0].strength),
            (MemoStatus::Learning, 3)
        );
        assert_eq!(learning[0].due_at, Some(1_700_000_000));
        let review = db.memo_set_status(3, 3, MemoStatus::Review).unwrap();
        assert_eq!(
            (review[0].status, review[0].strength),
            (MemoStatus::Review, 4)
        );
        let reset = db.memo_set_status(5, 9, MemoStatus::New).unwrap();
        assert_eq!(reset.len(), 5);
        assert!(
            reset
                .iter()
                .all(|p| p.status == MemoStatus::New && p.strength == 0 && p.due_at.is_none())
        );
        assert_eq!(
            db.memo_progress(1, 10)
                .unwrap()
                .iter()
                .map(|p| p.ayah_id)
                .collect::<Vec<_>>(),
            [1, 2, 3, 4]
        );
    }

    #[test]
    fn whole_quran_ranges_work_and_bad_input_is_rejected() {
        let (_dir, db) = temp_db();
        assert_eq!(
            db.memo_set_status(1, 6236, MemoStatus::Memorized)
                .unwrap()
                .len(),
            6236
        );
        assert_eq!(db.memo_progress(1, 6236).unwrap().len(), 6236);
        for (from, to) in [(0, 1), (2, 1), (1, 6237)] {
            assert!(matches!(
                db.memo_progress(from, to),
                Err(CoreError::InvalidArgument(_))
            ));
        }
        let bad = MemoReviewInput {
            from_ayah_id: 1,
            to_ayah_id: 1,
            rating: 0,
            mistakes: 0,
        };
        assert!(matches!(
            db.memo_review(&bad),
            Err(CoreError::InvalidArgument(_))
        ));
    }

    #[test]
    fn tests_start_and_finish_once() {
        let (_dir, db) = temp_db();
        let t = db.memo_test_start(8, 20, 12).unwrap();
        assert_eq!(
            (
                t.from_ayah_id,
                t.to_ayah_id,
                t.start_ayah_id,
                t.started_at,
                t.finished_at
            ),
            (8, 20, 12, 1_700_000_000, None)
        );
        db.set_test_clock(Some(T0 + 90_000));
        let done = db
            .memo_test_finish(&MemoTestResult {
                id: t.id,
                reveals: 2,
                mistakes: 1,
                rating: 3,
            })
            .unwrap();
        assert_eq!(
            (done.finished_at, done.reveals, done.mistakes, done.rating),
            (Some(1_700_000_090), Some(2), Some(1), Some(3))
        );
        let again = db.memo_test_finish(&MemoTestResult {
            id: t.id,
            reveals: 0,
            mistakes: 0,
            rating: 4,
        });
        assert!(matches!(again, Err(CoreError::InvalidArgument(_))));
        let missing = db.memo_test_finish(&MemoTestResult {
            id: 999,
            reveals: 0,
            mistakes: 0,
            rating: 4,
        });
        assert!(matches!(missing, Err(CoreError::NotFound(_))));
        let bad_rating = db.memo_test_finish(&MemoTestResult {
            id: t.id,
            reveals: 0,
            mistakes: 0,
            rating: 5,
        });
        assert!(matches!(bad_rating, Err(CoreError::InvalidArgument(_))));
        assert!(matches!(
            db.memo_test_start(8, 20, 21),
            Err(CoreError::InvalidArgument(_))
        ));
        assert!(db.memo_test_start(8, 20, 8).unwrap().id > t.id);
    }
}
