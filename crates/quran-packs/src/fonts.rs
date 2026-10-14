//! The interactive lane for page fonts and the decor fonts.
//!
//! [`Fonts`] backs `PackManager::{ensure_page_fonts, ensure_decor, decor_status}`:
//! - **`hafs`** has no page fonts: every page is `Ready` with family `qd-hafs`, no URL and 0 bytes, without IO.
//! - **A page on disk** (`packs/mushaf/{v}/p{N}.woff2`, starting with `wOF2`) is `Ready` at once with
//!   `url = <protocolBase>mushaf/{v}/p{N}.woff2?v=<sha256[0..8]>` (the `quran://` responses are immutable, so the URL
//!   carries the content hash) and `rel = mushaf/{v}/p{N}.woff2` (the `font_bytes` argument). Hashes are cached per file
//!   (length + modification time), so a page turn costs one `stat`. A file that is not a woff2 is deleted and fetched
//!   again. Files count by what is on disk, not by registry rows, so a `QD_PACKS_DIR` copy works as is.
//! - **A missing page** is `Unavailable` without any request while the network is not allowed or the tracker says
//!   offline. Otherwise it is fetched from the catalog's URL templates (mirrors in order): `interactive` on the
//!   interactive lane (it skips the job queue and always finds a slot), `prefetch` on the background lane; both resolve
//!   only when the page is final. Concurrent requests for one page share one download ([`InFlight`], keyed by variant,
//!   page and lane). The bytes go to a lane-private temp (`p{N}.woff2.i.tmp` / `.b.tmp`, each through its own `.part`),
//!   are verified (`Content-Length`, `wOF2`, at most [`MAX_FONT_BYTES`]) and renamed into place, so a page that a
//!   "download all" job writes at the same time never shares a temp file; the last rename wins with identical, verified
//!   content. The page is recorded as an on-demand `pack_item` (`p{N}`, `pinned = 0`, or kept pinned when it already
//!   was). Download or integrity failures are `Failed` (the reader offers Retry); going offline mid-way is
//!   `Unavailable`.
//! - **Decor** ([`Fonts::decor_status`], [`Fonts::ensure_decor`]): the three files of the `decor` pack behind
//!   `DecorStatus` (`qcf-surah-header.woff2`, `quran-common.ttf`, `sura-names.woff2`). Each URL is set when its file is
//!   present (`<protocolBase>decor/{file}?v=<sha8>`), and `installed` when all three are. `ensure_decor` downloads the
//!   missing files on the interactive lane (catalog length, pinned sha256, `wOF2` for woff2 files), records them (and
//!   the decor files already on disk) as pinned `pack_item` rows (`file:{path}`) and the `decor` pack as `installed`
//!   (or `partial`) with the same policy as the job runner, so the Downloads screen agrees. It fails with `Offline`
//!   when the network is off or offline, and with the download error otherwise; concurrent calls share one install.
//!
//! The registry listener ([`Fonts::set_listener`]) hears the pack ids whose `pack_item`/`installed_pack` rows changed:
//! once per `ensure_page_fonts` call that downloaded something, and after a decor install.

use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use futures_util::future::join_all;
use parking_lot::{Mutex, RwLock};
use quran_core::{CoreError, InstalledPackRow, InstalledStatus, PackItemRow, UserDb};
use quran_types::{
    DecorStatus, FetchPriority, FontAvailability, MushafStyle, PAGE_COUNT, PackKind, PageFontStatus,
};
use sha2::{Digest, Sha256};

use crate::PackError;
use crate::adapters::{
    Adapter, FontVariant, ItemKey, QcfFontPagesConfig, StaticFile, qcf_font_pages,
};
use crate::catalog::{Catalog, DECOR_PACK_ID};
use crate::http::{Downloaded, Expect, Http, InFlight, Lane, Request, WOFF2_MAGIC};
use crate::install;

