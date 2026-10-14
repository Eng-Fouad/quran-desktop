//! Planner: `PlayRequest` + timings → `Vec<Segment>`.
//!
//! The planner turns an inclusive ayah range (possibly crossing surahs) into the queue the decode thread plays, in
//! mushaf order:
//! - a **Basmala** segment before every planned surah that starts at ayah 1, except surahs 1 and 9: the reciter's
//!   surah-1 file, range 1:1, when the basmala is not in the surah file (every QDC reciter), else `[0, ayah1.from)` of
//!   the surah's own file;
//! - one **Ayah** segment per ayah, `[from_ms, end)` where `end` is the next ayah's `from_ms` in **continuous** mode
//!   (`ayah_repeat == 1`, no gap: inter-ayah breaths play and boundaries are seamless markers), else `to_ms`.
//!
//! A basmala whose source is unavailable **because it is offline** ([`AudioError::Offline`] from the surah-1 timings) is
//! skipped, not the play: [`PlannedQueue::basmala_skipped`] reports it for `AudioSnapshot.basmala_skipped`. The same
//! rule for an uncached basmala *file* is applied where files are opened (control and decode):
//! [`PlannedQueue::skip_basmalas_in`] drops the basmala segments of a file whose `SourceProvider::open` was `Offline`.
//!
//! Blocking: [`plan`] calls [`TimingsSource`], so it runs on `qd-audio-ctl` only.

use std::ops::RangeInclusive;
use std::sync::Arc;

use quran_types::{AYAH_COUNT, AyahRef, GapSetting, PlayRequest, SURAH_COUNT, StopAt};

use crate::{AudioError, FileKey, SurahTimingSet, TimingsSource};

/// Surah 9 (At-Tawbah) has no basmala.
const SURAH_WITHOUT_BASMALA: u16 = 9;
/// The basmala clip is the reciter's surah-1 ayah-1 range.
const BASMALA_SURAH: u16 = 1;

/// What a [`Segment`] plays.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SegmentKind {
    Ayah,
    /// The basmala before surahs 2..=114 except 9: the reciter's surah-1 file 1:1 range, or `[0, ayah1.from)` when
    /// the basmala is in the file.
    Basmala,
}

/// One playable range of one file, in mushaf order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment {
    pub kind: SegmentKind,
    pub surah: u16,
    /// 0 for Basmala.
    pub ayah: u16,
    /// 0 for Basmala.
    pub ayah_id: u32,
    pub file: FileKey,
    pub start_ms: u32,
    /// Continuous mode: the next ayah's `from_ms` in the same file (breaths play, seamless markers); else `to_ms`.
    /// Never before `start_ms`.
    pub end_ms: u32,
    /// `(position, start_ms, end_ms)` on the file timeline, sorted by start.
    pub words: Arc<[(u16, u32, u32)]>,
}

impl Segment {
    /// `end_ms − start_ms`.
    #[must_use]
    pub fn duration_ms(&self) -> u32 {
        self.end_ms.saturating_sub(self.start_ms)
    }

    /// Whether `ms` (file timeline) lies in `[start_ms, end_ms)`.
    #[must_use]
    pub fn contains_ms(&self, ms: u32) -> bool {
        ms >= self.start_ms && ms < self.end_ms
    }

    /// The ayah reference for UI events (`ayah = 0` during the basmala).
    #[must_use]
    pub fn ayah_ref(&self) -> AyahRef {
        AyahRef {
            surah: u32::from(self.surah),
            ayah: u32::from(self.ayah),
        }
    }

    /// The active word at `ms`: the last word with `start_ms ≤ ms`, held through inter-word gaps. `None` before the
    /// first word or when the segment has no word timings.
    #[must_use]
    pub fn word_at(&self, ms: u32) -> Option<u16> {
        let n = self.words.partition_point(|&(_, start, _)| start <= ms);
        n.checked_sub(1)
            .and_then(|i| self.words.get(i))
            .map(|&(pos, _, _)| pos)
    }
}

/// The planner's result: the queue plus what the snapshot must report about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedQueue {
    pub segments: Vec<Segment>,
    /// At least one basmala was skipped because it was offline and not cached (`AudioSnapshot.basmala_skipped`).
    pub basmala_skipped: bool,
}

