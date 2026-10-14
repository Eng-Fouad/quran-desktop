//! Debug-only outputs for `QD_AUDIO_SINK`: `null` drives the ring from a 48 kHz timer instead of cpal; `wav:<path>`
//! also writes the frames to a WAV file and appends every applied marker and tick to `<path>.log` as JSON lines.
//! Compiled only with `debug_assertions`.
//!
//! The sink replaces the device, nothing else: the output thread (`qd-audio-out`) runs the very same
//! [`crate::output::Renderer`] the cpal callback runs, in 10 ms buffers paced by the wall clock, so the engine behaves
//! exactly as on hardware (rebuilds, pause ramps, flush declicks, position publication), only silently.
//!
//! # Log format (`<path>.log`, one JSON object per line)
//! - `{"event":"marker","kind":"segment"|"gap"|"end"|"sync","generation":…,"ringFrame":…,"readFrame":…,
//!   "deviceFrame":…,"segIndex":…,"filePosUs":…,"rateNum":…,"rateDen":…,"outputGeneration":…}` — a marker applied by
//!   the callback. `readFrame` is the ring frame the callback was at (equal to `ringFrame` except for a late Sync),
//!   `deviceFrame` the sink frame (silence included, counted over the whole run) at which it took effect.
//! - `{"event":"tick","tick":{…AudioTick…}}` — every tick the ticker sent to the app.
//! - `{"event":"output","generation":…,"rate":…,"channels":…,"resumeAtUs":…|null,"reason":"open"|"rebuild"|"reopen",
//!   "deviceFrame":…}` — a sink "stream" was (re)built.
//!
//! The WAV is 32-bit IEEE float at [`SINK_RATE`] Hz, [`SINK_CHANNELS`] channels: exactly the rendered frames, gain and
//! ramps included, so tests can check sample content as well as marker frames.

use std::fs::File;
use std::io::{self, BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use quran_types::AudioTick;
use serde::Serialize;

use crate::shared::{Marker, MarkerKind};

/// The environment variable that selects a debug sink.
pub const SINK_ENV: &str = "QD_AUDIO_SINK";
/// Sample rate of the debug sinks.
pub const SINK_RATE: u32 = 48_000;
/// Channel count of the debug sinks.
pub const SINK_CHANNELS: u16 = 2;
/// Frames per sink "device buffer" (10 ms at 48 kHz, a typical WASAPI period).
pub const SINK_BUFFER_FRAMES: usize = 480;

/// Which debug sink replaces the audio device.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum SinkKind {
    /// Timer-driven silence: the ring is consumed in real time, nothing is written.
    Null,
    /// As `Null`, plus a WAV of the rendered frames and a JSON-lines marker/tick log at `<path>.log`.
    Wav(PathBuf),
}

impl SinkKind {
    /// Parses a `QD_AUDIO_SINK` value: `null` or `wav:<path>` (case-insensitive scheme, surrounding whitespace
    /// ignored). An empty value is `Ok(None)` (use the device).
    ///
    /// # Errors
    /// A description of the unrecognised value.
    pub fn parse(value: &str) -> Result<Option<Self>, String> {
        let v = value.trim();
        if v.is_empty() {
            return Ok(None);
        }
        if v.eq_ignore_ascii_case("null") {
            return Ok(Some(Self::Null));
        }
        let scheme = v.get(..4).filter(|s| s.eq_ignore_ascii_case("wav:"));
        if scheme.is_some() {
            let path = v.get(4..).map(str::trim).unwrap_or_default();
            if path.is_empty() {
                return Err(format!("{SINK_ENV}={value:?}: `wav:` needs a file path"));
            }
            return Ok(Some(Self::Wav(PathBuf::from(path))));
        }
        Err(format!(
            "{SINK_ENV}={value:?} is neither `null` nor `wav:<path>`"
        ))
    }

    /// The sink selected by `QD_AUDIO_SINK`, if any. An unrecognised value selects [`SinkKind::Null`] with a warning:
    /// whoever set the variable meant to keep audio off the speakers.
    #[must_use]
    pub fn from_env() -> Option<Self> {
        let value = std::env::var_os(SINK_ENV)?;
        let Some(value) = value.to_str() else {
            log::warn!("{SINK_ENV} is not valid UTF-8: using the null sink");
            return Some(Self::Null);
        };
        match Self::parse(value) {
            Ok(kind) => kind,
            Err(why) => {
                log::warn!("{why}: using the null sink");
                Some(Self::Null)
            }
        }
    }

