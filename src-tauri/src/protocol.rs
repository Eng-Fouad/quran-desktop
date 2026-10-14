//! The `quran://` custom protocol and the raw `font_bytes` command.
//!
//! The protocol serves downloaded pack files from `<app_local_data_dir>/packs/` to the webview: QCF page fonts, the
//! decorative fonts and (for diagnostics) cached recitation files. Only an allow-list of routes is served; every other
//! path is a `404`, and a path that is empty or contains anything but plain components (`..`, `.`, a root, a drive
//! prefix) is a `403` before any route is even considered. File paths are rebuilt from the validated route parts, never
//! from the request, so nothing outside the packs root can be reached.
//!
//! Rules:
//! - `GET`/`HEAD` are served, `OPTIONS` answers `204` with the CORS preflight headers, every other method is `405`;
//! - the query string (`?v=<sha8>`, a cache-buster) is ignored;
//! - a single `Range` (`bytes=a-b | a- | -n`, the first range of a multi-range request) is answered with `206` and at
//!   most [`MAX_RANGE_BYTES`] of body; an unsatisfiable range is `416` with `Content-Range: bytes */len`; a `Range` header
//!   that is not a byte range is ignored (`200` with the whole file, RFC 9110 §14.2);
//! - every response, errors included, carries the CORS and safety headers (`FontFace` URL loads are CORS-mode);
//! - file IO runs on the blocking pool, never on the webview's protocol thread, and the handler never panics.
//!
//! `font_bytes` is the raw-bytes twin of the font routes for `AppInfo.fontTransport = bytes`: the same allow-list and
//! path rules, the whole file as `InvokeResponseBody::Raw` (an `ArrayBuffer` in JS).

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use percent_encoding::percent_decode_str;
use quran_types::{AppError, PAGE_COUNT};
use tauri::http::{self, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::state::AppState;

/// Base URL of the protocol as seen by the webview (`AppInfo.protocolBase`): `http://quran.localhost/` on Windows
/// (WebView2 maps custom schemes to http), `quran://localhost/` on macOS and Linux.
pub const PROTOCOL_BASE: &str = if cfg!(windows) {
    "http://quran.localhost/"
} else {
    "quran://localhost/"
};

/// Largest body of one `206` response. A client asking for more gets the first MiB and asks again.
pub const MAX_RANGE_BYTES: u64 = 1024 * 1024;

/// Largest file `font_bytes` returns. The biggest real font (the optional Nastaliq face) is well under 1 MiB; anything
/// near this size is a damaged file, and refusing it keeps one bad file from allocating without bound.
pub const MAX_FONT_BYTES: u64 = 16 * 1024 * 1024;

/// `Cache-Control` of every successful response: pack URLs are content-versioned (`?v=<sha256[0..8]>`).
const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// How long the webview may cache a preflight answer.
const PREFLIGHT_MAX_AGE_SECS: u32 = 86_400;

/// The decorative fonts: file name and content type.
const DECOR_FILES: [(&str, &str); 4] = [
    ("qcf-surah-header.woff2", "font/woff2"),
    ("quran-common.ttf", "font/ttf"),
    ("sura-names.woff2", "font/woff2"),
    ("noto-nastaliq-urdu.woff2", "font/woff2"),
];

/// One file of the allow-list, rebuilt from validated parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    /// The path below the packs root, with `/` separators (`mushaf/v2/p262.woff2`).
    rel: String,
    content_type: &'static str,
    kind: RouteKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteKind {
    /// `mushaf/{v1,v2,v4}/p{N}.woff2` and `decor/*`: also served by `font_bytes`.
    Font,
    /// `audio/{reciter}/{sss}.mp3` (diagnostics; the engine reads files natively).
    Audio,
}

impl Route {
    /// Matches a decoded path **without** its leading `/` against the allow-list:
    ///
    /// | Route | Content-Type |
    /// |---|---|
    /// | `mushaf/(v1\|v2\|v4)/p([1-9][0-9]{0,2}).woff2`, page ≤ 604 | `font/woff2` |
    /// | `decor/qcf-surah-header.woff2`, `decor/sura-names.woff2`, `decor/noto-nastaliq-urdu.woff2` | `font/woff2` |
    /// | `decor/quran-common.ttf` | `font/ttf` |
    /// | `audio/([0-9]{1,4})/([0-9]{3}).mp3` | `audio/mpeg` |
    ///
    /// Matching is exact and case-sensitive: no empty segments, no leading zeros in page numbers, and
    /// `.stream.part`/`.dl.part` temporaries and sidecars never match.
    #[must_use]
    pub fn parse(rel: &str) -> Option<Self> {
        let mut parts = rel.split('/');
        let route = match (parts.next(), parts.next(), parts.next()) {
            (Some("mushaf"), Some(variant @ ("v1" | "v2" | "v4")), Some(file)) => {
                let page = page_font_number(file)?;
                Self::font(format!("mushaf/{variant}/p{page}.woff2"), "font/woff2")
            }
            (Some("decor"), Some(file), None) => {
                let (name, content_type) = DECOR_FILES.iter().find(|(name, _)| *name == file)?;
                Self::font(format!("decor/{name}"), content_type)
            }
            (Some("audio"), Some(reciter), Some(file)) => {
                let surah = file.strip_suffix(".mp3")?;
                let reciter_ok = (1..=4).contains(&reciter.len()) && all_ascii_digits(reciter);
                let surah_ok = surah.len() == 3 && all_ascii_digits(surah);
                if !(reciter_ok && surah_ok) {
                    return None;
                }
                Self {
                    rel: format!("audio/{reciter}/{surah}.mp3"),
                    content_type: "audio/mpeg",
                    kind: RouteKind::Audio,
                }
            }
            _ => return None,
        };
        // No fourth segment anywhere.
        parts.next().is_none().then_some(route)
    }

    fn font(rel: String, content_type: &'static str) -> Self {
        Self {
            rel,
            content_type,
            kind: RouteKind::Font,
        }
    }

    /// The path below the packs root (`mushaf/v2/p262.woff2`).
    #[must_use]
    pub fn rel(&self) -> &str {
        &self.rel
    }

    /// The exact `Content-Type` of the route.
    #[must_use]
    pub fn content_type(&self) -> &'static str {
        self.content_type
    }

    /// Page fonts and decorative fonts: the routes `font_bytes` accepts.
    #[must_use]
    pub fn is_font(&self) -> bool {
        self.kind == RouteKind::Font
    }

    /// The file under `packs_root`.
    #[must_use]
    pub fn file(&self, packs_root: &Path) -> PathBuf {
        self.rel
            .split('/')
            .fold(packs_root.to_path_buf(), |path, part| path.join(part))
    }
}

