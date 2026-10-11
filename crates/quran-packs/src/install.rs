//! Installation: the on-disk layout, staging, the atomic flip, removal and the startup sweep (docs/ARCHITECTURE.md
//! §2.5.5 "Atomic install", §2.8.3). Owner: WP5b.
//!
//! Layout under `packs/` (the `quran://` root; [`kind_dir`] and the `*_path` helpers are its single source of truth):
//! ```text
//! mushaf/{v1,v2,v4}/p{N}.woff2          per-item, `.part` + rename (p{N}.woff2.part)
//! decor/{file}                           per-item, `.part` + rename
//! translation/{packId}/{version}/pack.db whole packs, atomic flip
//! tafsir/{packId}/{version}/pack.db
//! audio/{reciterId}/{sss}.mp3            {sss}.stream.part (streams), {sss}.dl.part + {sss}.dl.part.json (jobs)
//! .staging/{packId}/                     one per pack with an unfinished job: job.json, downloads, pack.db build
//! ```
//!
//! **Atomic install** of a whole pack ([`flip_whole`]):
//! 1. the adapter builds `pack.db` in the pack's staging directory and finishes it;
//! 2. it is renamed into a **new** directory `packs/{kind}/{id}/{version}/pack.db` (`{version}~{n}` when that
//!    directory already exists, e.g. a repair of the same version), so nothing is overwritten;
//! 3. one user.db statement upserts `installed_pack` with the new version and path and `status = 'installed'` (on
//!    failure the build is moved back to staging and the old version stays exactly as it was);
//! 4. the cached `PackDb` handle of the old version is released, then the old directory is deleted. When Windows still
//!    holds a file, [`sweep`] deletes the unreferenced directory on the next start.
//!
//! **Removal** ([`remove_whole`]) marks the row `removing`, releases handles, deletes the directory and then the rows;
//! an interrupted removal is finished by [`sweep`]. Per-item files use [`part_path`] + [`commit`].
//!
//! Every function here is fallible and panic-free; blocking file-system work runs in `spawn_blocking`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use quran_core::{InstalledPackRow, InstalledStatus, UserDb};
use quran_types::PackKind;

use crate::PackError;
use crate::adapters::{Adapter, FontVariant, ItemKey, StagedPack};
use crate::catalog::is_valid_pack_id;
use crate::writers::Writers;

/// `packs/.staging/`.
pub const STAGING_DIR: &str = ".staging";
/// The job journal inside a pack's staging directory (written by `jobs`).
pub const JOURNAL_FILE: &str = "job.json";
/// The pack database file name, in staging and in a version directory.
pub const PACK_DB_FILE: &str = "pack.db";
/// Appended to a per-item file while it downloads (`p262.woff2.part`).
pub const PART_SUFFIX: &str = ".part";
/// Extension of a progressive stream's temp (`001.stream.part`).
pub const STREAM_PART_EXT: &str = "stream.part";
/// Extension of a job's resumable temp (`001.dl.part`).
pub const DL_PART_EXT: &str = "dl.part";
/// Extension of a resumable temp's sidecar (`001.dl.part.json`).
pub const DL_SIDECAR_EXT: &str = "dl.part.json";
/// Suffix of a temp written by [`write_atomic`].
const TMP_SUFFIX: &str = ".tmp";

/// The directory of a pack kind under `packs/`; `None` for content.db-backed kinds (WBW).
#[must_use]
pub const fn kind_dir(kind: PackKind) -> Option<&'static str> {
    match kind {
        PackKind::MushafFonts => Some("mushaf"),
        PackKind::Decor => Some("decor"),
        PackKind::Translation => Some("translation"),
        PackKind::Tafsir => Some("tafsir"),
        PackKind::Recitation => Some("audio"),
        PackKind::Wbw => None,
    }
}

/// `packs/mushaf/{v}/`.
#[must_use]
pub fn font_dir(root: &Path, variant: FontVariant) -> PathBuf {
    root.join("mushaf").join(variant.dir())
}