/// Base URL of the `quran://` protocol as the webview sees it (`AppInfo.protocolBase`): `http://quran.localhost/` on
/// Windows, `quran://localhost/` elsewhere. The same value as `src-tauri/src/protocol.rs`.
pub const PROTOCOL_BASE: &str = if cfg!(windows) {
    "http://quran.localhost/"
} else {
    "quran://localhost/"
};
/// The bundled font family of style `hafs`.
pub const HAFS_FAMILY: &str = "qd-hafs";
/// The largest font file accepted (QCF pages are 50–400 KB).
pub const MAX_FONT_BYTES: u64 = 8 * 1024 * 1024;
/// `DecorStatus.surahHeaderUrl`.
pub const SURAH_HEADER_FILE: &str = "qcf-surah-header.woff2";
/// `DecorStatus.quranCommonUrl`.
pub const QURAN_COMMON_FILE: &str = "quran-common.ttf";
/// `DecorStatus.suraNamesUrl`.
pub const SURA_NAMES_FILE: &str = "sura-names.woff2";
/// The files `DecorStatus.installed` needs.
pub const DECOR_STATUS_FILES: [&str; 3] = [SURAH_HEADER_FILE, QURAN_COMMON_FILE, SURA_NAMES_FILE];

/// What a [`Fonts`] works on.
#[derive(Clone)]
pub struct FontsConfig {
    /// `<app_local_data_dir>/packs` (the `quran://` root).
    pub packs_root: PathBuf,
    pub http: Http,
    pub user: UserDb,
    /// [`PROTOCOL_BASE`] in the app.
    pub protocol_base: String,
}

impl FontsConfig {
    /// The app's configuration: [`PROTOCOL_BASE`].
    #[must_use]
    pub fn new(packs_root: PathBuf, http: Http, user: UserDb) -> Self {
        Self {
            packs_root,
            http,
            user,
            protocol_base: PROTOCOL_BASE.to_owned(),
        }
    }
}

/// Called with the pack ids whose registry rows changed.
pub type FontsListener = Arc<dyn Fn(Vec<String>) + Send + Sync>;

/// Cheap-to-clone handle on the font lane. `Send + Sync`.
#[derive(Clone)]
pub struct Fonts {
    inner: Arc<Inner>,
}

struct Inner {
    root: PathBuf,
    http: Http,
    user: UserDb,
    base: String,
    pages: HashMap<FontVariant, PageSource>,
    decor: Option<DecorSource>,
    page_flights: InFlight<(FontVariant, u32, Lane), FileInfo>,
    decor_flight: InFlight<u8, ()>,
    hashes: Mutex<HashMap<PathBuf, Stamp>>,
    listener: RwLock<Option<FontsListener>>,
}

/// The page-font pack of one variant.
struct PageSource {
    pack_id: String,
    cfg: QcfFontPagesConfig,
}

/// The `decor` pack.
struct DecorSource {
    pack_id: String,
    kind: PackKind,
    version: String,
    item_count: u32,
    files: Vec<StaticFile>,
}

/// A verified font file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FileInfo {
    bytes: u64,
    sha256: String,
    /// Downloaded by this request (the registry changed).
    fresh: bool,
}

/// A cached hash, valid while the file keeps its length and modification time.
#[derive(Debug, Clone)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    sha256: String,
}

/// What a font file must start with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Magic {
    Woff2,
    /// TrueType/OpenType (`00 01 00 00`, `OTTO`, `true`, `ttcf`).
    Sfnt,
    Any,
}

impl Magic {
    fn for_file(name: &str) -> Self {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".woff2") {
            Self::Woff2
        } else if lower.ends_with(".ttf") || lower.ends_with(".otf") {
            Self::Sfnt
        } else {
            Self::Any
        }
    }

    fn accepts(self, head: &[u8]) -> bool {
        match self {
            Self::Woff2 => head.starts_with(WOFF2_MAGIC),
            Self::Sfnt => [&b"\x00\x01\x00\x00"[..], b"OTTO", b"true", b"ttcf"]
                .iter()
                .any(|m| head.starts_with(m)),
            Self::Any => !head.is_empty(),
        }
    }
}

