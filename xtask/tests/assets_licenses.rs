//! `cargo xtask licenses`: SPDX parsing, the licence policy, licence-file selection, recognising licence texts
//! by content, the gate that every package carries its licence text, the vendored stand-ins and notices of
//! `xtask/licenses/`, text sharing, the `cargo metadata` and `pnpm licenses` readers, and the committed
//! `src/lib/about/thirdparty.json`.
//!
//! `xtask` is a binary crate, so `cli.rs`, `assets.rs` (shared file helpers) and `licenses.rs` are compiled into this
//! test crate by path.

#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[path = "../src/cli.rs"]
mod cli;

#[path = "../src/assets.rs"]
mod assets;

#[path = "../src/licenses.rs"]
mod licenses;

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use licenses::{Candidate, Ecosystem, Metadata, ThirdParty, Vendored, policy, spdx};
use serde_json::json;

// ---- SPDX expressions --------------------------------------------------------------------------------------------

fn render(text: &str) -> String {
    spdx::parse(text).unwrap().render()
}

#[test]
fn spdx_expressions_are_parsed_and_normalised() {
    assert_eq!(render("MIT/Apache-2.0"), "MIT OR Apache-2.0");
    assert_eq!(render("Apache-2.0 / MIT"), "Apache-2.0 OR MIT");
    assert_eq!(render("Unlicense/MIT"), "Unlicense OR MIT");
    assert_eq!(render("(MPL-2.0 OR Apache-2.0)"), "MPL-2.0 OR Apache-2.0");
    assert_eq!(render("mit or apache-2.0"), "MIT OR Apache-2.0");
    assert_eq!(
        render("(MIT OR Apache-2.0) AND Unicode-3.0"),
        "(MIT OR Apache-2.0) AND Unicode-3.0"
    );
    assert_eq!(
        render("Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT"),
        "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT"
    );
    assert_eq!(render("((MIT))"), "MIT");
    assert_eq!(
        render("MIT OR (Apache-2.0 OR Zlib)"),
        "MIT OR Apache-2.0 OR Zlib"
    );
    assert_eq!(render("LicenseRef-Custom"), "LicenseRef-Custom");

    // AND binds tighter than OR.
    assert_eq!(
        spdx::parse("MIT OR Apache-2.0 AND BSD-3-Clause").unwrap(),
        spdx::Expr::Or(vec![
            spdx::Expr::Id("MIT".into()),
            spdx::Expr::And(vec![
                spdx::Expr::Id("Apache-2.0".into()),
                spdx::Expr::Id("BSD-3-Clause".into()),
            ]),
        ])
    );

    for bad in [
        "",
        "   ",
        "MIT OR",
        "(MIT",
        "MIT)",
        "MIT, Apache-2.0",
        "WITH LLVM-exception",
        "MIT WITH",
        "MIT Apache-2.0",
    ] {
        assert!(spdx::parse(bad).is_err(), "{bad:?} must not parse");
    }
}

#[test]
fn spdx_alternatives_are_the_disjunctive_normal_form() {
    let alternatives = |text: &str| spdx::parse(text).unwrap().alternatives().unwrap();
    assert_eq!(alternatives("MIT"), [vec!["MIT".to_owned()]]);
    assert_eq!(
        alternatives("ISC AND (Apache-2.0 OR ISC)"),
        [
            vec!["ISC".to_owned(), "Apache-2.0".to_owned()],
            vec!["ISC".to_owned()]
        ]
    );
    assert_eq!(
        alternatives("(MIT OR Apache-2.0) AND Unicode-3.0"),
        [
            vec!["MIT".to_owned(), "Unicode-3.0".to_owned()],
            vec!["Apache-2.0".to_owned(), "Unicode-3.0".to_owned()],
        ]
    );
    assert_eq!(
        alternatives("Apache-2.0 WITH LLVM-exception OR MIT"),
        [
            vec!["Apache-2.0 WITH LLVM-exception".to_owned()],
            vec!["MIT".to_owned()]
        ]
    );
    // 2^9 alternatives is over the cap.
    let huge = (0..9)
        .map(|_| "(MIT OR Zlib)")
        .collect::<Vec<_>>()
        .join(" AND ");
    assert!(spdx::parse(&huge).unwrap().alternatives().is_err());
}

// ---- policy ------------------------------------------------------------------------------------------------------

/// The choice for a package whose files are named `files` (families by name only).
fn choose(text: &str, files: &[&str]) -> Option<Vec<String>> {
    let backed: Vec<&str> = files
        .iter()
        .flat_map(|f| policy::file_families(f))
        .collect();
    policy::choose(&spdx::parse(text).unwrap(), &backed)
}

#[test]
fn the_policy_picks_an_allowed_alternative_backed_by_a_shipped_file() {
    let one = |id: &str| Some(vec![id.to_owned()]);
    assert_eq!(
        choose("MIT OR Apache-2.0", &["LICENSE-APACHE", "LICENSE-MIT"]),
        one("MIT")
    );
    assert_eq!(
        choose("Apache-2.0 OR MIT", &["LICENSE-APACHE", "LICENSE-MIT"]),
        one("MIT")
    );
    assert_eq!(
        choose("MIT OR Apache-2.0", &["LICENSE-APACHE"]),
        one("Apache-2.0")
    );
    assert_eq!(choose("MIT OR Apache-2.0", &["LICENSE"]), one("MIT"));
    assert_eq!(choose("MIT OR Apache-2.0", &[]), one("MIT"));
    assert_eq!(
        choose("Unlicense OR MIT", &["COPYING", "LICENSE-MIT", "UNLICENSE"]),
        one("MIT")
    );
    assert_eq!(
        choose(
            "Zlib OR Apache-2.0 OR MIT",
            &["LICENSE-ZLIB.md", "LICENSE-MIT.md"]
        ),
        one("MIT")
    );
    assert_eq!(
        choose("MIT OR Apache-2.0 OR LGPL-2.1-or-later", &[]),
        one("MIT")
    );
    assert_eq!(
        choose("Apache-2.0 WITH LLVM-exception", &[]),
        one("Apache-2.0 WITH LLVM-exception")
    );
    assert_eq!(
        choose(
            "(MIT OR Apache-2.0) AND Unicode-3.0",
            &["LICENSE-APACHE", "LICENSE-MIT", "LICENSE-UNICODE"]
        ),
        Some(vec!["MIT".to_owned(), "Unicode-3.0".to_owned()])
    );
    assert_eq!(choose("MPL-2.0", &["LICENSE"]), one("MPL-2.0"));
    assert_eq!(choose("OFL-1.1", &["LICENSE"]), one("OFL-1.1"));
    // Families recognised in a generic file's text count like named files.
    let expr = spdx::parse("BSD-3-Clause OR MIT").unwrap();
    assert_eq!(
        policy::choose(&expr, &[]),
        one("MIT"),
        "nothing backed: preference"
    );
    assert_eq!(policy::choose(&expr, &["bsd"]), one("BSD-3-Clause"));

    // Refused: copyleft without an alternative, unknown ids.
    assert_eq!(choose("GPL-3.0-only", &[]), None);
    assert_eq!(choose("GPL-2.0 AND MIT", &[]), None);
    assert_eq!(choose("AGPL-3.0-or-later OR GPL-3.0", &[]), None);
    assert_eq!(choose("LicenseRef-Proprietary", &[]), None);
    assert_eq!(choose("SSPL-1.0", &[]), None);
    // The app is GPL-3.0-or-later: the OpenSSL licence's advertising clause is incompatible.
    assert_eq!(choose("OpenSSL", &[]), None);
    assert_eq!(choose("ISC AND OpenSSL", &[]), None);
    assert_eq!(choose("OpenSSL OR MIT", &[]), one("MIT"));
}

