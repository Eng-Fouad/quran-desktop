//! `fetch-assets` and `fetch-dev-packs` against a local HTTP server, without touching the network (WP3c).
//!
//! `xtask` is a binary crate, so `cli.rs`, `assets.rs` and `dev_packs.rs` are compiled into this test crate by path
//! (their own unit tests run here too). `dev_packs.rs` reads `crate::fixtures::PAGES` only in `run()`, which needs the
//! network; the stand-in below keeps the inclusion exact without pulling in the fixture exporters.
//!
//! Covered: trust-on-first-use pinning, the offline fast path, damaged local files, upstream changes with and without
//! `--force`, the exact-size rules, archive member lookup, the EULA from the name table, retries/back-off/fatal
//! statuses/truncation, request headers; the dev-packs plan from the real catalog, mirror fallback, validation of
//! existing files, `--force`, and the summary.

#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "../src/cli.rs"]
mod cli;

#[path = "../src/assets.rs"]
mod assets;

#[path = "../src/dev_packs.rs"]
mod dev_packs;

/// Stand-in for `xtask/src/fixtures/mod.rs` (only `PAGES` is read by `dev_packs::run`).
mod fixtures {
    pub const PAGES: &[u32] = &[1, 2, 604];
}

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Cursor, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use anyhow::Context;
use assets::{ArchiveFont, AssetsLock, LockedAsset, Pin, net};
use dev_packs::{DevFile, Group, Outcome, Report};
use quran_packs::Catalog;
use quran_packs::adapters::FontVariant;

// ---- a tiny HTTP/1.1 server --------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Reply {
    status: u16,
    body: Vec<u8>,
    /// `Content-Length` to announce instead of the body's (to simulate a cut connection).
    declared: Option<usize>,
}

impl Reply {
    fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            body: body.into(),
            declared: None,
        }
    }

    fn status(status: u16) -> Self {
        Self {
            status,
            body: format!("status {status}").into_bytes(),
            declared: None,
        }
    }

    fn truncated(body: impl Into<Vec<u8>>, declared: usize) -> Self {
        Self {
            status: 200,
            body: body.into(),
            declared: Some(declared),
        }
    }
}

#[derive(Debug, Clone)]
struct Request {
    path: String,
    user_agent: String,
    accept_encoding: String,
}

#[derive(Default)]
struct State {
    /// Answers consumed in order before the steady answer.
    scripted: HashMap<String, VecDeque<Reply>>,
    steady: HashMap<String, Reply>,
    log: Vec<Request>,
}

struct Server {
    base: String,
    state: Arc<Mutex<State>>,
}

impl Server {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State::default()));
        let shared = Arc::clone(&state);
        std::thread::Builder::new()
            .name("test-http".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let state = Arc::clone(&shared);
                    let _ = std::thread::Builder::new()
                        .name("test-http-conn".into())
                        .spawn(move || handle(stream, &state));
                }
            })
            .unwrap();
        Self { base, state }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn serve(&self, path: &str, reply: Reply) {
        self.lock().steady.insert(path.to_owned(), reply);
    }

    fn script(&self, path: &str, replies: Vec<Reply>) {
        self.lock().scripted.insert(path.to_owned(), replies.into());
    }

    fn requests(&self) -> Vec<Request> {
        self.lock().log.clone()
    }

    fn hits(&self, path: &str) -> usize {
        self.lock().log.iter().filter(|r| r.path == path).count()
    }
}