    /// The `AudioSnapshot.device` label of this sink.
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Null => "Null sink (QD_AUDIO_SINK)".to_owned(),
            Self::Wav(path) => format!("WAV sink {} (QD_AUDIO_SINK)", path.display()),
        }
    }

    /// `<path>.log` of a WAV sink.
    #[must_use]
    pub fn log_path(wav: &Path) -> PathBuf {
        let mut name = wav.as_os_str().to_owned();
        name.push(".log");
        PathBuf::from(name)
    }
}

/// A 32-bit IEEE-float WAV written incrementally; the RIFF and data sizes are patched by [`WavWriter::finish`] (and,
/// best effort, on drop).
#[derive(Debug)]
pub struct WavWriter {
    out: Option<BufWriter<File>>,
    channels: u16,
    frames: u64,
}

/// Byte offset of the RIFF size field.
const RIFF_SIZE_AT: u64 = 4;
/// Header bytes before the sample data (RIFF + `fmt ` (18-byte body) + `fact` + `data` headers).
const WAV_HEADER_BYTES: u32 = 58;
/// Byte offset of the `fact` frame count.
const FACT_FRAMES_AT: u64 = 46;
/// Byte offset of the `data` size field.
const DATA_SIZE_AT: u64 = 54;

impl WavWriter {
    /// Creates (truncates) `path`, creating missing parent directories, and writes a header for an empty stream.
    ///
    /// # Errors
    /// Any IO error.
    pub fn create(path: &Path, rate: u32, channels: u16) -> io::Result<Self> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        let mut out = BufWriter::new(File::create(path)?);
        let ch = channels.max(1);
        let block_align = ch.saturating_mul(4);
        let mut h = Vec::with_capacity(WAV_HEADER_BYTES as usize);
        h.extend_from_slice(b"RIFF");
        h.extend_from_slice(&(WAV_HEADER_BYTES - 8).to_le_bytes());
        h.extend_from_slice(b"WAVEfmt ");
        h.extend_from_slice(&18_u32.to_le_bytes());
        h.extend_from_slice(&3_u16.to_le_bytes()); // WAVE_FORMAT_IEEE_FLOAT
        h.extend_from_slice(&ch.to_le_bytes());
        h.extend_from_slice(&rate.to_le_bytes());
        h.extend_from_slice(&rate.saturating_mul(u32::from(block_align)).to_le_bytes());
        h.extend_from_slice(&block_align.to_le_bytes());
        h.extend_from_slice(&32_u16.to_le_bytes());
        h.extend_from_slice(&0_u16.to_le_bytes()); // cbSize
        h.extend_from_slice(b"fact");
        h.extend_from_slice(&4_u32.to_le_bytes());
        h.extend_from_slice(&0_u32.to_le_bytes()); // frames, patched
        h.extend_from_slice(b"data");
        h.extend_from_slice(&0_u32.to_le_bytes()); // data bytes, patched
        out.write_all(&h)?;
        Ok(Self {
            out: Some(out),
            channels: ch,
            frames: 0,
        })
    }

    /// Frames written so far.
    #[must_use]
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Appends interleaved frames (a trailing partial frame is ignored).
    ///
    /// # Errors
    /// Any IO error; the writer stays usable.
    pub fn write(&mut self, interleaved: &[f32]) -> io::Result<()> {
        let Some(out) = self.out.as_mut() else {
            return Ok(());
        };
        let ch = usize::from(self.channels);
        let frames = interleaved.len() / ch;
        let mut bytes = Vec::with_capacity(frames * ch * 4);
        for s in interleaved.iter().take(frames * ch) {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        out.write_all(&bytes)?;
        self.frames += frames as u64;
        Ok(())
    }

    /// Patches the sizes, flushes and closes the file. Idempotent.
    ///
    /// # Errors
    /// Any IO error.
    pub fn finish(&mut self) -> io::Result<()> {
        let Some(mut out) = self.out.take() else {
            return Ok(());
        };
        let data = self.frames.saturating_mul(u64::from(self.channels) * 4);
        let data32 = u32::try_from(data).unwrap_or(u32::MAX);
        out.flush()?;
        let file = out.get_mut();
        file.seek(SeekFrom::Start(RIFF_SIZE_AT))?;
        file.write_all(&data32.saturating_add(WAV_HEADER_BYTES - 8).to_le_bytes())?;
        file.seek(SeekFrom::Start(FACT_FRAMES_AT))?;
        file.write_all(&u32::try_from(self.frames).unwrap_or(u32::MAX).to_le_bytes())?;
        file.seek(SeekFrom::Start(DATA_SIZE_AT))?;
        file.write_all(&data32.to_le_bytes())?;
        file.flush()
    }
}