impl PlannedQueue {
    /// Drops every Basmala segment that plays from `file` (its source turned out to be offline when control opened it)
    /// and sets [`Self::basmala_skipped`]. Returns how many were dropped. Ayah segments are never dropped: an ayah
    /// whose file is offline fails the play.
    pub fn skip_basmalas_in(&mut self, file: &FileKey) -> usize {
        let before = self.segments.len();
        self.segments
            .retain(|s| !(s.kind == SegmentKind::Basmala && &s.file == file));
        let dropped = before - self.segments.len();
        if dropped > 0 {
            log::info!(
                "audio plan: skipping {dropped} basmala segment(s): reciter {} surah-{} file is offline and not cached",
                file.reciter_id,
                file.surah
            );
            self.basmala_skipped = true;
        }
        dropped
    }
}

/// Plans `req.from ..= req.to` (`to` already resolved by the glue), possibly across surahs. An empty range, `from >
/// to`, or an ayah outside its surah is [`AudioError::Invalid`].
///
/// `to == None` is resolved here as a fallback: `stop_at == EndOfQuran` ⇒ 114:last, anything else ⇒ the end of
/// `from`'s surah (page and juz ends need the core DB, which the glue owns).
///
/// # Errors
/// [`AudioError::Invalid`] for a bad range; any error of [`TimingsSource::surah_timings`] for a planned surah
/// (including `Offline`); [`AudioError::Timings`] when a planned ayah has no timing. An offline **basmala** is skipped
/// instead (see [`plan_queue`]).
pub fn plan(req: &PlayRequest, src: &dyn TimingsSource) -> Result<Vec<Segment>, AudioError> {
    plan_queue(req, src).map(|q| q.segments)
}