#[test]
fn licence_files_map_to_families() {
    assert_eq!(policy::file_families("LICENSE-MIT"), ["mit"]);
    assert_eq!(policy::file_families("license-apache-2.0"), ["apache"]);
    assert_eq!(
        policy::file_families("LICENSE-Apache-2.0_WITH_LLVM-exception"),
        ["apache"]
    );
    assert_eq!(policy::file_families("UNLICENSE"), ["unlicense"]);
    assert_eq!(policy::file_families("LICENSE.ZLIB"), ["zlib"]);
    assert!(policy::file_families("LICENSE").is_empty());
    assert!(policy::file_families("COPYRIGHT").is_empty());
    assert!(policy::file_families("LICENSE-THIRD-PARTY").is_empty());
    assert!(
        policy::file_families("LIMITS").is_empty(),
        "no partial-token matches"
    );
    assert_eq!(policy::family("MIT-0"), Some("mit"));
    assert_eq!(
        policy::family("Apache-2.0 WITH LLVM-exception"),
        Some("apache")
    );
    assert_eq!(policy::family("Unicode-3.0"), Some("unicode"));
    assert_eq!(
        policy::family("CDLA-Permissive-2.0"),
        Some("cdla-permissive")
    );
    assert_eq!(
        policy::family("0BSD"),
        Some("0bsd"),
        "not BSD: no conditions"
    );
    assert_eq!(policy::file_families("LICENSE-0BSD"), ["0bsd"]);
    assert_eq!(policy::family("GPL-3.0-only"), None);
    assert!(policy::ALLOWED.iter().all(|id| policy::KNOWN.contains(id)));
    assert!(
        policy::ALLOWED
            .iter()
            .all(|id| policy::family(id).is_some()),
        "every allowed licence's text can be checked"
    );
}

fn families(text: &str) -> Vec<&'static str> {
    policy::text_families(text).into_iter().collect()
}

#[test]
fn licence_texts_are_recognised_by_their_wording_not_their_name() {
    assert_eq!(families(MIT_BODY), ["mit"]);
    assert_eq!(families(&rewrapped(MIT_BODY)), ["mit"], "line breaks");
    assert_eq!(
        families(
            "Copyright © 2020-2024 Unicode, Inc.\n\nPermission is hereby granted, free of charge, to any person \
             obtaining a\ncopy of data files and any associated documentation (the “Data Files”) or software"
        ),
        ["unicode"],
        "Unicode's grant is not MIT's"
    );
    assert_eq!(
        families(
            "Apache License\nVersion 2.0, January 2004\n\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND \
             DISTRIBUTION\n\n1. Definitions."
        ),
        ["apache"]
    );
    assert!(
        families(
            "Licensed under the Apache License, Version 2.0 (the \"License\"); you may not use this file except in \
             compliance with the License."
        )
        .is_empty(),
        "a header that names Apache-2.0 is not its text"
    );
    let bsd = "Redistribution and use in source and binary forms, with or without\nmodification, are permitted \
               provided that the following conditions are met:";
    assert_eq!(families(bsd), ["bsd"]);
    assert_eq!(
        families(
            "// Copyright 2015-2016 Brian Smith.\n//\n// Permission to use, copy, modify, and/or distribute this \
             software for any\n// purpose with or without fee is hereby granted, provided that the above\n// \
             copyright notice and this permission notice appear in all copies."
        ),
        ["isc"],
        "comment leaders are ignored"
    );
    assert_eq!(
        families(
            "Permission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee \
             is hereby granted.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\""
        ),
        ["0bsd"]
    );
    assert_eq!(
        families(
            "This software is provided ‘as-is’, without any express or implied warranty.\n2. Altered source \
             versions must be plainly marked as such, and must not be misrepresented"
        ),
        ["zlib"]
    );
    assert_eq!(
        families(
            "Mozilla Public License Version 2.0\n==================================\n\n1.1. \"Contributor\"\n    \
             means each individual or legal entity that creates, contributes to\n    the creation of, or owns \
             Covered Software."
        ),
        ["mpl"]
    );
    assert!(
        families(
            "This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the \
             MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/."
        )
        .is_empty(),
        "MPL's Exhibit A notice is not its text"
    );
    assert_eq!(
        families(
            "SIL OPEN FONT LICENSE Version 1.1\n\nPermission is hereby granted, free of charge, to any person \
             obtaining a copy of the Font Software"
        ),
        ["ofl"]
    );
    assert_eq!(
        families(
            "Creative Commons Legal Code\n\nCC0 1.0 Universal\n\n    CREATIVE COMMONS CORPORATION"
        ),
        ["cc0"]
    );
    assert_eq!(
        families("This is free and unencumbered software released into the public domain."),
        ["unlicense"]
    );
    assert_eq!(
        families(
            "Boost Software License - Version 1.0 - August 17th, 2003\n\nPermission is hereby granted, free of \
             charge, to any person or organization\nobtaining a copy of the software"
        ),
        ["boost"]
    );
    // Both licences in one file (a dual-licence LICENSE).
    assert_eq!(families(&format!("{bsd}\n\n{MIT_BODY}")), ["bsd", "mit"]);
    // Metadata and pointers are not licence texts.
    for not_a_licence in [
        "SPDXVersion: SPDX-2.1\nDataLicense: CC0-1.0\nPackageName: tauri\nPackageLicenseDeclared: MIT",
        "# License\n\nThe crates are licensed under [the MIT license][MIT].\n\n[MIT]: https://opensource.org/license/MIT",
        "Copyright (c) 2009, 2010, 2013-2016 by the Brotli Authors.",
        "",
    ] {
        assert!(families(not_a_licence).is_empty(), "{not_a_licence:?}");
    }
}

