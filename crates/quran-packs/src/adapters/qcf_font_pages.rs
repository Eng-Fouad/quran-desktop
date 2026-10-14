//! `qcf_font_pages`: QCF per-page woff2 fonts.
//!
//! `GET <urlTemplate with {page}>` for a missing page, the templates tried in order as mirrors; integrity: the length
//! equals `Content-Length`, at most [`MAX_FONT_BYTES`](crate::fonts::MAX_FONT_BYTES), and the file starts with `wOF2`;
//! written to `packs/mushaf/{variant}/p{page}.woff2` through `.part` + rename. The job runner records `pack_item`
//! `p{page}`. A page already on disk (fetched earlier on demand by [`crate::fonts`]) is `Present`, so "download all"
//! only pins it.
//!
//! The interactive lane writes the same destination through its own temp name, so a page the reader fetches while a
//! job downloads it never shares a temp file; both writers verify the bytes and the last rename wins with identical
//! content.

use super::{AdapterCtx, ItemOutcome, QcfFontPagesConfig};
use crate::PackError;
use crate::fonts;
use crate::http::Request;
use crate::install;

/// Fetches page `page` (1..=604) of `cfg.variant`.
pub async fn fetch_page(
    ctx: &AdapterCtx,
    cfg: &QcfFontPagesConfig,
    page: u32,
) -> Result<ItemOutcome, PackError> {
    let urls = page_urls(cfg, page)?;
    let dest = install::font_page_path(&ctx.packs_root, cfg.variant, page);
    if let Some(bytes) = fonts::valid_font_len(&dest).await {
        return Ok(ItemOutcome::Present { bytes });
    }
    let done = ctx
        .http
        .fetch_file(Request::for_ctx(ctx, &urls), &dest, &fonts::page_expect())
        .await?;
    Ok(ItemOutcome::Stored {
        bytes: done.bytes,
        sha256: done.sha256,
    })
}

/// The mirrors of one page: every template with `{page}` replaced, in catalog order.
pub fn page_urls(cfg: &QcfFontPagesConfig, page: u32) -> Result<Vec<String>, PackError> {
    fonts::check_page(page)?;
    if cfg.url_templates.is_empty() {
        return Err(PackError::Catalog(format!(
            "mushaf {} has no URL templates",
            cfg.variant.dir()
        )));
    }
    let page = page.to_string();
    Ok(cfg
        .url_templates
        .iter()
        .map(|t| t.replace("{page}", &page))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::FontVariant;

    #[test]
    fn templates_expand_in_order() {
        let cfg = QcfFontPagesConfig {
            variant: FontVariant::V4,
            url_templates: vec![
                "https://a.example/v4/colrv1/woff2/p{page}.woff2".into(),
                "https://b.example/v4-tajweed/woff2/p{page}.woff2".into(),
            ],
        };
        assert_eq!(
            page_urls(&cfg, 262).ok(),
            Some(vec![
                "https://a.example/v4/colrv1/woff2/p262.woff2".to_owned(),
                "https://b.example/v4-tajweed/woff2/p262.woff2".to_owned(),
            ])
        );
        assert!(page_urls(&cfg, 0).is_err());
        assert!(page_urls(&cfg, 605).is_err());
        let empty = QcfFontPagesConfig {
            variant: FontVariant::V2,
            url_templates: vec![],
        };
        assert!(matches!(page_urls(&empty, 1), Err(PackError::Catalog(_))));
    }
}