/// [`plan`] plus the offline-basmala report ([`PlannedQueue::basmala_skipped`]).
///
/// # Errors
/// As [`plan`].
pub fn plan_queue(req: &PlayRequest, src: &dyn TimingsSource) -> Result<PlannedQueue, AudioError> {
    let (from_s, from_a) = checked_ref(req.from, src, "from")?;
    let (to_s, to_a) = match req.to {
        Some(to) => checked_ref(to, src, "to")?,
        None => default_to(req, src, from_s)?,
    };
    if (from_s, from_a) > (to_s, to_a) {
        return Err(AudioError::Invalid(format!(
            "play range {from_s}:{from_a} > {to_s}:{to_a}"
        )));
    }
    let ayahs = range_len(src, (from_s, from_a), (to_s, to_a));
    if ayahs == 0 || ayahs > u64::from(AYAH_COUNT) {
        return Err(AudioError::Invalid(format!(
            "play range {from_s}:{from_a}..={to_s}:{to_a} has {ayahs} ayahs"
        )));
    }

    let reciter = req.reciter_id;
    let continuous = is_continuous(req.ayah_repeat, req.gap);
    let flags = src.reciter_flags(reciter);
    let mut basmala_source: Option<Option<Arc<SurahTimingSet>>> = None;
    let mut out = PlannedQueue {
        segments: Vec::with_capacity(usize::try_from(ayahs).unwrap_or(0) + 4),
        basmala_skipped: false,
    };

    for surah in from_s..=to_s {
        let first = if surah == from_s { from_a } else { 1 };
        let last = if surah == to_s {
            to_a
        } else {
            src.surah_ayah_count(surah)
        };
        let timings = src.surah_timings(reciter, surah)?;
        if timings.surah != surah || timings.reciter_id != reciter {
            return Err(AudioError::Timings(format!(
                "asked for reciter {reciter} surah {surah}, got reciter {} surah {}",
                timings.reciter_id, timings.surah
            )));
        }

        if first == 1 && surah != BASMALA_SURAH && surah != SURAH_WITHOUT_BASMALA {
            let basmala = if flags.basmala_in_file {
                in_file_basmala(&timings)?
            } else {
                // Surah-1 timings are loaded once per plan: `Some(None)` records that they are offline.
                if basmala_source.is_none() {
                    basmala_source = Some(match src.surah_timings(reciter, BASMALA_SURAH) {
                        Ok(t) => Some(t),
                        Err(AudioError::Offline(why)) => {
                            log::info!(
                                "audio plan: reciter {reciter} surah 1 is offline ({why}): basmalas are skipped"
                            );
                            None
                        }
                        Err(e) => return Err(e),
                    });
                }
                match basmala_source.as_ref().and_then(Option::as_ref) {
                    Some(t1) => Some(surah1_basmala(t1, reciter)?),
                    None => {
                        log::info!("audio plan: basmala before surah {surah} skipped (offline)");
                        out.basmala_skipped = true;
                        None
                    }
                }
            };
            // A basmala without audio is left out rather than planned as a 0 ms segment (which would flash ayah 0 in
            // the UI and the OS media session): QDC reciter 173's surah-1 file has 1:1 at 80–80 ms, its file starting
            // after the basmala.
            let basmala = basmala.filter(|(_, start_ms, end_ms, _)| {
                let audible = end_ms > start_ms;
                if !audible {
                    log::info!(
                        "audio plan: reciter {reciter}: the basmala before surah {surah} has no audio; left out"
                    );
                }
                audible
            });
            if let Some((file, start_ms, end_ms, words)) = basmala {
                out.segments.push(Segment {
                    kind: SegmentKind::Basmala,
                    surah,
                    ayah: 0,
                    ayah_id: 0,
                    file,
                    start_ms,
                    end_ms: end_ms.max(start_ms),
                    words,
                });
            }
        }

        for ayah in first..=last {
            let span = timings.ayah(ayah).ok_or_else(|| {
                AudioError::Timings(format!("reciter {reciter}: no timing for {surah}:{ayah}"))
            })?;
            // Continuous: up to the next ayah of this file when that ayah is planned too (seamless marker), so the
            // breath between them plays. The last planned ayah, and every ayah in repeat/gap mode, ends at `to_ms`.
            let next_from = (continuous && (surah, ayah) < (to_s, to_a))
                .then(|| timings.ayah(ayah.saturating_add(1)))
                .flatten()
                .map(|next| next.from_ms);
            let end_ms = next_from.unwrap_or(span.to_ms).max(span.from_ms);
            out.segments.push(Segment {
                kind: SegmentKind::Ayah,
                surah,
                ayah,
                ayah_id: src.ayah_id(surah, ayah),
                file: timings.file.clone(),
                start_ms: span.from_ms,
                end_ms,
                words: Arc::from(span.words.as_slice()),
            });
        }
    }
    Ok(out)
}

/// Continuous mode: `ayah_repeat == 1` and no gap (a zero gap counts as none; A-B is not part of a play request and
/// suspends repeats anyway).
#[must_use]
pub fn is_continuous(ayah_repeat: u32, gap: GapSetting) -> bool {
    ayah_repeat == 1 && gap_is_none(gap)
}

/// `none`, `fixed{0}` and `multiplier{0}` all mean "no gap".
#[must_use]
pub fn gap_is_none(gap: GapSetting) -> bool {
    matches!(
        gap,
        GapSetting::None | GapSetting::Fixed { ms: 0 } | GapSetting::Multiplier { pct: 0 }
    )
}

/// The gap after one play of `seg`, in milliseconds of output time: `fixed{ms}` ⇒ `ms`, `multiplier{pct}` ⇒
/// `(end_ms − start_ms) × pct / 100`, both clamped to their setting limits. Basmala segments never get a gap.
#[must_use]
pub fn gap_ms(gap: GapSetting, seg: &Segment) -> u32 {
    if seg.kind != SegmentKind::Ayah {
        return 0;
    }
    match gap.clamped() {
        GapSetting::None => 0,
        GapSetting::Fixed { ms } => ms,
        GapSetting::Multiplier { pct } => {
            let ms = u64::from(seg.duration_ms()) * u64::from(pct) / 100;
            u32::try_from(ms).unwrap_or(u32::MAX)
        }
    }
}

/// The first Ayah segment of `ayah_id` (seek to an ayah, skip).
#[must_use]
pub fn index_of_ayah(queue: &[Segment], ayah_id: u32) -> Option<usize> {
    queue
        .iter()
        .position(|s| s.kind == SegmentKind::Ayah && s.ayah_id == ayah_id)
}

