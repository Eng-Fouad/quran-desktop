//! Listening renders for the WSOLA quality check (3 reciters × 5 speeds). Ignored by default: it writes WAV files for a
//! person to audition, it never plays anything.
//!
//! ```text
//! QD_DSP_LISTEN="C:\path\001.mp3;C:\path\002.mp3" cargo test -p quran-audio --release --test dsp_listen -- --ignored
//! ```
//! renders every listed file (MP3 or WAV; `;`-separated) at 50, 75, 125, 150 and 200 % through the real decode chain
//! (WSOLA → resampler → 48 kHz stereo) into `artifacts/dsp-listen/` (gitignored; `QD_DSP_LISTEN_OUT` overrides). Without
//! `QD_DSP_LISTEN` the synthetic recitation-like voice is rendered instead.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use quran_audio::dsp::signals::VoiceGen;
use quran_audio::dsp::{DspChain, StreamFormat};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

const SPEEDS: [u32; 5] = [50, 75, 125, 150, 200];
const OUT_RATE: u32 = 48_000;

/// Decodes a whole file to interleaved f32: `(rate, channels, samples)`.
fn decode(path: &Path) -> Result<(u32, usize, Vec<f32>), SymError> {
    let mss = MediaSourceStream::new(Box::new(File::open(path)?), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut reader = symphonia::default::get_probe().probe(
        &hint,
        mss,
        FormatOptions::default(),
        MetadataOptions::default(),
    )?;
    let track = reader
        .default_track(TrackType::Audio)
        .ok_or(SymError::Unsupported("no audio track"))?;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or(SymError::Unsupported("no audio params"))?
        .clone();
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())?;
    let (mut rate, mut channels, mut samples, mut scratch) = (
        params.sample_rate.unwrap_or(44_100),
        0,
        Vec::new(),
        Vec::new(),
    );
    while let Some(packet) = reader.next_packet()? {
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e),
        };
        rate = decoded.spec().rate();
        channels = decoded.spec().channels().count().max(1);
        decoded.copy_to_vec_interleaved::<f32>(&mut scratch);
        samples.extend_from_slice(&scratch);
    }
    Ok((rate, channels.max(1), samples))
}

/// 16-bit PCM WAV.
fn write_wav(path: &Path, rate: u32, channels: u16, samples: &[f32]) -> std::io::Result<()> {
    let mut w = BufWriter::new(File::create(path)?);
    let data_len = (samples.len() * 2) as u32;
    let block = channels * 2;
    w.write_all(b"RIFF")?;
    w.write_all(&(36 + data_len).to_le_bytes())?;
    w.write_all(b"WAVEfmt ")?;
    w.write_all(&16_u32.to_le_bytes())?;
    w.write_all(&1_u16.to_le_bytes())?;
    w.write_all(&channels.to_le_bytes())?;
    w.write_all(&rate.to_le_bytes())?;
    w.write_all(&(rate * u32::from(block)).to_le_bytes())?;
    w.write_all(&block.to_le_bytes())?;
    w.write_all(&16_u16.to_le_bytes())?;
    w.write_all(b"data")?;
    w.write_all(&data_len.to_le_bytes())?;
    for s in samples {
        w.write_all(&((s.clamp(-1.0, 1.0) * 32_767.0).round() as i16).to_le_bytes())?;
    }
    w.flush()
}

fn render(name: &str, rate: u32, channels: usize, samples: &[f32], dir: &Path) {
    for pct in SPEEDS {
        let fmt = StreamFormat {
            src_rate: rate,
            src_channels: channels,
            out_rate: OUT_RATE,
            out_channels: 2,
        };
        let mut chain = DspChain::new(fmt, pct).unwrap();
        let mut out = Vec::new();
        for p in samples.chunks(1_152 * channels) {
            chain.push(p);
            chain.pull(&mut out);
        }
        chain.drain(&mut out, true);
        let path = dir.join(format!("{name}_{pct:03}.wav"));
        write_wav(&path, OUT_RATE, 2, &out).unwrap();
        println!("wrote {}", path.display());
    }
}

#[test]
#[ignore = "writes WAV files for a listening test; run on demand"]
fn render_listening_set() {
    let dir = std::env::var_os("QD_DSP_LISTEN_OUT").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../artifacts/dsp-listen"),
        PathBuf::from,
    );
    std::fs::create_dir_all(&dir).unwrap();
    match std::env::var("QD_DSP_LISTEN") {
        Ok(list) => {
            for file in list.split(';').filter(|s| !s.trim().is_empty()) {
                let path = PathBuf::from(file.trim());
                let (rate, channels, samples) = decode(&path).unwrap();
                let name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("input")
                    .to_owned();
                render(&name, rate, channels, &samples, &dir);
            }
        }
        Err(_) => {
            let mut voice = Vec::new();
            VoiceGen::new(44_100).fill(&mut voice, 44_100 * 15, 1);
            render("synthetic_voice", 44_100, 1, &voice, &dir);
        }
    }
}