impl Fonts {
    /// Builds the lane from the catalog's page-font packs and its `decor` pack. No IO.
    #[must_use]
    pub fn new(cfg: FontsConfig, catalog: &Catalog) -> Self {
        let mut pages = HashMap::new();
        for style in [MushafStyle::QcfV1, MushafStyle::QcfV2, MushafStyle::QcfV4] {
            if let Some(pack) = catalog.mushaf_pack(style)
                && let Adapter::QcfFontPages(c) = &pack.source
            {
                pages.insert(
                    c.variant,
                    PageSource {
                        pack_id: pack.id.clone(),
                        cfg: c.clone(),
                    },
                );
            }
        }
        let decor = catalog
            .get(DECOR_PACK_ID)
            .and_then(|pack| match &pack.source {
                Adapter::StaticFiles(c) => Some(DecorSource {
                    pack_id: pack.id.clone(),
                    kind: pack.kind,
                    version: pack.version.clone(),
                    item_count: pack.item_count,
                    files: c.files.clone(),
                }),
                _ => None,
            });
        Self {
            inner: Arc::new(Inner {
                root: cfg.packs_root,
                http: cfg.http,
                user: cfg.user,
                base: cfg.protocol_base,
                pages,
                decor,
                page_flights: InFlight::new(),
                decor_flight: InFlight::new(),
                hashes: Mutex::new(HashMap::new()),
                listener: RwLock::new(None),
            }),
        }
    }

    /// Sets the registry listener (module docs).
    pub fn set_listener(&self, listener: impl Fn(Vec<String>) + Send + Sync + 'static) {
        *self.inner.listener.write() = Some(Arc::new(listener));
    }

    #[must_use]
    pub fn protocol_base(&self) -> &str {
        &self.inner.base
    }

    /// The `FontFace` family of a page: `qcf-v2-p262`, `qd-hafs` for `hafs`.
    #[must_use]
    pub fn family(style: MushafStyle, page: u32) -> String {
        match FontVariant::for_style(style) {
            Some(v) => format!("qcf-{}-p{page}", v.dir()),
            None => HAFS_FAMILY.to_owned(),
        }
    }

    /// The `quran://` path of a page font: `mushaf/v2/p262.woff2`.
    #[must_use]
    pub fn page_rel(variant: FontVariant, page: u32) -> String {
        format!("mushaf/{}/p{page}.woff2", variant.dir())
    }

    /// Resolves when each page is `Ready`, `Failed` or `Unavailable` (module docs), in the order asked. Pages outside
    /// 1..=604 fail the whole call with `invalid_argument`.
    pub async fn ensure_page_fonts(
        &self,
        style: MushafStyle,
        pages: &[u32],
        prio: FetchPriority,
    ) -> Result<Vec<PageFontStatus>, PackError> {
        for &page in pages {
            check_page(page)?;
        }
        let Some(variant) = FontVariant::for_style(style) else {
            return Ok(pages.iter().map(|&page| hafs_status(page)).collect());
        };
        let lane = match prio {
            FetchPriority::Interactive => Lane::Interactive,
            FetchPriority::Prefetch => Lane::Background,
        };
        let results = join_all(pages.iter().map(|&page| self.page(variant, page, lane))).await;
        let mut fresh = false;
        let statuses = pages
            .iter()
            .zip(results)
            .map(|(&page, result)| match result {
                Ok(file) => {
                    fresh |= file.fresh;
                    self.ready_status(style, variant, page, &file)
                }
                Err(availability) => missing_status(style, variant, page, availability),
            })
            .collect();
        if fresh && let Some(source) = self.inner.pages.get(&variant) {
            self.notify(vec![source.pack_id.clone()]);
        }
        Ok(statuses)
    }