fn handle(stream: TcpStream, state: &Mutex<State>) {
    let Ok(read_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(read_half);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let reply = {
        let mut state = state.lock().unwrap_or_else(PoisonError::into_inner);
        state.log.push(Request {
            path: path.clone(),
            user_agent: headers.get("user-agent").cloned().unwrap_or_default(),
            accept_encoding: headers.get("accept-encoding").cloned().unwrap_or_default(),
        });
        let scripted = state.scripted.get_mut(&path).and_then(VecDeque::pop_front);
        scripted
            .or_else(|| state.steady.get(&path).cloned())
            .unwrap_or_else(|| Reply::status(404))
    };
    let mut stream = stream;
    let head = format!(
        "HTTP/1.1 {} X\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        reply.status,
        reply.declared.unwrap_or(reply.body.len())
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&reply.body);
    let _ = stream.flush();
}

// ---- synthetic fonts and archives --------------------------------------------------------------------------------

/// A minimal sfnt with only a `name` table: `(platform, encoding, language, name id, text)`.
fn ttf(names: &[(u16, u16, u16, u16, &str)]) -> Vec<u8> {
    let mut storage = Vec::new();
    let mut records = Vec::new();
    for (platform, encoding, language, id, text) in names {
        let bytes: Vec<u8> = if *platform == 1 {
            text.bytes().collect()
        } else {
            text.encode_utf16().flat_map(u16::to_be_bytes).collect()
        };
        records.push((
            *platform,
            *encoding,
            *language,
            *id,
            bytes.len(),
            storage.len(),
        ));
        storage.extend(bytes);
    }
    let count = u16::try_from(records.len()).unwrap();
    let mut table = Vec::new();
    table.extend(0u16.to_be_bytes());
    table.extend(count.to_be_bytes());
    table.extend((6 + 12 * count).to_be_bytes());
    for (platform, encoding, language, id, length, offset) in records {
        for field in [
            platform,
            encoding,
            language,
            id,
            u16::try_from(length).unwrap(),
            u16::try_from(offset).unwrap(),
        ] {
            table.extend(field.to_be_bytes());
        }
    }
    table.extend(storage);

    let mut font = Vec::new();
    font.extend(0x0001_0000u32.to_be_bytes());
    font.extend(1u16.to_be_bytes()); // numTables
    font.extend([0u8; 6]); // searchRange, entrySelector, rangeShift
    font.extend(*b"name");
    font.extend(0u32.to_be_bytes()); // checksum
    font.extend(28u32.to_be_bytes()); // offset = 12 + 16
    font.extend(u32::try_from(table.len()).unwrap().to_be_bytes());
    font.extend(table);
    font
}

const EULA: &str =
    "TEST FONT LICENCE\r\n\r\nYou may use, copy and distribute this font.   \r\nNo modification.";

fn licensed_ttf(version: &str) -> Vec<u8> {
    ttf(&[
        (1, 0, 0, 0, "mac copyright"),
        (
            3,
            1,
            0x0409,
            0,
            "(c) 2010 Test Foundry.\r\nAll rights reserved.",
        ),
        (3, 1, 0x0409, 4, "Test Sans Regular"),
        (3, 1, 0x0409, 5, version),
        (3, 1, 0x0401, 13, "arabic licence"),
        (3, 1, 0x0409, 13, EULA),
    ])
}

fn zip(members: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in members {
        if name.ends_with('/') {
            writer.add_directory(*name, options).unwrap();
        } else {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
    }
    writer.finish().unwrap().into_inner()
}

/// A font spec served by `server` at `/font.zip`, with exact sizes taken from the given archive and font.
fn spec<'a>(url: &'a str, archive: &[u8], font: &[u8]) -> ArchiveFont<'a> {
    ArchiveFont {
        name: "Test Sans",
        url,
        archive_bytes: u64::try_from(archive.len()).unwrap(),
        entry: "Test Sans.ttf",
        bytes: u64::try_from(font.len()).unwrap(),
        file: "public/fonts/Test-Sans.ttf",
        licence_file: "public/fonts/Test-Sans.LICENSE.txt",
    }
}

const FAST: net::Retry = net::Retry {
    attempts: 3,
    first_delay: Duration::from_millis(1),
};

struct Env {
    server: Server,
    dir: tempfile::TempDir,
    runtime: tokio::runtime::Runtime,
    client: reqwest::Client,
}

