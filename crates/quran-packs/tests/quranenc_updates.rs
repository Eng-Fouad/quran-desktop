//! QuranEnc update checks (`quranenc_sqlite::check_update`): the list version for listed keys, a conditional `HEAD`
//! with `If-None-Match` (never `If-Modified-Since`: QuranEnc's `Last-Modified` is a constant) for unlisted ones and for
//! keys that left the list, and the offline gate.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod quranenc_support;
mod support;

use quran_core::{InstalledPackRow, InstalledStatus};
use quran_packs::PackError;
use quran_packs::adapters::quranenc_sqlite::{Endpoints, SourceVersion, check_update_from};
use quran_types::PackKind;
use quranenc_support::{list_json, muyassar, saheeh};
use support::TestEnv;
use support::http::{Route, TestServer};

const OLD_ETAG: &str = "\"67e2bd39-c64f2\"";
const NEW_ETAG: &str = "\"69c915c2-8cb75\"";

fn installed(
    pack_id: &str,
    kind: PackKind,
    version: &str,
    sv: Option<SourceVersion>,
) -> InstalledPackRow {
    InstalledPackRow {
        pack_id: pack_id.into(),
        kind,
        version: version.into(),
        path: Some(format!("x/{pack_id}/{version}/pack.db")),
        status: InstalledStatus::Installed,
        bytes: 1,
        items_total: 1,
        items_present: 1,
        sha256: None,
        source_version: sv.map(|s| s.to_json()),
        installed_at: 0,
        updated_at: 0,
        last_checked_at: None,
    }
}

fn validators(key: &str, etag: Option<&str>, len: Option<u64>) -> SourceVersion {
    SourceVersion {
        key: key.into(),
        etag: etag.map(str::to_owned),
        last_modified: Some("Thu, 26 Mar 2000 17:35:45 GMT".into()),
        content_length: len,
        ..SourceVersion::default()
    }
}

fn endpoints(s: &TestServer, zip: &str) -> Endpoints {
    Endpoints {
        zip: vec![s.url(zip)],
        list: s.url("/list"),
    }
}

#[tokio::test]
async fn listed_packs_compare_the_list_version() {
    let s = TestServer::start();
    s.route(
        "/list",
        Route::json(&list_json(&[("english_saheeh", "1.1.2", "Saheeh")])),
    );
    let env = TestEnv::new();
    let ctx = env.ctx("tr.en.saheeh", PackKind::Translation, None, false);
    let ep = endpoints(&s, "/english_saheeh.zip");
    let sv = SourceVersion {
        key: "english_saheeh".into(),
        version: Some("1.1.2".into()),
        ..SourceVersion::default()
    };
    let row = installed(
        "tr.en.saheeh",
        PackKind::Translation,
        "1.1.2",
        Some(sv.clone()),
    );
    assert_eq!(
        check_update_from(&ctx, &saheeh("1.1.2"), &row, &ep)
            .await
            .unwrap(),
        None
    );

    s.route(
        "/list",
        Route::json(&list_json(&[("english_saheeh", "1.1.3", "Saheeh")])),
    );
    assert_eq!(
        check_update_from(&ctx, &saheeh("1.1.2"), &row, &ep)
            .await
            .unwrap()
            .as_deref(),
        Some("1.1.3")
    );
    // Without a stored list version, the installed version is compared.
    let bare = installed("tr.en.saheeh", PackKind::Translation, "1.1.3", None);
    assert_eq!(
        check_update_from(&ctx, &saheeh("1.1.2"), &bare, &ep)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        s.hits("/english_saheeh.zip"),
        0,
        "listed keys never HEAD the zip"
    );
}

#[tokio::test]
async fn a_key_that_left_the_list_falls_back_to_the_validators() {
    let s = TestServer::start();
    s.route(
        "/list",
        Route::json(&list_json(&[("english_rwwad", "1.0.19", "Rowwad")])),
    );
    s.route(
        "/english_saheeh.zip",
        Route::bytes(vec![1u8; 100]).etag(NEW_ETAG),
    );
    let env = TestEnv::new();
    let ctx = env.ctx("tr.en.saheeh", PackKind::Translation, None, false);
    let row = installed(
        "tr.en.saheeh",
        PackKind::Translation,
        "1.1.2",
        Some(validators("english_saheeh", Some(OLD_ETAG), Some(100))),
    );
    let latest = check_update_from(
        &ctx,
        &saheeh("1.1.2"),
        &row,
        &endpoints(&s, "/english_saheeh.zip"),
    )
    .await
    .unwrap();
    assert_eq!(latest.as_deref(), Some("2026.03"));
    let head = &s.requests_to("/english_saheeh.zip")[0];
    assert_eq!(head.method, "HEAD");
}