/// `packs/mushaf/{v}/p{page}.woff2`.
#[must_use]
pub fn font_page_path(root: &Path, variant: FontVariant, page: u32) -> PathBuf {
    font_dir(root, variant).join(format!("p{page}.woff2"))
}

/// `packs/decor/`.
#[must_use]
pub fn decor_dir(root: &Path) -> PathBuf {
    root.join("decor")
}

/// `packs/decor/{file}`; `file` must be a plain file name (no separators, no `..`).
pub fn decor_path(root: &Path, file: &str) -> Result<PathBuf, PackError> {
    if !is_plain_file_name(file) {
        return Err(PackError::Catalog(format!(
            "decor file {file:?} is not a plain file name"
        )));
    }
    Ok(decor_dir(root).join(file))
}

/// `packs/audio/{reciter}/`.
#[must_use]
pub fn audio_dir(root: &Path, reciter_id: u32) -> PathBuf {
    root.join("audio").join(reciter_id.to_string())
}

/// `packs/audio/{reciter}/{sss}.mp3`.
#[must_use]
pub fn audio_path(root: &Path, reciter_id: u32, surah: u32) -> PathBuf {
    audio_dir(root, reciter_id).join(format!("{surah:03}.mp3"))
}

/// `packs/audio/{reciter}/{sss}.stream.part`.
#[must_use]
pub fn stream_part_path(root: &Path, reciter_id: u32, surah: u32) -> PathBuf {
    audio_path(root, reciter_id, surah).with_extension(STREAM_PART_EXT)
}

/// The non-resumable temp of a per-item file: `{dest}.part` (`p262.woff2.part`).
#[must_use]
pub fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(PART_SUFFIX);
    PathBuf::from(s)
}

/// The resumable temp of a large file: `{name}.dl.part` (`001.mp3` → `001.dl.part`).
#[must_use]
pub fn dl_part_path(dest: &Path) -> PathBuf {
    dest.with_extension(DL_PART_EXT)
}

/// The sidecar of a resumable temp: `{name}.dl.part.json`.
#[must_use]
pub fn dl_sidecar_path(dest: &Path) -> PathBuf {
    dest.with_extension(DL_SIDECAR_EXT)
}

/// `packs/{kind}/{packId}/` for whole packs (translation, tafsir).
pub fn pack_dir(root: &Path, kind: PackKind, pack_id: &str) -> Result<PathBuf, PackError> {
    let kind_name = kind_dir(kind).ok_or_else(|| {
        PackError::Unsupported(format!("{pack_id}: {kind:?} packs have no files"))
    })?;
    check_pack_id(pack_id)?;
    Ok(root.join(kind_name).join(pack_id))
}

/// `packs/.staging/`.
#[must_use]
pub fn staging_root(root: &Path) -> PathBuf {
    root.join(STAGING_DIR)
}

/// `packs/.staging/{packId}/`.
pub fn staging_dir(root: &Path, pack_id: &str) -> Result<PathBuf, PackError> {
    check_pack_id(pack_id)?;
    Ok(staging_root(root).join(pack_id))
}

/// The path of `path` relative to `root` with `/` separators (what `installed_pack.path` stores), if it is inside.
#[must_use]
pub fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(p) => parts.push(p.to_str()?.to_owned()),
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Resolves a stored relative path (`translation/tr.en.saheeh/1.1.2/pack.db`) under `root`, rejecting anything that
/// could leave it (absolute paths, `..`, drive or root prefixes, empty segments).
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, PackError> {
    let bad = || {
        PackError::Integrity(format!(
            "stored pack path {rel:?} is not a plain relative path"
        ))
    };
    if rel.is_empty() || rel.contains('\\') {
        return Err(bad());
    }
    let mut out = root.to_path_buf();
    for seg in rel.split('/') {
        if !is_plain_file_name(seg) {
            return Err(bad());
        }
        out.push(seg);
    }
    Ok(out)
}

fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':', '\0'])
        && Path::new(name)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

fn check_pack_id(pack_id: &str) -> Result<(), PackError> {
    if is_valid_pack_id(pack_id) {
        Ok(())
    } else {
        Err(PackError::Catalog(format!("invalid pack id {pack_id:?}")))
    }
}