    /// One page: on disk, or fetched, or why not.
    async fn page(
        &self,
        variant: FontVariant,
        page: u32,
        lane: Lane,
    ) -> Result<FileInfo, FontAvailability> {
        let dest = install::font_page_path(&self.inner.root, variant, page);
        if let Some(file) = self.present(&dest, Magic::Woff2).await {
            return Ok(file);
        }
        if !self.can_fetch() {
            return Err(FontAvailability::Unavailable);
        }
        let Some(source) = self.inner.pages.get(&variant) else {
            log::warn!(
                "no catalog pack serves mushaf {} pages; p{page} stays on the fallback",
                variant.dir()
            );
            return Err(FontAvailability::Failed);
        };
        let urls = match qcf_font_pages::page_urls(&source.cfg, page) {
            Ok(urls) => urls,
            Err(e) => {
                log::warn!("{}: p{page}: {e}", source.pack_id);
                return Err(FontAvailability::Failed);
            }
        };
        let this = self.clone();
        let pack_id = source.pack_id.clone();
        let result = self
            .inner
            .page_flights
            .run((variant, page, lane), move || async move {
                this.download_page(pack_id, page, urls, dest, lane).await
            })
            .await;
        result.map_err(|e| match e {
            PackError::Offline => FontAvailability::Unavailable,
            e => {
                log::warn!("mushaf {} p{page}: {e}", variant.dir());
                FontAvailability::Failed
            }
        })
    }

    async fn download_page(
        &self,
        pack_id: String,
        page: u32,
        urls: Vec<String>,
        dest: PathBuf,
        lane: Lane,
    ) -> Result<FileInfo, PackError> {
        // Another lane or a job may have finished it while this request waited.
        if let Some(file) = self.present(&dest, Magic::Woff2).await {
            return Ok(file);
        }
        let temp = lane_temp(&dest, lane);
        let done = self
            .inner
            .http
            .fetch_file(Request::new(&urls).lane(lane), &temp, &page_expect())
            .await?;
        let file = self.place(&temp, &dest, Magic::Woff2, &done).await?;
        self.record_item(
            &pack_id,
            ItemKey::Page(page).db_key(),
            file.bytes,
            file.sha256.clone(),
            false,
        )
        .await;
        Ok(file)
    }

    /// The decor fonts on disk now (module docs). Reads at most three small files once (hashes are cached).
    #[must_use]
    pub fn decor_status(&self) -> DecorStatus {
        let url = |name: &str| {
            let path = install::decor_path(&self.inner.root, name).ok()?;
            let file = self.present_blocking(&path, Magic::for_file(name))?;
            Some(format!(
                "{}decor/{name}?v={}",
                self.inner.base,
                sha8(&file.sha256)
            ))
        };
        let surah_header_url = url(SURAH_HEADER_FILE);
        let quran_common_url = url(QURAN_COMMON_FILE);
        let sura_names_url = url(SURA_NAMES_FILE);
        DecorStatus {
            installed: surah_header_url.is_some()
                && quran_common_url.is_some()
                && sura_names_url.is_some(),
            surah_header_url,
            quran_common_url,
            sura_names_url,
        }
    }

    /// Installs the missing decor files on the interactive lane and returns the new status (module docs).
    pub async fn ensure_decor(&self) -> Result<DecorStatus, PackError> {
        let status = self.decor_status_async().await?;
        if status.installed {
            return Ok(status);
        }
        let this = self.clone();
        self.inner
            .decor_flight
            .run(0, move || async move { this.install_decor().await })
            .await?;
        self.decor_status_async().await
    }

