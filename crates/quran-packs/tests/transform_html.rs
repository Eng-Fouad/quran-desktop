//! The HTML policy (`quran_packs::transform::html`): allowed tags and classes, `sup[data-fn]`, verse-reference links
//! rewritten to `a[data-ref]`, `h1` → `h2`, no `style`/`href`/handlers, XSS vectors, idempotence, and the `plain` text
//! derivation.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use quran_packs::transform::html::{
    ALLOWED_CLASSES, ALLOWED_TAGS, decode_entities, escape, is_footnote_id, parse_ref, plain_text,
    sanitize,
};

/// Every tag in sanitised output is allowed, with only the allowed attributes and classes.
fn assert_policy(html: &str) {
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        let tag_end = rest[i..].find('>').map(|j| i + j).expect("tags are closed");
        let tag = &rest[i + 1..tag_end];
        rest = &rest[tag_end + 1..];
        let tag = tag.strip_prefix('/').unwrap_or(tag);
        let mut parts = tag.splitn(2, ' ');
        let name = parts.next().unwrap();
        assert!(ALLOWED_TAGS.contains(&name), "tag {name} in {html}");
        let attrs = parts.next().unwrap_or("");
        for attr in attrs.split("\" ").filter(|a| !a.is_empty()) {
            let (k, v) = attr.split_once("=\"").unwrap_or((attr, ""));
            let v = v.trim_end_matches('"');
            match (name, k) {
                ("a", "data-ref") => assert!(parse_ref(v).as_deref() == Some(v), "{v}"),
                ("sup", "data-fn") => assert!(is_footnote_id(v), "{v}"),
                (_, "class") => {
                    let allowed = ALLOWED_CLASSES
                        .iter()
                        .find(|(t, _)| *t == name)
                        .map(|(_, c)| *c)
                        .unwrap_or_else(|| panic!("class on {name} in {html}"));
                    for c in v.split(' ') {
                        assert!(allowed.contains(&c), "class {name}.{c} in {html}");
                    }
                }
                _ => panic!("attribute {k} on {name} in {html}"),
            }
        }
    }
}

fn clean(html: &str) -> String {
    let out = sanitize(html);
    assert_policy(&out);
    assert_eq!(sanitize(&out), out, "sanitising is idempotent for {html:?}");
    out
}

#[test]
fn allowed_markup_survives() {
    let html = r#"<p>One <b>two</b> <strong>three</strong> <i class="s">four</i> <em>five</em><br><sub>6</sub></p><h2>H2</h2><h3>H3</h3><h4>H4</h4><ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote><span class="arabic qpc-hafs brown">بِسْمِ</span>"#;
    assert_eq!(clean(html), html);
}

