//! Shared helpers of the `source_*` tests (included with `#[path]`; also built as its own empty test target):
//! an in-repo HTTP/1.1 file server (`Range`, throttling, stalls, forced statuses, a request log), a recording
//! `StreamRegistry`, a tokio runtime and a `CachingHttpSource` wired to them.
//!
//! The server uses only `std::net` (the workspace's tokio has no `net` feature) and one thread per connection.
//! Every response closes its connection, so request counts are exact.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::missing_panics_doc,
    clippy::new_without_default
)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use quran_audio::{CachingHttpSource, FileKey, OnlineFn, StreamRegistry};

/// The reciter every test uses.
pub const RECITER: u32 = 7;

/// Deterministic, non-repeating test content (no run of zeros, so a pre-sized hole would show).
#[must_use]
pub fn content(len: usize, seed: u32) -> Vec<u8> {
    let mut x = seed.wrapping_mul(2_654_435_761).max(1);
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x % 251) as u8 + 1
        })
        .collect()
}

/// How the server answers.
#[derive(Clone, Debug)]
pub struct Behavior {
    /// Answer every request with this status and an empty body.
    pub status: Option<u16>,
    /// Body bytes per write.
    pub chunk: usize,
    /// Pause after each chunk.
    pub delay: Duration,
    /// Per response: stop sending after this many body bytes and hold the connection open (until the client closes
    /// it or the server stops).
    pub stall_after: Option<u64>,
    /// Omit `Content-Length` (the stream then has no known length).
    pub no_length: bool,
}

impl Default for Behavior {
    fn default() -> Self {
        Self {
            status: None,
            chunk: 16 * 1024,
            delay: Duration::ZERO,
            stall_after: None,
            no_length: false,
        }
    }
}

impl Behavior {
    /// `chunk` bytes every `delay`.
    #[must_use]
    pub fn throttled(chunk: usize, delay: Duration) -> Self {
        Self {
            chunk,
            delay,
            ..Self::default()
        }
    }
}

/// One request the server saw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Logged {
    pub method: String,
    pub path: String,
    /// The `Range` header, verbatim.
    pub range: Option<String>,
}

#[derive(Default)]
struct State {
    files: Mutex<HashMap<String, Arc<Vec<u8>>>>,
    behavior: Mutex<Behavior>,
    log: Mutex<Vec<Logged>>,
    open_connections: AtomicUsize,
}

/// A local HTTP file server on `127.0.0.1:<ephemeral>`.
pub struct Server {
    addr: SocketAddr,
    state: Arc<State>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    #[must_use]
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(State::default());
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (state, stop) = (Arc::clone(&state), Arc::clone(&stop));
            std::thread::Builder::new()
                .name("test-http".into())
                .spawn(move || {
                    while !stop.load(Ordering::Acquire) {
                        match listener.accept() {
                            Ok((conn, _)) => {
                                let (state, stop) = (Arc::clone(&state), Arc::clone(&stop));
                                state.open_connections.fetch_add(1, Ordering::AcqRel);
                                std::thread::spawn(move || {
                                    serve(&state, &stop, conn);
                                    state.open_connections.fetch_sub(1, Ordering::AcqRel);
                                });
                            }
                            Err(_) => std::thread::sleep(Duration::from_millis(2)),
                        }
                    }
                })
                .unwrap()
        };
        Self {
            addr,
            state,
            stop,
            thread: Some(thread),
        }
    }

    /// `127.0.0.1:<port>`.
    #[must_use]
    pub fn authority(&self) -> String {
        self.addr.to_string()
    }

    /// `http://127.0.0.1:<port><path>`.
    #[must_use]
    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    pub fn put(&self, path: &str, bytes: Vec<u8>) {
        self.state
            .files
            .lock()
            .unwrap()
            .insert(path.to_owned(), Arc::new(bytes));
    }

    pub fn set_behavior(&self, behavior: Behavior) {
        *self.state.behavior.lock().unwrap() = behavior;
    }

    #[must_use]
    pub fn requests(&self) -> Vec<Logged> {
        self.state.log.lock().unwrap().clone()
    }

    /// Requests that carried a `Range` header.
    #[must_use]
    pub fn range_requests(&self) -> usize {
        self.requests().iter().filter(|r| r.range.is_some()).count()
    }

    #[must_use]
    pub fn open_connections(&self) -> usize {
        self.state.open_connections.load(Ordering::Acquire)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// A port nothing listens on (bound, then released).
#[must_use]
pub fn dead_authority() -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    addr.to_string()
}