    async fn decor_status_async(&self) -> Result<DecorStatus, PackError> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.decor_status())
            .await
            .map_err(|e| PackError::Io(io::Error::other(format!("decor status task failed: {e}"))))
    }

    async fn install_decor(&self) -> Result<(), PackError> {
        let Some(src) = &self.inner.decor else {
            return Err(PackError::NotFound(format!(
                "the catalog has no {DECOR_PACK_ID} pack"
            )));
        };
        if !self.can_fetch() {
            return Err(PackError::Offline);
        }
        let mut wanted = Vec::new();
        let mut present = Vec::new();
        for file in &src.files {
            let dest = install::decor_path(&self.inner.root, &file.path)?;
            match self.present(&dest, Magic::for_file(&file.path)).await {
                Some(info) => present.push((file, info)),
                None => wanted.push((file, dest)),
            }
        }
        let results = join_all(
            wanted
                .iter()
                .map(|(file, dest)| self.download_decor_file(&src.pack_id, file, dest)),
        )
        .await;
        if results.iter().any(Result::is_ok) {
            // Files that were already on disk (a dev copy, an earlier partial install) belong to the install too.
            for (file, info) in present {
                self.record_item(
                    &src.pack_id,
                    ItemKey::File(file.path.clone()).db_key(),
                    info.bytes,
                    info.sha256,
                    true,
                )
                .await;
            }
            self.sync_decor_row().await;
            self.notify(vec![src.pack_id.clone()]);
        }
        match results.into_iter().find_map(Result::err) {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    async fn download_decor_file(
        &self,
        pack_id: &str,
        file: &StaticFile,
        dest: &Path,
    ) -> Result<(), PackError> {
        if file.urls.is_empty() {
            return Err(PackError::Catalog(format!(
                "{pack_id}: {} has no URLs",
                file.path
            )));
        }
        let temp = lane_temp(dest, Lane::Interactive);
        let done = self
            .inner
            .http
            .fetch_file(Request::new(&file.urls), &temp, &static_expect(file))
            .await?;
        let placed = self
            .place(temp.as_path(), dest, Magic::for_file(&file.path), &done)
            .await?;
        self.record_item(
            pack_id,
            ItemKey::File(file.path.clone()).db_key(),
            placed.bytes,
            placed.sha256,
            true,
        )
        .await;
        Ok(())
    }

    /// The `decor` row after an interactive install, with the job runner's policy: `installed` when every catalog
    /// item is present and pinned, else `partial`; a pack being removed is left alone.
    async fn sync_decor_row(&self) {
        let Some(src) = &self.inner.decor else {
            return;
        };
        let user = self.inner.user.clone();
        let (pack_id, kind, version, item_count) = (
            src.pack_id.clone(),
            src.kind,
            src.version.clone(),
            src.item_count,
        );
        let result = blocking(move || {
            let pinned: Vec<PackItemRow> = user
                .pack_items(&pack_id)?
                .into_iter()
                .filter(|r| r.pinned)
                .collect();
            if pinned.is_empty() {
                return Ok(());
            }
            let prev = user.pack_installed(&pack_id)?;
            if prev
                .as_ref()
                .is_some_and(|p| p.status == InstalledStatus::Removing)
            {
                return Ok(());
            }
            let present = u32::try_from(pinned.len()).unwrap_or(u32::MAX);
            let bytes = pinned
                .iter()
                .map(|r| r.bytes)
                .fold(0u64, u64::saturating_add);
            let now = user.now_ms();
            user.pack_upsert(&InstalledPackRow {
                pack_id: pack_id.clone(),
                kind,
                version,
                path: None,
                status: if item_count > 0 && present >= item_count {
                    InstalledStatus::Installed
                } else {
                    InstalledStatus::Partial
                },
                bytes,
                items_total: item_count,
                items_present: present,
                sha256: None,
                source_version: prev.as_ref().and_then(|p| p.source_version.clone()),
                installed_at: prev.as_ref().map_or(now, |p| p.installed_at),
                updated_at: now,
                last_checked_at: prev.as_ref().and_then(|p| p.last_checked_at),
            })?;
            Ok(())
        })
        .await;
        if let Err(e) = result {
            log::warn!("{DECOR_PACK_ID}: cannot record the install: {e}");
        }
    }

    // -----------------------------------------------------------------------------------------------------------
    // Files, hashes and the registry
    // -----------------------------------------------------------------------------------------------------------

    fn can_fetch(&self) -> bool {
        self.inner.http.network_allowed() && self.inner.http.online()
    }

    /// The verified file at `path`, if any (async wrapper of [`Self::present_blocking`]).
    async fn present(&self, path: &Path, magic: Magic) -> Option<FileInfo> {
        let this = self.clone();
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || this.present_blocking(&path, magic))
            .await
            .ok()
            .flatten()
    }

    /// A regular, non-empty file with the right magic, and its sha256 (from the cache while the file keeps its length
    /// and modification time). A file with the wrong magic can never load: it is deleted, so it is fetched again.
    fn present_blocking(&self, path: &Path, magic: Magic) -> Option<FileInfo> {
        let meta = std::fs::metadata(path)
            .ok()
            .filter(std::fs::Metadata::is_file)?;
        let (len, modified) = (meta.len(), meta.modified().ok());
        if len == 0 {
            return None;
        }
        if let Some(stamp) = self.inner.hashes.lock().get(path)
            && stamp.len == len
            && stamp.modified == modified
        {
            return Some(FileInfo {
                bytes: len,
                sha256: stamp.sha256.clone(),
                fresh: false,
            });
        }
        let (stamp, head) = match hash_file(path) {
            Ok(v) => v,
            Err(e) => {
                log::debug!("cannot read {}: {e}", path.display());
                return None;
            }
        };
        if stamp.len == 0 || !magic.accepts(&head) {
            log::warn!(
                "{} is not a {magic:?} font; deleting it so it is fetched again",
                path.display()
            );
            if let Err(e) = install::remove_file_blocking(path) {
                log::warn!("cannot delete {}: {e}", path.display());
            }
            self.inner.hashes.lock().remove(path);
            return None;
        }
        let info = FileInfo {
            bytes: stamp.len,
            sha256: stamp.sha256.clone(),
            fresh: false,
        };
        self.inner.hashes.lock().insert(path.to_path_buf(), stamp);
        Some(info)
    }

    /// Caches the hash of a file this lane just placed.
    async fn remember(&self, path: &Path, sha256: &str) {
        let Ok(meta) = tokio::fs::metadata(path).await else {
            return;
        };
        self.inner.hashes.lock().insert(
            path.to_path_buf(),
            Stamp {
                len: meta.len(),
                modified: meta.modified().ok(),
                sha256: sha256.to_owned(),
            },
        );
    }

    /// Moves a verified temp into place and caches its hash. When the rename fails because the destination is held
    /// (Windows) but already holds a valid file, that file wins ("first complete wins"): the temp is deleted and the
    /// file in place is described instead.
    async fn place(
        &self,
        temp: &Path,
        dest: &Path,
        magic: Magic,
        done: &Downloaded,
    ) -> Result<FileInfo, PackError> {
        match install::commit(temp, dest).await {
            Ok(()) => {
                self.remember(dest, &done.sha256).await;
                Ok(FileInfo {
                    bytes: done.bytes,
                    sha256: done.sha256.clone(),
                    fresh: true,
                })
            }
            Err(e) => {
                install::remove_file(temp).await?;
                match self.present(dest, magic).await {
                    Some(kept) => {
                        log::debug!("{} is already in place ({e}); keeping it", dest.display());
                        Ok(FileInfo {
                            fresh: true,
                            ..kept
                        })
                    }
                    None => Err(e),
                }
            }
        }
    }

    /// Records a fetched item: `pinned` as given, or kept when the row already was pinned. A failure is logged (the file
    /// is in place and verified either way).
    async fn record_item(
        &self,
        pack_id: &str,
        item: String,
        bytes: u64,
        sha256: String,
        pinned: bool,
    ) {
        let user = self.inner.user.clone();
        let pack = pack_id.to_owned();
        let result = blocking(move || {
            let now = user.now_ms();
            let prev = user.pack_item(&pack, &item)?;
            user.pack_item_upsert(&PackItemRow {
                pinned: pinned || prev.as_ref().is_some_and(|p| p.pinned),
                pack_id: pack,
                item,
                bytes,
                sha256,
                fetched_at: now,
                last_used_at: now,
            })?;
            Ok(())
        })
        .await;
        if let Err(e) = result {
            log::warn!("{pack_id}: cannot record a fetched font: {e}");
        }
    }

    fn notify(&self, pack_ids: Vec<String>) {
        let listener = self.inner.listener.read().clone();
        if let Some(listener) = listener {
            listener(pack_ids);
        }
    }

    fn ready_status(
        &self,
        style: MushafStyle,
        variant: FontVariant,
        page: u32,
        file: &FileInfo,
    ) -> PageFontStatus {
        let rel = Self::page_rel(variant, page);
        PageFontStatus {
            style,
            page,
            availability: FontAvailability::Ready,
            family: Self::family(style, page),
            url: Some(format!("{}{rel}?v={}", self.inner.base, sha8(&file.sha256))),
            rel: Some(rel),
            bytes: u32::try_from(file.bytes).unwrap_or(u32::MAX),
        }
    }
}