impl Env {
    fn new() -> Self {
        Self {
            server: Server::start(),
            dir: tempfile::tempdir().unwrap(),
            runtime: net::runtime().unwrap(),
            client: net::client("test").unwrap(),
        }
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn lock_path(&self) -> std::path::PathBuf {
        self.root().join("xtask").join("assets.lock")
    }

    fn fetch(&self, font: &ArchiveFont<'_>, force: bool) -> anyhow::Result<assets::FontReport> {
        assets::fetch_archive_font(
            &self.runtime,
            &self.client,
            FAST,
            font,
            self.root(),
            &self.lock_path(),
            force,
        )
    }

    fn read(&self, rel: &str) -> Vec<u8> {
        std::fs::read(assets::rel_path(self.root(), rel)).unwrap()
    }
}

// ---- fetch-assets ------------------------------------------------------------------------------------------------

#[test]
fn first_use_pins_the_font_then_later_runs_verify_offline() -> anyhow::Result<()> {
    let env = Env::new();
    let font = licensed_ttf("Version 1.0");
    let archive = zip(&[
        ("Test-Sans/", b""),
        ("Test-Sans/Test Sans.docx", b"not the font"),
        ("Test-Sans/Test Sans.ttf", &font),
    ]);
    env.server.serve("/font.zip", Reply::ok(archive.clone()));
    let url = env.server.url("/font.zip");
    let spec = spec(&url, &archive, &font);

    let first = env.fetch(&spec, false)?;
    assert_eq!(first.pin, Pin::Pinned);
    assert!(first.font_written && first.licence_written && first.lock_written);
    assert_eq!(first.sha256, assets::sha256_hex(&font));
    assert_eq!(env.read(spec.file), font, "the font is written unmodified");

    let lock = AssetsLock::read(&env.lock_path())?;
    assert_eq!(
        lock.assets,
        [LockedAsset {
            file: spec.file.to_owned(),
            source: url.clone(),
            bytes: spec.bytes,
            sha256: assets::sha256_hex(&font),
        }]
    );
    let lock_text = String::from_utf8(std::fs::read(env.lock_path())?)?;
    assert!(lock_text.starts_with("# sha256 pins"), "{lock_text}");
    assert!(lock_text.contains("[[asset]]"), "{lock_text}");

    let licence = String::from_utf8(env.read(spec.licence_file))?;
    let expected = format!(
        "Test Sans (Test Sans Regular, Version 1.0)\n\
         Source: {url}\n\
         File: Test-Sans.ttf ({} B, sha256 {}), shipped unmodified.\n\
         The licence below is reproduced verbatim from the font's name table (IDs 0 and 13).\n\
         Generated by `cargo xtask fetch-assets`; do not edit.\n\
         \n\
         (c) 2010 Test Foundry.\nAll rights reserved.\n\
         \n\
         TEST FONT LICENCE\n\nYou may use, copy and distribute this font.\nNo modification.\n",
        font.len(),
        assets::sha256_hex(&font)
    );
    assert_eq!(licence, expected);
    assert_eq!(env.server.hits("/font.zip"), 1);

    // Second run: the local font matches the pin, nothing is downloaded or written.
    let second = env.fetch(&spec, false)?;
    assert_eq!(second.pin, Pin::Verified);
    assert!(!second.font_written && !second.licence_written && !second.lock_written);
    assert_eq!(
        env.server.hits("/font.zip"),
        1,
        "no network on a verified run"
    );

    // A hand-edited licence text is regenerated from the font, still offline.
    std::fs::write(assets::rel_path(env.root(), spec.licence_file), "edited")?;
    let third = env.fetch(&spec, false)?;
    assert_eq!(third.pin, Pin::Verified);
    assert!(third.licence_written);
    assert_eq!(String::from_utf8(env.read(spec.licence_file))?, expected);
    assert_eq!(env.server.hits("/font.zip"), 1);
    Ok(())
}

#[test]
fn requests_identify_the_tool_and_ask_for_identity_encoding() -> anyhow::Result<()> {
    let env = Env::new();
    let font = licensed_ttf("Version 1.0");
    let archive = zip(&[("Test Sans.ttf", &font)]);
    env.server.serve("/font.zip", Reply::ok(archive.clone()));
    let url = env.server.url("/font.zip");
    env.fetch(&spec(&url, &archive, &font), false)?;
    let requests = env.server.requests();
    assert_eq!(requests.len(), 1);
    let request = requests.first().context("one request")?;
    assert!(
        request.user_agent.starts_with("QuranForDesktop-xtask/")
            && request.user_agent.ends_with("(test)"),
        "{}",
        request.user_agent
    );
    assert_eq!(request.accept_encoding, "identity");
    Ok(())
}

#[test]
fn a_damaged_local_font_is_downloaded_again_and_checked_against_the_pin() -> anyhow::Result<()> {
    let env = Env::new();
    let font = licensed_ttf("Version 1.0");
    let archive = zip(&[("Test Sans.ttf", &font)]);
    env.server.serve("/font.zip", Reply::ok(archive.clone()));
    let url = env.server.url("/font.zip");
    let spec = spec(&url, &archive, &font);
    env.fetch(&spec, false)?;

    let mut damaged = font.clone();
    if let Some(last) = damaged.last_mut() {
        *last ^= 0xFF;
    }
    std::fs::write(assets::rel_path(env.root(), spec.file), &damaged)?;
    let report = env.fetch(&spec, false)?;
    assert_eq!(report.pin, Pin::Matched);
    assert!(report.font_written && !report.lock_written);
    assert_eq!(env.read(spec.file), font);
    assert_eq!(env.server.hits("/font.zip"), 2);
    Ok(())
}

#[test]
fn an_upstream_change_fails_without_force_and_is_repinned_with_force() -> anyhow::Result<()> {
    let env = Env::new();
    let v1 = licensed_ttf("Version 1.0");
    let v2 = licensed_ttf("Version 2.0"); // same size, different bytes
    assert_eq!(v1.len(), v2.len());
    let archive_v1 = zip(&[("Test Sans.ttf", &v1)]);
    let archive_v2 = zip(&[("Test Sans.ttf", &v2)]);
    assert_eq!(archive_v1.len(), archive_v2.len());
    let url = env.server.url("/font.zip");
    let spec = spec(&url, &archive_v1, &v1);

    env.server.serve("/font.zip", Reply::ok(archive_v1));
    env.fetch(&spec, false)?;
    let lock_before = std::fs::read(env.lock_path())?;
    let licence_before = env.read(spec.licence_file);

    env.server.serve("/font.zip", Reply::ok(archive_v2));
    // The local file still matches the pin: offline, no change noticed.
    assert_eq!(env.fetch(&spec, false)?.pin, Pin::Verified);
    // With the local copy gone, the new upstream file contradicts the pin: nothing is written.
    std::fs::remove_file(assets::rel_path(env.root(), spec.file))?;
    let error = env.fetch(&spec, false).unwrap_err();
    let message = format!("{error:#}");
    assert!(message.contains("--force"), "{message}");
    assert!(message.contains(&assets::sha256_hex(&v1)), "{message}");
    assert!(!assets::rel_path(env.root(), spec.file).exists());
    assert_eq!(std::fs::read(env.lock_path())?, lock_before);
    assert_eq!(env.read(spec.licence_file), licence_before);

    let report = env.fetch(&spec, true)?;
    assert_eq!(
        report.pin,
        Pin::Repinned {
            previous: assets::sha256_hex(&v1)
        }
    );
    assert!(report.font_written && report.licence_written && report.lock_written);
    assert_eq!(env.read(spec.file), v2);
    assert_eq!(
        AssetsLock::read(&env.lock_path())?
            .get(spec.file)
            .map(|a| a.sha256.clone()),
        Some(assets::sha256_hex(&v2))
    );
    assert!(String::from_utf8(env.read(spec.licence_file))?.contains("Version 2.0"));

    // --force with an unchanged upstream simply re-downloads.
    assert_eq!(env.fetch(&spec, true)?.pin, Pin::Matched);
    Ok(())
}

#[test]
fn archive_and_font_sizes_are_exact() -> anyhow::Result<()> {
    let env = Env::new();
    let font = licensed_ttf("Version 1.0");
    let archive = zip(&[("Test Sans.ttf", &font)]);
    env.server.serve("/font.zip", Reply::ok(archive.clone()));
    let url = env.server.url("/font.zip");

    let mut wrong_archive = spec(&url, &archive, &font);
    wrong_archive.archive_bytes += 1;
    let message = format!("{:#}", env.fetch(&wrong_archive, false).unwrap_err());
    assert!(message.contains("expected exactly"), "{message}");

    let mut wrong_font = spec(&url, &archive, &font);
    wrong_font.bytes -= 1;
    let message = format!("{:#}", env.fetch(&wrong_font, false).unwrap_err());
    assert!(message.contains("expected exactly"), "{message}");

    assert!(!assets::rel_path(env.root(), wrong_font.file).exists());
    assert!(!env.lock_path().exists(), "a failed run writes no lock");
    Ok(())
}

#[test]
fn a_font_without_a_licence_is_refused() -> anyhow::Result<()> {
    let env = Env::new();
    let font = ttf(&[(3, 1, 0x0409, 4, "Test Sans Regular")]);
    let archive = zip(&[("Test Sans.ttf", &font)]);
    env.server.serve("/font.zip", Reply::ok(archive.clone()));
    let url = env.server.url("/font.zip");
    let spec = spec(&url, &archive, &font);
    let message = format!("{:#}", env.fetch(&spec, false).unwrap_err());
    assert!(message.contains("EULA"), "{message}");
    assert!(!assets::rel_path(env.root(), spec.file).exists());
    assert!(!env.lock_path().exists());
    Ok(())
}

#[test]
fn the_archive_member_is_found_in_any_directory_and_must_be_unique() {
    let found = zip(&[("a/b/Font.ttf", b"bytes"), ("Font.ttf.sig", b"x")]);
    assert_eq!(
        assets::extract_entry(&found, "Font.ttf", 5).unwrap(),
        b"bytes"
    );

    let missing = zip(&[("Other.ttf", b"x")]);
    let message = format!(
        "{:#}",
        assets::extract_entry(&missing, "Font.ttf", 1).unwrap_err()
    );
    assert!(
        message.contains("Other.ttf"),
        "lists the members: {message}"
    );

    let twice = zip(&[("a/Font.ttf", b"x"), ("b/Font.ttf", b"y")]);
    assert!(assets::extract_entry(&twice, "Font.ttf", 1).is_err());

    // Decompression stops one byte past the expected size.
    let big = zip(&[("Font.ttf", &[7u8; 4096])]);
    assert_eq!(
        assets::extract_entry(&big, "Font.ttf", 10).unwrap().len(),
        11
    );

    assert!(assets::extract_entry(b"not a zip", "Font.ttf", 1).is_err());
}

#[test]
fn name_records_prefer_windows_english_and_are_decoded() {
    let names = assets::font_names(&licensed_ttf("Version 3.0")).unwrap();
    assert_eq!(
        names.copyright.as_deref(),
        Some("(c) 2010 Test Foundry.\r\nAll rights reserved.")
    );
    assert_eq!(names.licence.as_deref(), Some(EULA));
    assert_eq!(names.full_name.as_deref(), Some("Test Sans Regular"));
    assert_eq!(names.version.as_deref(), Some("Version 3.0"));
    assert_eq!(names.licence_url, None);

    // Macintosh Roman is the last resort.
    let mac = assets::font_names(&ttf(&[(1, 0, 0, 13, "mac only")])).unwrap();
    assert_eq!(mac.licence.as_deref(), Some("mac only"));

    assert!(assets::font_names(b"wOF2....").is_err(), "not an sfnt");
    assert!(
        assets::font_names(&[0, 1, 0, 0, 0, 0]).is_err(),
        "truncated"
    );
}

#[test]
fn the_real_font_produces_the_committed_licence_text() -> anyhow::Result<()> {
    // Runs where `cargo xtask fetch-assets` has run (the font is gitignored): the committed licence text must be
    // exactly what the font's name table says.
    let root = cli::workspace_root();
    let font = assets::KFGQPC_HAFS_V30;
    let Some(ttf) = assets::read_optional(&assets::rel_path(&root, font.file))? else {
        eprintln!("skipped: {} is not fetched", font.file);
        return Ok(());
    };
    let lock = AssetsLock::read(&assets::rel_path(&root, assets::LOCK_FILE))?;
    let pin = lock
        .get(font.file)
        .context("the font is pinned in xtask/assets.lock")?;
    assert_eq!(assets::sha256_hex(&ttf), pin.sha256);
    assert_eq!(pin.bytes, 301_356);
    assert_eq!(
        pin.sha256,
        "c9dd7e71a454565b13d89e5e6f2663a918acb0a20a23eea31eccb32a3aeec47a"
    );
    let committed = std::fs::read_to_string(assets::rel_path(&root, font.licence_file))?;
    assert_eq!(committed, assets::licence_text(&font, &ttf)?);
    assert!(committed.contains("ELECTRONIC END-USER LICENSE AGREEMENT"));
    assert!(committed.contains("cannot be Sold, Modified, Altered"));
    Ok(())
}

#[test]
fn the_lock_rejects_malformed_pins() {
    let good = "[[asset]]\nfile = \"a\"\nsource = \"https://x\"\nbytes = 1\nsha256 = \"".to_owned()
        + &"ab".repeat(32)
        + "\"\n";
    let lock = AssetsLock::parse(&good).unwrap();
    assert_eq!(AssetsLock::parse(&lock.render().unwrap()).unwrap(), lock);
    assert!(
        AssetsLock::parse(&good.replace("ab", "AB")).is_err(),
        "uppercase hex"
    );
    assert!(
        AssetsLock::parse(&format!("{good}\n{good}")).is_err(),
        "pinned twice"
    );
    assert!(
        AssetsLock::parse(&good.replace("bytes", "size")).is_err(),
        "unknown field"
    );
    assert_eq!(AssetsLock::parse("").unwrap(), AssetsLock::default());
}

// ---- HTTP behaviour ----------------------------------------------------------------------------------------------

#[test]
fn transient_failures_are_retried_and_fatal_ones_are_not() {
    let env = Env::new();
    let get = |path: &str| {
        env.runtime
            .block_on(net::get(&env.client, &env.server.url(path), 1 << 20, FAST))
    };

    env.server
        .script("/flaky", vec![Reply::status(503), Reply::status(429)]);
    env.server.serve("/flaky", Reply::ok("body"));
    assert_eq!(get("/flaky").unwrap(), b"body");
    assert_eq!(env.server.hits("/flaky"), 3);

    env.server.script("/cut", vec![Reply::truncated("par", 10)]);
    env.server.serve("/cut", Reply::ok("full body!"));
    assert_eq!(get("/cut").unwrap(), b"full body!");
    assert_eq!(env.server.hits("/cut"), 2);

    env.server.serve("/down", Reply::status(500));
    let message = format!("{:#}", get("/down").unwrap_err());
    assert!(
        message.contains("500") && message.contains("after 3 attempts"),
        "{message}"
    );
    assert_eq!(env.server.hits("/down"), 3);

    let message = format!("{:#}", get("/missing").unwrap_err());
    assert!(message.contains("404"), "{message}");
    assert_eq!(env.server.hits("/missing"), 1, "a 404 is not retried");

    env.server.serve("/big", Reply::ok(vec![0u8; 2 << 20]));
    let message = format!("{:#}", get("/big").unwrap_err());
    assert!(message.contains("limit"), "{message}");
    assert_eq!(
        env.server.hits("/big"),
        1,
        "an oversized body is not retried"
    );
}

// ---- fetch-dev-packs ---------------------------------------------------------------------------------------------

fn catalog() -> Catalog {
    let path = assets::rel_path(&cli::workspace_root(), cli::DEFAULT_CATALOG);
    Catalog::load(&path).unwrap()
}

#[test]
fn the_plan_follows_the_catalog_templates_and_mirrors() {
    let catalog = catalog();
    let files = dev_packs::plan(&catalog, &[1, 262, 604]).unwrap();
    assert_eq!(
        files.len(),
        3 * 3 + 3,
        "3 variants × 3 pages + 3 decor files"
    );

    let rels: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
    assert_eq!(
        rels,
        [
            "mushaf/v1/p1.woff2",
            "mushaf/v1/p262.woff2",
            "mushaf/v1/p604.woff2",
            "mushaf/v2/p1.woff2",
            "mushaf/v2/p262.woff2",
            "mushaf/v2/p604.woff2",
            "mushaf/v4/p1.woff2",
            "mushaf/v4/p262.woff2",
            "mushaf/v4/p604.woff2",
            "decor/qcf-surah-header.woff2",
            "decor/quran-common.ttf",
            "decor/sura-names.woff2",
        ]
    );
    let v2 = files
        .iter()
        .find(|f| f.rel == "mushaf/v2/p262.woff2")
        .unwrap();
    assert_eq!(v2.group, Group::Mushaf(FontVariant::V2));
    assert_eq!(
        v2.urls,
        [
            "https://verses.quran.foundation/fonts/quran/hafs/v2/woff2/p262.woff2",
            "https://static-cdn.tarteel.ai/qul/fonts/quran_fonts/v2/woff2/p262.woff2",
        ]
    );
    assert_eq!((v2.bytes, v2.sha256.as_deref()), (None, None));
    let v4 = files
        .iter()
        .find(|f| f.rel == "mushaf/v4/p1.woff2")
        .unwrap();
    assert!(v4.urls.iter().all(|u| u.ends_with("/p1.woff2")));
    assert!(v4.urls.first().unwrap().contains("/v4/colrv1/"));

    let decor: Vec<&DevFile> = files.iter().filter(|f| f.group == Group::Decor).collect();
    let total: u64 = decor.iter().filter_map(|f| f.bytes).sum();
    assert_eq!(total, 332_556, "the decor pack's size");
    assert!(
        decor
            .iter()
            .all(|f| f.sha256.as_ref().is_some_and(|s| s.len() == 64))
    );

    let all: Vec<u32> = (1..=604).collect();
    assert_eq!(dev_packs::plan(&catalog, &all).unwrap().len(), 3 * 604 + 3);
    assert_eq!(
        dev_packs::plan(&catalog, fixtures::PAGES).unwrap().len(),
        3 * fixtures::PAGES.len() + 3
    );
    assert!(dev_packs::plan(&catalog, &[0]).is_err());
    assert!(dev_packs::plan(&catalog, &[605]).is_err());
    assert!(dev_packs::plan(&catalog, &[]).is_err());
}

/// A WOFF2-shaped file: signature, flavor, total length, then filler.
fn woff2(len: u32, fill: u8) -> Vec<u8> {
    let mut bytes = b"wOF2".to_vec();
    bytes.extend(0x0001_0000u32.to_be_bytes());
    bytes.extend(len.to_be_bytes());
    bytes.resize(usize::try_from(len).unwrap(), fill);
    bytes
}

#[test]
fn files_are_validated_by_signature_header_length_size_and_digest() {
    let page = DevFile {
        group: Group::Mushaf(FontVariant::V2),
        rel: "mushaf/v2/p1.woff2".into(),
        urls: vec![],
        bytes: None,
        sha256: None,
    };
    assert_eq!(dev_packs::check(&page, &woff2(64, 1)), None);
    let mut truncated = woff2(64, 1);
    truncated.truncate(40);
    assert!(
        dev_packs::check(&page, &truncated)
            .unwrap()
            .contains("truncated")
    );
    assert!(dev_packs::check(&page, b"wOFF....").is_some());
    assert!(dev_packs::check(&page, b"").is_some());

    let body = ttf(&[(3, 1, 0x0409, 13, "x")]);
    let decor = DevFile {
        group: Group::Decor,
        rel: "decor/quran-common.ttf".into(),
        urls: vec![],
        bytes: Some(u64::try_from(body.len()).unwrap()),
        sha256: Some(assets::sha256_hex(&body)),
    };
    assert_eq!(dev_packs::check(&decor, &body), None);
    assert!(
        dev_packs::check(&decor, &woff2(64, 0))
            .unwrap()
            .contains("TrueType")
    );
    let mut other = body.clone();
    if let Some(last) = other.last_mut() {
        *last ^= 1;
    }
    assert!(dev_packs::check(&decor, &other).unwrap().contains("sha256"));
    let mut longer = body.clone();
    longer.push(0);
    assert!(
        dev_packs::check(&decor, &longer)
            .unwrap()
            .contains("catalog says")
    );
}

#[test]
fn dev_packs_fetch_with_mirror_fallback_and_keep_valid_files() -> anyhow::Result<()> {
    let env = Env::new();
    let out = env.root().join("dev-packs");
    let decor_bytes = ttf(&[(3, 1, 0x0409, 13, "decor")]);
    let page_1 = woff2(96, 1);
    let page_2 = woff2(128, 2);

    env.server.serve("/qf/p1.woff2", Reply::ok(page_1.clone()));
    env.server.serve("/qul/p1.woff2", Reply::ok(woff2(96, 9)));
    // p2: the first mirror is missing it, the second has it.
    env.server.serve("/qul/p2.woff2", Reply::ok(page_2.clone()));
    env.server
        .serve("/decor/common.ttf", Reply::ok(decor_bytes.clone()));
    // A mirror serving a different file than the catalog pins.
    env.server
        .serve("/decor/bad.woff2", Reply::ok(woff2(64, 3)));

    let page = |n: u32| DevFile {
        group: Group::Mushaf(FontVariant::V1),
        rel: format!("mushaf/v1/p{n}.woff2"),
        urls: vec![
            env.server.url(&format!("/qf/p{n}.woff2")),
            env.server.url(&format!("/qul/p{n}.woff2")),
        ],
        bytes: None,
        sha256: None,
    };
    let files = vec![
        page(1),
        page(2),
        DevFile {
            group: Group::Decor,
            rel: "decor/quran-common.ttf".into(),
            urls: vec![env.server.url("/decor/common.ttf")],
            bytes: Some(u64::try_from(decor_bytes.len())?),
            sha256: Some(assets::sha256_hex(&decor_bytes)),
        },
        DevFile {
            group: Group::Decor,
            rel: "decor/sura-names.woff2".into(),
            urls: vec![env.server.url("/decor/bad.woff2")],
            bytes: Some(64),
            sha256: Some("0".repeat(64)),
        },
    ];
    let run = |force: bool| {
        let mut calls = Vec::new();
        let outcomes = env.runtime.block_on(dev_packs::fetch_all(
            &env.client,
            FAST,
            &files,
            &out,
            force,
            3,
            |done, total| calls.push((done, total)),
        ));
        assert_eq!(calls.last(), Some(&(files.len(), files.len())));
        outcomes
    };

    let first = run(false);
    assert_eq!(
        first.first(),
        Some(&Outcome::Downloaded {
            bytes: 96,
            mirror: 0
        })
    );
    assert_eq!(
        first.get(1),
        Some(&Outcome::Downloaded {
            bytes: 128,
            mirror: 1
        })
    );
    assert!(matches!(
        first.get(2),
        Some(Outcome::Downloaded { mirror: 0, .. })
    ));
    let Some(Outcome::Failed { errors }) = first.get(3) else {
        panic!("the decor file with the wrong digest fails: {first:?}");
    };
    assert!(errors.iter().any(|e| e.contains("sha256")), "{errors:?}");
    assert_eq!(
        std::fs::read(out.join("mushaf").join("v1").join("p1.woff2"))?,
        page_1
    );
    assert_eq!(
        std::fs::read(out.join("mushaf").join("v1").join("p2.woff2"))?,
        page_2
    );
    assert_eq!(
        std::fs::read(out.join("decor").join("quran-common.ttf"))?,
        decor_bytes
    );
    assert!(!out.join("decor").join("sura-names.woff2").exists());
    let leftovers: Vec<_> = walk(&out)
        .into_iter()
        .filter(|p| p.ends_with(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "no temporary files remain: {leftovers:?}"
    );

    let report = Report::new(&files, &first);
    assert_eq!(report.failures.len(), 1);
    let lines = report.lines();
    assert!(
        lines.iter().any(|l| l.starts_with("ok")
            && l.contains("mushaf/v1")
            && l.contains("1 from a fallback mirror")),
        "{lines:?}"
    );
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("FAIL") && l.contains("decor")),
        "{lines:?}"
    );