/// A version string as a directory name: `[A-Za-z0-9._-]`, other characters become `_`, at most 64 bytes, never
/// `.`/`..`/empty.
#[must_use]
pub fn version_dir_name(version: &str) -> String {
    let mut s: String = version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if s.is_empty() || s.chars().all(|c| c == '.') {
        s = format!("v{s}");
    }
    s
}

// ---------------------------------------------------------------------------------------------------------------
// Small file operations
// ---------------------------------------------------------------------------------------------------------------

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, PackError> + Send + 'static,
) -> Result<T, PackError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| PackError::Io(io::Error::other(format!("blocking task failed: {e}"))))?
}

/// Moves a finished temp into place: fsync the temp, create the parent, rename over `dest` (atomic on every OS), then
/// fsync the directory where the OS supports it.
pub async fn commit(part: &Path, dest: &Path) -> Result<(), PackError> {
    let (part, dest) = (part.to_path_buf(), dest.to_path_buf());
    blocking(move || commit_blocking(&part, &dest)).await
}

/// [`commit`] for blocking contexts.
pub fn commit_blocking(part: &Path, dest: &Path) -> Result<(), PackError> {
    fs::OpenOptions::new().write(true).open(part)?.sync_all()?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(part, dest)?;
    sync_dir(dest.parent());
    Ok(())
}

/// Writes `bytes` to `dest` atomically (`{dest}.tmp`, fsync, rename).
pub async fn write_atomic(dest: &Path, bytes: Vec<u8>) -> Result<(), PackError> {
    let dest = dest.to_path_buf();
    blocking(move || write_atomic_blocking(&dest, &bytes)).await
}

/// [`write_atomic`] for blocking contexts.
pub fn write_atomic_blocking(dest: &Path, bytes: &[u8]) -> Result<(), PackError> {
    let mut tmp = dest.as_os_str().to_owned();
    tmp.push(TMP_SUFFIX);
    let tmp = PathBuf::from(tmp);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let result = (|| -> io::Result<()> {
        use std::io::Write;
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, dest)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    sync_dir(dest.parent());
    Ok(())
}

#[cfg(unix)]
fn sync_dir(dir: Option<&Path>) {
    if let Some(dir) = dir
        && let Ok(d) = fs::File::open(dir)
    {
        let _ = d.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: Option<&Path>) {}

/// Deletes a file; returns the bytes freed (`0` when it did not exist).
pub async fn remove_file(path: &Path) -> Result<u64, PackError> {
    let path = path.to_path_buf();
    blocking(move || remove_file_blocking(&path)).await
}

/// [`remove_file`] for blocking contexts.
pub fn remove_file_blocking(path: &Path) -> Result<u64, PackError> {
    let len = match fs::symlink_metadata(path) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    match fs::remove_file(path) {
        Ok(()) => Ok(len),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e.into()),
    }
}

/// Deletes a directory tree; returns the bytes freed (`0` when it did not exist).
pub async fn remove_dir(path: &Path) -> Result<u64, PackError> {
    let path = path.to_path_buf();
    blocking(move || remove_dir_blocking(&path)).await
}

/// [`remove_dir`] for blocking contexts.
pub fn remove_dir_blocking(path: &Path) -> Result<u64, PackError> {
    let size = dir_size(path);
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(size),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e.into()),
    }
}

/// Total size of the files under `path` (0 when missing; symlinks are not followed).
#[must_use]
pub fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| dir_size(&e.path()))
        .fold(0u64, u64::saturating_add)
}

/// The length of a regular file, or `None` when it does not exist (or is not a file).
pub async fn file_len(path: &Path) -> Option<u64> {
    tokio::fs::metadata(path)
        .await
        .ok()
        .filter(std::fs::Metadata::is_file)
        .map(|m| m.len())
}

// ---------------------------------------------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------------------------------------------

/// The staging directory of one pack, `packs/.staging/{packId}/`. One job per pack, so the name is stable across
/// pause/resume and restarts (the job journal and resumable downloads live here) and never shared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staging {
    dir: PathBuf,
}