fn missing_status(
    style: MushafStyle,
    variant: FontVariant,
    page: u32,
    availability: FontAvailability,
) -> PageFontStatus {
    PageFontStatus {
        style,
        page,
        availability,
        family: format!("qcf-{}-p{page}", variant.dir()),
        url: None,
        rel: None,
        bytes: 0,
    }
}

fn hafs_status(page: u32) -> PageFontStatus {
    PageFontStatus {
        style: MushafStyle::Hafs,
        page,
        availability: FontAvailability::Ready,
        family: HAFS_FAMILY.to_owned(),
        url: None,
        rel: None,
        bytes: 0,
    }
}

/// The first eight hex digits of a sha256 (the `?v=` cache-buster).
fn sha8(sha256: &str) -> &str {
    sha256.get(..8).unwrap_or(sha256)
}

/// The lane-private temp of a font fetched outside a job: `p262.woff2.i.tmp` (interactive) or `.b.tmp` (prefetch).
/// The startup sweep deletes leftovers (`*.tmp`, `*.part` in `mushaf/` and `decor/`).
fn lane_temp(dest: &Path, lane: Lane) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(match lane {
        Lane::Interactive => ".i.tmp",
        Lane::Background => ".b.tmp",
    });
    PathBuf::from(s)
}

/// Opens `path` once and returns its stamp (from the open handle, so it matches the bytes hashed) and first bytes.
fn hash_file(path: &Path) -> io::Result<(Stamp, Vec<u8>)> {
    let mut f = std::fs::File::open(path)?;
    let meta = f.metadata()?;
    let mut hasher = Sha256::new();
    let mut head = Vec::with_capacity(8);
    let mut buf = vec![0u8; 64 * 1024];
    let mut len = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let chunk = buf.get(..n).unwrap_or_default();
        if head.len() < 8 {
            head.extend(chunk.iter().take(8usize.saturating_sub(head.len())));
        }
        hasher.update(chunk);
        len = len.saturating_add(u64::try_from(n).unwrap_or(u64::MAX));
    }
    Ok((
        Stamp {
            len,
            modified: meta.modified().ok(),
            sha256: hex::encode(hasher.finalize()),
        },
        head,
    ))
}