impl Drop for WavWriter {
    fn drop(&mut self) {
        if let Err(e) = self.finish() {
            log::warn!("WAV sink: cannot finalise the file: {e}");
        }
    }
}

/// One line of the `<path>.log` JSON-lines log.
#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LogLine<'a> {
    Marker {
        kind: &'static str,
        generation: u32,
        ring_frame: u64,
        read_frame: u64,
        device_frame: u64,
        seg_index: u32,
        file_pos_us: u64,
        rate_num: u64,
        rate_den: u64,
        output_generation: u32,
    },
    Tick {
        tick: &'a AudioTick,
    },
    Output {
        generation: u32,
        rate: u32,
        channels: u16,
        resume_at_us: Option<u64>,
        reason: &'static str,
        device_frame: u64,
    },
}

/// The name a [`MarkerKind`] has in the log.
#[must_use]
pub const fn kind_name(kind: MarkerKind) -> &'static str {
    match kind {
        MarkerKind::Segment => "segment",
        MarkerKind::Gap => "gap",
        MarkerKind::End => "end",
        MarkerKind::Sync => "sync",
    }
}

/// The JSON-lines marker/tick log, shared by the output thread (markers, outputs) and the ticker (ticks). Every
/// write is flushed, so the log can be read while the engine runs.
#[derive(Debug)]
pub struct EventLog {
    out: Mutex<Option<BufWriter<File>>>,
}

impl EventLog {
    /// Creates (truncates) `path`, creating missing parent directories.
    ///
    /// # Errors
    /// Any IO error.
    pub fn create(path: &Path) -> io::Result<Self> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        Ok(Self {
            out: Mutex::new(Some(BufWriter::new(File::create(path)?))),
        })
    }

    /// Appends one line per item and flushes. A failing write disables the log (with one warning).
    pub fn write(&self, lines: &[LogLine<'_>]) {
        if lines.is_empty() {
            return;
        }
        let mut guard = self.out.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(out) = guard.as_mut() else {
            return;
        };
        let result = lines
            .iter()
            .try_for_each(|line| {
                serde_json::to_writer(&mut *out, line).map_err(io::Error::other)?;
                out.write_all(b"\n")
            })
            .and_then(|()| out.flush());
        if let Err(e) = result {
            log::warn!("audio sink log disabled: {e}");
            *guard = None;
        }
    }

    /// Logs a tick.
    pub fn tick(&self, tick: &AudioTick) {
        self.write(&[LogLine::Tick { tick }]);
    }
}

/// A marker the renderer applied, as the sink logs it.
#[must_use]
pub fn marker_line(
    m: &Marker,
    read_frame: u64,
    device_frame: u64,
    output_generation: u32,
) -> LogLine<'static> {
    LogLine::Marker {
        kind: kind_name(m.kind),
        generation: m.generation,
        ring_frame: m.ring_frame,
        read_frame,
        device_frame,
        seg_index: m.seg_index,
        file_pos_us: m.file_pos_us,
        rate_num: m.rate.num,
        rate_den: m.rate.den,
        output_generation,
    }
}

/// The files of a WAV sink (none for the null sink).
#[derive(Debug, Default)]
pub struct SinkFiles {
    pub wav: Option<WavWriter>,
    pub log: Option<std::sync::Arc<EventLog>>,
}

impl SinkFiles {
    /// Opens the WAV and its log for `kind` (nothing for `Null`). A file that cannot be created is logged and skipped:
    /// the sink still runs, silently.
    #[must_use]
    pub fn open(kind: &SinkKind) -> Self {
        let SinkKind::Wav(path) = kind else {
            return Self::default();
        };
        let wav = WavWriter::create(path, SINK_RATE, SINK_CHANNELS)
            .map_err(|e| log::error!("WAV sink: cannot create {}: {e}", path.display()))
            .ok();
        let log_path = SinkKind::log_path(path);
        let log = EventLog::create(&log_path)
            .map_err(|e| log::error!("WAV sink: cannot create {}: {e}", log_path.display()))
            .ok()
            .map(std::sync::Arc::new);
        Self { wav, log }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)]
mod tests {
    use quran_types::PlaybackStatus;

    use super::*;
    use crate::shared::MediaRate;

