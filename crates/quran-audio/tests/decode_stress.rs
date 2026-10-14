//! Randomised (deterministic, seeded) runs of the decode state machine against the fake callback: random device
//! buffer sizes, pauses, and random jumps, seeks, speed changes, A-B loops, repeat and gap changes across a queue of
//! three surah files and their basmalas. Every run must keep the marker contract:
//! - every Segment/Gap/End marker is applied on exactly its ring frame;
//! - markers come in ring-frame order within a generation, and generations only grow;
//! - the first marker of every flush sits exactly where the ring stood at the flush;
//! - Sync positions agree with the exact rational extrapolation of their segment's anchor;
//! - the decoder never spins without blocking, and the queue still runs to its End afterwards.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

use std::sync::Arc;
use std::sync::atomic::Ordering;

use quran_audio::dsp::signals::Lcg;
use quran_audio::fake_out::Rig;
use quran_audio::fake_out::fixtures::{FixtureSources, FixtureTimings, Layout};
use quran_audio::shared::{DecodeCmd, DecodeParams, MarkerKind};
use quran_audio::{SegmentKind, plan};
use quran_types::{AbLoop, AyahRef, GapSetting, MushafLayout, PlayRequest};

/// Uniform integer in `0..n`.
fn below(rng: &mut Lcg, n: u32) -> u32 {
    let u = (f64::from(rng.next_f32()) + 1.0) / 2.0;
    ((u * f64::from(n)) as u32).min(n.saturating_sub(1))
}

