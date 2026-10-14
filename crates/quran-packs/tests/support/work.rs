//! Fake pack work for job tests: real downloads through the HTTP layer from the test server, without the catalog
//! adapters.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use futures_util::future::BoxFuture;
use quran_packs::PackError;
use quran_packs::adapters::{AdapterCtx, ItemKey, ItemOutcome, StagedPack};
use quran_packs::http::{Expect, Request};
use quran_packs::install;
use quran_packs::jobs::{JobSpec, PackWork, SpecSource};
use quran_types::{InstallScope, JobPhase, PackKind};

/// Per-item work: item `n` (`p{n}`) is `GET {base}/{n}`, stored at `packs/test/{packId}/{n}.bin`. An item already on
/// disk is reported `Present`.
pub struct ItemsWork {
    pub base: String,
    pub count: u32,
    /// `Http::download` (`.dl.part` + sidecar) instead of `Http::fetch_file` (`.part`).
    pub resumable: bool,
    /// `fetch_item` calls.
    pub calls: Arc<AtomicU32>,
}

impl ItemsWork {
    pub fn new(base: String, count: u32) -> Self {
        Self {
            base,
            count,
            resumable: false,
            calls: Arc::new(AtomicU32::new(0)),
        }
    }

    pub fn resumable(mut self) -> Self {
        self.resumable = true;
        self
    }

    pub fn dest(root: &Path, pack_id: &str, n: u32) -> PathBuf {
        root.join("test").join(pack_id).join(format!("{n}.bin"))
    }
}

impl PackWork for ItemsWork {
    fn items(&self, scope: &InstallScope) -> Result<Vec<ItemKey>, PackError> {
        match scope {
            InstallScope::All => Ok((1..=self.count).map(ItemKey::Page).collect()),
            InstallScope::Items { items } => items
                .iter()
                .map(|&n| {
                    if (1..=self.count).contains(&n) {
                        Ok(ItemKey::Page(n))
                    } else {
                        Err(PackError::NotFound(format!("item {n}")))
                    }
                })
                .collect(),
        }
    }

    fn whole(&self) -> bool {
        false
    }

    fn fetch_item<'a>(
        &'a self,
        ctx: &'a AdapterCtx,
        item: &'a ItemKey,
    ) -> BoxFuture<'a, Result<ItemOutcome, PackError>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let ItemKey::Page(n) = item else {
                return Err(PackError::Unsupported(format!("{item}")));
            };
            let dest = Self::dest(&ctx.packs_root, &ctx.pack_id, *n);
            if let Some(len) = install::file_len(&dest).await {
                return Ok(ItemOutcome::Present { bytes: len });
            }
            let urls = vec![format!("{}/{n}", self.base)];
            let req = Request::for_ctx(ctx, &urls);
            let done = if self.resumable {
                ctx.http.download(req, &dest, &Expect::default()).await?
            } else {
                ctx.http.fetch_file(req, &dest, &Expect::default()).await?
            };
            Ok(ItemOutcome::Stored {
                bytes: done.bytes,
                sha256: done.sha256,
            })
        })
    }

    fn install_whole<'a>(
        &'a self,
        _ctx: &'a AdapterCtx,
        _staging: &'a Path,
    ) -> BoxFuture<'a, Result<StagedPack, PackError>> {
        Box::pin(async { Err(PackError::Unsupported("per item".into())) })
    }

    fn temp_paths(&self, packs_root: &Path, item: &ItemKey) -> Vec<PathBuf> {
        // The tests use one pack id per work; the path needs the pack id, so it is derived from the item alone via
        // every pack directory under packs/test/.
        let ItemKey::Page(n) = item else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(packs_root.join("test")) {
            for e in rd.flatten() {
                let dest = e.path().join(format!("{n}.bin"));
                out.push(install::part_path(&dest));
                out.push(install::dl_part_path(&dest));
                out.push(install::dl_sidecar_path(&dest));
            }
        }
        out
    }
}

/// Whole-pack work: downloads `url` resumably into staging as `pack.zip`, reports `Verifying`, then "builds" a
/// `pack.db` (a non-SQLite placeholder; the flip only moves it).
pub struct WholeWork {
    pub url: String,
    pub version: String,
    pub sha256: Option<String>,
    /// Builds left to fail after the download, as a bad archive would.
    pub fail_builds: Arc<AtomicU32>,
}