async fn blocking(
    f: impl FnOnce() -> Result<(), PackError> + Send + 'static,
) -> Result<(), PackError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| PackError::Io(io::Error::other(format!("registry task failed: {e}"))))?
}

// ---------------------------------------------------------------------------------------------------------------
// Shared with the job adapters (`qcf_font_pages`, `static_files`)
// ---------------------------------------------------------------------------------------------------------------

/// `invalid_argument` unless `page` is 1..=604.
pub fn check_page(page: u32) -> Result<(), PackError> {
    if (1..=PAGE_COUNT).contains(&page) {
        Ok(())
    } else {
        Err(PackError::Core(CoreError::InvalidArgument(format!(
            "page {page} is outside 1..={PAGE_COUNT}"
        ))))
    }
}

/// What a page font must satisfy: `wOF2`, at most [`MAX_FONT_BYTES`] (the length is checked against
/// `Content-Length`).
#[must_use]
pub fn page_expect() -> Expect {
    Expect::default().magic(WOFF2_MAGIC).max_len(MAX_FONT_BYTES)
}

/// What a static file must satisfy: the catalog length, the pinned sha256 if any, `wOF2` for woff2 files.
#[must_use]
pub fn static_expect(file: &StaticFile) -> Expect {
    let mut expect = Expect::default().len(file.bytes);
    if let Some(sha) = &file.sha256 {
        expect = expect.sha256(sha.clone());
    }
    if Magic::for_file(&file.path) == Magic::Woff2 {
        expect = expect.magic(WOFF2_MAGIC);
    }
    expect
}

