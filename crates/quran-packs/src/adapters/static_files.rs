//! `static_files`: fixed files such as the decor fonts (docs/ARCHITECTURE.md §2.5.6). Owner: WP5c.
//!
//! `GET url` (the mirrors in order); integrity: exactly the catalog `bytes`, the catalog `sha256` when pinned (otherwise
//! the computed hash is recorded: trust on first use), and the `wOF2` prefix for `.woff2` files; written to
//! `packs/decor/{path}` through `.part` + rename. The job runner records `pack_item` `file:{path}`. A file already on
//! disk with the catalog length (and hash) is `Present`. A pinned file whose upstream changed fails with `Integrity`
//! until the catalog is updated (WP5a). [`crate::fonts::Fonts::ensure_decor`] installs the same files on the interactive
//! lane, through its own temp names.

use super::{AdapterCtx, ItemOutcome, StaticFile, StaticFilesConfig};
use crate::PackError;
use crate::fonts;
use crate::http::Request;
use crate::install;

/// Fetches one file of `cfg`.
pub async fn fetch_file(
    ctx: &AdapterCtx,
    cfg: &StaticFilesConfig,
    file: &StaticFile,
) -> Result<ItemOutcome, PackError> {
    if !cfg.files.iter().any(|f| f.path == file.path) {
        return Err(PackError::NotFound(format!(
            "{}: no file {}",
            ctx.pack_id, file.path
        )));
    }
    if file.urls.is_empty() {
        return Err(PackError::Catalog(format!(
            "{}: {} has no URLs",
            ctx.pack_id, file.path
        )));
    }
    let dest = install::decor_path(&ctx.packs_root, &file.path)?;
    if let Some(bytes) = fonts::static_file_present(&dest, file).await {
        return Ok(ItemOutcome::Present { bytes });
    }
    let done = ctx
        .http
        .fetch_file(
            Request::for_ctx(ctx, &file.urls),
            &dest,
            &fonts::static_expect(file),
        )
        .await?;
    Ok(ItemOutcome::Stored {
        bytes: done.bytes,
        sha256: done.sha256,
    })
}