/// `p{N}.woff2` with `N` in `1..=604` written without leading zeros.
fn page_font_number(file: &str) -> Option<u32> {
    let digits = file.strip_prefix('p')?.strip_suffix(".woff2")?;
    if !(1..=3).contains(&digits.len()) || !all_ascii_digits(digits) || digits.starts_with('0') {
        return None;
    }
    digits
        .parse::<u32>()
        .ok()
        .filter(|page| (1..=PAGE_COUNT).contains(page))
}

fn all_ascii_digits(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_digit())
}

/// The path rules on a relative path: empty, or any component other than a plain name (`..`, `.`, an empty segment, a
/// root, a Windows drive or UNC prefix; on Windows `\` separates components too) → `403`.
///
/// `Path::components` alone is not enough: it silently drops interior `.` and empty segments, so every segment is also
/// checked as written.
fn check_components(rel: &str) -> Result<(), StatusCode> {
    let is_separator = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let plain = !rel.is_empty()
        && rel
            .split(is_separator)
            .all(|segment| !matches!(segment, "" | "." | ".."))
        && Path::new(rel)
            .components()
            .all(|c| matches!(c, Component::Normal(_)));
    if plain {
        Ok(())
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

/// Request path (as in the URI, without the query) → route: percent-decode (`400` on invalid UTF-8), path rules
/// (`403`), allow-list (`404`).
fn resolve(uri_path: &str) -> Result<Route, StatusCode> {
    let decoded = percent_decode_str(uri_path)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let rel = decoded.strip_prefix('/').unwrap_or(&decoded);
    check_components(rel)?;
    Route::parse(rel).ok_or(StatusCode::NOT_FOUND)
}

/// What a request needs: an answer that requires no IO, or a file read.
#[derive(Debug)]
enum Plan {
    Respond(http::Response<Vec<u8>>),
    Read {
        route: Route,
        head: bool,
        range: Option<String>,
    },
}

/// Method and path checks, done on the protocol thread (no IO).
fn plan(method: &Method, uri_path: &str, range: Option<&str>) -> Plan {
    let head = match *method {
        Method::GET => false,
        Method::HEAD => true,
        Method::OPTIONS => return Plan::Respond(preflight()),
        _ => return Plan::Respond(method_not_allowed()),
    };
    match resolve(uri_path) {
        Ok(route) => Plan::Read {
            route,
            head,
            range: range.map(str::to_owned),
        },
        Err(status) => Plan::Respond(status_response(status)),
    }
}

/// A parsed `Range` header against a file of `len` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RangeRequest {
    /// No header, or one that is not a byte range: the whole file (`200`).
    Full,
    /// Inclusive byte offsets, already clamped to the file and to [`MAX_RANGE_BYTES`] (`206`).
    Partial { start: u64, end: u64 },
    /// A valid byte range that selects nothing (`416`).
    Unsatisfiable,
}

impl RangeRequest {
    /// `bytes=a-b | a- | -n`. Only the first range of a list is honoured. Whitespace around the parts is tolerated, the
    /// unit is case-insensitive (RFC 9110 §14.1).
    fn parse(header: Option<&str>, len: u64) -> Self {
        let Some(header) = header else {
            return Self::Full;
        };
        let Some((unit, set)) = header.trim().split_once('=') else {
            return Self::Full;
        };
        if !unit.trim().eq_ignore_ascii_case("bytes") {
            return Self::Full;
        }
        let first = set.split(',').next().unwrap_or_default().trim();
        let Some((from, to)) = first.split_once('-') else {
            return Self::Full;
        };
        let (from, to) = (from.trim(), to.trim());
        let number =
            |s: &str| (!s.is_empty() && all_ascii_digits(s)).then(|| s.parse::<u64>().ok());
        let (start, end) = match (number(from), number(to)) {
            // `a-b` / `a-`
            (Some(Some(start)), last) => {
                let end = match last {
                    Some(Some(end)) if end >= start => end,
                    Some(_) => return Self::Full, // `b < a` or overflow: an invalid range-spec is ignored
                    None if to.is_empty() => u64::MAX,
                    None => return Self::Full,
                };
                if start >= len {
                    return Self::Unsatisfiable;
                }
                (start, end.min(len - 1))
            }
            // `-n`: the last n bytes
            (None, Some(Some(suffix))) if from.is_empty() => {
                if suffix == 0 || len == 0 {
                    return Self::Unsatisfiable;
                }
                (len - suffix.min(len), len - 1)
            }
            _ => return Self::Full,
        };
        let capped = end.min(start.saturating_add(MAX_RANGE_BYTES - 1));
        Self::Partial { start, end: capped }
    }
}

/// Reads the route's file and builds the response (`200`, `206`, `416`, `404` or `500`). Runs on the blocking pool.
fn read_response(
    root: &Path,
    route: &Route,
    head: bool,
    range: Option<&str>,
) -> http::Response<Vec<u8>> {
    match read_file(&route.file(root), head, range) {
        Ok(Served::Body {
            status,
            len,
            span,
            body,
        }) => {
            let mut response = status_response(status);
            *response.body_mut() = body;
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(route.content_type),
            );
            headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(CACHE_IMMUTABLE),
            );
            let body_len = match span {
                Some((start, end)) => {
                    insert_text(
                        headers,
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{len}"),
                    );
                    end - start + 1
                }
                None => len,
            };
            headers.insert(header::CONTENT_LENGTH, HeaderValue::from(body_len));
            response
        }
        Ok(Served::Unsatisfiable { len }) => {
            let mut response = status_response(StatusCode::RANGE_NOT_SATISFIABLE);
            insert_text(
                response.headers_mut(),
                header::CONTENT_RANGE,
                format!("bytes */{len}"),
            );
            response
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            log::debug!("quran://{}: not found", route.rel);
            status_response(StatusCode::NOT_FOUND)
        }
        Err(e) => {
            log::debug!("quran://{}: {e}", route.rel);
            status_response(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// What [`read_file`] produced.
#[derive(Debug)]
enum Served {
    Body {
        status: StatusCode,
        /// File length.
        len: u64,
        /// Inclusive byte span of a `206`.
        span: Option<(u64, u64)>,
        /// Empty for `HEAD`.
        body: Vec<u8>,
    },
    Unsatisfiable {
        len: u64,
    },
}

/// Opens a regular file and returns it with its length (taken from the open handle). Anything else at the path (a
/// directory, which Windows refuses to open with "access denied") reads as missing.
fn open_regular(path: &Path) -> io::Result<(File, u64)> {
    if !std::fs::metadata(path)?.is_file() {
        return Err(io::ErrorKind::NotFound.into());
    }
    let file = File::open(path)?;
    let len = file.metadata()?.len();
    Ok((file, len))
}

/// Opens the file once and reads the requested span. A path that is not a regular file reads as missing; a file that
/// shrank while being read is an error.
fn read_file(path: &Path, head: bool, range: Option<&str>) -> io::Result<Served> {
    let (mut file, len) = open_regular(path)?;
    let (status, span, start, count) = match RangeRequest::parse(range, len) {
        RangeRequest::Full => (StatusCode::OK, None, 0, len),
        RangeRequest::Partial { start, end } => (
            StatusCode::PARTIAL_CONTENT,
            Some((start, end)),
            start,
            end - start + 1,
        ),
        RangeRequest::Unsatisfiable => return Ok(Served::Unsatisfiable { len }),
    };
    let body = if head {
        Vec::new()
    } else {
        if start > 0 {
            file.seek(SeekFrom::Start(start))?;
        }
        read_exact_len(&mut file, count)?
    };
    Ok(Served::Body {
        status,
        len,
        span,
        body,
    })
}

/// Reads exactly `count` bytes into a buffer allocated once.
fn read_exact_len(reader: &mut impl Read, count: u64) -> io::Result<Vec<u8>> {
    let capacity =
        usize::try_from(count).map_err(|_| io::Error::other("file too large for this platform"))?;
    let mut body = Vec::with_capacity(capacity);
    reader.take(count).read_to_end(&mut body)?;
    if body.len() == capacity {
        Ok(body)
    } else {
        Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "the file changed while it was read",
        ))
    }
}

fn insert_text(headers: &mut HeaderMap, name: HeaderName, value: String) {
    match HeaderValue::try_from(value) {
        Ok(value) => {
            headers.insert(name, value);
        }
        Err(e) => log::warn!("quran://: invalid {name} header: {e}"),
    }
}

/// A bodiless response with the headers every `quran://` response carries, errors included.
fn status_response(status: StatusCode) -> http::Response<Vec<u8>> {
    let mut response = http::Response::new(Vec::new());
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("content-range, content-length, accept-ranges"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("cross-origin"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

/// `OPTIONS` → `204` with the CORS preflight answer (a `Range` request header is the only non-simple header used).
fn preflight() -> http::Response<Vec<u8>> {
    let mut response = status_response(StatusCode::NO_CONTENT);
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("range"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from(PREFLIGHT_MAX_AGE_SECS),
    );
    response
}

/// Any method but `GET`, `HEAD` and `OPTIONS` → `405` with `Allow`.
fn method_not_allowed() -> http::Response<Vec<u8>> {
    let mut response = status_response(StatusCode::METHOD_NOT_ALLOWED);
    response.headers_mut().insert(
        header::ALLOW,
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    response
}

/// Handler registered by `lib.rs` through `register_asynchronous_uri_scheme_protocol("quran", protocol::handle)`.
///
/// Method and path checks answer at once; file reads go to the blocking pool, which answers through `responder`.
/// Before `AppState` is managed (the fatal startup path, where the window stays hidden) every file request is `503`.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let (route, head, range) = match plan(request.method(), request.uri().path(), range) {
        Plan::Respond(response) => return responder.respond(response),
        Plan::Read { route, head, range } => (route, head, range),
    };
    let Some(root) = packs_root(ctx.app_handle()) else {
        log::debug!("quran://{}: app state not ready", route.rel);
        return responder.respond(status_response(StatusCode::SERVICE_UNAVAILABLE));
    };
    // Detached: the task owns the responder and always answers. A JoinHandle is only needed to await it.
    drop(tauri::async_runtime::spawn_blocking(move || {
        responder.respond(read_response(&root, &route, head, range.as_deref()));
    }));
}

fn packs_root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.try_state::<AppState>()
        .map(|state| state.paths.packs.clone())
}

/// `rel` (no leading `/`, not percent-encoded, e.g. `PageFontStatus.rel`) → a font route, under the same path rules and
/// allow-list as the protocol.
fn font_route(rel: &str) -> Result<Route, AppError> {
    check_components(rel)
        .map_err(|_| AppError::InvalidArgument(format!("not a pack font path: {rel:?}")))?;
    Route::parse(rel)
        .filter(Route::is_font)
        .ok_or_else(|| AppError::InvalidArgument(format!("not a pack font path: {rel:?}")))
}

/// The whole font file, at most [`MAX_FONT_BYTES`].
fn read_font(root: &Path, route: &Route) -> Result<Vec<u8>, AppError> {
    let read = || -> io::Result<Vec<u8>> {
        let (mut file, len) = open_regular(&route.file(root))?;
        if len > MAX_FONT_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{len} bytes exceeds the {MAX_FONT_BYTES}-byte font limit"),
            ));
        }
        read_exact_len(&mut file, len)
    };
    read().map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => AppError::NotFound(format!("pack font {}", route.rel)),
        io::ErrorKind::InvalidData => AppError::Integrity(format!("pack font {}: {e}", route.rel)),
        _ => AppError::Io(format!("pack font {}: {e}", route.rel)),
    })
}