#[tokio::test]
async fn validators_packs_send_a_conditional_head() {
    let s = TestServer::start();
    let body = vec![7u8; 1000];
    s.route(
        "/arabic_moyassar.zip",
        Route::bytes(body.clone())
            .etag(OLD_ETAG)
            .last_modified("Thu, 26 Mar 2000 17:35:45 GMT"),
    );
    let env = TestEnv::new();
    let ctx = env.ctx("tafsir.ar.muyassar", PackKind::Tafsir, None, false);
    let ep = endpoints(&s, "/arabic_moyassar.zip");
    let row = installed(
        "tafsir.ar.muyassar",
        PackKind::Tafsir,
        "2025.03",
        Some(validators("arabic_moyassar", Some(OLD_ETAG), Some(1000))),
    );
    // Unchanged: 304.
    assert_eq!(
        check_update_from(&ctx, &muyassar("2025.03"), &row, &ep)
            .await
            .unwrap(),
        None
    );
    let req = &s.requests_to("/arabic_moyassar.zip")[0];
    assert_eq!(req.method, "HEAD");
    assert_eq!(req.header("if-none-match"), Some(OLD_ETAG));
    assert_eq!(
        req.header("if-modified-since"),
        None,
        "Last-Modified is constant upstream"
    );
    assert_eq!(s.hits("/list"), 0);

    // A new file: a new ETag (dated 2026-03) and length.
    s.route(
        "/arabic_moyassar.zip",
        Route::bytes(vec![8u8; 1200]).etag(NEW_ETAG),
    );
    assert_eq!(
        check_update_from(&ctx, &muyassar("2025.03"), &row, &ep)
            .await
            .unwrap()
            .as_deref(),
        Some("2026.03")
    );
    // A new length without an ETag is an update too (the version then falls back to the catalog's).
    s.route("/arabic_moyassar.zip", Route::bytes(vec![8u8; 1200]));
    assert_eq!(
        check_update_from(&ctx, &muyassar("2026.10"), &row, &ep)
            .await
            .unwrap()
            .as_deref(),
        Some("2026.10")
    );
    // The same ETag and length served without honouring If-None-Match: no update.
    s.route(
        "/arabic_moyassar.zip",
        Route::bytes(body).etag(&format!("W/{OLD_ETAG}")),
    );
    assert_eq!(
        check_update_from(&ctx, &muyassar("2025.03"), &row, &ep)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn an_update_within_the_month_gets_a_day_version() {
    let s = TestServer::start();
    s.route(
        "/arabic_moyassar.zip",
        Route::bytes(vec![1u8; 10]).etag(OLD_ETAG),
    );
    let env = TestEnv::new();
    let ctx = env.ctx("tafsir.ar.muyassar", PackKind::Tafsir, None, false);
    let row = installed(
        "tafsir.ar.muyassar",
        PackKind::Tafsir,
        "2025.03",
        Some(validators(
            "arabic_moyassar",
            Some("\"67e00000-a\""),
            Some(10),
        )),
    );
    assert_eq!(
        check_update_from(
            &ctx,
            &muyassar("2025.03"),
            &row,
            &endpoints(&s, "/arabic_moyassar.zip")
        )
        .await
        .unwrap()
        .as_deref(),
        Some("2025.03.25")
    );
}

#[tokio::test]
async fn without_stored_validators_nothing_can_be_compared() {
    let s = TestServer::start();
    let env = TestEnv::new();
    let ctx = env.ctx("tafsir.ar.muyassar", PackKind::Tafsir, None, false);
    for sv in [None, Some(validators("arabic_moyassar", None, None))] {
        let row = installed("tafsir.ar.muyassar", PackKind::Tafsir, "2025.03", sv);
        assert_eq!(
            check_update_from(
                &ctx,
                &muyassar("2025.03"),
                &row,
                &endpoints(&s, "/arabic_moyassar.zip")
            )
            .await
            .unwrap(),
            None
        );
    }
    assert!(s.requests().is_empty());
}

#[tokio::test]
async fn checks_are_offline_when_the_network_is_off() {
    let s = TestServer::start();
    s.route(
        "/list",
        Route::json(&list_json(&[("english_saheeh", "9", "Saheeh")])),
    );
    let env = TestEnv::new();
    env.http.set_network_allowed(false);
    let ctx = env.ctx("tr.en.saheeh", PackKind::Translation, None, false);
    let row = installed("tr.en.saheeh", PackKind::Translation, "1.1.2", None);
    let err = check_update_from(&ctx, &saheeh("1.1.2"), &row, &endpoints(&s, "/z.zip"))
        .await
        .unwrap_err();
    assert!(matches!(err, PackError::Offline));
    assert!(s.requests().is_empty());
}