impl Staging {
    /// Creates (or reuses) the pack's staging directory.
    pub async fn open(root: &Path, pack_id: &str) -> Result<Self, PackError> {
        let dir = staging_dir(root, pack_id)?;
        tokio::fs::create_dir_all(&dir).await?;
        Ok(Self { dir })
    }

    /// The directory, without creating it.
    pub fn locate(root: &Path, pack_id: &str) -> Result<Self, PackError> {
        Ok(Self {
            dir: staging_dir(root, pack_id)?,
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.dir
    }

    /// `job.json` inside it.
    #[must_use]
    pub fn journal_path(&self) -> PathBuf {
        self.dir.join(JOURNAL_FILE)
    }

    /// `pack.db` inside it.
    #[must_use]
    pub fn pack_db_path(&self) -> PathBuf {
        self.dir.join(PACK_DB_FILE)
    }

    /// Removes a leftover `pack.db` build (and its journals) before a new build; downloads are kept for resume.
    pub async fn clear_build(&self) -> Result<(), PackError> {
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let mut name = PACK_DB_FILE.to_owned();
            name.push_str(suffix);
            remove_file(&self.dir.join(name)).await?;
        }
        Ok(())
    }

    /// Deletes the whole directory (job journal, downloads, build); returns the bytes freed.
    pub async fn remove(&self) -> Result<u64, PackError> {
        remove_dir(&self.dir).await
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Atomic flip and removal of whole packs
// ---------------------------------------------------------------------------------------------------------------

/// What [`flip_whole`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flipped {
    /// The new `installed_pack` row (status `installed`).
    pub row: InstalledPackRow,
    /// The row it replaced, if any.
    pub previous: Option<InstalledPackRow>,
    /// The previous version's directory was deleted now (`false`: none, or left for the next start's [`sweep`]).
    pub old_dir_removed: bool,
}

/// Steps 2–4 of the atomic install (module docs). `release` drops cached handles on the old version; it runs after
/// the registry flip and before the old directory is deleted.
pub async fn flip_whole(
    root: &Path,
    user: &UserDb,
    pack_id: &str,
    kind: PackKind,
    staged: &StagedPack,
    release: impl FnOnce() + Send + 'static,
) -> Result<Flipped, PackError> {
    let root = root.to_path_buf();
    let user = user.clone();
    let pack_id = pack_id.to_owned();
    let staged = staged.clone();
    blocking(move || flip_blocking(&root, &user, &pack_id, kind, &staged, release)).await
}

fn flip_blocking(
    root: &Path,
    user: &UserDb,
    pack_id: &str,
    kind: PackKind,
    staged: &StagedPack,
    release: impl FnOnce(),
) -> Result<Flipped, PackError> {
    if !matches!(kind, PackKind::Translation | PackKind::Tafsir) {
        return Err(PackError::Unsupported(format!(
            "{pack_id}: {kind:?} packs are not installed whole"
        )));
    }
    let meta = fs::metadata(&staged.db_path)
        .map_err(|e| PackError::Integrity(format!("{pack_id}: staged pack.db missing: {e}")))?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(PackError::Integrity(format!(
            "{pack_id}: staged pack.db is not a non-empty file"
        )));
    }
    let previous = user.pack_installed(pack_id)?;
    let pack_root = pack_dir(root, kind, pack_id)?;
    fs::create_dir_all(&pack_root)?;

    // 2. A new directory, never an existing one.
    let base = version_dir_name(&staged.version);
    let mut new_dir = pack_root.join(&base);
    let mut n = 1u32;
    while new_dir.exists() {
        n = n.saturating_add(1);
        new_dir = pack_root.join(format!("{base}~{n}"));
        if n == u32::MAX {
            return Err(PackError::Io(io::Error::other("no free version directory")));
        }
    }
    fs::create_dir(&new_dir)?;
    let new_db = new_dir.join(PACK_DB_FILE);
    if let Err(e) = fs::rename(&staged.db_path, &new_db) {
        let _ = fs::remove_dir_all(&new_dir);
        return Err(e.into());
    }
    sync_dir(Some(&new_dir));
    let Some(rel) = relative(root, &new_db) else {
        undo_flip(&new_db, &staged.db_path, &new_dir);
        return Err(PackError::Io(io::Error::other(
            "pack directory is outside the packs root",
        )));
    };

    // 3. One statement = one transaction.
    let now = user.now_ms();
    let row = InstalledPackRow {
        pack_id: pack_id.to_owned(),
        kind,
        version: staged.version.clone(),
        path: Some(rel),
        status: InstalledStatus::Installed,
        bytes: staged.bytes,
        items_total: 1,
        items_present: 1,
        sha256: Some(staged.sha256.clone()),
        source_version: Some(staged.source_version.clone()),
        installed_at: previous.as_ref().map_or(now, |p| p.installed_at),
        updated_at: now,
        last_checked_at: Some(now),
    };
    if let Err(e) = user.pack_upsert(&row) {
        undo_flip(&new_db, &staged.db_path, &new_dir);
        return Err(e.into());
    }

    // 4. Release handles on the old version, then delete it.
    release();
    let mut old_dir_removed = false;
    if let Some(old_rel) = previous.as_ref().and_then(|p| p.path.as_deref()) {
        match resolve(root, old_rel) {
            Ok(old_db) => {
                if let Some(old_dir) = old_db.parent()
                    && old_dir != new_dir
                    && old_dir.starts_with(&pack_root)
                    && old_dir != pack_root
                {
                    match fs::remove_dir_all(old_dir) {
                        Ok(()) => old_dir_removed = true,
                        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                        Err(e) => log::warn!(
                            "{pack_id}: old version directory kept until the next start: {e}"
                        ),
                    }
                }
            }
            Err(e) => log::warn!("{pack_id}: ignoring the previous path: {e}"),
        }
    }
    Ok(Flipped {
        row,
        previous,
        old_dir_removed,
    })
}

/// Moves the build back to staging (so a retry can flip without rebuilding) and removes the new directory.
fn undo_flip(new_db: &Path, staged_db: &Path, new_dir: &Path) {
    if let Err(e) = fs::rename(new_db, staged_db) {
        log::warn!("could not move {} back to staging: {e}", new_db.display());
    }
    if let Err(e) = fs::remove_dir_all(new_dir) {
        log::warn!("could not remove {}: {e}", new_dir.display());
    }
}

/// Removes a whole pack (translation, tafsir): marks the row `removing`, calls `release` (drop cached handles), deletes
/// `packs/{kind}/{id}/` with every version, then the item rows and the row. Returns the bytes freed. When a file is
/// still held (Windows), the row stays `removing` and [`sweep`] finishes the removal on the next start.
pub async fn remove_whole(
    root: &Path,
    user: &UserDb,
    pack_id: &str,
    kind: PackKind,
    release: impl FnOnce() + Send + 'static,
) -> Result<u64, PackError> {
    let root = root.to_path_buf();
    let user = user.clone();
    let pack_id = pack_id.to_owned();
    blocking(move || {
        let dir = pack_dir(&root, kind, &pack_id)?;
        if let Some(mut row) = user.pack_installed(&pack_id)? {
            row.status = InstalledStatus::Removing;
            row.updated_at = user.now_ms();
            user.pack_upsert(&row)?;
        }
        release();
        let bytes = remove_dir_blocking(&dir)?;
        user.pack_items_clear(&pack_id)?;
        user.pack_delete(&pack_id)?;
        Ok(bytes)
    })
    .await
}

// ---------------------------------------------------------------------------------------------------------------
// Per-item files
// ---------------------------------------------------------------------------------------------------------------

/// The files behind one item of a per-item pack.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ItemFiles {
    /// The installed file (`None` for content.db items and whole packs).
    pub file: Option<PathBuf>,
    /// Job temps: `.part`, or `.dl.part` + sidecar. A stream's `.stream.part` is never listed (it belongs to the live
    /// stream; the startup sweep removes stale ones).
    pub temps: Vec<PathBuf>,
}

