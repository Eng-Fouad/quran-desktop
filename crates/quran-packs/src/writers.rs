//! The single-writer registry for audio files.
//!
//! Every `packs/audio/{reciter}/{sss}.mp3` has at most one writer per temp file:
//! - a progressive **stream** (the audio glue's `StreamRegistry`, fed through `PackManager::audio_stream_begin/end`)
//!   writes `{sss}.stream.part`;
//! - an explicit **download job** writes `{sss}.dl.part` (+ `.dl.part.json`).
//!
//! The rules:
//! - A job item whose surah is currently streaming **waits** for the stream to end, at most [`STREAM_WAIT`]
//!   (10 min). The [`JobClaim`] it gets back says whether a stream promoted the file meanwhile, so the adapter can only
//!   pin a promoted file of the expected length instead of downloading it again. After the wait expires the job
//!   downloads into its own `.dl.part` anyway (the stream keeps its own temp; first complete wins).
//! - A stream that starts while a job writes the same surah is registered too (it writes its own `.stream.part`);
//!   whichever completes first renames into place and the other deletes its temp. Two writers never share a file.
//! - Two jobs never write the same file at once: a second job claim waits until the first claim is dropped (no time
//!   limit; it stays cancellable through its [`JobHandle`]).
//!
//! The registry is in-memory and lock-cheap (`parking_lot`, never held across an `.await`), and nothing here panics.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::PackError;
use crate::jobs::JobHandle;

/// How long a job item waits for a live stream of the same surah before downloading on its own.
pub const STREAM_WAIT: Duration = Duration::from_secs(10 * 60);

/// `(reciter_id, surah)`.
pub type AudioKey = (u32, u32);

/// Cheap-to-clone handle on the registry. `Send + Sync`.
#[derive(Clone, Default)]
pub struct Writers {
    inner: Arc<Registry>,
}

#[derive(Default)]
struct Registry {
    slots: Mutex<HashMap<AudioKey, Slot>>,
}

/// Who currently writes one `(reciter, surah)` file: a stream or a job (`WriterState::{Stream(Arc<Notify>), Job}`) kept
/// as counters, because a stream may begin while a job writes (and two stream cursors may overlap begin/end).
struct Slot {
    /// Live streams writing `{sss}.stream.part` (normally 0 or 1).
    streams: u32,
    /// A job holds the [`JobClaim`] (writes `{sss}.dl.part`).
    job: bool,
    /// Tasks inside [`Writers::claim_job`] (keeps the slot, and its `promoted` value, alive for them).
    waiting: u32,
    /// Bytes of the last stream that promoted the file to `{sss}.mp3` while this slot lived.
    promoted: Option<u64>,
    /// Notified on every change (stream end, claim release).
    changed: Arc<Notify>,
}

impl Slot {
    fn new() -> Self {
        Self {
            streams: 0,
            job: false,
            waiting: 0,
            promoted: None,
            changed: Arc::new(Notify::new()),
        }
    }

    const fn idle(&self) -> bool {
        self.streams == 0 && !self.job && self.waiting == 0
    }
}

/// What a writer of one file currently looks like (diagnostics, tests, cache eviction).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WriterInfo {
    /// Live streams.
    pub streams: u32,
    /// A job holds the claim.
    pub job: bool,
}

impl Writers {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A stream started writing `{sss}.stream.part` (`StreamRegistry::begin`).
    pub fn stream_begin(&self, reciter_id: u32, surah: u32) {
        let mut slots = self.inner.slots.lock();
        let slot = slots.entry((reciter_id, surah)).or_insert_with(Slot::new);
        slot.streams = slot.streams.saturating_add(1);
        log::debug!(
            "writers: stream begin {reciter_id}/{surah:03} (streams {}, job {})",
            slot.streams,
            slot.job
        );
    }