#[test]
fn everything_else_is_dropped_or_unwrapped() {
    assert_eq!(
        clean(r#"<div id="x" style="color:red" onclick="alert(1)" lang="ar" title="t">text</div>"#),
        "text"
    );
    assert_eq!(
        clean(r#"<p style="color: rgb(1, 2, 3);">x</p>"#),
        "<p>x</p>"
    );
    assert_eq!(clean("<table><tr><td>cell</td></tr></table>"), "cell");
    assert_eq!(
        clean("a<script>alert(1)</script>b<style>p{}</style>c"),
        "abc"
    );
    assert_eq!(clean("a<!-- comment -->b"), "ab");
    assert_eq!(clean(r#"<font color="red">red</font>"#), "red");
    assert_eq!(clean("<h5>five</h5><h6>six</h6>"), "fivesix");
    assert_eq!(clean(r#"<span class="blue">b</span>"#), "<span>b</span>");
    assert_eq!(
        clean(
            r#"<span class="h foo s">x</span><sup class="fn qiraat">1</sup><i class="s x">y</i><b class="h">z</b>"#
        ),
        r#"<span class="h s">x</span><sup class="fn">1</sup><i class="s">y</i><b>z</b>"#
    );
}

#[test]
fn h1_becomes_h2() {
    assert_eq!(
        clean(r#"<h1 style="x">Title</h1><p>t</p>"#),
        "<h2>Title</h2><p>t</p>"
    );
}

#[test]
fn verse_links_become_data_refs() {
    let cases = [
        (
            r#"<a href="2:255">Ayat al-Kursi</a>"#,
            r#"<a data-ref="2:255">Ayat al-Kursi</a>"#,
        ),
        (r#"<a href="/2:255">x</a>"#, r#"<a data-ref="2:255">x</a>"#),
        (
            r#"<a href="2:255-257">x</a>"#,
            r#"<a data-ref="2:255-257">x</a>"#,
        ),
        (r#"<a href=" 002:005 ">x</a>"#, r#"<a data-ref="2:5">x</a>"#),
        (
            r#"<a href="2:255-255">x</a>"#,
            r#"<a data-ref="2:255">x</a>"#,
        ),
        (r#"<a href="114:6">x</a>"#, r#"<a data-ref="114:6">x</a>"#),
        (
            r#"<a class="sup" href="1:7" target="_blank" rel="x">x</a>"#,
            r#"<a data-ref="1:7">x</a>"#,
        ),
    ];
    for (input, want) in cases {
        assert_eq!(clean(input), want, "{input}");
    }
}

#[test]
fn other_links_are_unwrapped() {
    for href in [
        "https://quran.com/2/255",
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "#fn1",
        "2:287",
        "2:0",
        "0:1",
        "115:1",
        "2:5-3",
        "2:286-287",
        "1:1:1",
        "1234:1",
        "2:255x",
        "quran-ref:2:255",
        "",
    ] {
        assert_eq!(
            clean(&format!(r#"see <a href="{href}">this</a>."#)),
            "see this.",
            "{href:?}"
        );
    }
    assert_eq!(clean("<a>bare</a>"), "bare");
    // Grammatical-number markers in Quran.com's Bridges translation: `<a class="sup"><sup>sg</sup></a>`.
    assert_eq!(
        clean(r#"you<a class="sup"><sup>pl</sup></a>"#),
        "you<sup>pl</sup>"
    );
}

#[test]
fn footnote_ids_are_checked() {
    assert_eq!(
        clean(r#"x<sup class="fn" data-fn="2:255:98">98</sup>"#),
        r#"x<sup class="fn" data-fn="2:255:98">98</sup>"#
    );
    assert_eq!(
        clean(r#"<sup class="fn" data-fn="1:1:১">১</sup>"#),
        r#"<sup class="fn" data-fn="1:1:১">১</sup>"#,
        "markers keep their source digits"
    );
    for bad in [
        "195932",
        "2:255:12345",
        "2:255:x",
        "a:1:1",
        "2:255",
        "1234:1:1",
    ] {
        assert_eq!(
            clean(&format!(r#"<sup class="fn" data-fn="{bad}">1</sup>"#)),
            r#"<sup class="fn">1</sup>"#,
            "{bad}"
        );
    }
    // Quran.com's `foot_note` attribute is not part of the policy.
    assert_eq!(clean(r#"<sup foot_note="195932">1</sup>"#), "<sup>1</sup>");
    assert!(is_footnote_id("2:255:98") && is_footnote_id("114:6:٣"));
    assert!(!is_footnote_id("2:255:"));
}

#[test]
fn xss_vectors_are_neutralised() {
    let vectors = [
        r#"<img src=x onerror=alert(1)>"#,
        r#"<svg><script>alert(1)</script></svg>"#,
        r#"<svg onload=alert(1)>"#,
        r#"<math><mi xlink:href="javascript:alert(1)">x</mi></math>"#,
        r#"<iframe src="javascript:alert(1)"></iframe>"#,
        r#"<a href="javascript:alert(1)">x</a>"#,
        r#"<a href="&#106;avascript:alert(1)">x</a>"#,
        r#"<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>"#,
        r#"<style>@import 'x';</style><p>ok</p>"#,
        r#"<object data="x.swf"></object><embed src="x">"#,
        r#"<form action="x"><input value="y"><button formaction="z">b</button></form>"#,
        r#"<![CDATA[<script>alert(1)</script>]]>"#,
        r#"<p onmouseover="alert(1)" data-x="y">p</p>"#,
        r#"<span style="background:url(javascript:alert(1))">s</span>"#,
        r#"<base href="https://evil.example/"><link rel="stylesheet" href="x"><meta http-equiv="refresh" content="0">"#,
        r#"<template><img src=x onerror=alert(1)></template>"#,
        r#"<sup data-fn="1:1:1" onclick="x">1</sup>"#,
        "<scr<script>ipt>alert(1)</script>",
    ];
    for v in vectors {
        let out = clean(v);
        let lower = out.to_ascii_lowercase();
        for bad in [
            "<img",
            "<script",
            "<iframe",
            "<svg",
            "<math",
            "onerror",
            "onload",
            "onclick",
            "javascript",
            "<style",
            "<object",
            "<embed",
            "<form",
            "<input",
            "<base",
            "<link",
            "<meta",
            "href",
            "src=",
        ] {
            assert!(!lower.contains(bad), "{bad} survived {v:?}: {out}");
        }
    }
}

#[test]
fn malformed_markup_is_balanced() {
    assert_eq!(
        clean("<p><b>bold<p>next"),
        "<p><b>bold</b></p><p><b>next</b></p>"
    );
    assert_eq!(clean("a </b> b"), "a  b");
    assert_eq!(clean("x > y & z < w"), "x &gt; y &amp; z &lt; w");
    assert_eq!(clean("واﻻ ہے>"), "واﻻ ہے&gt;");
    assert_eq!(
        clean("<a href=\"2:255\"><a href=\"2:256\">x</a></a>"),
        r#"<a data-ref="2:255"></a><a data-ref="2:256">x</a>"#
    );
    assert_eq!(clean(""), "");
    assert_eq!(clean("   "), "   ");
    assert_eq!(clean("a\u{a0}b"), "a&nbsp;b");
}

#[test]
fn sanitising_never_panics_on_noise() {
    // A deterministic soup of markup fragments.
    let pieces = [
        "<",
        ">",
        "</",
        "<p",
        "<a href=\"",
        "2:255",
        "\">",
        "</a>",
        "<h1>",
        "</h1",
        "&",
        "&amp",
        ";",
        "\"",
        "'",
        "=",
        "<sup class=\"fn\" data-fn=\"1:1:1\">",
        "</sup>",
        "<!--",
        "-->",
        "<script>",
        "</script>",
        " ",
        "\n",
        "ب",
        "১",
        "<br/>",
        "<b>",
        "</b>",
        "<i class='s'>",
        "<span class=h>",
        "</span>",
        "\u{a0}",
        "<![CDATA[",
        "]]>",
    ];
    let mut x: u32 = 0x1234_5678;
    for _ in 0..300 {
        let mut s = String::new();
        for _ in 0..24 {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            s.push_str(pieces[(x as usize) % pieces.len()]);
        }
        let out = clean(&s);
        let _ = plain_text(&out);
    }
}

#[test]
fn parse_ref_rules() {
    assert_eq!(parse_ref("2:255").as_deref(), Some("2:255"));
    assert_eq!(parse_ref("/1:7").as_deref(), Some("1:7"));
    assert_eq!(parse_ref("9:129").as_deref(), Some("9:129"));
    assert_eq!(parse_ref("9:130"), None);
    assert_eq!(parse_ref("2:1-286").as_deref(), Some("2:1-286"));
    assert_eq!(parse_ref("//2:255"), None);
    assert_eq!(parse_ref("2:+5"), None);
    assert_eq!(
        parse_ref("٢:٢٥٥"),
        None,
        "ASCII digits only, as REF_PATTERN in html.ts"
    );
}

#[test]
fn plain_text_rules() {
    assert_eq!(
        plain_text(
            r#"<p>In the name of Allāh,<sup class="fn" data-fn="1:1:2">2</sup> the Merciful.<sup class="fn" data-fn="1:1:3">3</sup></p>"#
        ),
        "In the name of Allāh, the Merciful."
    );
    assert_eq!(
        plain_text("<p>a  b\n c</p><p>d</p><br>e<br><br>f<li>g</li>"),
        "a b c\nd\ne\nf\ng"
    );
    assert_eq!(plain_text("x &amp; y &lt;z&gt; a&nbsp;b"), "x & y <z> a b");
    assert_eq!(plain_text("you<sup>pl</sup> all"), "youpl all");
    assert_eq!(
        plain_text(r#"<a data-ref="2:255">Ayat al-Kursi</a> <span class="arabic">آية</span>"#),
        "Ayat al-Kursi آية"
    );
    assert_eq!(
        plain_text("<sup class=\"fn\">1<sup>2</sup>3</sup>after"),
        "after"
    );
    assert_eq!(plain_text(""), "");
}

#[test]
fn escaping() {
    assert_eq!(
        escape("a < b & \"c\" > d"),
        "a &lt; b &amp; &quot;c&quot; &gt; d"
    );
    assert!(matches!(
        escape("plain"),
        std::borrow::Cow::Borrowed("plain")
    ));
    assert_eq!(decode_entities(&escape("<&>\"")), "<&>\"");
}