    #[test]
    fn parses_sink_values() {
        assert_eq!(SinkKind::parse(""), Ok(None));
        assert_eq!(SinkKind::parse("  "), Ok(None));
        assert_eq!(SinkKind::parse("null"), Ok(Some(SinkKind::Null)));
        assert_eq!(SinkKind::parse(" NULL "), Ok(Some(SinkKind::Null)));
        assert_eq!(
            SinkKind::parse("wav:artifacts/ic2.wav"),
            Ok(Some(SinkKind::Wav(PathBuf::from("artifacts/ic2.wav"))))
        );
        assert_eq!(
            SinkKind::parse("WAV:C:\\tmp\\a b.wav"),
            Ok(Some(SinkKind::Wav(PathBuf::from("C:\\tmp\\a b.wav"))))
        );
        assert!(SinkKind::parse("wav:").is_err());
        assert!(SinkKind::parse("speakers").is_err());
        assert!(SinkKind::parse("wa").is_err());
        assert_eq!(
            SinkKind::log_path(Path::new("out/x.wav")),
            PathBuf::from("out/x.wav.log")
        );
        assert!(SinkKind::Null.label().contains("Null"));
    }

    #[test]
    fn wav_files_have_exact_headers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/out.wav");
        let mut w = WavWriter::create(&path, 48_000, 2).unwrap();
        w.write(&[0.5, -0.5, 0.25, -0.25, 9.0]).unwrap(); // the partial frame is ignored
        assert_eq!(w.frames(), 2);
        w.finish().unwrap();
        w.finish().unwrap(); // idempotent
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 58 + 16);
        let u32_at = |i: usize| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
        let u16_at = |i: usize| u16::from_le_bytes(bytes[i..i + 2].try_into().unwrap());
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(u32_at(4) as usize, bytes.len() - 8);
        assert_eq!(&bytes[8..16], b"WAVEfmt ");
        assert_eq!(u16_at(20), 3);
        assert_eq!(u16_at(22), 2);
        assert_eq!(u32_at(24), 48_000);
        assert_eq!(u32_at(28), 48_000 * 8);
        assert_eq!(u16_at(32), 8);
        assert_eq!(u16_at(34), 32);
        assert_eq!(&bytes[38..42], b"fact");
        assert_eq!(u32_at(46), 2);
        assert_eq!(&bytes[50..54], b"data");
        assert_eq!(u32_at(54), 16);
        let first = f32::from_le_bytes(bytes[58..62].try_into().unwrap());
        assert!((first - 0.5).abs() < f32::EPSILON);
    }

    #[test]
    fn logs_markers_and_ticks_as_json_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.wav.log");
        let log = EventLog::create(&path).unwrap();
        let m = Marker {
            generation: 3,
            ring_frame: 480,
            kind: MarkerKind::Gap,
            seg_index: 2,
            file_pos_us: 1_000,
            rate: MediaRate::FROZEN,
            plays: 1,
            passes: 1,
        };
        log.write(&[marker_line(&m, 480, 960, 1)]);
        log.tick(&AudioTick {
            seq: 1,
            generation: 3,
            status: PlaybackStatus::Playing,
            surah: 1,
            ayah: 2,
            ayah_id: 2,
            file_ms: 10,
            word_pos: 1,
            speed_pct: 100,
            in_gap: false,
            buffered_pct: 100,
        });
        log.write(&[LogLine::Output {
            generation: 1,
            rate: 48_000,
            channels: 2,
            resume_at_us: None,
            reason: "open",
            device_frame: 0,
        }]);
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["event"], "marker");
        assert_eq!(lines[0]["kind"], "gap");
        assert_eq!(lines[0]["ringFrame"], 480);
        assert_eq!(lines[0]["deviceFrame"], 960);
        assert_eq!(lines[0]["rateDen"], 1);
        assert_eq!(lines[1]["event"], "tick");
        assert_eq!(lines[1]["tick"]["ayahId"], 2);
        assert_eq!(lines[1]["tick"]["status"], "playing");
        assert_eq!(lines[2]["event"], "output");
        assert_eq!(lines[2]["resumeAtUs"], serde_json::Value::Null);
    }

    #[test]
    fn sink_files_for_each_kind() {
        let none = SinkFiles::open(&SinkKind::Null);
        assert!(none.wav.is_none() && none.log.is_none());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.wav");
        let files = SinkFiles::open(&SinkKind::Wav(path.clone()));
        assert!(files.wav.is_some() && files.log.is_some());
        drop(files);
        assert!(path.exists() && SinkKind::log_path(&path).exists());
    }
}