fn serve(state: &State, stop: &AtomicBool, conn: TcpStream) {
    // Accepted sockets inherit the listener's non-blocking mode on Windows.
    if conn.set_nonblocking(false).is_err() {
        return;
    }
    let _ = conn.set_nodelay(true);
    let mut reader = BufReader::new(match conn.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    });
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let path = parts.next().unwrap_or("").to_owned();
    let mut range = None;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).unwrap_or(0) == 0 {
            return;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((name, value)) = h.split_once(':')
            && name.trim().eq_ignore_ascii_case("range")
        {
            range = Some(value.trim().to_owned());
        }
    }
    state.log.lock().unwrap().push(Logged {
        method: method.clone(),
        path: path.clone(),
        range: range.clone(),
    });
    let behavior = state.behavior.lock().unwrap().clone();
    let mut out = conn;
    if let Some(status) = behavior.status {
        let _ = write!(
            out,
            "HTTP/1.1 {status} Forced\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        return;
    }
    let Some(file) = state.files.lock().unwrap().get(&path).cloned() else {
        let _ = write!(
            out,
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        return;
    };
    let len = file.len() as u64;
    let (start, end, status_line) = match range.as_deref().and_then(|r| parse_range(r, len)) {
        Some(Ok((a, b))) => (a, b, "206 Partial Content".to_owned()),
        Some(Err(())) => {
            let _ = write!(
                out,
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            return;
        }
        None => (0, len, "200 OK".to_owned()),
    };
    let mut head =
        format!("HTTP/1.1 {status_line}\r\nContent-Type: audio/mpeg\r\nAccept-Ranges: bytes\r\n");
    if !behavior.no_length {
        head.push_str(&format!("Content-Length: {}\r\n", end - start));
    }
    if status_line.starts_with("206") {
        head.push_str(&format!(
            "Content-Range: bytes {start}-{}/{len}\r\n",
            end - 1
        ));
    }
    head.push_str("Connection: close\r\n\r\n");
    if method == "HEAD" {
        let _ = out.write_all(head.as_bytes());
        return;
    }
    if out.write_all(head.as_bytes()).is_err() {
        return;
    }
    let mut pos = start;
    let mut sent = 0_u64;
    while pos < end {
        if stop.load(Ordering::Acquire) {
            return;
        }
        if let Some(limit) = behavior.stall_after
            && sent >= limit
        {
            hold(stop, &out);
            return;
        }
        let mut n = (behavior.chunk.max(1) as u64).min(end - pos);
        if let Some(limit) = behavior.stall_after {
            n = n.min(limit - sent);
        }
        let slice = &file[pos as usize..(pos + n) as usize];
        if out.write_all(slice).is_err() {
            return;
        }
        pos += n;
        sent += n;
        if !behavior.delay.is_zero() {
            std::thread::sleep(behavior.delay);
        }
    }
    let _ = out.flush();
}

/// Keeps a stalled connection open until the client goes away or the server stops.
fn hold(stop: &AtomicBool, conn: &TcpStream) {
    let _ = conn.set_read_timeout(Some(Duration::from_millis(50)));
    let mut probe = conn.try_clone().ok();
    let started = Instant::now();
    while !stop.load(Ordering::Acquire) && started.elapsed() < Duration::from_secs(60) {
        if let Some(p) = probe.as_mut() {
            let mut b = [0_u8; 1];
            match p.read(&mut b) {
                Ok(0) => return, // client closed
                Ok(_) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => return,
            }
        } else {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// `bytes=a-b` / `bytes=a-` → `[a, b+1)` clamped to `len`; `Err` when unsatisfiable; `None` when not a byte range.
fn parse_range(header: &str, len: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let a: u64 = a.trim().parse().ok()?;
    let b = b.trim();
    let end = if b.is_empty() {
        len
    } else {
        (b.parse::<u64>().ok()? + 1).min(len)
    };
    if a >= len || a >= end {
        return Some(Err(()));
    }
    Some(Ok((a, end)))
}

/// What the source told the registry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegEvent {
    Begin(u16),
    End(u16, Option<u64>),
}

#[derive(Default)]
pub struct Registry {
    events: Mutex<Vec<RegEvent>>,
}

impl Registry {
    #[must_use]
    pub fn events(&self) -> Vec<RegEvent> {
        self.events.lock().unwrap().clone()
    }
}

impl StreamRegistry for Registry {
    fn begin(&self, key: &FileKey) {
        self.events.lock().unwrap().push(RegEvent::Begin(key.surah));
    }

    fn end(&self, key: &FileKey, promoted_bytes: Option<u64>) {
        self.events
            .lock()
            .unwrap()
            .push(RegEvent::End(key.surah, promoted_bytes));
    }
}

/// A multi-thread tokio runtime like tauri's (time and IO drivers on).
#[must_use]
pub fn runtime() -> TestRuntime {
    TestRuntime(Some(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap(),
    ))
}

/// A runtime that shuts down without waiting for its blocking pool. The app's runtime lives until the process exits;
/// a test's ends with the test, possibly while a stream's Range request still waits on the blocking pool for a
/// download task that the shutdown itself drops.
pub struct TestRuntime(Option<tokio::runtime::Runtime>);

impl std::ops::Deref for TestRuntime {
    type Target = tokio::runtime::Runtime;

    fn deref(&self) -> &tokio::runtime::Runtime {
        self.0.as_ref().unwrap()
    }
}

impl Drop for TestRuntime {
    fn drop(&mut self) {
        if let Some(rt) = self.0.take() {
            rt.shutdown_timeout(Duration::from_millis(500));
        }
    }
}

/// A reqwest client like the app's (no total timeout: streams are long).
#[must_use]
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("QuranForDesktop/test")
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .unwrap()
}

/// A source, its registry and its online switch.
pub struct Fixture {
    pub rt: TestRuntime,
    pub dir: tempfile::TempDir,
    pub registry: Arc<Registry>,
    pub online: Arc<AtomicBool>,
    pub source: CachingHttpSource,
}

impl Fixture {
    #[must_use]
    pub fn new() -> Self {
        Self::with(|s| s)
    }

    #[must_use]
    pub fn with(configure: impl FnOnce(CachingHttpSource) -> CachingHttpSource) -> Self {
        let _ = log_init();
        let rt = runtime();
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(Registry::default());
        let online = Arc::new(AtomicBool::new(true));
        let flag = Arc::clone(&online);
        let online_fn: OnlineFn = Arc::new(move || flag.load(Ordering::Acquire));
        let source = configure(CachingHttpSource::new(
            dir.path().join("audio"),
            rt.handle().clone(),
            client(),
            Arc::clone(&registry) as Arc<dyn StreamRegistry>,
            online_fn,
        ));
        Self {
            rt,
            dir,
            registry,
            online,
            source,
        }
    }

    #[must_use]
    pub fn root(&self) -> PathBuf {
        self.dir.path().join("audio")
    }

    #[must_use]
    pub fn mp3(&self, surah: u16) -> PathBuf {
        quran_audio::cached_file_path(&self.root(), RECITER, surah)
    }

    #[must_use]
    pub fn part(&self, surah: u16) -> PathBuf {
        quran_audio::stream_part_path(&self.root(), RECITER, surah)
    }
}

/// The key of `surah` served at `url`.
#[must_use]
pub fn key(url: String, surah: u16, expected_len: Option<u64>) -> FileKey {
    FileKey {
        reciter_id: RECITER,
        surah,
        url,
        expected_len,
    }
}

/// Polls `cond` until it holds; panics with `what` after `timeout`.
pub fn wait_for(timeout: Duration, what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + timeout;
    while !cond() {
        assert!(
            Instant::now() < deadline,
            "timed out after {timeout:?}: {what}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Reads a whole source.
pub fn read_all(source: &mut dyn Read) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    source.read_to_end(&mut out)?;
    Ok(out)
}

#[must_use]
pub fn exists(path: &Path) -> bool {
    path.try_exists().unwrap_or(false)
}

fn log_init() -> Result<(), log::SetLoggerError> {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata<'_>) -> bool {
            m.level() <= log::Level::Info
        }
        fn log(&self, r: &log::Record<'_>) {
            if self.enabled(r.metadata()) && r.target().starts_with("quran_audio") {
                eprintln!("[{}] {}", r.level(), r.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Stderr = Stderr;
    log::set_logger(&LOGGER).map(|()| log::set_max_level(log::LevelFilter::Info))
}