/// Where an item of `adapter` lives under `root` (§2.5.3 item ids, §2.8.3 layout).
pub fn item_files(adapter: &Adapter, root: &Path, item: &ItemKey) -> Result<ItemFiles, PackError> {
    Ok(match (adapter, item) {
        (Adapter::QcfFontPages(c), ItemKey::Page(page)) => {
            let file = font_page_path(root, c.variant, *page);
            ItemFiles {
                temps: vec![part_path(&file)],
                file: Some(file),
            }
        }
        (Adapter::StaticFiles(_), ItemKey::File(name)) => {
            let file = decor_path(root, name)?;
            ItemFiles {
                temps: vec![part_path(&file)],
                file: Some(file),
            }
        }
        (Adapter::QdcAudio(c), ItemKey::Surah(surah)) => {
            let file = audio_path(root, c.reciter_id, *surah);
            ItemFiles {
                temps: vec![dl_part_path(&file), dl_sidecar_path(&file)],
                file: Some(file),
            }
        }
        _ => ItemFiles::default(),
    })
}

/// Deletes the files (and job temps) of `items`; returns the bytes freed.
pub async fn remove_item_files(
    adapter: &Adapter,
    root: &Path,
    items: &[ItemKey],
) -> Result<u64, PackError> {
    let mut paths = Vec::new();
    for item in items {
        let f = item_files(adapter, root, item)?;
        paths.extend(f.file);
        paths.extend(f.temps);
    }
    blocking(move || {
        let mut freed = 0u64;
        for p in &paths {
            freed = freed.saturating_add(remove_file_blocking(p)?);
        }
        Ok(freed)
    })
    .await
}