    /// A stream ended (`StreamRegistry::end`): `Some(bytes)` = it promoted `{sss}.mp3`, `None` = abandoned. Wakes jobs
    /// waiting for it. An end without a begin is ignored.
    pub fn stream_end(&self, reciter_id: u32, surah: u32, promoted_bytes: Option<u64>) {
        let key = (reciter_id, surah);
        let mut slots = self.inner.slots.lock();
        let Some(slot) = slots.get_mut(&key) else {
            log::debug!("writers: stream end {reciter_id}/{surah:03} without a begin");
            return;
        };
        if slot.streams == 0 {
            log::debug!("writers: stream end {reciter_id}/{surah:03} without a live stream");
        }
        slot.streams = slot.streams.saturating_sub(1);
        if promoted_bytes.is_some() {
            slot.promoted = promoted_bytes;
        }
        slot.changed.notify_waiters();
        if slot.idle() {
            slots.remove(&key);
        }
    }

    /// The writers of one file right now.
    #[must_use]
    pub fn info(&self, reciter_id: u32, surah: u32) -> WriterInfo {
        self.inner
            .slots
            .lock()
            .get(&(reciter_id, surah))
            .map(|s| WriterInfo {
                streams: s.streams,
                job: s.job,
            })
            .unwrap_or_default()
    }

    /// True while a stream writes this file.
    #[must_use]
    pub fn is_streaming(&self, reciter_id: u32, surah: u32) -> bool {
        self.info(reciter_id, surah).streams > 0
    }

    /// Every file a stream currently writes (the startup sweep and cache eviction skip them).
    #[must_use]
    pub fn live_streams(&self) -> Vec<AudioKey> {
        let mut keys: Vec<AudioKey> = self
            .inner
            .slots
            .lock()
            .iter()
            .filter(|(_, s)| s.streams > 0)
            .map(|(k, _)| *k)
            .collect();
        keys.sort_unstable();
        keys
    }

    /// Claims the job writer of one file, waiting at most [`STREAM_WAIT`] for a live stream to end.
    ///
    /// Fails only with `PackError::Cancelled` when `job` is paused or cancelled while waiting.
    pub async fn claim_job(
        &self,
        reciter_id: u32,
        surah: u32,
        job: Option<&JobHandle>,
    ) -> Result<JobClaim, PackError> {
        self.claim_job_within(reciter_id, surah, job, STREAM_WAIT)
            .await
    }

    /// [`Self::claim_job`] with an explicit stream wait (tests use short waits).
    pub async fn claim_job_within(
        &self,
        reciter_id: u32,
        surah: u32,
        job: Option<&JobHandle>,
        max_stream_wait: Duration,
    ) -> Result<JobClaim, PackError> {
        let key = (reciter_id, surah);
        let deadline = Instant::now() + max_stream_wait;
        let mut waited = false;
        // Registered as a waiter (keeps the slot alive) from the first wait until this function returns or its future is
        // dropped.
        let mut waiter: Option<WaitGuard> = None;
        loop {
            if let Some(job) = job {
                job.check()?;
            }
            let notify = {
                let mut slots = self.inner.slots.lock();
                let slot = slots.entry(key).or_insert_with(Slot::new);
                let stream_wait_over = slot.streams == 0 || Instant::now() >= deadline;
                if !slot.job && stream_wait_over {
                    slot.job = true;
                    let claim = JobClaim {
                        writers: self.clone(),
                        key,
                        waited_for_stream: waited,
                        promoted: slot.promoted,
                        stream_still_live: slot.streams > 0,
                    };
                    if let Some(mut guard) = waiter.take() {
                        guard.release_locked(slot);
                    }
                    return Ok(claim);
                }
                if waiter.is_none() {
                    slot.waiting = slot.waiting.saturating_add(1);
                    waiter = Some(WaitGuard {
                        writers: self.clone(),
                        key,
                        armed: true,
                    });
                }
                waited = waited || slot.streams > 0;
                slot.changed.clone()
            };
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            // Anything that changed between the unlock and `enable` is caught here.
            if self.claimable(key, deadline) {
                continue;
            }
            let streaming = self.is_streaming(reciter_id, surah);
            let sleep = tokio::time::sleep_until(deadline);
            tokio::pin!(sleep);
            match job {
                Some(job) => {
                    tokio::select! {
                        () = &mut notified => {}
                        () = &mut sleep, if streaming => {}
                        () = job.stopped() => return Err(PackError::Cancelled),
                    }
                }
                None => {
                    tokio::select! {
                        () = &mut notified => {}
                        () = &mut sleep, if streaming => {}
                    }
                }
            }
        }
    }