/// The segment that should become current when playback continues at `ms` on `file`'s timeline (seek, A-B wrap),
/// preferring segments close to index `near` (a file can appear several times: the surah-1 file backs every basmala):
/// a segment containing `ms`; else the first segment of `file` that starts after `ms` (playback runs into it); else the
/// last segment of `file` that starts before it. `None` when no segment uses `file`.
#[must_use]
pub fn segment_for_position(
    queue: &[Segment],
    file: &FileKey,
    ms: u32,
    near: usize,
) -> Option<usize> {
    let closest = |pred: &dyn Fn(&Segment) -> bool| {
        queue
            .iter()
            .enumerate()
            .filter(|(_, s)| &s.file == file && pred(s))
            .min_by_key(|(i, _)| (i.abs_diff(near), *i))
            .map(|(i, _)| i)
    };
    let of_file = || queue.iter().enumerate().filter(|(_, s)| &s.file == file);
    closest(&|s| s.contains_ms(ms))
        .or_else(|| {
            // In a breath or lead-in: the earliest segment starting after `ms`.
            of_file()
                .filter(|(_, s)| s.start_ms > ms)
                .min_by_key(|(i, s)| (s.start_ms, i.abs_diff(near)))
                .map(|(i, _)| i)
        })
        .or_else(|| {
            // Past every segment of the file: the latest one.
            of_file()
                .max_by_key(|(i, s)| (s.start_ms, std::cmp::Reverse(i.abs_diff(near))))
                .map(|(i, _)| i)
        })
}

/// The part of the file timeline that a seek or an A-B loop may reach while segment `idx` is heard: `[start, end]`,
/// from the start of the first to the end of the last segment of the **run** around `idx` (consecutive segments that
/// play the same file in order, each starting at or after the one before). Outside it is audio of that file the queue
/// does not play (the ayahs before or after the range, or the run's own surah when the file also backs a basmala
/// elsewhere in the queue), which [`segment_for_position`] would play under the label of the run's first or last
/// segment. `None` for an index outside the queue.
#[must_use]
pub fn file_run_span(queue: &[Segment], idx: usize) -> Option<(u32, u32)> {
    let run = queue.get(file_run(queue, idx)?)?;
    let start = run.first()?.start_ms;
    let end = run.iter().map(|s| s.end_ms).max().unwrap_or(start);
    Some((start, end.max(start)))
}

/// The indices of the run around `idx` (see [`file_run_span`]). `None` for an index outside the queue.
#[must_use]
pub fn file_run(queue: &[Segment], idx: usize) -> Option<RangeInclusive<usize>> {
    queue.get(idx)?;
    let in_order = |a: usize, b: usize| match (queue.get(a), queue.get(b)) {
        (Some(a), Some(b)) => a.file == b.file && b.start_ms >= a.start_ms,
        _ => false,
    };
    let mut first = idx;
    while let Some(before) = first.checked_sub(1)
        && in_order(before, first)
    {
        first = before;
    }
    let mut last = idx;
    while in_order(last, last + 1) {
        last += 1;
    }
    Some(first..=last)
}

/// Where a seek to `ms` on the timeline of segment `idx`'s file continues: `ms` bounded to the run around `idx`
/// ([`file_run_span`]; before it, its start, past it, its end, which ends the run's last segment at once) and the
/// segment of that run that becomes current ([`segment_for_position`] within the run, so a file that also backs a
/// basmala elsewhere in the queue never jumps there). `None` for an index outside the queue.
#[must_use]
pub fn seek_in_run(queue: &[Segment], idx: usize, ms: u32) -> Option<(usize, u32)> {
    let range = file_run(queue, idx)?;
    let first = *range.start();
    let run = queue.get(range)?;
    let (start, end) = file_run_span(queue, idx)?;
    let ms = ms.clamp(start, end);
    let file = &queue.get(idx)?.file;
    let at = segment_for_position(run, file, ms, idx - first)?;
    Some((first + at, ms))
}