/// One seeded run; returns the number of flushes it exercised.
fn run(seed: u64, src_rate: u32) -> usize {
    let mut rng = Lcg::new(seed);
    let layout = Layout {
        ayah_ms: 700 + below(&mut rng, 900),
        breath_ms: 80 + below(&mut rng, 200),
        ..Layout::default()
    };
    let timings = FixtureTimings::new(7).with_layout(layout);
    let sources = Arc::new(FixtureSources::new(
        layout,
        src_rate,
        1 + below(&mut rng, 2) as u16,
    ));
    let mut rig = Rig::new(48_000, 2, 750).with_sources(sources);
    let request = PlayRequest {
        reciter_id: 7,
        from: AyahRef {
            surah: 112,
            ayah: 1,
        },
        to: Some(AyahRef {
            surah: 114,
            ayah: 6,
        }),
        stop_at: None,
        layout: MushafLayout::V2,
        ayah_repeat: 1 + below(&mut rng, 2),
        range_repeat: 1,
        gap: GapSetting::None,
        start_paused: false,
        record: true,
    };
    let queue = plan(&request, &timings).unwrap();
    let params = DecodeParams {
        ayah_repeat: request.ayah_repeat,
        ..DecodeParams::default()
    };
    rig.load(queue.clone(), 0, None, params).unwrap();

    // (generation, ring frame where the flush happened)
    let mut flushes: Vec<(u32, u64)> = vec![(rig.decoder.generation(), 0)];
    for step in 0..2_500 {
        rig.buffer_frames = 1 + below(&mut rng, 1_500) as usize;
        if below(&mut rng, 50) == 0 {
            let before = rig.decoder.generation();
            let written = rig.decoder.written_frames();
            let current = rig.out.current().seg_index as usize;
            let seg = &queue[current.min(queue.len() - 1)];
            let cmd = match below(&mut rng, 9) {
                0 => DecodeCmd::Jump {
                    index: below(&mut rng, queue.len() as u32),
                },
                1 => DecodeCmd::Seek {
                    file_ms: seg.start_ms.saturating_sub(300)
                        + below(&mut rng, seg.duration_ms() + 600),
                },
                2 => DecodeCmd::SetSpeed {
                    speed_pct: 50 + 5 * below(&mut rng, 31),
                },
                3 => {
                    let a_ms = seg.start_ms + below(&mut rng, seg.duration_ms().max(1));
                    DecodeCmd::SetAbLoop(Some(AbLoop {
                        a_ms,
                        b_ms: a_ms + 300 + below(&mut rng, 2_500),
                    }))
                }
                4 => DecodeCmd::SetAbLoop(None),
                5 => DecodeCmd::SetRepeat {
                    ayah_repeat: below(&mut rng, 4),
                    range_repeat: below(&mut rng, 3),
                },
                6 => DecodeCmd::SetGap(match below(&mut rng, 3) {
                    0 => GapSetting::None,
                    1 => GapSetting::Fixed {
                        ms: below(&mut rng, 900),
                    },
                    _ => GapSetting::Multiplier {
                        pct: below(&mut rng, 120),
                    },
                }),
                7 => {
                    let playing = rig.shared.playing.load(Ordering::Relaxed);
                    rig.shared.playing.store(!playing, Ordering::Relaxed);
                    continue;
                }
                _ => continue,
            };
            rig.cmd(cmd);
            let after = rig.decoder.generation();
            if after != before {
                assert_eq!(after, before + 1, "seed {seed} step {step}");
                flushes.push((after, written));
            }
        }
        assert!(rig.step(), "seed {seed}: decoder loop at step {step}");
    }

    // Wind down: no loop, no repeats, playing; the queue must reach its End.
    rig.cmd(DecodeCmd::SetAbLoop(None));
    rig.cmd(DecodeCmd::SetRepeat {
        ayah_repeat: 1,
        range_repeat: 1,
    });
    rig.cmd(DecodeCmd::SetGap(GapSetting::None));
    rig.shared.playing.store(true, Ordering::Relaxed);
    rig.buffer_frames = 480;
    assert!(
        rig.run_to_end(900),
        "seed {seed}: no End after winding down"
    );

    let applied = rig.out.applied();
    let mut last = applied[0].marker;
    let mut anchor = applied[0].marker;
    for a in applied {
        let m = a.marker;
        if m.kind != MarkerKind::Sync {
            assert_eq!(a.read_frame, m.ring_frame, "seed {seed}: {a:?}");
        }
        assert!(
            m.generation >= last.generation,
            "seed {seed}: generations go back"
        );
        if m.generation == last.generation {
            assert!(
                m.ring_frame >= last.ring_frame,
                "seed {seed}: out of order {last:?} {m:?}"
            );
        } else if let Some(&(_, at)) = flushes.iter().find(|(g, _)| *g == m.generation) {
            assert_eq!(
                m.ring_frame, at,
                "seed {seed}: flush marker of generation {}",
                m.generation
            );
            assert_ne!(m.kind, MarkerKind::Sync);
        }
        match m.kind {
            MarkerKind::Sync => {
                assert_eq!(m.generation, anchor.generation);
                let tolerance = 500_000_u64.div_ceil(u64::from(src_rate)) + 2;
                let exact = anchor.position_at(m.ring_frame);
                assert!(
                    m.file_pos_us.abs_diff(exact) <= tolerance,
                    "seed {seed}: sync {} vs {exact}",
                    m.file_pos_us
                );
            }
            MarkerKind::Segment => {
                anchor = m;
                let seg = &queue[m.seg_index as usize];
                assert!(seg.kind == SegmentKind::Ayah || seg.kind == SegmentKind::Basmala);
            }
            MarkerKind::Gap | MarkerKind::End => {
                assert_eq!(m.rate.num, 0, "frozen");
                anchor = m;
            }
        }
        last = m;
    }
    flushes.len() - 1
}

/// Seeds per test: 4 by default; `QD_DECODE_STRESS_SEEDS=<n>` runs a deeper sweep.
fn seeds() -> u64 {
    std::env::var("QD_DECODE_STRESS_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4)
}

#[test]
fn random_commands_keep_the_marker_contract_at_48k() {
    let flushes: usize = (1..=seeds()).map(|seed| run(seed, 48_000)).sum();
    assert!(flushes as u64 > 8 * seeds(), "{flushes} flushes exercised");
}

#[test]
fn random_commands_keep_the_marker_contract_with_resampling() {
    let flushes: usize = (1_001..=1_000 + seeds())
        .map(|seed| run(seed, 44_100))
        .sum();
    assert!(flushes as u64 > 8 * seeds(), "{flushes} flushes exercised");
}
