//! A small in-repo HTTP/1.1 server for the quran-packs tests.
//!
//! std only (the crate has no dev-dependencies): one thread per connection, `Connection: close`. Per route it supports
//! - `Range: bytes=N-` / `bytes=N-M` (206 with `Content-Range`, 416 past the end), `If-Range` against the ETag (strong
//!   comparison) or `Last-Modified`, conditional `If-None-Match` / `If-Modified-Since` (304), `HEAD`;
//! - a script of per-request [`Action`]s consumed in order (404/5xx, 429/503 with `Retry-After`, a mid-stream
//!   disconnect after N body bytes, ignoring `Range`), then normal serving;
//! - throttled bodies (chunk size + delay), a [`Gate`] that holds responses until opened, and responses without
//!   `Content-Length`;
//! - a request log (method, path, host and headers) and the peak number of concurrent requests, overall and per host.
//!
//! Unknown paths answer 404. [`closed_port_url`] gives a URL whose connection is refused.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the server does with the next request to a route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Normal serving (also what happens once the script is used up).
    Serve,
    /// Answer with this status and a short body.
    Status(u16),
    /// Answer with this status (429/503) and a `Retry-After` header.
    RetryAfter(u16, String),
    /// Send the normal headers (full length) and only this many body bytes, then close.
    Disconnect(usize),
    /// Serve the full body with 200 even when a valid `Range` is sent.
    IgnoreRange,
    /// Serve a 206 for a different start than requested (a broken server).
    WrongRange,
}

/// A served resource.
#[derive(Clone)]
pub struct Route {
    body: Arc<Vec<u8>>,
    content_type: String,
    etag: Option<String>,
    last_modified: Option<String>,
    ranges: bool,
    send_length: bool,
    script: VecDeque<Action>,
    chunk: usize,
    delay: Duration,
    gate: Option<Gate>,
}

impl Route {
    /// `application/octet-stream`, ranges on, `Content-Length` sent.
    pub fn bytes(body: impl Into<Vec<u8>>) -> Self {
        Self {
            body: Arc::new(body.into()),
            content_type: "application/octet-stream".into(),
            etag: None,
            last_modified: None,
            ranges: true,
            send_length: true,
            script: VecDeque::new(),
            chunk: 16 * 1024,
            delay: Duration::ZERO,
            gate: None,
        }
    }

    /// A JSON document.
    pub fn json(value: &serde_json::Value) -> Self {
        let mut r = Self::bytes(serde_json::to_vec(value).unwrap_or_default());
        r.content_type = "application/json".into();
        r
    }

    pub fn etag(mut self, etag: &str) -> Self {
        self.etag = Some(etag.into());
        self
    }

    pub fn last_modified(mut self, lm: &str) -> Self {
        self.last_modified = Some(lm.into());
        self
    }

    pub fn no_ranges(mut self) -> Self {
        self.ranges = false;
        self
    }

    /// Close-delimited body without `Content-Length`.
    pub fn no_length(mut self) -> Self {
        self.send_length = false;
        self
    }

    /// Appends one scripted action.
    pub fn then(mut self, action: Action) -> Self {
        self.script.push_back(action);
        self
    }

    /// Body written in `chunk`-byte pieces with `delay` between them.
    pub fn throttle(mut self, chunk: usize, delay: Duration) -> Self {
        self.chunk = chunk.max(1);
        self.delay = delay;
        self
    }

    /// Responses wait until the gate opens.
    pub fn gated(mut self, gate: &Gate) -> Self {
        self.gate = Some(gate.clone());
        self
    }

    pub fn len(&self) -> usize {
        self.body.len()
    }
}

/// Holds responses until opened (at most 30 s, so a broken test cannot hang forever).
#[derive(Clone, Default)]
pub struct Gate {
    inner: Arc<(Mutex<GateState>, Condvar)>,
}

#[derive(Default)]
struct GateState {
    open: bool,
    waiting: usize,
}

impl Gate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&self) {
        let (m, cv) = &*self.inner;
        lock(m).open = true;
        cv.notify_all();
    }

    /// Requests currently held.
    pub fn waiting(&self) -> usize {
        lock(&self.inner.0).waiting
    }

    fn wait(&self) {
        let (m, cv) = &*self.inner;
        let mut st = lock(m);
        st.waiting += 1;
        let deadline = Instant::now() + Duration::from_secs(30);
        while !st.open {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            st = cv
                .wait_timeout(st, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        st.waiting -= 1;
    }
}

/// One logged request.
#[derive(Debug, Clone)]
pub struct Logged {
    pub method: String,
    /// Path including any query string.
    pub path: String,
    /// The `Host` header.
    pub host: String,
    /// Lowercase header names.
    pub headers: HashMap<String, String>,
}

impl Logged {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }
}