/// `(surah, ayah)` of `r`, checked against the Quran structure the timings source reports.
fn checked_ref(r: AyahRef, src: &dyn TimingsSource, what: &str) -> Result<(u16, u16), AudioError> {
    let invalid = || AudioError::Invalid(format!("{what} {}:{} is not an ayah", r.surah, r.ayah));
    if r.surah == 0 || r.surah > SURAH_COUNT || r.ayah == 0 {
        return Err(invalid());
    }
    let surah = u16::try_from(r.surah).map_err(|_| invalid())?;
    let ayah = u16::try_from(r.ayah).map_err(|_| invalid())?;
    if ayah > src.surah_ayah_count(surah) {
        return Err(invalid());
    }
    Ok((surah, ayah))
}

/// Fallback when the glue left `to` unresolved.
fn default_to(
    req: &PlayRequest,
    src: &dyn TimingsSource,
    from_surah: u16,
) -> Result<(u16, u16), AudioError> {
    let surah = if req.stop_at == Some(StopAt::EndOfQuran) {
        u16::try_from(SURAH_COUNT).unwrap_or(u16::MAX)
    } else {
        from_surah
    };
    match src.surah_ayah_count(surah) {
        0 => Err(AudioError::Invalid(format!("surah {surah} has no ayahs"))),
        n => Ok((surah, n)),
    }
}

/// Number of ayahs in `from ..= to` (both valid, `from ≤ to`).
fn range_len(src: &dyn TimingsSource, from: (u16, u16), to: (u16, u16)) -> u64 {
    (from.0..=to.0)
        .map(|s| {
            let first = if s == from.0 { from.1 } else { 1 };
            let last = if s == to.0 {
                to.1
            } else {
                src.surah_ayah_count(s)
            };
            u64::from(last.saturating_sub(first)) + u64::from(last >= first)
        })
        .sum()
}

type BasmalaSource = (FileKey, u32, u32, Arc<[(u16, u32, u32)]>);

/// The 1:1 range of the reciter's surah-1 file (`basmala_in_file == false`).
fn surah1_basmala(t1: &SurahTimingSet, reciter: u32) -> Result<BasmalaSource, AudioError> {
    let span = t1.ayah(1).ok_or_else(|| {
        AudioError::Timings(format!("reciter {reciter}: no timing for 1:1 (basmala)"))
    })?;
    Ok((
        t1.file.clone(),
        span.from_ms,
        span.to_ms,
        Arc::from(span.words.as_slice()),
    ))
}