    // Second run: valid files are kept without a request; a damaged one is fetched again.
    let hits_before = env.server.requests().len();
    std::fs::write(
        out.join("mushaf").join("v1").join("p1.woff2"),
        &page_1[..50],
    )?;
    let second = run(false);
    assert_eq!(
        second.first(),
        Some(&Outcome::Downloaded {
            bytes: 96,
            mirror: 0
        })
    );
    assert_eq!(second.get(1), Some(&Outcome::Present { bytes: 128 }));
    assert!(matches!(second.get(2), Some(Outcome::Present { .. })));
    let mut new_paths: Vec<String> = env.server.requests()[hits_before..]
        .iter()
        .map(|r| r.path.clone())
        .collect();
    new_paths.sort();
    assert_eq!(new_paths, ["/decor/bad.woff2", "/qf/p1.woff2"]);

    // --force downloads every file again.
    let forced = run(true);
    assert!(matches!(
        forced.get(1),
        Some(Outcome::Downloaded { mirror: 1, .. })
    ));
    assert!(matches!(forced.get(2), Some(Outcome::Downloaded { .. })));
    Ok(())
}

fn walk(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path.to_string_lossy().into_owned());
            }
        }
    }
    out
}

#[test]
fn group_formats_thousands() {
    assert_eq!(assets::group(0), "0");
    assert_eq!(assets::group(999), "999");
    assert_eq!(assets::group(1_000), "1,000");
    assert_eq!(assets::group(301_356), "301,356");
    assert_eq!(assets::group(97_748_500), "97,748,500");
}