    fn claimable(&self, key: AudioKey, deadline: Instant) -> bool {
        self.inner
            .slots
            .lock()
            .get(&key)
            .is_none_or(|s| !s.job && (s.streams == 0 || Instant::now() >= deadline))
    }

    fn release_job(&self, key: AudioKey) {
        let mut slots = self.inner.slots.lock();
        if let Some(slot) = slots.get_mut(&key) {
            slot.job = false;
            slot.changed.notify_waiters();
            if slot.idle() {
                slots.remove(&key);
            }
        }
    }

    fn release_waiter(&self, key: AudioKey) {
        let mut slots = self.inner.slots.lock();
        if let Some(slot) = slots.get_mut(&key) {
            slot.waiting = slot.waiting.saturating_sub(1);
            if slot.idle() {
                slots.remove(&key);
            }
        }
    }
}

/// Decrements the slot's waiter count when a waiting claim returns or is dropped mid-wait.
struct WaitGuard {
    writers: Writers,
    key: AudioKey,
    armed: bool,
}

impl WaitGuard {
    /// Releases while the caller already holds the registry lock.
    fn release_locked(&mut self, slot: &mut Slot) {
        if self.armed {
            slot.waiting = slot.waiting.saturating_sub(1);
            self.armed = false;
        }
    }
}

impl Drop for WaitGuard {
    fn drop(&mut self) {
        if self.armed {
            self.writers.release_waiter(self.key);
        }
    }
}

/// The job writer of one audio file, held while the job item downloads; released on drop.
#[must_use = "dropping the claim releases the file at once"]
pub struct JobClaim {
    writers: Writers,
    key: AudioKey,
    waited_for_stream: bool,
    promoted: Option<u64>,
    stream_still_live: bool,
}

impl JobClaim {
    /// `(reciter_id, surah)`.
    #[must_use]
    pub const fn key(&self) -> AudioKey {
        self.key
    }

    /// The claim had to wait for a live stream.
    #[must_use]
    pub const fn waited_for_stream(&self) -> bool {
        self.waited_for_stream
    }

    /// Bytes of a file a stream promoted to `{sss}.mp3` while the claim waited (or shortly before, while the slot was
    /// alive). The adapter only pins when this equals the expected length (and the file on disk has it).
    #[must_use]
    pub const fn promoted_bytes(&self) -> Option<u64> {
        self.promoted
    }

    /// The stream wait expired with a stream still live: the job writes its own `.dl.part` and first complete wins.
    #[must_use]
    pub const fn stream_still_live(&self) -> bool {
        self.stream_still_live
    }
}

impl Drop for JobClaim {
    fn drop(&mut self) {
        self.writers.release_job(self.key);
    }
}

impl std::fmt::Debug for JobClaim {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobClaim")
            .field("key", &self.key)
            .field("waited_for_stream", &self.waited_for_stream)
            .field("promoted", &self.promoted)
            .field("stream_still_live", &self.stream_still_live)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[tokio::test]
    async fn free_files_are_claimed_at_once_and_released_on_drop() {
        let w = Writers::new();
        let claim = w.claim_job(7, 2, None).await.unwrap();
        assert!(!claim.waited_for_stream());
        assert_eq!(
            w.info(7, 2),
            WriterInfo {
                streams: 0,
                job: true
            }
        );
        drop(claim);
        assert_eq!(w.info(7, 2), WriterInfo::default());
        assert!(w.inner.slots.lock().is_empty(), "idle slots are removed");
    }

    #[tokio::test]
    async fn end_without_begin_is_ignored() {
        let w = Writers::new();
        w.stream_end(7, 1, Some(10));
        assert!(w.inner.slots.lock().is_empty());
        assert!(w.live_streams().is_empty());
    }

    #[tokio::test]
    async fn a_dropped_waiter_leaves_no_slot_behind() {
        let w = Writers::new();
        w.stream_begin(7, 3);
        let fut = w.claim_job_within(7, 3, None, Duration::from_secs(60));
        let res = tokio::time::timeout(Duration::from_millis(10), fut).await;
        assert!(res.is_err(), "still waiting for the stream");
        assert_eq!(
            w.inner.slots.lock().get(&(7, 3)).map(|s| s.waiting),
            Some(0)
        );
        w.stream_end(7, 3, None);
        assert!(w.inner.slots.lock().is_empty());
    }
}