#[derive(Default)]
struct State {
    routes: Mutex<HashMap<String, Route>>,
    log: Mutex<Vec<Logged>>,
    active: Mutex<(usize, HashMap<String, usize>)>,
    peak: Mutex<(usize, HashMap<String, usize>)>,
}

/// The running server; stops on drop.
pub struct TestServer {
    addr: SocketAddr,
    state: Arc<State>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl TestServer {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("bind: {e}"));
        let addr = listener
            .local_addr()
            .unwrap_or_else(|e| panic!("local_addr: {e}"));
        let state = Arc::new(State::default());
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let state = Arc::clone(&state);
            let stop = Arc::clone(&stop);
            std::thread::Builder::new()
                .name("test-http".into())
                .spawn(move || {
                    for conn in listener.incoming() {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        let Ok(stream) = conn else { continue };
                        let state = Arc::clone(&state);
                        let _ = std::thread::Builder::new()
                            .name("test-http-conn".into())
                            .spawn(move || handle(&state, stream));
                    }
                })
                .unwrap_or_else(|e| panic!("spawn: {e}"))
        };
        Self {
            addr,
            state,
            stop,
            thread: Some(thread),
        }
    }

    /// Adds or replaces a route (`path` without query string, starting with `/`).
    pub fn route(&self, path: &str, route: Route) {
        lock(&self.state.routes).insert(path.to_owned(), route);
    }

    /// `http://127.0.0.1:{port}{path}`.
    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.addr.port())
    }

    /// The same server under another host name (`localhost`): a different host for the per-host limits.
    pub fn url_as(&self, host: &str, path: &str) -> String {
        format!("http://{host}:{}{path}", self.addr.port())
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    pub fn requests(&self) -> Vec<Logged> {
        lock(&self.state.log).clone()
    }

    /// Requests whose path (without query) is `path`.
    pub fn requests_to(&self, path: &str) -> Vec<Logged> {
        self.requests()
            .into_iter()
            .filter(|r| r.path.split('?').next() == Some(path))
            .collect()
    }

    pub fn hits(&self, path: &str) -> usize {
        self.requests_to(path).len()
    }

    /// Peak concurrent requests overall.
    pub fn peak(&self) -> usize {
        lock(&self.state.peak).0
    }

    /// Peak concurrent requests with this `Host` header (`127.0.0.1:{port}`).
    pub fn peak_for_host(&self, host: &str) -> usize {
        lock(&self.state.peak).1.get(host).copied().unwrap_or(0)
    }

    pub fn clear_log(&self) {
        lock(&self.state.log).clear();
        *lock(&self.state.peak) = (0, HashMap::new());
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(200));
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// A URL on a port nothing listens on (connection refused at once).
pub fn closed_port_url(path: &str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|e| panic!("bind: {e}"));
    let port = listener
        .local_addr()
        .unwrap_or_else(|e| panic!("local_addr: {e}"))
        .port();
    drop(listener);
    format!("http://127.0.0.1:{port}{path}")
}

struct Parsed {
    method: String,
    path: String,
    headers: HashMap<String, String>,
}

fn read_request(stream: &TcpStream) -> Option<Parsed> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).ok()? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
        }
    }
    Some(Parsed {
        method,
        path,
        headers,
    })
}

fn handle(state: &State, stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_nodelay(true);
    let Some(req) = read_request(&stream) else {
        return;
    };
    let host = req.headers.get("host").cloned().unwrap_or_default();
    lock(&state.log).push(Logged {
        method: req.method.clone(),
        path: req.path.clone(),
        host: host.clone(),
        headers: req.headers.clone(),
    });
    {
        let mut active = lock(&state.active);
        active.0 += 1;
        let n = {
            let e = active.1.entry(host.clone()).or_insert(0);
            *e += 1;
            *e
        };
        let total = active.0;
        let mut peak = lock(&state.peak);
        peak.0 = peak.0.max(total);
        let p = peak.1.entry(host.clone()).or_insert(0);
        *p = (*p).max(n);
    }
    respond(state, &req, stream);
    let mut active = lock(&state.active);
    active.0 -= 1;
    if let Some(e) = active.1.get_mut(&host) {
        *e -= 1;
    }
}