/// Raw font bytes for `AppInfo.fontTransport = bytes`. Not a specta command: it returns `InvokeResponseBody::Raw` (an
/// `ArrayBuffer` in JS), is excluded from bindings.ts and is dispatched by name in `lib.rs`. `rel` must match a font
/// route (`mushaf/…` or `decor/…`) under the same path rules as [`handle`].
///
/// Errors are the `AppError` display strings (`"not found: pack font mushaf/v2/p262.woff2"`, `"invalid argument: …"`),
/// because the command returns a plain string error. It reaches `AppState` through `AppHandle` (a borrowed
/// `State<'_, _>` would expand to `unreachable!()`, which the crate-root lint denies here, see `lib.rs`).
#[tauri::command]
pub async fn font_bytes(app: AppHandle, rel: String) -> Result<tauri::ipc::Response, String> {
    let route = font_route(&rel).map_err(|e| e.to_string())?;
    let root = packs_root(&app)
        .ok_or_else(|| AppError::Internal("app state is not ready".to_owned()).to_string())?;
    let bytes = crate::util::blocking(move || read_font(&root, &route))
        .await
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )]

    use std::fs;

    use tempfile::TempDir;

    use super::*;

    const CORS_HEADERS: [&str; 4] = [
        "access-control-allow-origin",
        "access-control-expose-headers",
        "cross-origin-resource-policy",
        "x-content-type-options",
    ];

    /// A packs root with a 50-byte page font, a 3 MiB audio file, an empty decor font and a directory where a page
    /// font should be.
    fn packs() -> TempDir {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("mushaf/v2")).unwrap();
        fs::write(root.join("mushaf/v2/p262.woff2"), sample(50)).unwrap();
        fs::create_dir_all(root.join("mushaf/v2/p263.woff2")).unwrap();
        fs::create_dir_all(root.join("audio/7")).unwrap();
        fs::write(root.join("audio/7/002.mp3"), sample(3 * 1024 * 1024 + 7)).unwrap();
        fs::write(root.join("audio/7/002.mp3.stream.part"), sample(10)).unwrap();
        fs::create_dir_all(root.join("decor")).unwrap();
        fs::write(root.join("decor/sura-names.woff2"), b"").unwrap();
        fs::write(root.join("secret.txt"), b"top secret").unwrap();
        dir
    }

    fn sample(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    /// The whole request path: plan, then (if needed) the read the blocking task would do.
    fn request(
        root: &Path,
        method: Method,
        path: &str,
        range: Option<&str>,
    ) -> http::Response<Vec<u8>> {
        match plan(&method, path, range) {
            Plan::Respond(response) => response,
            Plan::Read { route, head, range } => {
                read_response(root, &route, head, range.as_deref())
            }
        }
    }

    fn get(root: &Path, path: &str, range: Option<&str>) -> http::Response<Vec<u8>> {
        request(root, Method::GET, path, range)
    }

    fn header<'a>(response: &'a http::Response<Vec<u8>>, name: &str) -> &'a str {
        response
            .headers()
            .get(name)
            .map_or("", |v| v.to_str().unwrap())
    }

    fn assert_cors(response: &http::Response<Vec<u8>>) {
        for name in CORS_HEADERS {
            assert!(
                response.headers().contains_key(name),
                "{name} missing on {}",
                response.status()
            );
        }
        assert_eq!(header(response, "access-control-allow-origin"), "*");
        assert_eq!(
            header(response, "cross-origin-resource-policy"),
            "cross-origin"
        );
        assert_eq!(header(response, "x-content-type-options"), "nosniff");
        assert!(header(response, "access-control-expose-headers").contains("content-range"));
    }

    #[test]
    fn page_font_routes() {
        for (rel, ok) in [
            ("mushaf/v2/p1.woff2", true),
            ("mushaf/v1/p604.woff2", true),
            ("mushaf/v4/p262.woff2", true),
            ("mushaf/v2/p605.woff2", false),
            ("mushaf/v2/p0.woff2", false),
            ("mushaf/v2/p001.woff2", false),
            ("mushaf/v2/p01.woff2", false),
            ("mushaf/v2/p1000.woff2", false),
            ("mushaf/v3/p1.woff2", false),
            ("mushaf/V2/p1.woff2", false),
            ("mushaf/v2/P1.woff2", false),
            ("mushaf/v2/p1.WOFF2", false),
            ("mushaf/v2/p1.woff", false),
            ("mushaf/v2/p1.woff2.dl.part", false),
            ("mushaf/v2/p+1.woff2", false),
            ("mushaf/v2/p-1.woff2", false),
            ("mushaf/v2/p 1.woff2", false),
            ("mushaf/v2/p1.woff2/x", false),
            ("mushaf/v2", false),
            ("mushaf//p1.woff2", false),
            ("mushaf/v2//p1.woff2", false),
        ] {
            let route = Route::parse(rel);
            assert_eq!(route.is_some(), ok, "{rel}");
            if let Some(route) = route {
                assert_eq!(route.rel(), rel);
                assert_eq!(route.content_type(), "font/woff2");
                assert!(route.is_font());
            }
        }
    }

    #[test]
    fn decor_routes() {
        for (rel, content_type) in [
            ("decor/qcf-surah-header.woff2", Some("font/woff2")),
            ("decor/quran-common.ttf", Some("font/ttf")),
            ("decor/sura-names.woff2", Some("font/woff2")),
            ("decor/noto-nastaliq-urdu.woff2", Some("font/woff2")),
            ("decor/quran-common.woff2", None),
            ("decor/Sura-Names.woff2", None),
            ("decor/sura-names.woff2.dl.part", None),
            ("decor/x/sura-names.woff2", None),
            ("decor", None),
            ("decor/", None),
        ] {
            let route = Route::parse(rel);
            assert_eq!(
                route.as_ref().map(Route::content_type),
                content_type,
                "{rel}"
            );
            assert!(route.is_none_or(|r| r.is_font() && r.rel() == rel), "{rel}");
        }
    }

    #[test]
    fn audio_routes() {
        for (rel, ok) in [
            ("audio/7/001.mp3", true),
            ("audio/1234/114.mp3", true),
            ("audio/0/999.mp3", true),
            ("audio/12345/001.mp3", false),
            ("audio//001.mp3", false),
            ("audio/7/1.mp3", false),
            ("audio/7/0001.mp3", false),
            ("audio/7/001.mp3.stream.part", false),
            ("audio/7/001.dl.part", false),
            ("audio/7/001.dl.part.json", false),
            ("audio/7/001.MP3", false),
            ("audio/x7/001.mp3", false),
            ("audio/7/abc.mp3", false),
            ("audio/7", false),
        ] {
            let route = Route::parse(rel);
            assert_eq!(route.is_some(), ok, "{rel}");
            if let Some(route) = route {
                assert_eq!(route.content_type(), "audio/mpeg");
                assert!(!route.is_font());
                assert_eq!(route.rel(), rel);
            }
        }
        assert_eq!(Route::parse(""), None);
        assert_eq!(Route::parse("secret.txt"), None);
        assert_eq!(Route::parse("packs/mushaf/v2/p1.woff2"), None);
    }

    #[test]
    fn route_files_stay_under_the_root() {
        let root = Path::new("root");
        let file = Route::parse("mushaf/v2/p262.woff2").unwrap().file(root);
        assert_eq!(file, root.join("mushaf").join("v2").join("p262.woff2"));
        assert!(file.starts_with(root));
    }

    #[test]
    fn path_rules_forbid_anything_but_plain_components() {
        for path in [
            "/",
            "",
            "/..",
            "/../secret.txt",
            "/mushaf/../secret.txt",
            "/mushaf/v2/../../secret.txt",
            "/%2e%2e/secret.txt",
            "/%2E%2E%2Fsecret.txt",
            "/mushaf/%2e%2e%2f%2e%2e%2fsecret.txt",
            "/./mushaf/v2/p1.woff2",
            "/mushaf/./v2/p1.woff2",
            "/mushaf/v2/p1.woff2/.",
            "/mushaf//v2/p1.woff2",
            "/mushaf/v2/",
            "//etc/passwd",
            "/%2Fetc%2Fpasswd",
        ] {
            assert_eq!(resolve(path), Err(StatusCode::FORBIDDEN), "{path:?}");
        }
        if cfg!(windows) {
            for path in [
                "/C:/Windows/win.ini",
                "/..%5Csecret.txt",
                "/mushaf%5C..%5C..%5Csecret.txt",
                "/%5C%5Cserver%5Cshare",
            ] {
                assert_eq!(resolve(path), Err(StatusCode::FORBIDDEN), "{path:?}");
            }
        }
        assert_eq!(resolve("/%FF.woff2"), Err(StatusCode::BAD_REQUEST));
        assert_eq!(resolve("/secret.txt"), Err(StatusCode::NOT_FOUND));
        assert_eq!(
            resolve("/mushaf/v2/p262.woff2"),
            Ok(Route::parse("mushaf/v2/p262.woff2").unwrap())
        );
        // Percent-encoded plain characters decode before matching.
        assert_eq!(
            resolve("/mushaf/v2/p26%32.woff2"),
            Ok(Route::parse("mushaf/v2/p262.woff2").unwrap())
        );
    }

    #[test]
    fn range_parsing() {
        use RangeRequest::{Full, Partial, Unsatisfiable};
        let p = |start, end| Partial { start, end };
        for (header, len, expected) in [
            (None, 50, Full),
            (Some("bytes=0-9"), 50, p(0, 9)),
            (Some("bytes=10-"), 50, p(10, 49)),
            (Some("bytes=-5"), 50, p(45, 49)),
            (Some("bytes=-500"), 50, p(0, 49)),
            (Some("bytes=40-100"), 50, p(40, 49)),
            (Some("bytes=49-49"), 50, p(49, 49)),
            (Some("bytes=0-0"), 1, p(0, 0)),
            (Some(" bytes = 1 - 2 "), 50, p(1, 2)),
            (Some("BYTES=1-2"), 50, p(1, 2)),
            (Some("bytes=1-2, 5-6"), 50, p(1, 2)),
            (Some("bytes=50-"), 50, Unsatisfiable),
            (Some("bytes=50-60"), 50, Unsatisfiable),
            (Some("bytes=-0"), 50, Unsatisfiable),
            (Some("bytes=0-"), 0, Unsatisfiable),
            (Some("bytes=-1"), 0, Unsatisfiable),
            (Some("bytes=5-1"), 50, Full),
            (Some("bytes=-"), 50, Full),
            (Some("bytes=a-b"), 50, Full),
            (Some("bytes=1-x"), 50, Full),
            (Some("bytes=+1-2"), 50, Full),
            (Some("bytes=99999999999999999999999-"), 50, Full),
            (Some("items=0-1"), 50, Full),
            (Some("bytes"), 50, Full),
            (Some(""), 50, Full),
            (Some("bytes=0-18446744073709551615"), 50, p(0, 49)),
        ] {
            assert_eq!(
                RangeRequest::parse(header, len),
                expected,
                "{header:?} on {len} bytes"
            );
        }
        // At most one MiB per response.
        assert_eq!(
            RangeRequest::parse(Some("bytes=0-"), 3 * MAX_RANGE_BYTES),
            p(0, MAX_RANGE_BYTES - 1)
        );
        assert_eq!(
            RangeRequest::parse(Some("bytes=10-"), 3 * MAX_RANGE_BYTES),
            p(10, 10 + MAX_RANGE_BYTES - 1)
        );
        assert_eq!(
            RangeRequest::parse(Some("bytes=-2097152"), 3 * MAX_RANGE_BYTES),
            p(MAX_RANGE_BYTES, 2 * MAX_RANGE_BYTES - 1)
        );
    }

    #[test]
    fn get_serves_the_whole_file() {
        let dir = packs();
        let r = get(dir.path(), "/mushaf/v2/p262.woff2", None);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), &sample(50));
        assert_eq!(header(&r, "content-type"), "font/woff2");
        assert_eq!(header(&r, "content-length"), "50");
        assert_eq!(header(&r, "accept-ranges"), "bytes");
        assert_eq!(
            header(&r, "cache-control"),
            "public, max-age=31536000, immutable"
        );
        assert!(!r.headers().contains_key("content-range"));
        assert_cors(&r);
    }

    #[test]
    fn the_query_string_is_not_part_of_the_path() {
        // The URI path the handler sees never includes the query; a literal `?` in the decoded path is no route.
        let dir = packs();
        assert_eq!(
            get(dir.path(), "/mushaf/v2/p262.woff2%3Fv=1", None).status(),
            StatusCode::NOT_FOUND
        );
        let uri: http::Uri = "http://quran.localhost/mushaf/v2/p262.woff2?v=0123abcd"
            .parse()
            .unwrap();
        assert_eq!(get(dir.path(), uri.path(), None).status(), StatusCode::OK);
    }

    #[test]
    fn ranges_are_partial_content() {
        let dir = packs();
        let r = get(dir.path(), "/mushaf/v2/p262.woff2", Some("bytes=10-19"));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body(), &sample(50)[10..20]);
        assert_eq!(header(&r, "content-range"), "bytes 10-19/50");
        assert_eq!(header(&r, "content-length"), "10");
        assert_eq!(header(&r, "content-type"), "font/woff2");
        assert_cors(&r);

        let r = get(dir.path(), "/mushaf/v2/p262.woff2", Some("bytes=-4"));
        assert_eq!(r.body(), &sample(50)[46..]);
        assert_eq!(header(&r, "content-range"), "bytes 46-49/50");

        let r = get(dir.path(), "/mushaf/v2/p262.woff2", Some("bytes=50-"));
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(header(&r, "content-range"), "bytes */50");
        assert!(r.body().is_empty());
        assert_cors(&r);

        // An empty file has no satisfiable range, but a plain GET works.
        let r = get(dir.path(), "/decor/sura-names.woff2", Some("bytes=0-"));
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(header(&r, "content-range"), "bytes */0");
        let r = get(dir.path(), "/decor/sura-names.woff2", None);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(header(&r, "content-length"), "0");

        // A header that is not a byte range is ignored.
        let r = get(dir.path(), "/mushaf/v2/p262.woff2", Some("pages=1-2"));
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body().len(), 50);
    }

    #[test]
    fn large_files_are_served_one_mebibyte_at_a_time() {
        let dir = packs();
        let len = 3 * 1024 * 1024 + 7;
        let data = sample(len);
        let r = get(dir.path(), "/audio/7/002.mp3", Some("bytes=0-"));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body().len(), 1024 * 1024);
        assert_eq!(
            header(&r, "content-range"),
            format!("bytes 0-1048575/{len}")
        );
        assert_eq!(header(&r, "content-type"), "audio/mpeg");

        let r = get(dir.path(), "/audio/7/002.mp3", Some("bytes=3145728-"));
        assert_eq!(r.body(), &data[3_145_728..]);
        assert_eq!(
            header(&r, "content-range"),
            format!("bytes 3145728-{}/{len}", len - 1)
        );

        // Without a Range header the whole file is the answer.
        let r = get(dir.path(), "/audio/7/002.mp3", None);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), &data);
    }

    #[test]
    fn head_has_the_headers_of_get_without_a_body() {
        let dir = packs();
        let r = request(dir.path(), Method::HEAD, "/mushaf/v2/p262.woff2", None);
        assert_eq!(r.status(), StatusCode::OK);
        assert!(r.body().is_empty());
        assert_eq!(header(&r, "content-length"), "50");
        assert_eq!(header(&r, "content-type"), "font/woff2");

        let r = request(
            dir.path(),
            Method::HEAD,
            "/mushaf/v2/p262.woff2",
            Some("bytes=0-9"),
        );
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert!(r.body().is_empty());
        assert_eq!(header(&r, "content-length"), "10");
        assert_eq!(header(&r, "content-range"), "bytes 0-9/50");
    }

    #[test]
    fn errors_have_the_right_status_and_the_cors_headers() {
        let dir = packs();
        let root = dir.path();
        for (method, path, status) in [
            (Method::GET, "/mushaf/v2/p1.woff2", StatusCode::NOT_FOUND), // allowed route, file missing
            (Method::GET, "/mushaf/v2/p263.woff2", StatusCode::NOT_FOUND), // a directory, not a file
            (Method::GET, "/secret.txt", StatusCode::NOT_FOUND),
            (
                Method::GET,
                "/audio/7/002.mp3.stream.part",
                StatusCode::NOT_FOUND,
            ),
            (Method::GET, "/../secret.txt", StatusCode::FORBIDDEN),
            (Method::GET, "/%2e%2e/secret.txt", StatusCode::FORBIDDEN),
            (Method::GET, "/", StatusCode::FORBIDDEN),
            (Method::GET, "/%C0.woff2", StatusCode::BAD_REQUEST),
            (Method::HEAD, "/nope", StatusCode::NOT_FOUND),
            (
                Method::POST,
                "/mushaf/v2/p262.woff2",
                StatusCode::METHOD_NOT_ALLOWED,
            ),
            (
                Method::PUT,
                "/mushaf/v2/p262.woff2",
                StatusCode::METHOD_NOT_ALLOWED,
            ),
            (
                Method::DELETE,
                "/../secret.txt",
                StatusCode::METHOD_NOT_ALLOWED,
            ),
            (
                Method::OPTIONS,
                "/mushaf/v2/p262.woff2",
                StatusCode::NO_CONTENT,
            ),
        ] {
            let r = request(root, method.clone(), path, None);
            assert_eq!(r.status(), status, "{method} {path}");
            assert_cors(&r);
            assert!(r.body().is_empty(), "{method} {path}");
            assert!(
                !r.headers().contains_key("cache-control"),
                "{method} {path}"
            );
        }
        let r = request(root, Method::POST, "/x", None);
        assert_eq!(header(&r, "allow"), "GET, HEAD, OPTIONS");
        let r = request(root, Method::OPTIONS, "/anything", None);
        assert_eq!(
            header(&r, "access-control-allow-methods"),
            "GET, HEAD, OPTIONS"
        );
        assert_eq!(header(&r, "access-control-allow-headers"), "range");
        assert_eq!(header(&r, "access-control-max-age"), "86400");
    }

    #[test]
    fn font_bytes_accepts_exactly_the_font_routes() {
        let dir = packs();
        let root = dir.path();
        let read = |rel: &str| font_route(rel).and_then(|route| read_font(root, &route));
        assert_eq!(read("mushaf/v2/p262.woff2"), Ok(sample(50)));
        assert_eq!(read("decor/sura-names.woff2"), Ok(Vec::new()));
        assert!(matches!(
            read("mushaf/v2/p1.woff2"),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            read("mushaf/v2/p263.woff2"),
            Err(AppError::NotFound(_))
        ));
        for rel in [
            "audio/7/002.mp3",
            "/mushaf/v2/p262.woff2",
            "mushaf/v2/../v2/p262.woff2",
            "../secret.txt",
            "secret.txt",
            "",
            "mushaf%2Fv2%2Fp262.woff2",
            "mushaf/v2/p262.woff2?v=1",
        ] {
            assert!(
                matches!(read(rel), Err(AppError::InvalidArgument(_))),
                "{rel:?}"
            );
        }
        let message = read("mushaf/v2/p1.woff2").unwrap_err().to_string();
        assert_eq!(message, "not found: pack font mushaf/v2/p1.woff2");
    }

    #[test]
    fn font_bytes_refuses_oversized_files() {
        let dir = packs();
        let path = dir.path().join("decor/quran-common.ttf");
        let file = File::create(&path).unwrap();
        file.set_len(MAX_FONT_BYTES + 1).unwrap();
        drop(file);
        let route = font_route("decor/quran-common.ttf").unwrap();
        assert!(matches!(
            read_font(dir.path(), &route),
            Err(AppError::Integrity(_))
        ));
    }

    #[test]
    fn short_reads_are_errors() {
        let mut short = io::Cursor::new(vec![1_u8, 2, 3]);
        assert_eq!(read_exact_len(&mut short, 3).unwrap(), vec![1, 2, 3]);
        let mut short = io::Cursor::new(vec![1_u8, 2, 3]);
        assert_eq!(
            read_exact_len(&mut short, 4).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn protocol_base_matches_the_platform() {
        assert!(PROTOCOL_BASE.ends_with("localhost/"));
        assert_eq!(PROTOCOL_BASE.starts_with("http://quran."), cfg!(windows));
    }
}