/// The length of a woff2 file on disk (non-empty, `wOF2`), or `None`.
pub(crate) async fn valid_font_len(path: &Path) -> Option<u64> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut f = std::fs::File::open(&path).ok()?;
        let len = f.metadata().ok().filter(std::fs::Metadata::is_file)?.len();
        let mut head = [0u8; 4];
        f.read_exact(&mut head).ok()?;
        Magic::Woff2.accepts(&head).then_some(len)
    })
    .await
    .ok()
    .flatten()
}

/// The length of a static file on disk when it is exactly the catalog's (length, pinned sha256, magic), or `None`.
pub(crate) async fn static_file_present(path: &Path, file: &StaticFile) -> Option<u64> {
    let path = path.to_path_buf();
    let (bytes, sha, magic) = (file.bytes, file.sha256.clone(), Magic::for_file(&file.path));
    tokio::task::spawn_blocking(move || {
        let meta = std::fs::metadata(&path)
            .ok()
            .filter(std::fs::Metadata::is_file)?;
        if meta.len() != bytes {
            return None;
        }
        let (stamp, head) = hash_file(&path).ok()?;
        let sha_ok = sha
            .as_deref()
            .is_none_or(|want| want.eq_ignore_ascii_case(&stamp.sha256));
        (stamp.len == bytes && sha_ok && magic.accepts(&head)).then_some(bytes)
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_paths() {
        assert_eq!(Fonts::family(MushafStyle::QcfV2, 262), "qcf-v2-p262");
        assert_eq!(Fonts::family(MushafStyle::QcfV1, 1), "qcf-v1-p1");
        assert_eq!(Fonts::family(MushafStyle::QcfV4, 604), "qcf-v4-p604");
        assert_eq!(Fonts::family(MushafStyle::Hafs, 9), "qd-hafs");
        assert_eq!(Fonts::page_rel(FontVariant::V4, 3), "mushaf/v4/p3.woff2");
        assert_eq!(sha8("0123456789abcdef"), "01234567");
        assert_eq!(sha8("ab"), "ab");
        assert!(PROTOCOL_BASE.ends_with("localhost/"));
        assert_eq!(PROTOCOL_BASE.starts_with("http://quran."), cfg!(windows));
        let p = Path::new("x").join("p1.woff2");
        assert_eq!(
            lane_temp(&p, Lane::Interactive),
            Path::new("x").join("p1.woff2.i.tmp")
        );
        assert_eq!(
            lane_temp(&p, Lane::Background),
            Path::new("x").join("p1.woff2.b.tmp")
        );
    }

    #[test]
    fn magics() {
        assert!(Magic::Woff2.accepts(b"wOF2\0\0"));
        assert!(!Magic::Woff2.accepts(b"wOFF"));
        assert!(Magic::Sfnt.accepts(b"\x00\x01\x00\x00x"));
        assert!(Magic::Sfnt.accepts(b"OTTO"));
        assert!(!Magic::Sfnt.accepts(b"<htm"));
        assert_eq!(Magic::for_file("Quran-Common.TTF"), Magic::Sfnt);
        assert_eq!(Magic::for_file("a.woff2"), Magic::Woff2);
        assert_eq!(Magic::for_file("a.bin"), Magic::Any);
        assert!(check_page(1).is_ok() && check_page(604).is_ok());
        assert!(check_page(0).is_err() && check_page(605).is_err());
    }
}