fn respond(state: &State, req: &Parsed, mut stream: TcpStream) {
    let route_path = req.path.split('?').next().unwrap_or_default().to_owned();
    let (route, action) = {
        let mut routes = lock(&state.routes);
        match routes.get_mut(&route_path) {
            Some(r) => {
                let action = r.script.pop_front().unwrap_or(Action::Serve);
                (Some(r.clone()), action)
            }
            None => (None, Action::Serve),
        }
    };
    let Some(route) = route else {
        write_simple(&mut stream, 404, &[]);
        return;
    };
    if let Some(gate) = &route.gate {
        gate.wait();
    }
    match action {
        Action::Status(code) => {
            write_simple(&mut stream, code, &[]);
            return;
        }
        Action::RetryAfter(code, value) => {
            write_simple(&mut stream, code, &[("Retry-After", value)]);
            return;
        }
        _ => {}
    }
    let len = route.body.len();
    let head_only = req.method.eq_ignore_ascii_case("HEAD");

    // Conditional requests.
    let inm = req.headers.get("if-none-match");
    let not_modified = match (inm, &route.etag) {
        (Some(v), Some(etag)) => v.split(',').any(|t| t.trim() == etag || t.trim() == "*"),
        (Some(_), None) => false,
        (None, _) => matches!(
            (req.headers.get("if-modified-since"), &route.last_modified),
            (Some(a), Some(b)) if a == b
        ),
    };
    if not_modified {
        let mut extra = Vec::new();
        if let Some(e) = &route.etag {
            extra.push(("ETag", e.clone()));
        }
        write_head(&mut stream, 304, None, &route, &extra);
        return;
    }

    // Range.
    let range = req
        .headers
        .get("range")
        .filter(|_| route.ranges && action != Action::IgnoreRange)
        .and_then(|v| parse_range(v, len));
    let range_valid = range.is_some()
        && match req.headers.get("if-range") {
            None => true,
            Some(v) => {
                let strong_etag = route.etag.as_deref().filter(|e| !e.starts_with("W/"));
                Some(v.as_str()) == strong_etag || Some(v) == route.last_modified.as_ref()
            }
        };
    let (status, start, end) = match range {
        Some(Err(())) if range_valid => {
            write_head(
                &mut stream,
                416,
                Some(0),
                &route,
                &[("Content-Range", format!("bytes */{len}"))],
            );
            return;
        }
        Some(Ok((s, e))) if range_valid => (206, s, e),
        _ => (200, 0, len),
    };
    let start = if action == Action::WrongRange && status == 206 {
        start.saturating_sub(1)
    } else {
        start
    };
    let mut extra = Vec::new();
    if status == 206 {
        extra.push((
            "Content-Range",
            format!("bytes {start}-{}/{len}", end.saturating_sub(1)),
        ));
    }
    let length = route.send_length.then_some(end - start);
    write_head(&mut stream, status, length, &route, &extra);
    if head_only {
        return;
    }
    let body = &route.body[start..end];
    let limit = match action {
        Action::Disconnect(n) => n.min(body.len()),
        _ => body.len(),
    };
    for piece in body[..limit].chunks(route.chunk) {
        if stream.write_all(piece).is_err() {
            return;
        }
        let _ = stream.flush();
        if !route.delay.is_zero() {
            std::thread::sleep(route.delay);
        }
    }
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

/// `bytes=N-` / `bytes=N-M` → `Ok((start, end_exclusive))`, `Err(())` when unsatisfiable.
fn parse_range(v: &str, len: usize) -> Option<Result<(usize, usize), ()>> {
    let spec = v.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let start: usize = a.trim().parse().ok()?;
    if start >= len {
        return Some(Err(()));
    }
    let end = match b.trim() {
        "" => len,
        b => b.parse::<usize>().ok()?.saturating_add(1).min(len),
    };
    if end <= start {
        return Some(Err(()));
    }
    Some(Ok((start, end)))
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        206 => "Partial Content",
        304 => "Not Modified",
        404 => "Not Found",
        416 => "Range Not Satisfiable",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

fn write_head(
    stream: &mut TcpStream,
    status: u16,
    length: Option<usize>,
    route: &Route,
    extra: &[(&str, String)],
) {
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    head.push_str(&format!("Content-Type: {}\r\n", route.content_type));
    if let Some(n) = length {
        head.push_str(&format!("Content-Length: {n}\r\n"));
    }
    if let Some(e) = &route.etag {
        head.push_str(&format!("ETag: {e}\r\n"));
    }
    if let Some(lm) = &route.last_modified {
        head.push_str(&format!("Last-Modified: {lm}\r\n"));
    }
    if route.ranges {
        head.push_str("Accept-Ranges: bytes\r\n");
    }
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    let _ = stream.write_all(head.as_bytes());
}

fn write_simple(stream: &mut TcpStream, status: u16, extra: &[(&str, String)]) {
    let body = format!("{status}");
    let mut head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n",
        reason(status),
        body.len()
    );
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}