/// `[0, ayah1.from)` of the surah's own file (`basmala_in_file == true`); `None` when ayah 1 starts at 0.
fn in_file_basmala(t: &SurahTimingSet) -> Result<Option<BasmalaSource>, AudioError> {
    let span = t.ayah(1).ok_or_else(|| {
        AudioError::Timings(format!(
            "reciter {}: no timing for {}:1",
            t.reciter_id, t.surah
        ))
    })?;
    if span.from_ms == 0 {
        log::debug!(
            "audio plan: reciter {} surah {}: basmala in file but ayah 1 starts at 0",
            t.reciter_id,
            t.surah
        );
        return Ok(None);
    }
    Ok(Some((
        t.file.clone(),
        0,
        span.from_ms,
        Arc::from(Vec::new()),
    )))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use quran_types::MushafLayout;

    use super::*;
    use crate::ReciterFlags;
    use crate::fake_out::fixtures::FixtureTimings;

    fn req(from: (u32, u32), to: Option<(u32, u32)>) -> PlayRequest {
        PlayRequest {
            reciter_id: 7,
            from: AyahRef {
                surah: from.0,
                ayah: from.1,
            },
            to: to.map(|(surah, ayah)| AyahRef { surah, ayah }),
            stop_at: None,
            layout: MushafLayout::V2,
            ayah_repeat: 1,
            range_repeat: 1,
            gap: GapSetting::None,
            start_paused: false,
            record: true,
        }
    }

    #[test]
    fn continuous_single_surah_without_basmala_for_surah_1() {
        let src = FixtureTimings::new(7);
        let q = plan_queue(&req((1, 1), Some((1, 7))), &src).unwrap();
        assert!(!q.basmala_skipped);
        assert_eq!(q.segments.len(), 7);
        assert!(q.segments.iter().all(|s| s.kind == SegmentKind::Ayah));
        let t = src.timings(1);
        for (i, s) in q.segments.iter().enumerate() {
            let span = &t.ayahs[i];
            assert_eq!((s.surah, s.ayah, s.ayah_id), (1, span.ayah, 1 + i as u32));
            assert_eq!(s.start_ms, span.from_ms);
            let expected_end = t.ayahs.get(i + 1).map_or(span.to_ms, |n| n.from_ms);
            assert_eq!(s.end_ms, expected_end, "continuous end = next.from");
        }
        assert_eq!(q.segments[6].end_ms, t.ayahs[6].to_ms);
    }

    #[test]
    fn repeat_or_gap_ends_at_to_ms() {
        let src = FixtureTimings::new(7);
        let mut r = req((1, 2), Some((1, 4)));
        r.ayah_repeat = 3;
        let q = plan(&r, &src).unwrap();
        let t = src.timings(1);
        assert!(
            q.iter()
                .zip(&t.ayahs[1..4])
                .all(|(s, a)| s.end_ms == a.to_ms)
        );
        let mut r = req((1, 2), Some((1, 4)));
        r.gap = GapSetting::Fixed { ms: 500 };
        assert!(
            plan(&r, &src)
                .unwrap()
                .iter()
                .zip(&t.ayahs[1..4])
                .all(|(s, a)| s.end_ms == a.to_ms)
        );
        // A zero gap is no gap.
        r.gap = GapSetting::Multiplier { pct: 0 };
        assert_eq!(plan(&r, &src).unwrap()[0].end_ms, t.ayahs[2].from_ms);
    }

    #[test]
    fn basmala_rules() {
        let src = FixtureTimings::new(7);
        // Surah 2 from ayah 1: basmala from the surah-1 file, 1:1 range.
        let q = plan(&req((2, 1), Some((2, 3))), &src).unwrap();
        let t1 = src.timings(1);
        assert_eq!(q[0].kind, SegmentKind::Basmala);
        assert_eq!((q[0].surah, q[0].ayah, q[0].ayah_id), (2, 0, 0));
        assert_eq!(q[0].file, t1.file);
        assert_eq!(
            (q[0].start_ms, q[0].end_ms),
            (t1.ayahs[0].from_ms, t1.ayahs[0].to_ms)
        );
        assert_eq!(q.len(), 4);
        // Not from ayah 2, never before surah 9.
        assert!(
            plan(&req((2, 2), Some((2, 3))), &src)
                .unwrap()
                .iter()
                .all(|s| s.kind == SegmentKind::Ayah)
        );
        let q = plan(&req((8, 75), Some((10, 1))), &src).unwrap();
        let kinds: Vec<_> = q.iter().map(|s| (s.kind, s.surah, s.ayah)).collect();
        assert_eq!(
            kinds,
            [
                (SegmentKind::Ayah, 8, 75),
                (SegmentKind::Ayah, 9, 1),
                (SegmentKind::Ayah, 9, 2),
                (SegmentKind::Ayah, 9, 3),
            ][..]
                .iter()
                .copied()
                .chain((4..=129).map(|a| (SegmentKind::Ayah, 9, a)))
                .chain([(SegmentKind::Basmala, 10, 0), (SegmentKind::Ayah, 10, 1)])
                .collect::<Vec<_>>()
        );
    }

    /// QDC reciter 173: 1:1 spans 80–80 ms in the surah-1 file (the file starts after the basmala). Its basmala has
    /// no audio and is left out instead of being a 0 ms segment; ayah 1:1 itself is still planned (it is an ayah).
    #[test]
    fn a_basmala_without_audio_is_left_out() {
        struct EmptyFatihaBasmala(FixtureTimings);
        impl TimingsSource for EmptyFatihaBasmala {
            fn surah_timings(
                &self,
                reciter_id: u32,
                surah: u16,
            ) -> Result<Arc<SurahTimingSet>, AudioError> {
                let mut t = (*self.0.surah_timings(reciter_id, surah)?).clone();
                if surah == BASMALA_SURAH
                    && let Some(first) = t.ayahs.first_mut()
                {
                    first.from_ms = 80;
                    first.to_ms = 80;
                    first.words.clear();
                }
                Ok(Arc::new(t))
            }
            fn reciter_flags(&self, reciter_id: u32) -> ReciterFlags {
                self.0.reciter_flags(reciter_id)
            }
            fn surah_ayah_count(&self, surah: u16) -> u16 {
                self.0.surah_ayah_count(surah)
            }
            fn ayah_id(&self, surah: u16, ayah: u16) -> u32 {
                self.0.ayah_id(surah, ayah)
            }
        }
        let src = EmptyFatihaBasmala(FixtureTimings::new(7));
        let q = plan_queue(&req((112, 1), Some((113, 2))), &src).unwrap();
        assert!(!q.basmala_skipped, "not an offline skip");
        let kinds: Vec<_> = q
            .segments
            .iter()
            .map(|s| (s.kind, s.surah, s.ayah))
            .collect();
        assert_eq!(
            kinds,
            [
                (SegmentKind::Ayah, 112, 1),
                (SegmentKind::Ayah, 112, 2),
                (SegmentKind::Ayah, 112, 3),
                (SegmentKind::Ayah, 112, 4),
                (SegmentKind::Ayah, 113, 1),
                (SegmentKind::Ayah, 113, 2),
            ]
        );
        let fatiha = plan(&req((1, 1), Some((1, 2))), &src).unwrap();
        assert_eq!(
            (
                fatiha[0].kind,
                fatiha[0].ayah,
                fatiha[0].start_ms,
                fatiha[0].end_ms
            ),
            (
                SegmentKind::Ayah,
                1,
                80,
                src.surah_timings(7, 1).unwrap().ayahs[1].from_ms
            ),
            "1:1 stays an ayah of the queue"
        );
    }

    #[test]
    fn basmala_in_file_uses_the_lead_in() {
        let src = FixtureTimings::new(7).with_basmala_in_file(1_500);
        let q = plan(&req((112, 1), Some((112, 2))), &src).unwrap();
        let t = src.timings(112);
        assert_eq!(q[0].kind, SegmentKind::Basmala);
        assert_eq!(q[0].file, t.file);
        assert_eq!((q[0].start_ms, q[0].end_ms), (0, t.ayahs[0].from_ms));
        assert_eq!(q[0].end_ms, q[1].start_ms, "seamless into ayah 1");
    }

    #[test]
    fn offline_basmala_is_skipped_with_the_flag() {
        let src = FixtureTimings::new(7).with_offline(1);
        let q = plan_queue(&req((112, 1), Some((114, 6))), &src).unwrap();
        assert!(q.basmala_skipped);
        assert!(q.segments.iter().all(|s| s.kind == SegmentKind::Ayah));
        assert_eq!(q.segments.len(), 4 + 5 + 6);
        // Any other basmala error fails the play.
        let src = FixtureTimings::new(7).with_failing(1, AudioError::Timings("corrupt".into()));
        assert!(matches!(
            plan(&req((112, 1), Some((112, 4))), &src),
            Err(AudioError::Timings(_))
        ));
        // An offline planned surah fails the play.
        let src = FixtureTimings::new(7).with_offline(113);
        assert!(matches!(
            plan(&req((112, 1), Some((113, 5))), &src),
            Err(AudioError::Offline(_))
        ));
    }

    #[test]
    fn invalid_ranges() {
        let src = FixtureTimings::new(7);
        for (from, to) in [
            ((2, 5), Some((2, 4))),
            ((0, 1), Some((1, 1))),
            ((1, 0), Some((1, 1))),
            ((1, 8), Some((1, 8))),
            ((115, 1), Some((115, 1))),
            ((1, 1), Some((1, 8))),
            ((3, 1), Some((2, 1))),
        ] {
            assert!(
                matches!(plan(&req(from, to), &src), Err(AudioError::Invalid(_))),
                "{from:?}..{to:?}"
            );
        }
    }

    #[test]
    fn unresolved_to_falls_back() {
        let src = FixtureTimings::new(7);
        let q = plan(&req((113, 2), None), &src).unwrap();
        assert_eq!(q.last().map(|s| (s.surah, s.ayah)), Some((113, 5)));
        let mut r = req((112, 1), None);
        r.stop_at = Some(StopAt::EndOfQuran);
        let q = plan(&r, &src).unwrap();
        assert_eq!(q.last().map(|s| (s.surah, s.ayah)), Some((114, 6)));
    }

    #[test]
    fn helpers() {
        let src = FixtureTimings::new(7);
        let q = plan(&req((2, 1), Some((2, 3))), &src).unwrap();
        assert_eq!(index_of_ayah(&q, src.ayah_id(2, 2)), Some(2));
        assert_eq!(index_of_ayah(&q, 1), None);
        let f2 = &q[1].file;
        let mid = q[2].start_ms + 1;
        assert_eq!(segment_for_position(&q, f2, mid, 0), Some(2));
        assert_eq!(segment_for_position(&q, f2, 0, 3), Some(1));
        assert_eq!(segment_for_position(&q, f2, u32::MAX, 0), Some(3));
        assert_eq!(segment_for_position(&q, &q[0].file, 1, 3), Some(0));
        let seg = Segment {
            words: Arc::from(vec![(1, 100, 200), (2, 250, 400), (3, 400, 500)]),
            ..q[1].clone()
        };
        assert_eq!(seg.word_at(50), None);
        assert_eq!(seg.word_at(100), Some(1));
        assert_eq!(seg.word_at(220), Some(1), "held through the gap");
        assert_eq!(seg.word_at(400), Some(3));
        assert_eq!(
            gap_ms(GapSetting::Multiplier { pct: 50 }, &seg),
            seg.duration_ms() / 2
        );
        assert_eq!(gap_ms(GapSetting::Fixed { ms: 99_999 }, &seg), 30_000);
        assert_eq!(
            gap_ms(GapSetting::Fixed { ms: 700 }, &q[0]),
            0,
            "basmala: no gap"
        );
        let mut pq = PlannedQueue {
            segments: q.clone(),
            basmala_skipped: false,
        };
        assert_eq!(pq.skip_basmalas_in(&q[0].file), 1);
        assert!(pq.basmala_skipped && pq.segments.len() == 3);
        assert_eq!(pq.skip_basmalas_in(f2), 0, "ayahs are never dropped");
    }

    /// Seeks and A-B loops stay inside the run of the heard segment's file: the ranged ayahs, never the ayahs of the
    /// file before or after the range, nor a basmala that the same (surah-1) file backs elsewhere in the queue.
    #[test]
    fn file_runs_bound_seeks_to_the_queue() {
        let src = FixtureTimings::new(7);
        // 1:6, 1:7, the basmala of surah 2 (the surah-1 file's 1:1), 2:1, 2:2.
        let q = plan(&req((1, 6), Some((2, 2))), &src).unwrap();
        let t1 = src.timings(1);
        let t2 = src.timings(2);
        let fatiha = (t1.ayahs[5].from_ms, t1.ayahs[6].to_ms);
        assert_eq!(file_run_span(&q, 0), Some(fatiha));
        assert_eq!(file_run_span(&q, 1), Some(fatiha));
        assert_eq!(
            file_run_span(&q, 2),
            Some((t1.ayahs[0].from_ms, t1.ayahs[0].to_ms)),
            "the basmala is a run of its own"
        );
        assert_eq!(file_run_span(&q, 3), Some((q[3].start_ms, q[4].end_ms)));
        assert_eq!(q[4].end_ms, t2.ayahs[1].to_ms);
        assert_eq!(file_run_span(&q, 5), None);
        // A basmala in the surah's own file leads its run.
        let src = FixtureTimings::new(7).with_basmala_in_file(1_500);
        let q = plan(&req((112, 1), Some((112, 2))), &src).unwrap();
        assert_eq!(file_run_span(&q, 2), Some((0, q[2].end_ms)));
        // Repeat mode leaves breaths between the segments: they are inside the run.
        let mut r = req((1, 2), Some((1, 4)));
        r.ayah_repeat = 2;
        let q = plan(&r, &src).unwrap();
        assert_eq!(file_run_span(&q, 1), Some((q[0].start_ms, q[2].end_ms)));
    }
}