// ---- text helpers ------------------------------------------------------------------------------------------------

const MIT_BODY: &str = "Permission is hereby granted, free of charge, to any person obtaining a copy of this \
software and associated documentation files (the \"Software\"), to deal in the Software without restriction.\n\n\
THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND.";

/// The same body, wrapped differently.
fn rewrapped(text: &str) -> String {
    text.split(' ')
        .enumerate()
        .map(|(i, w)| {
            if i % 7 == 6 {
                format!("{w}\n")
            } else {
                format!("{w} ")
            }
        })
        .collect::<String>()
        .replace(" \n", "\n")
        .replace("\n\n\n", "\n\n")
}

#[test]
fn texts_are_normalised_and_split_into_shareable_segments() {
    assert_eq!(
        licenses::normalise_text("\u{FEFF}\r\n\r\n  Title  \r\n\r\nBody\ttext \rmore\n\n\n"),
        "  Title\n\nBody\ttext\nmore"
    );
    assert_eq!(licenses::normalise_text(" \n\t\n"), "");

    let mit = format!("MIT License\n\nCopyright (c) 2020 Someone\n\n{MIT_BODY}");
    assert_eq!(
        licenses::segments(&mit),
        [
            "MIT License\n\nCopyright (c) 2020 Someone".to_owned(),
            MIT_BODY.to_owned()
        ]
    );
    assert_eq!(
        licenses::segments(MIT_BODY),
        [MIT_BODY.to_owned()],
        "nothing before the grant"
    );

    let apache = "Apache License\n\nTERMS AND CONDITIONS\n\n1. Definitions.\n\nEND OF TERMS AND CONDITIONS\n\n\
                  APPENDIX: How to apply the Apache License to your work.\n\nCopyright [yyyy] [name]";
    assert_eq!(
        licenses::segments(apache),
        [
            "Apache License\n\nTERMS AND CONDITIONS\n\n1. Definitions.\n\nEND OF TERMS AND CONDITIONS".to_owned(),
            "APPENDIX: How to apply the Apache License to your work.\n\nCopyright [yyyy] [name]".to_owned(),
        ]
    );
    let ofl = "Copyright 2016 The Inter Project Authors\n\nThis Font Software is licensed under the SIL Open Font \
               License, Version 1.1.\n\n\n-----\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----\n\n\
               PREAMBLE";
    assert_eq!(
        licenses::segments(ofl),
        [
            "Copyright 2016 The Inter Project Authors\n\nThis Font Software is licensed under the SIL Open Font \
             License, Version 1.1."
                .to_owned(),
            "-----\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----\n\nPREAMBLE".to_owned(),
        ]
    );
    assert_eq!(licenses::segments(""), Vec::<String>::new());
}