impl WholeWork {
    pub fn new(url: String, version: &str) -> Self {
        Self {
            url,
            version: version.to_owned(),
            sha256: None,
            fail_builds: Arc::new(AtomicU32::new(0)),
        }
    }

    pub fn failing(self, builds: u32) -> Self {
        self.fail_builds.store(builds, Ordering::SeqCst);
        self
    }
}

impl PackWork for WholeWork {
    fn items(&self, scope: &InstallScope) -> Result<Vec<ItemKey>, PackError> {
        match scope {
            InstallScope::All => Ok(vec![ItemKey::Whole]),
            InstallScope::Items { .. } => Err(PackError::Unsupported("whole only".into())),
        }
    }

    fn whole(&self) -> bool {
        true
    }

    fn fetch_item<'a>(
        &'a self,
        _ctx: &'a AdapterCtx,
        _item: &'a ItemKey,
    ) -> BoxFuture<'a, Result<ItemOutcome, PackError>> {
        Box::pin(async { Err(PackError::Unsupported("whole".into())) })
    }

    fn install_whole<'a>(
        &'a self,
        ctx: &'a AdapterCtx,
        staging: &'a Path,
    ) -> BoxFuture<'a, Result<StagedPack, PackError>> {
        Box::pin(async move {
            let zip = staging.join("pack.zip");
            let urls = vec![self.url.clone()];
            let expect = Expect {
                sha256: self.sha256.clone(),
                ..Expect::default()
            };
            let dl = ctx
                .http
                .download(Request::for_ctx(ctx, &urls), &zip, &expect)
                .await?;
            if let Some(job) = &ctx.job {
                job.set_phase(JobPhase::Verifying);
            }
            let fail = loop {
                let n = self.fail_builds.load(Ordering::SeqCst);
                if n == 0 {
                    break false;
                }
                if self
                    .fail_builds
                    .compare_exchange(n, n - 1, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    break true;
                }
            };
            if fail {
                return Err(PackError::Integrity(
                    "translations table has 6235 rows".into(),
                ));
            }
            let db_path = staging.join("pack.db");
            let mut db = b"SQLite format 3\0".to_vec();
            db.extend_from_slice(dl.sha256.as_bytes());
            tokio::fs::write(&db_path, &db).await?;
            Ok(StagedPack {
                db_path,
                version: self.version.clone(),
                source_version:
                    serde_json::json!({ "etag": dl.validators.etag, "contentLength": dl.bytes })
                        .to_string(),
                sha256: dl.sha256,
                bytes: u64::try_from(db.len()).unwrap_or(0),
            })
        })
    }

    fn temp_paths(&self, _packs_root: &Path, _item: &ItemKey) -> Vec<PathBuf> {
        Vec::new()
    }
}

/// A job spec for test work.
pub fn spec(
    pack_id: &str,
    kind: PackKind,
    work: Arc<dyn PackWork>,
    scope: InstallScope,
    item_count: u32,
    size_bytes: u64,
) -> JobSpec {
    JobSpec {
        pack_id: pack_id.to_owned(),
        kind,
        version: "2026.10".into(),
        item_count,
        size_bytes,
        scope,
        pin: true,
        work,
    }
}

/// One test pack: `(pack_id, kind, work, item_count, size_bytes)`.
pub type TestPack<'a> = (&'a str, PackKind, Arc<dyn PackWork>, u32, u64);

/// A spec source over fixed works.
pub fn spec_source(works: Vec<TestPack<'_>>) -> SpecSource {
    let map: HashMap<String, (PackKind, Arc<dyn PackWork>, u32, u64)> = works
        .into_iter()
        .map(|(id, kind, work, n, size)| (id.to_owned(), (kind, work, n, size)))
        .collect();
    Arc::new(move |pack_id: &str, scope: InstallScope, pin: bool| {
        map.get(pack_id).map(|(kind, work, n, size)| {
            let mut s = spec(pack_id, *kind, Arc::clone(work), scope, *n, *size);
            s.pin = pin;
            s
        })
    })
}