// ---------------------------------------------------------------------------------------------------------------
// Startup sweep
// ---------------------------------------------------------------------------------------------------------------

/// What [`sweep`] removed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SweepReport {
    /// Stale `*.stream.part` (no live stream).
    pub stream_parts: u32,
    /// Interrupted per-item temps (`*.part`, `*.tmp`).
    pub part_files: u32,
    /// `*.dl.part` (+ sidecars) with no job journal to resume them.
    pub orphan_downloads: u32,
    /// Staging directories without a readable job journal.
    pub staging_dirs: u32,
    /// Unreferenced version directories of whole packs (an old version Windows held, an interrupted flip).
    pub version_dirs: u32,
    /// Whole packs whose interrupted removal was finished.
    pub removals: u32,
    /// Per-item packs still marked `removing` (their files are the manager's to delete, with the catalog).
    pub pending_removals: Vec<String>,
    pub bytes: u64,
}

/// Cleans `packs/` at startup, before any job resumes or stream starts (§2.5.5 "At startup start_background deletes
/// every stale `*.stream.part`", "retry on the next start"). Errors on single entries are logged and skipped.
pub async fn sweep(
    root: &Path,
    user: &UserDb,
    writers: &Writers,
) -> Result<SweepReport, PackError> {
    let root = root.to_path_buf();
    let user = user.clone();
    let live = writers.live_streams();
    blocking(move || sweep_blocking(&root, &user, &live)).await
}