#[test]
fn urls_authors_and_versions_are_cleaned() {
    let url = |u: &str| licenses::clean_url(Some(u));
    assert_eq!(
        url("https://github.com/a/b"),
        Some("https://github.com/a/b".into())
    );
    assert_eq!(
        url("git+https://github.com/a/b.git"),
        Some("https://github.com/a/b".into())
    );
    assert_eq!(
        url("git://github.com/a/b.git"),
        Some("https://github.com/a/b".into())
    );
    assert_eq!(
        url("git@github.com:a/b.git"),
        Some("https://github.com/a/b".into())
    );
    assert_eq!(
        url("ssh://git@github.com/a/b"),
        Some("https://github.com/a/b".into())
    );
    assert_eq!(
        url("http://github.com/a/b/"),
        Some("https://github.com/a/b".into())
    );
    assert_eq!(
        url("http://example.org/x"),
        Some("http://example.org/x".into())
    );
    assert_eq!(
        url("https://floating-ui.com"),
        Some("https://floating-ui.com".into())
    );
    assert_eq!(url("ftp://example.org"), None);
    assert_eq!(url("javascript:alert(1)"), None);
    assert_eq!(url("https://"), None);
    assert_eq!(url("https://exa mple.org"), None);
    assert_eq!(licenses::clean_url(None), None);
    assert_eq!(
        licenses::registry_url(Ecosystem::Npm, "@scope/pkg"),
        "https://www.npmjs.com/package/@scope/pkg"
    );
    assert_eq!(
        licenses::registry_url(Ecosystem::Cargo, "serde"),
        "https://crates.io/crates/serde"
    );

    let authors: Vec<String> = [
        "Jane Doe <jane@example.com>",
        "Joe (https://joe.dev)",
        "Jane Doe",
        "  ",
        "<only@mail.example>",
        "bare@mail.example",
        "The   Project   Developers",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(
        licenses::clean_authors(&authors),
        ["Jane Doe", "Joe", "The Project Developers"]
    );

    let mut versions = vec![
        "0.10.0",
        "0.9.3",
        "1.0.0-rc.25",
        "1.0.0",
        "0.9.10",
        "2.0.0-rc.3",
    ];
    versions.sort_by(|a, b| licenses::compare_versions(a, b));
    assert_eq!(
        versions,
        [
            "0.9.3",
            "0.9.10",
            "0.10.0",
            "1.0.0",
            "1.0.0-rc.25",
            "2.0.0-rc.3"
        ]
    );
    assert_eq!(licenses::compare_versions("1.2", "1.2"), Ordering::Equal);
}

// ---- assembling ----------------------------------------------------------------------------------------------------

fn package_dir(root: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    for (file, text) in files {
        let path = dir.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    dir
}

const ZLIB: &str = "Copyright (c) 2024 Someone\n\nThis software is provided 'as-is', without any express or implied \
                    warranty.\n\n2. Altered source versions must be plainly marked as such, and must not be \
                    misrepresented as being the original software.";

const SDK_NOTICE: &str = "Copyright (C) SDK Corp.\n\nRedistribution and use in source and binary forms, with or \
                          without modification, are permitted provided that the conditions are met.";

/// A vendored `source.toml`: `files` are `(name, kind, heading)`.
fn source_toml(versions: &[&str], files: &[(&str, &str, Option<&str>)]) -> String {
    let mut toml = format!("versions = {versions:?}\n");
    for (name, kind, heading) in files {
        toml.push_str(&format!(
            "\n[[file]]\nname = {name:?}\nkind = {kind:?}\nsource = \"https://example.com/{name}\"\n"
        ));
        if let Some(heading) = heading {
            toml.push_str(&format!("heading = {heading:?}\n"));
        }
    }
    toml
}

fn candidate(
    ecosystem: Ecosystem,
    name: &str,
    version: &str,
    licence: Option<&str>,
    dir: Option<PathBuf>,
) -> Candidate {
    Candidate {
        ecosystem,
        name: name.to_owned(),
        version: version.to_owned(),
        licence: licence.map(str::to_owned),
        url: Some(format!("git+https://github.com/example/{name}.git")),
        authors: vec![format!("{name} authors <team@example.com>")],
        dir,
        licence_file: None,
    }
}

/// A package's full licence text: its segments joined by a blank line.
fn text_of(notices: &ThirdParty, package: &licenses::Package) -> String {
    package
        .texts
        .iter()
        .map(|i| notices.texts.get(*i).expect("a valid text index").as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn assembling_checks_the_policy_selects_files_and_shares_texts() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let apache = "Apache License\n\nTERMS AND CONDITIONS\n\nEND OF TERMS AND CONDITIONS";
    let b_mit = format!("MIT License\n\nCopyright (c) 2019 B\n\n{MIT_BODY}");
    let a_mit = format!(
        "Copyright (c) 2018 A\r\n\r\n{}",
        rewrapped(MIT_BODY).replace('\n', "\r\n")
    );
    let b = package_dir(
        root,
        "b",
        &[
            ("LICENSE-MIT", &b_mit),
            ("LICENSE-APACHE", apache),
            ("lib.rs", "// code"),
        ],
    );
    let a9 = package_dir(
        root,
        "a9",
        &[("LICENSE-MIT", &a_mit), ("COPYRIGHT", "Parts (c) C.")],
    );
    let a10 = package_dir(
        root,
        "a10",
        &[("LICENSES/MIT.txt", &a_mit), ("license.json", "{}")],
    );
    let npm = package_dir(root, "npm", &[("LICENSE", &b_mit), ("package.json", "{}")]);
    // `nofile` publishes no licence text: a reviewed stand-in and a bundled-component notice fill in.
    package_dir(
        root,
        "vendored/cargo/nofile",
        &[
            (
                "source.toml",
                &source_toml(
                    &["2.0.0"],
                    &[
                        ("LICENSE", "licence", None),
                        ("SDK.txt", "notice", Some("The SDK it bundles.")),
                    ],
                ),
            ),
            ("LICENSE", ZLIB),
            ("SDK.txt", SDK_NOTICE),
        ],
    );
    let vendored = Vendored::load(&root.join("vendored"), "xtask/licenses").unwrap();

    let mut packages = vec![
        candidate(
            Ecosystem::Npm,
            "@scope/pkg",
            "1.0.0",
            Some("(MIT)"),
            Some(npm),
        ),
        candidate(
            Ecosystem::Cargo,
            "b-crate",
            "1.0.0",
            Some("MIT OR Apache-2.0"),
            Some(b),
        ),
        candidate(
            Ecosystem::Cargo,
            "A-crate",
            "0.10.0",
            Some("MIT/Apache-2.0"),
            Some(a10),
        ),
        candidate(
            Ecosystem::Cargo,
            "A-crate",
            "0.9.0",
            Some("MIT/Apache-2.0"),
            Some(a9),
        ),
        candidate(Ecosystem::Cargo, "nofile", "2.0.0", Some("Zlib"), None),
    ];
    if let Some(last) = packages.last_mut() {
        last.url = Some("not a url".into());
    }
    let notices = licenses::assemble(packages, &vendored).unwrap();

    let order: Vec<(Ecosystem, &str, &str)> = notices
        .packages
        .iter()
        .map(|p| (p.ecosystem, p.name.as_str(), p.version.as_str()))
        .collect();
    assert_eq!(
        order,
        [
            (Ecosystem::Cargo, "A-crate", "0.9.0"),
            (Ecosystem::Cargo, "A-crate", "0.10.0"),
            (Ecosystem::Cargo, "b-crate", "1.0.0"),
            (Ecosystem::Cargo, "nofile", "2.0.0"),
            (Ecosystem::Npm, "@scope/pkg", "1.0.0"),
        ]
    );
    let by_name = |name: &str, version: &str| {
        notices
            .packages
            .iter()
            .find(|p| p.name == name && p.version == version)
            .unwrap()
    };

    let b = by_name("b-crate", "1.0.0");
    assert_eq!(
        (b.licence.as_str(), b.used.as_str()),
        ("MIT OR Apache-2.0", "MIT")
    );
    assert_eq!(b.url, "https://github.com/example/b-crate");
    assert_eq!(b.authors, ["b-crate authors"]);
    // Only LICENSE-MIT; its body is the shared (first-seen, re-wrapped) copy, equal up to line breaks.
    assert_eq!(collapse(&text_of(&notices, b)), collapse(&b_mit));
    assert!(text_of(&notices, b).starts_with("MIT License\n\nCopyright (c) 2019 B\n\nPermission"));

    let a9 = by_name("A-crate", "0.9.0");
    assert_eq!(a9.licence, "MIT OR Apache-2.0");
    // COPYRIGHT (generic) sorts before LICENSE-MIT; the re-wrapped MIT body is shared with b-crate's.
    assert_eq!(a9.texts.len(), 3);
    assert_eq!(a9.texts.last(), b.texts.last(), "one shared MIT body");
    assert_eq!(
        collapse(&text_of(&notices, a9)),
        collapse(&format!("Parts (c) C. {a_mit}"))
    );
    let a10 = by_name("A-crate", "0.10.0");
    assert_eq!(
        collapse(&text_of(&notices, a10)),
        collapse(&a_mit),
        "LICENSES/ is read; license.json is not"
    );

    let nofile = by_name("nofile", "2.0.0");
    assert_eq!(nofile.used, "Zlib");
    assert_eq!(
        text_of(&notices, nofile),
        format!("{ZLIB}\n\nThe SDK it bundles.\n\n{SDK_NOTICE}"),
        "the stand-in, then the notice with its heading"
    );
    assert_eq!(
        nofile.url, "https://crates.io/crates/nofile",
        "an unusable URL falls back to the registry"
    );

    let npm = by_name("@scope/pkg", "1.0.0");
    assert_eq!((npm.licence.as_str(), npm.used.as_str()), ("MIT", "MIT"));
    assert_eq!(npm.texts, b.texts, "identical files are stored once");

    // Every text is used, and stored once.
    let mut used: Vec<usize> = notices
        .packages
        .iter()
        .flat_map(|p| p.texts.clone())
        .collect();
    used.sort_unstable();
    used.dedup();
    assert_eq!(used, (0..notices.texts.len()).collect::<Vec<_>>());
    assert!(
        !notices.texts.iter().any(|t| t.contains("Apache License")),
        "the unused alternative is dropped"
    );

    // Rendering: one item per line, round-trips, trailing newline.
    let json = notices.render().unwrap();
    assert!(json.ends_with("\n}\n"));
    assert_eq!(
        json.lines().count(),
        2 + notices.packages.len() + 2 + notices.texts.len() + 2
    );
    let parsed: ThirdParty = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, notices);
    assert_eq!(
        ThirdParty::default().render().unwrap(),
        "{\n  \"packages\": [],\n  \"texts\": []\n}\n"
    );
    let parsed_empty: ThirdParty =
        serde_json::from_str(&ThirdParty::default().render().unwrap()).unwrap();
    assert_eq!(parsed_empty, ThirdParty::default());
}

#[test]
fn every_policy_violation_is_reported_at_once() {
    let tmp = tempfile::tempdir().unwrap();
    let isc = "Copyright (c) Fine\n\nPermission to use, copy, modify, and/or distribute this software for any purpose \
               with or without fee is hereby granted, provided that the above copyright notice and this permission \
               notice appear in all copies.";
    let fine = package_dir(tmp.path(), "fine", &[("LICENSE", isc)]);
    let message = licenses::assemble(
        vec![
            candidate(Ecosystem::Cargo, "gpl", "1.0.0", Some("GPL-3.0-only"), None),
            candidate(Ecosystem::Cargo, "nolicence", "1.0.0", None, None),
            candidate(
                Ecosystem::Npm,
                "weird",
                "1.0.0",
                Some("SEE LICENSE IN LICENSE.txt"),
                None,
            ),
            candidate(Ecosystem::Npm, "fine", "1.0.0", Some("ISC"), Some(fine)),
        ],
        &Vendored::default(),
    )
    .map(|_| ())
    .unwrap_err()
    .to_string();
    assert!(message.contains("3 problem(s)"), "{message}");
    assert!(
        message.contains("crate gpl@1.0.0: licence GPL-3.0-only is not satisfiable"),
        "{message}"
    );
    assert!(
        message.contains("crate nolicence@1.0.0: declares no licence"),
        "{message}"
    );
    assert!(message.contains("npm weird@1.0.0"), "{message}");
    assert!(!message.contains("fine"), "{message}");
}

/// A test package: ecosystem, name, version, declared licence, and its files as `(name, text)` (none: no directory).
type PackageSpec<'a> = (
    Ecosystem,
    &'a str,
    &'a str,
    &'a str,
    &'a [(&'a str, &'a str)],
);

/// Files to write: `(name, text)`.
type FileList = Vec<(&'static str, String)>;

/// The `packages` as candidates in `root`, assembled with the vendored tree at `root/vendored`.
fn assemble_in(root: &Path, packages: &[PackageSpec<'_>]) -> anyhow::Result<ThirdParty> {
    let candidates = packages
        .iter()
        .map(|(ecosystem, name, version, licence, files)| {
            let dir = (!files.is_empty())
                .then(|| package_dir(root, &format!("pkg-{}", name.replace('/', "+")), files));
            candidate(*ecosystem, name, version, Some(*licence), dir)
        })
        .collect();
    licenses::assemble(
        candidates,
        &Vendored::load(&root.join("vendored"), "xtask/licenses")?,
    )
}

#[test]
fn every_package_must_carry_the_text_of_its_licence() {
    let spdx_doc = "SPDXVersion: SPDX-2.1\nDataLicense: CC0-1.0\nPackageName: tauri\nPackageLicenseDeclared: MIT\n\
                    PackageCopyrightText: 2019-2022, The Tauri Programme in the Commons Conservancy";
    let bsd = "Copyright (c) 2016 Dropbox, Inc.\n\nRedistribution and use in source and binary forms, with or without \
               modification, are permitted provided that the following conditions are met:";
    let cc0 = "Creative Commons Legal Code\n\nCC0 1.0 Universal\n\n    CREATIVE COMMONS CORPORATION IS NOT A LAW FIRM";
    let apache_header = "Licensed under the Apache License, Version 2.0 (the \"License\").";
    let tmp = tempfile::tempdir().unwrap();
    let packages: &[PackageSpec<'_>] = &[
        // Only SPDX metadata (the npm @tauri-apps plugins), nothing at all, a header that only names the licence.
        (
            Ecosystem::Npm,
            "@tauri-apps/plugin-x",
            "2.0.0",
            "MIT OR Apache-2.0",
            &[("LICENSE.spdx", spdx_doc)],
        ),
        (Ecosystem::Cargo, "bare", "0.1.0", "MIT", &[]),
        (
            Ecosystem::Cargo,
            "header-only",
            "1.0.0",
            "Apache-2.0",
            &[("LICENSE", apache_header)],
        ),
        // A generic LICENSE backs the alternative it contains, not the preferred one.
        (
            Ecosystem::Cargo,
            "brotli-like",
            "6.0.1",
            "BSD-3-Clause OR MIT",
            &[("LICENSE", bsd)],
        ),
        (
            Ecosystem::Cargo,
            "dunce-like",
            "1.0.5",
            "CC0-1.0 OR MIT-0 OR Apache-2.0",
            &[("LICENSE", cc0)],
        ),
    ];
    let message = assemble_in(tmp.path(), packages).unwrap_err().to_string();
    assert!(message.contains("3 problem(s)"), "{message}");
    assert!(
        message.contains(
            "npm @tauri-apps/plugin-x@2.0.0: no MIT licence text among its files (LICENSE.spdx); add the upstream \
             licence file at this version to xtask/licenses/npm/@tauri-apps/plugin-x/"
        ),
        "{message}"
    );
    assert!(
        message.contains("crate bare@0.1.0: no MIT licence text among its files (it ships none)"),
        "{message}"
    );
    assert!(
        message.contains("crate header-only@1.0.0: no Apache-2.0 licence text"),
        "{message}"
    );
    assert!(
        !message.contains("brotli-like") && !message.contains("dunce-like"),
        "{message}"
    );

    // Reviewed stand-ins fill the gaps. The package's own generic files are kept: a header stays first, an SPDX document
    // comes last (it carries a copyright line, but a reader should meet the licence first).
    let mit = format!(
        "MIT License\n\nCopyright (c) 2017 - Present Tauri Apps Contributors\n\n{MIT_BODY}"
    );
    let apache = "Apache License\n\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n1. Definitions.";
    for (dir, version, file, text) in [
        (
            "npm/@tauri-apps/plugin-x",
            "2.0.0",
            "LICENSE_MIT",
            mit.as_str(),
        ),
        ("cargo/bare", "0.1.0", "LICENSE-MIT", mit.as_str()),
        ("cargo/header-only", "1.0.0", "LICENSE.txt", apache),
    ] {
        package_dir(
            tmp.path(),
            &format!("vendored/{dir}"),
            &[
                (
                    "source.toml",
                    &source_toml(&[version], &[(file, "licence", None)]),
                ),
                (file, text),
            ],
        );
    }
    let notices = assemble_in(tmp.path(), packages).unwrap();
    let find = |name: &str| notices.packages.iter().find(|p| p.name == name).unwrap();
    let plugin = find("@tauri-apps/plugin-x");
    assert_eq!(plugin.used, "MIT");
    assert_eq!(
        collapse(&text_of(&notices, plugin)),
        collapse(&format!("{mit}\n\n{spdx_doc}"))
    );
    assert_eq!(collapse(&text_of(&notices, find("bare"))), collapse(&mit));
    assert_eq!(
        collapse(&text_of(&notices, find("header-only"))),
        collapse(&format!("{apache_header}\n\n{apache}"))
    );
    assert_eq!(find("brotli-like").used, "BSD-3-Clause");
    assert_eq!(find("dunce-like").used, "CC0-1.0");
    for package in &notices.packages {
        assert!(!package.texts.is_empty(), "{}", package.name);
    }
}

#[test]
fn vendored_entries_are_validated_and_stale_ones_fail() {
    let mit_file = format!("MIT License\n\nCopyright (c) X\n\n{MIT_BODY}");
    let ok_entry = |tmp: &Path, dir: &str, versions: &[&str]| {
        package_dir(
            tmp,
            &format!("vendored/{dir}"),
            &[
                (
                    "source.toml",
                    &source_toml(versions, &[("LICENSE", "licence", None)]),
                ),
                ("LICENSE", mit_file.as_str()),
            ],
        );
    };
    let own_mit: &[(&str, &str)] = &[("LICENSE", MIT_BODY)];
    let packages: &[PackageSpec<'_>] = &[
        (Ecosystem::Cargo, "bumped", "1.1.0", "MIT", &[]),
        (Ecosystem::Cargo, "fixed-upstream", "2.0.0", "MIT", own_mit),
        (Ecosystem::Cargo, "two", "1.0.0", "MIT", &[]),
    ];
    let tmp = tempfile::tempdir().unwrap();
    ok_entry(tmp.path(), "cargo/bumped", &["1.0.0"]);
    ok_entry(tmp.path(), "cargo/fixed-upstream", &["2.0.0"]);
    ok_entry(tmp.path(), "cargo/two", &["1.0.0", "0.9.0"]);
    ok_entry(tmp.path(), "cargo/removed", &["3.0.0"]);
    let message = assemble_in(tmp.path(), packages).unwrap_err().to_string();
    for expected in [
        "crate bumped@1.1.0: xtask/licenses/cargo/bumped/ was reviewed for 1.0.0 only; check the upstream licence at \
         1.1.0",
        "xtask/licenses/cargo/bumped/source.toml: bumped@1.0.0 is not shipped any more",
        "crate fixed-upstream@2.0.0: ships the text of MIT itself now; delete the `licence` files from \
         xtask/licenses/cargo/fixed-upstream/",
        "xtask/licenses/cargo/two/source.toml: two@0.9.0 is not shipped any more; remove it from `versions`",
        "xtask/licenses/cargo/removed/: crate removed is not shipped any more; delete the directory",
    ] {
        assert!(message.contains(expected), "{expected}\n---\n{message}");
    }
    assert!(message.contains("5 problem(s)"), "{message}");

    // Malformed directories are refused when they are read.
    let malformed: [(&str, FileList, &str); 6] = [
        (
            "no-manifest",
            vec![("LICENSE", mit_file.clone())],
            "read source.toml",
        ),
        (
            "undeclared",
            vec![
                (
                    "source.toml",
                    source_toml(&["1.0.0"], &[("LICENSE", "licence", None)]),
                ),
                ("LICENSE", mit_file.clone()),
                ("NOTES.txt", "x".into()),
            ],
            "NOTES.txt: not declared in source.toml",
        ),
        (
            "missing-file",
            vec![(
                "source.toml",
                source_toml(&["1.0.0"], &[("LICENSE", "licence", None)]),
            )],
            "LICENSE: read",
        ),
        (
            "empty-file",
            vec![
                (
                    "source.toml",
                    source_toml(&["1.0.0"], &[("LICENSE", "licence", None)]),
                ),
                ("LICENSE", "  \n".into()),
            ],
            "LICENSE: empty",
        ),
        (
            "bad-kind",
            vec![
                (
                    "source.toml",
                    source_toml(&["1.0.0"], &[("LICENSE", "readme", None)]),
                ),
                ("LICENSE", mit_file.clone()),
            ],
            "source.toml",
        ),
        (
            "no-versions",
            vec![
                (
                    "source.toml",
                    source_toml(&[], &[("LICENSE", "licence", None)]),
                ),
                ("LICENSE", mit_file.clone()),
            ],
            "`versions` must list the reviewed versions",
        ),
    ];
    for (name, files, expected) in malformed {
        let tmp = tempfile::tempdir().unwrap();
        let files: Vec<(&str, &str)> = files.iter().map(|(n, t)| (*n, t.as_str())).collect();
        package_dir(tmp.path(), &format!("vendored/cargo/{name}"), &files);
        let err = Vendored::load(&tmp.path().join("vendored"), "xtask/licenses").unwrap_err();
        let chain = format!("{err:#}");
        assert!(
            chain.contains(&format!("xtask/licenses/cargo/{name}")) && chain.contains(expected),
            "{name}: {chain}"
        );
    }
    let tmp = tempfile::tempdir().unwrap();
    package_dir(tmp.path(), "vendored/cargo", &[("stray.txt", "x")]);
    assert!(Vendored::load(&tmp.path().join("vendored"), "xtask/licenses").is_err());
    assert_eq!(
        Vendored::load(&tmp.path().join("absent"), "xtask/licenses")
            .unwrap()
            .entries()
            .count(),
        0
    );
}

// ---- the tool readers ----------------------------------------------------------------------------------------------

#[test]
fn cargo_metadata_yields_the_normal_closure_of_the_app_without_workspace_crates() {
    let tmp = tempfile::tempdir().unwrap();
    let manifest = |name: &str| {
        tmp.path()
            .join(name)
            .join("Cargo.toml")
            .to_string_lossy()
            .into_owned()
    };
    let package = |name: &str, source: Option<&str>| {
        json!({
            "name": name, "version": "1.0.0", "id": format!("{name} 1.0.0"), "license": "MIT",
            "license_file": null, "source": source, "manifest_path": manifest(name),
            "authors": ["Someone <s@example.com>"], "repository": null, "homepage": format!("https://{name}.example"),
        })
    };
    let registry = Some("registry+https://github.com/rust-lang/crates.io-index");
    let normal = |pkg: &str| json!({ "pkg": format!("{pkg} 1.0.0"), "dep_kinds": [{ "kind": null, "target": null }] });
    let kind = |pkg: &str, kind: &str| json!({ "pkg": format!("{pkg} 1.0.0"), "dep_kinds": [{ "kind": kind }] });
    let node = |name: &str, deps: Vec<serde_json::Value>| json!({ "id": format!("{name} 1.0.0"), "deps": deps });
    let mut licensed = package("licensed", registry);
    licensed["license"] = serde_json::Value::Null;
    licensed["license_file"] = json!("COPYING.custom");
    let metadata: Metadata = serde_json::from_value(json!({
        "packages": [
            package("quran-desktop", None),
            package("quran-core", None),
            package("serde", registry),
            package("serde_derive", registry),
            package("tauri-build", registry),
            package("tempfile", registry),
            package("both", registry),
            licensed,
            package("unreached", registry),
        ],
        "resolve": { "nodes": [
            node("quran-desktop", vec![normal("quran-core"), kind("tauri-build", "build"), kind("tempfile", "dev"), normal("both")]),
            node("quran-core", vec![normal("serde"), kind("tempfile", "dev")]),
            node("serde", vec![normal("serde_derive")]),
            node("serde_derive", vec![]),
            node("tauri-build", vec![]),
            node("tempfile", vec![]),
            node("both", vec![json!({ "pkg": "licensed 1.0.0", "dep_kinds": [{ "kind": "build" }, { "kind": null }] })]),
            node("licensed", vec![]),
            node("unreached", vec![]),
        ]},
        "workspace_members": [],
    }))
    .unwrap();

    let candidates = licenses::cargo_packages(&metadata, "quran-desktop").unwrap();
    let mut names: Vec<&str> = candidates.iter().map(|c| c.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["both", "licensed", "serde", "serde_derive"]);
    let serde = candidates.iter().find(|c| c.name == "serde").unwrap();
    assert_eq!(serde.ecosystem, Ecosystem::Cargo);
    assert_eq!(serde.url.as_deref(), Some("https://serde.example"));
    assert_eq!(
        serde.dir.as_deref(),
        Some(tmp.path().join("serde").as_path())
    );
    let licensed = candidates.iter().find(|c| c.name == "licensed").unwrap();
    assert_eq!(licensed.licence, None);
    assert_eq!(
        licensed.licence_file.as_deref(),
        Some(tmp.path().join("licensed").join("COPYING.custom").as_path())
    );
    assert!(licenses::cargo_packages(&metadata, "missing-app").is_err());
}

#[test]
fn the_pnpm_listing_yields_one_candidate_per_installed_version() {
    let tmp = tempfile::tempdir().unwrap();
    let dir_a = package_dir(
        tmp.path(),
        "runed-0.1",
        &[(
            "package.json",
            r#"{ "repository": { "type": "git", "url": "git+https://github.com/svecosystem/runed.git" }, "author": { "name": "Hunter" } }"#,
        )],
    );
    let dir_b = package_dir(
        tmp.path(),
        "runed-0.2",
        &[("package.json", r#"{ "repository": "svecosystem/runed" }"#)],
    );
    let dir_c = package_dir(
        tmp.path(),
        "font",
        &[(
            "package.json",
            r#"{ "author": "Font Team <f@example.com>" }"#,
        )],
    );
    let listing = json!({
        "MIT": [{
            "name": "runed", "versions": ["0.1.0", "0.2.0"],
            "paths": [dir_a.to_string_lossy(), dir_b.to_string_lossy()],
            "license": "MIT", "homepage": "https://runed.dev",
        }],
        "OFL-1.1": [{
            "name": "@fontsource/font", "versions": ["5.3.0"], "paths": [dir_c.to_string_lossy()],
            "license": "OFL-1.1", "author": "ignored when package.json has one",
        }],
    });
    let mut candidates = licenses::npm_packages(&listing).unwrap();
    candidates.sort_by(|a, b| a.version.cmp(&b.version));
    assert_eq!(candidates.len(), 3);
    let find = |name: &str, version: &str| {
        candidates
            .iter()
            .find(|c| c.name == name && c.version == version)
            .unwrap()
    };
    let a = find("runed", "0.1.0");
    assert_eq!(a.ecosystem, Ecosystem::Npm);
    assert_eq!(a.licence.as_deref(), Some("MIT"));
    assert_eq!(
        a.url.as_deref(),
        Some("git+https://github.com/svecosystem/runed.git")
    );
    assert_eq!(a.authors, ["Hunter"]);
    assert_eq!(a.dir.as_deref(), Some(dir_a.as_path()));
    let b = find("runed", "0.2.0");
    assert_eq!(
        b.url.as_deref(),
        Some("https://github.com/svecosystem/runed")
    );
    assert_eq!(b.dir.as_deref(), Some(dir_b.as_path()));
    let font = find("@fontsource/font", "5.3.0");
    assert_eq!(font.authors, ["Font Team <f@example.com>"]);
    assert_eq!(
        font.url, None,
        "no repository and no homepage: the registry page is used later"
    );

    assert!(licenses::npm_packages(&json!([])).is_err());
    assert!(licenses::npm_packages(&json!({ "MIT": [{ "versions": ["1"] }] })).is_err());
}

// ---- the committed file ----------------------------------------------------------------------------------------------

#[test]
fn the_committed_thirdparty_json_is_complete_and_canonical() {
    let path = assets::rel_path(&cli::workspace_root(), licenses::OUTPUT);
    let bytes = std::fs::read(&path).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let notices: ThirdParty = serde_json::from_str(&text).unwrap();
    assert_eq!(
        notices.render().unwrap(),
        text,
        "the file is exactly what `cargo xtask licenses` renders"
    );

    let cargo = notices
        .packages
        .iter()
        .filter(|p| p.ecosystem == Ecosystem::Cargo)
        .count();
    let npm = notices
        .packages
        .iter()
        .filter(|p| p.ecosystem == Ecosystem::Npm)
        .count();
    assert!(cargo > 300, "{cargo} crates");
    assert!(npm > 20, "{npm} npm packages");
    let has = |ecosystem: Ecosystem, name: &str| {
        notices
            .packages
            .iter()
            .any(|p| p.ecosystem == ecosystem && p.name == name)
    };
    for name in [
        "tauri",
        "serde",
        "rusqlite",
        "cpal",
        "symphonia-core",
        "reqwest",
        "tokio",
    ] {
        assert!(has(Ecosystem::Cargo, name), "crate {name}");
    }
    for name in [
        "svelte",
        "bits-ui",
        "dompurify",
        "@tauri-apps/api",
        "@fontsource-variable/inter",
    ] {
        assert!(has(Ecosystem::Npm, name), "npm {name}");
    }
    for name in [
        "quran-core",
        "quran-desktop",
        "xtask",
        "tauri-build",
        "clap",
        "vite",
        "vitest",
        "eslint",
    ] {
        assert!(
            !has(Ecosystem::Cargo, name) && !has(Ecosystem::Npm, name),
            "{name} is not shipped"
        );
    }

    for pair in notices.packages.windows(2) {
        let [a, b] = pair else { continue };
        let order = a
            .ecosystem
            .cmp(&b.ecosystem)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| licenses::compare_versions(&a.version, &b.version));
        assert_eq!(
            order,
            Ordering::Less,
            "{} {} before {} {}",
            a.name,
            a.version,
            b.name,
            b.version
        );
    }
    let mut referenced = vec![false; notices.texts.len()];
    for package in &notices.packages {
        assert!(
            package.url.starts_with("https://") || package.url.starts_with("http://"),
            "{}: {}",
            package.name,
            package.url
        );
        let expr = spdx::parse(&package.licence).unwrap();
        assert_eq!(
            expr.render(),
            package.licence,
            "{}: normalised",
            package.name
        );
        assert!(
            package
                .used
                .split(" AND ")
                .all(|t| policy::rank(t).is_some()),
            "{}: {} is allowed",
            package.name,
            package.used
        );
        assert!(
            package.authors.iter().all(|a| !a.contains('@')),
            "{}: no e-mail",
            package.name
        );
        for index in &package.texts {
            *referenced.get_mut(*index).expect("a valid text index") = true;
        }
    }
    assert!(referenced.iter().all(|r| *r), "every text is referenced");
    for needle in ["C:\\", "/home/", "/Users/", "node_modules", ".cargo"] {
        assert!(!text.contains(needle), "no local path ({needle})");
    }
    let inter = notices
        .packages
        .iter()
        .find(|p| p.name == "@fontsource-variable/inter")
        .unwrap();
    assert_eq!(inter.used, "OFL-1.1");
    assert!(text_of(&notices, inter).contains("SIL OPEN FONT LICENSE"));
    let tauri = notices.packages.iter().find(|p| p.name == "tauri").unwrap();
    assert!(text_of(&notices, tauri).contains("Permission is hereby granted"));

    // The gate of `cargo xtask licenses`: every package carries the text of each licence it is used under, so About
    // never has to say that a package ships no licence file.
    for package in &notices.packages {
        assert!(
            !package.texts.is_empty(),
            "{}: no licence text",
            package.name
        );
        let contains = policy::text_families(&text_of(&notices, package));
        for term in package.used.split(" AND ") {
            let family = policy::family(term).expect("every allowed licence has a family");
            assert!(
                contains.contains(family),
                "{}@{}: no {term} text",
                package.name,
                package.version
            );
        }
    }
    let by = |name: &str| notices.packages.iter().find(|p| p.name == name).unwrap();
    // The WebView2 SDK's loader is linked into the Windows exe: its BSD-style notice travels with webview2-com-sys.
    let webview2 = text_of(&notices, by("webview2-com-sys"));
    for needle in [
        "Copyright (c) 2021 Bill Avery",
        "Microsoft WebView2 SDK 1.0.3800.47",
        "WebView2LoaderStatic.lib",
        "Copyright (C) Microsoft Corporation. All rights reserved.",
        "Redistributions in binary form must reproduce the above",
    ] {
        assert!(webview2.contains(needle), "webview2-com-sys: {needle}");
    }
    // Reviewed stand-ins for packages that publish no licence text (xtask/licenses/).
    for plugin in ["dialog", "log", "opener", "os"] {
        let text = text_of(&notices, by(&format!("@tauri-apps/plugin-{plugin}")));
        assert!(
            text.starts_with("MIT License\n\nCopyright (c) 2017 - Present Tauri Apps Contributors")
                && text.contains("Permission is hereby granted")
                && text.contains("SPDXVersion"),
            "plugin-{plugin}: the MIT text first, then LICENSE.spdx"
        );
    }
    // Wherever an SPDX metadata document is kept, the licence text comes first.
    for package in &notices.packages {
        let text = text_of(&notices, package);
        assert!(
            !text.starts_with("SPDXVersion"),
            "{}: starts with SPDX metadata",
            package.name
        );
    }
    assert!(
        text_of(&notices, by("objc2-app-kit"))
            .contains("Copyright (c) the objc2 project contributors")
    );
    assert!(text_of(&notices, by("rusqlite_migration")).contains("TERMS AND CONDITIONS FOR USE"));
    assert!(text_of(&notices, by("selectors")).contains("Mozilla Public License Version 2.0"));
    // A generic LICENSE backs the alternative it contains.
    assert_eq!(by("brotli-decompressor").used, "BSD-3-Clause");
    assert_eq!(by("dunce").used, "CC0-1.0");

    // The vendored tree is valid, and every entry belongs to a shipped package version.
    let vendored = Vendored::load(
        &assets::rel_path(&cli::workspace_root(), licenses::VENDORED),
        licenses::VENDORED,
    )
    .unwrap();
    assert!(vendored.entries().count() >= 40);
    for entry in vendored.entries() {
        for version in &entry.versions {
            assert!(
                notices
                    .packages
                    .iter()
                    .any(|p| p.name == entry.package && &p.version == version),
                "{}/: {}@{version} is not in thirdparty.json",
                entry.rel,
                entry.package
            );
        }
    }
}