fn sweep_blocking(
    root: &Path,
    user: &UserDb,
    live: &[(u32, u32)],
) -> Result<SweepReport, PackError> {
    let mut report = SweepReport::default();
    let rows = user.packs_installed()?;

    // Staging: keep only directories with a readable job journal.
    let mut journaled: Vec<String> = Vec::new();
    for entry in read_dir_or_empty(&staging_root(root)) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let journal_ok = path.is_dir()
            && fs::read(path.join(JOURNAL_FILE))
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .is_some();
        if journal_ok && is_valid_pack_id(&name) {
            journaled.push(name);
        } else {
            remove_any(&path, &mut report.bytes, &mut report.staging_dirs);
        }
    }

    // Audio: stale stream temps, orphan job temps, interrupted atomic writes.
    for reciter_dir in read_dir_or_empty(&root.join("audio")) {
        let dir = reciter_dir.path();
        if !dir.is_dir() {
            continue;
        }
        let reciter = reciter_dir
            .file_name()
            .to_string_lossy()
            .parse::<u32>()
            .ok();
        let resumable = reciter.is_some_and(|r| journaled.contains(&format!("audio.qdc.{r}")));
        for f in read_dir_or_empty(&dir) {
            let path = f.path();
            let name = f.file_name().to_string_lossy().into_owned();
            if let Some(stem) = name.strip_suffix(".stream.part") {
                let key = reciter.zip(stem.parse::<u32>().ok());
                if key.is_some_and(|k| live.contains(&k)) {
                    continue;
                }
                remove_any(&path, &mut report.bytes, &mut report.stream_parts);
            } else if name.ends_with(".dl.part") || name.ends_with(".dl.part.json") {
                if !resumable {
                    remove_any(&path, &mut report.bytes, &mut report.orphan_downloads);
                }
            } else if name.ends_with(TMP_SUFFIX) || name.ends_with(PART_SUFFIX) {
                remove_any(&path, &mut report.bytes, &mut report.part_files);
            }
        }
    }

    // Fonts and decor: interrupted `.part`/`.tmp` temps.
    let mut temp_dirs = vec![decor_dir(root)];
    temp_dirs.extend(
        [FontVariant::V1, FontVariant::V2, FontVariant::V4]
            .into_iter()
            .map(|v| font_dir(root, v)),
    );
    for dir in temp_dirs {
        for f in read_dir_or_empty(&dir) {
            let name = f.file_name();
            if has_suffix(&name, PART_SUFFIX) || has_suffix(&name, TMP_SUFFIX) {
                remove_any(&f.path(), &mut report.bytes, &mut report.part_files);
            }
        }
    }

    // Whole packs: finish removals, delete unreferenced version directories and orphan pack directories.
    let by_id: HashMap<&str, &InstalledPackRow> =
        rows.iter().map(|r| (r.pack_id.as_str(), r)).collect();
    for kind in [PackKind::Translation, PackKind::Tafsir] {
        let Some(kind_name) = kind_dir(kind) else {
            continue;
        };
        for pack in read_dir_or_empty(&root.join(kind_name)) {
            let pack_path = pack.path();
            if !pack_path.is_dir() {
                continue;
            }
            let id = pack.file_name().to_string_lossy().into_owned();
            let row = by_id.get(id.as_str()).copied();
            if row.is_some_and(|r| r.status == InstalledStatus::Removing) {
                let mut n = 0;
                remove_any(&pack_path, &mut report.bytes, &mut n);
                if !pack_path.exists() {
                    user.pack_items_clear(&id)?;
                    user.pack_delete(&id)?;
                    report.removals = report.removals.saturating_add(1);
                }
                continue;
            }
            let keep: Option<PathBuf> = row
                .and_then(|r| r.path.as_deref())
                .and_then(|p| resolve(root, p).ok())
                .and_then(|db| db.parent().map(Path::to_path_buf));
            if journaled.contains(&id) && keep.is_none() {
                // A first install is running or paused; its flip creates the directory.
                continue;
            }
            for version in read_dir_or_empty(&pack_path) {
                let vp = version.path();
                if keep.as_deref() != Some(vp.as_path()) {
                    remove_any(&vp, &mut report.bytes, &mut report.version_dirs);
                }
            }
            if keep.is_none() {
                let _ = fs::remove_dir(&pack_path);
            }
        }
    }
    // Rows marked `removing` whose directory is already gone (or per-item packs).
    for row in rows
        .iter()
        .filter(|r| r.status == InstalledStatus::Removing)
    {
        let dir_gone = pack_dir(root, row.kind, &row.pack_id).is_ok_and(|d| !d.exists());
        match row.kind {
            PackKind::Translation | PackKind::Tafsir if dir_gone => {
                if user.pack_installed(&row.pack_id)?.is_some() {
                    user.pack_items_clear(&row.pack_id)?;
                    user.pack_delete(&row.pack_id)?;
                    report.removals = report.removals.saturating_add(1);
                }
            }
            PackKind::Translation | PackKind::Tafsir => {}
            _ => report.pending_removals.push(row.pack_id.clone()),
        }
    }
    if report != SweepReport::default() {
        log::info!("packs sweep: {report:?}");
    }
    Ok(report)
}

fn has_suffix(name: &OsStr, suffix: &str) -> bool {
    name.to_str().is_some_and(|n| n.ends_with(suffix))
}

fn read_dir_or_empty(dir: &Path) -> Vec<fs::DirEntry> {
    match fs::read_dir(dir) {
        Ok(rd) => rd.flatten().collect(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            log::warn!("packs sweep: cannot list {}: {e}", dir.display());
            Vec::new()
        }
    }
}

fn remove_any(path: &Path, bytes: &mut u64, count: &mut u32) {
    let result = if path.is_dir() {
        remove_dir_blocking(path)
    } else {
        remove_file_blocking(path)
    };
    match result {
        Ok(freed) => {
            *bytes = bytes.saturating_add(freed);
            *count = count.saturating_add(1);
        }
        Err(e) => log::warn!("packs sweep: cannot remove {}: {e}", path.display()),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

    use super::*;

    #[test]
    fn layout_paths() {
        let root = Path::new("/data/packs");
        assert_eq!(
            font_page_path(root, FontVariant::V4, 262),
            root.join("mushaf").join("v4").join("p262.woff2")
        );
        assert_eq!(
            audio_path(root, 7, 2),
            root.join("audio").join("7").join("002.mp3")
        );
        assert_eq!(
            stream_part_path(root, 7, 2),
            root.join("audio").join("7").join("002.stream.part")
        );
        let mp3 = audio_path(root, 7, 114);
        assert_eq!(
            dl_part_path(&mp3),
            root.join("audio").join("7").join("114.dl.part")
        );
        assert_eq!(
            dl_sidecar_path(&mp3),
            root.join("audio").join("7").join("114.dl.part.json")
        );
        let font = font_page_path(root, FontVariant::V2, 1);
        assert_eq!(
            part_path(&font),
            root.join("mushaf").join("v2").join("p1.woff2.part")
        );
        assert_eq!(
            dl_part_path(Path::new("x/english_saheeh.zip")),
            Path::new("x/english_saheeh.dl.part")
        );
        assert!(decor_path(root, "../x").is_err());
        assert!(decor_path(root, "a/b.ttf").is_err());
        assert_eq!(
            decor_path(root, "quran-common.ttf").unwrap(),
            root.join("decor").join("quran-common.ttf")
        );
        assert_eq!(kind_dir(PackKind::Wbw), None);
        assert!(pack_dir(root, PackKind::Wbw, "wbw.en").is_err());
        assert!(pack_dir(root, PackKind::Translation, "../x").is_err());
        assert!(staging_dir(root, "tr.en.saheeh").is_ok());
        assert!(staging_dir(root, "..").is_err());
    }

    #[test]
    fn relative_and_resolve_round_trip_and_reject_escapes() {
        let root = Path::new("/data/packs");
        let db = root
            .join("translation")
            .join("tr.en.saheeh")
            .join("1.1.2")
            .join("pack.db");
        let rel = relative(root, &db).unwrap();
        assert_eq!(rel, "translation/tr.en.saheeh/1.1.2/pack.db");
        assert_eq!(resolve(root, &rel).unwrap(), db);
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../b",
            "a//b",
            "a\\b",
            "C:/x",
            "a/./b",
        ] {
            assert!(resolve(root, bad).is_err(), "{bad:?}");
        }
        assert_eq!(relative(root, Path::new("/elsewhere/x")), None);
    }

    #[test]
    fn version_names_are_safe() {
        assert_eq!(version_dir_name("1.1.2"), "1.1.2");
        assert_eq!(version_dir_name("2026.10"), "2026.10");
        assert_eq!(version_dir_name("v1 beta/2"), "v1_beta_2");
        assert_eq!(version_dir_name(""), "v");
        assert_eq!(version_dir_name(".."), "v..");
        assert_eq!(version_dir_name(&"x".repeat(100)).len(), 64);
    }
}
