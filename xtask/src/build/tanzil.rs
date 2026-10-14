//! Tanzil `quran-data.xml` (CC BY 3.0): juz, hizb, manzil, rub cross-check, ruku, sajda kinds and English surah
//! meanings.
//!
//! [`Tanzil::parse`] reads the metadata file and validates its internal consistency (counts, contiguous indices,
//! strictly increasing starts that begin at 1:1, `start` offsets, per-surah ruku counts, sajda kinds), so a truncated
//! or edited file can never feed wrong boundaries into core.db. The parsed form is also what `verify-core` needs for G1
//! (per-surah ayah counts), G10 (V1 page starts) and G11 (division boundaries).

use std::path::Path;

use anyhow::{Context, anyhow, bail, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::model::{AYAH_COUNT, AyahKey, PAGE_COUNT, RevelationPlace, SURAH_COUNT};

/// `GET https://tanzil.net/res/text/metadata/quran-data.xml` (77,234 B).
pub const URL: &str = "https://tanzil.net/res/text/metadata/quran-data.xml";
/// Attribution required by CC BY 3.0 (part of `meta.licence_note`).
pub const ATTRIBUTION: &str =
    "Tanzil quran-data.xml v1.0 (C) 2008-2009 Tanzil.info, CC BY 3.0, https://tanzil.net";

pub const JUZ_COUNT: usize = 30;
pub const HIZB_COUNT: usize = 60;
pub const QUARTER_COUNT: usize = 240;
pub const MANZIL_COUNT: usize = 7;
pub const RUKU_COUNT: usize = 556;
pub const SAJDA_COUNT: usize = 15;

/// One `<sura>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TanzilSura {
    pub index: u32,
    pub ayas: u32,
    /// Ayahs before this surah (so `ayah.id = start + aya`).
    pub start: u32,
    pub name: String,
    /// Transliteration (`Al-Faatiha`).
    pub tname: String,
    /// English meaning (`The Opening`): `surah.name_en`.
    pub ename: String,
    pub revelation: RevelationPlace,
    pub order: u32,
    pub rukus: u32,
}

/// `sajda.kind` / `ayah.sajda`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SajdaKind {
    Recommended,
    Obligatory,
}

impl SajdaKind {
    /// `sajda.kind`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Recommended => "recommended",
            Self::Obligatory => "obligatory",
        }
    }

    /// `ayah.sajda` (0 = none).
    #[must_use]
    pub const fn ayah_value(self) -> u32 {
        match self {
            Self::Recommended => 1,
            Self::Obligatory => 2,
        }
    }
}

/// One `<sajda>`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TanzilSajda {
    pub index: u32,
    pub key: AyahKey,
    pub kind: SajdaKind,
}

/// The validated metadata.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tanzil {
    /// sha256 (lowercase hex) of the file bytes: `meta.tanzil_sha256`.
    pub sha256: String,
    pub suras: Vec<TanzilSura>,
    pub juz_starts: Vec<AyahKey>,
    /// `<hizbs><quarter>`: 240 rub starts; hizb `h` starts at quarter `4h − 3`.
    pub quarter_starts: Vec<AyahKey>,
    pub manzil_starts: Vec<AyahKey>,
    pub ruku_starts: Vec<AyahKey>,
    /// 604 page starts. These are the **V1 (1405H)** page starts, never V2's.
    pub page_starts: Vec<AyahKey>,
    pub sajdas: Vec<TanzilSajda>,
}

impl Tanzil {
    /// Reads and validates `path`.
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
        Self::parse(&bytes).with_context(|| format!("Tanzil metadata {}", path.display()))
    }

    /// Parses and validates the bytes of `quran-data.xml`.
    pub fn parse(bytes: &[u8]) -> anyhow::Result<Self> {
        let text = std::str::from_utf8(bytes).context("not UTF-8")?;
        let xml: XmlQuran = quick_xml::de::from_str(text).context("parse XML")?;
        ensure!(
            xml.kind == "metadata",
            "root <quran type={:?}> is not the metadata file",
            xml.kind
        );

        let mut suras = Vec::with_capacity(xml.suras.items.len());
        for (i, s) in xml.suras.items.into_iter().enumerate() {
            let revelation = match s.kind.as_str() {
                "Meccan" => RevelationPlace::Makkah,
                "Medinan" => RevelationPlace::Madinah,
                other => bail!("sura {}: type {other:?}", s.index),
            };
            ensure!(
                usize::try_from(s.index).ok() == Some(i + 1),
                "sura #{} has index {}",
                i + 1,
                s.index
            );
            ensure!(s.ayas > 0, "sura {} has no ayas", s.index);
            ensure!(!s.ename.trim().is_empty(), "sura {} has no ename", s.index);
            suras.push(TanzilSura {
                index: s.index,
                ayas: s.ayas,
                start: s.start,
                name: s.name,
                tname: s.tname,
                ename: s.ename,
                revelation,
                order: s.order,
                rukus: s.rukus,
            });
        }
        ensure!(
            suras.len() == SURAH_COUNT as usize,
            "{} suras, expected {SURAH_COUNT}",
            suras.len()
        );
        let mut expected_start = 0_u32;
        for s in &suras {
            ensure!(
                s.start == expected_start,
                "sura {} starts at {}, expected {expected_start}",
                s.index,
                s.start
            );
            expected_start += s.ayas;
        }
        ensure!(
            expected_start == AYAH_COUNT,
            "the suras have {expected_start} ayas, expected {AYAH_COUNT}"
        );

        let mut tanzil = Self {
            sha256: hex::encode(Sha256::digest(bytes)),
            juz_starts: Vec::new(),
            quarter_starts: Vec::new(),
            manzil_starts: Vec::new(),
            ruku_starts: Vec::new(),
            page_starts: Vec::new(),
            sajdas: Vec::new(),
            suras,
        };
        tanzil.juz_starts = tanzil.starts("juz", xml.juzs.items, JUZ_COUNT)?;
        tanzil.quarter_starts = tanzil.starts("quarter", xml.hizbs.items, QUARTER_COUNT)?;
        tanzil.manzil_starts = tanzil.starts("manzil", xml.manzils.items, MANZIL_COUNT)?;
        tanzil.ruku_starts = tanzil.starts("ruku", xml.rukus.items, RUKU_COUNT)?;
        tanzil.page_starts = tanzil.starts("page", xml.pages.items, PAGE_COUNT as usize)?;

        for s in &tanzil.suras {
            let count = tanzil
                .ruku_starts
                .iter()
                .filter(|k| k.surah == s.index)
                .count();
            ensure!(
                usize::try_from(s.rukus).ok() == Some(count),
                "sura {} declares {} rukus but {count} ruku starts fall in it",
                s.index,
                s.rukus
            );
            ensure!(
                tanzil.ruku_starts.contains(&AyahKey::new(s.index, 1)),
                "sura {} does not start a ruku",
                s.index
            );
        }

        let mut sajdas = Vec::with_capacity(xml.sajdas.items.len());
        for (i, s) in xml.sajdas.items.into_iter().enumerate() {
            ensure!(
                usize::try_from(s.index).ok() == Some(i + 1),
                "sajda #{} has index {}",
                i + 1,
                s.index
            );
            let key = AyahKey::new(s.sura, s.aya);
            tanzil
                .ayah_id(key)
                .with_context(|| format!("sajda {}", s.index))?;
            let kind = match s.kind.as_str() {
                "recommended" => SajdaKind::Recommended,
                "obligatory" => SajdaKind::Obligatory,
                other => bail!("sajda {}: type {other:?}", s.index),
            };
            sajdas.push(TanzilSajda {
                index: s.index,
                key,
                kind,
            });
        }
        ensure!(
            sajdas.len() == SAJDA_COUNT,
            "{} sajdas, expected {SAJDA_COUNT}",
            sajdas.len()
        );
        ensure!(
            sajdas
                .windows(2)
                .all(|w| matches!(w, [a, b] if a.key < b.key)),
            "sajdas are not in mushaf order"
        );
        tanzil.sajdas = sajdas;
        Ok(tanzil)
    }

    /// The canonical ayah id (1..=6236) of `key`.
    pub fn ayah_id(&self, key: AyahKey) -> anyhow::Result<u32> {
        let sura = key
            .surah
            .checked_sub(1)
            .and_then(|i| self.suras.get(usize::try_from(i).ok()?))
            .ok_or_else(|| anyhow!("{key}: no such surah"))?;
        ensure!(
            (1..=sura.ayas).contains(&key.ayah),
            "{key}: surah {} has {} ayahs",
            sura.index,
            sura.ayas
        );
        Ok(sura.start + key.ayah)
    }

    /// The 60 hizb starts (every fourth quarter start).
    #[must_use]
    pub fn hizb_starts(&self) -> Vec<AyahKey> {
        self.quarter_starts.iter().step_by(4).copied().collect()
    }

    /// Checks one start table: indices 1..=`count` in order, valid keys, strictly increasing, the first at 1:1.
    fn starts(
        &self,
        what: &str,
        items: Vec<XmlStart>,
        count: usize,
    ) -> anyhow::Result<Vec<AyahKey>> {
        ensure!(
            items.len() == count,
            "{} {what} entries, expected {count}",
            items.len()
        );
        let mut keys = Vec::with_capacity(count);
        let mut previous = 0_u32;
        for (i, item) in items.into_iter().enumerate() {
            ensure!(
                usize::try_from(item.index).ok() == Some(i + 1),
                "{what} #{} has index {}",
                i + 1,
                item.index
            );
            let key = AyahKey::new(item.sura, item.aya);
            let id = self
                .ayah_id(key)
                .with_context(|| format!("{what} {}", item.index))?;
            ensure!(
                id > previous,
                "{what} {} starts at {key}, not after the previous start",
                item.index
            );
            ensure!(i > 0 || id == 1, "{what} 1 starts at {key}, not 1:1");
            previous = id;
            keys.push(key);
        }
        Ok(keys)
    }
}

#[derive(Debug, Deserialize)]
struct XmlQuran {
    #[serde(rename = "@type")]
    kind: String,
    suras: XmlList<XmlSura>,
    juzs: XmlList<XmlStart>,
    hizbs: XmlList<XmlStart>,
    manzils: XmlList<XmlStart>,
    rukus: XmlList<XmlStart>,
    pages: XmlList<XmlStart>,
    sajdas: XmlList<XmlSajda>,
}

/// A section element whose children all share one element name (`<juzs><juz/>…`, `<hizbs><quarter/>…`); the child
/// name is not checked, only the count and contents.
#[derive(Debug, Deserialize)]
struct XmlList<T> {
    #[serde(rename = "$value", default = "Vec::new")]
    items: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct XmlSura {
    #[serde(rename = "@index")]
    index: u32,
    #[serde(rename = "@ayas")]
    ayas: u32,
    #[serde(rename = "@start")]
    start: u32,
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@tname")]
    tname: String,
    #[serde(rename = "@ename")]
    ename: String,
    #[serde(rename = "@type")]
    kind: String,
    #[serde(rename = "@order")]
    order: u32,
    #[serde(rename = "@rukus")]
    rukus: u32,
}

#[derive(Debug, Deserialize)]
struct XmlStart {
    #[serde(rename = "@index")]
    index: u32,
    #[serde(rename = "@sura")]
    sura: u32,
    #[serde(rename = "@aya")]
    aya: u32,
}

#[derive(Debug, Deserialize)]
struct XmlSajda {
    #[serde(rename = "@index")]
    index: u32,
    #[serde(rename = "@sura")]
    sura: u32,
    #[serde(rename = "@aya")]
    aya: u32,
    #[serde(rename = "@type")]
    kind: String,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A complete, internally consistent synthetic metadata file: 114 suras (1:7, 2–113 with 50 ayahs each, 114 with
    /// the rest), divisions spread evenly. Shared with the derive tests.
    pub(crate) fn synthetic_xml() -> String {
        let mut ayas = vec![7_u32];
        ayas.extend(std::iter::repeat_n(50, 112));
        let used: u32 = ayas.iter().sum();
        ayas.push(AYAH_COUNT - used);
        let mut out = String::from(
            "<?xml version=\"1.0\" encoding=\"utf-8\" ?>\n<quran type=\"metadata\" version=\"1.0\">\n<suras alias=\"chapters\">\n",
        );
        let mut start = 0;
        for (i, n) in ayas.iter().enumerate() {
            let index = i + 1;
            let kind = if index % 2 == 0 { "Medinan" } else { "Meccan" };
            out.push_str(&format!(
                "<sura index=\"{index}\" ayas=\"{n}\" start=\"{start}\" name=\"س{index}\" tname=\"S-{index}\" ename=\"Meaning {index}\" type=\"{kind}\" order=\"{index}\" rukus=\"{rukus}\" />\n",
                rukus = rukus_in(index)
            ));
            start += n;
        }
        out.push_str("</suras>\n");
        let keys = all_keys(&ayas);
        let section = |out: &mut String, tag: &str, child: &str, count: usize| {
            out.push_str(&format!("<{tag}>\n"));
            for i in 0..count {
                let key = keys[i * keys.len() / count];
                out.push_str(&format!(
                    "<{child} index=\"{}\" sura=\"{}\" aya=\"{}\" />\n",
                    i + 1,
                    key.surah,
                    key.ayah
                ));
            }
            out.push_str(&format!("</{tag}>\n"));
        };
        section(&mut out, "juzs", "juz", JUZ_COUNT);
        section(&mut out, "hizbs", "quarter", QUARTER_COUNT);
        section(&mut out, "manzils", "manzil", MANZIL_COUNT);
        out.push_str("<rukus>\n");
        let mut index = 0;
        for (s, n) in ayas.iter().enumerate() {
            let surah = s + 1;
            let r = rukus_in(surah);
            for k in 0..r {
                index += 1;
                let aya = 1 + k * (*n as usize) / r;
                out.push_str(&format!(
                    "<ruku index=\"{index}\" sura=\"{surah}\" aya=\"{aya}\" />\n"
                ));
            }
        }
        out.push_str("</rukus>\n");
        section(&mut out, "pages", "page", PAGE_COUNT as usize);
        out.push_str("<sajdas>\n");
        for i in 0..SAJDA_COUNT {
            let kind = if i % 4 == 3 {
                "obligatory"
            } else {
                "recommended"
            };
            out.push_str(&format!(
                "<sajda index=\"{}\" sura=\"{}\" aya=\"3\" type=\"{kind}\" />\n",
                i + 1,
                i + 2
            ));
        }
        out.push_str("</sajdas>\n</quran>\n");
        out
    }

    /// 556 rukus over 114 suras: 1 (sura 1) + 2 × 6 (suras 2–3) + 108 × 5 (suras 4–111) + 3 × 1 (suras 112–114).
    fn rukus_in(surah: usize) -> usize {
        match surah {
            1 => 1,
            2 | 3 => 6,
            112..=114 => 1,
            _ => 5,
        }
    }

    fn all_keys(ayas: &[u32]) -> Vec<AyahKey> {
        let mut keys = Vec::new();
        for (s, n) in ayas.iter().enumerate() {
            for a in 1..=*n {
                keys.push(AyahKey::new(u32::try_from(s + 1).unwrap_or(0), a));
            }
        }
        keys
    }

    #[test]
    fn parses_a_valid_file() -> anyhow::Result<()> {
        let xml = synthetic_xml();
        let t = Tanzil::parse(xml.as_bytes())?;
        assert_eq!(t.suras.len(), 114);
        assert_eq!(t.juz_starts.len(), 30);
        assert_eq!(t.quarter_starts.len(), 240);
        assert_eq!(t.hizb_starts().len(), 60);
        assert_eq!(t.ruku_starts.len(), 556);
        assert_eq!(t.page_starts.len(), 604);
        assert_eq!(t.sajdas.len(), 15);
        assert_eq!(t.ayah_id(AyahKey::new(1, 1))?, 1);
        assert_eq!(t.ayah_id(AyahKey::new(2, 1))?, 8);
        assert_eq!(t.ayah_id(AyahKey::new(114, t.suras[113].ayas))?, AYAH_COUNT);
        assert!(t.ayah_id(AyahKey::new(1, 8)).is_err());
        assert!(t.ayah_id(AyahKey::new(115, 1)).is_err());
        assert_eq!(t.suras[1].revelation, RevelationPlace::Madinah);
        assert_eq!(t.sha256.len(), 64);
        Ok(())
    }

    #[test]
    fn rejects_inconsistent_files() {
        let xml = synthetic_xml();
        let replace_line = |prefix: &str, with: &str| {
            xml.lines()
                .map(|l| if l.starts_with(prefix) { with } else { l })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let cases = [
            // a missing quarter
            replace_line("<quarter index=\"240\"", ""),
            // a start that goes backwards
            replace_line(
                "<juz index=\"2\"",
                "<juz index=\"2\" sura=\"1\" aya=\"1\" />",
            ),
            // indices out of order
            replace_line(
                "<manzil index=\"3\"",
                "<manzil index=\"4\" sura=\"60\" aya=\"1\" />",
            ),
            // an ayah outside its surah
            xml.replacen(
                "<sajda index=\"1\" sura=\"2\" aya=\"3\"",
                "<sajda index=\"1\" sura=\"2\" aya=\"51\"",
                1,
            ),
            // a broken start offset
            xml.replacen("start=\"7\"", "start=\"8\"", 1),
            // an unknown sajda type
            xml.replacen("type=\"obligatory\"", "type=\"wajib\"", 1),
            // an unknown revelation type
            xml.replacen("type=\"Meccan\"", "type=\"Makki\"", 1),
            // wrong ruku count for sura 1
            xml.replacen("rukus=\"1\"", "rukus=\"2\"", 1),
            // not the metadata file
            xml.replacen("type=\"metadata\"", "type=\"text\"", 1),
            // truncated
            xml[..xml.len() / 2].to_owned(),
        ];
        for (i, case) in cases.iter().enumerate() {
            if case == &xml {
                continue;
            }
            assert!(
                Tanzil::parse(case.as_bytes()).is_err(),
                "case {i} must fail"
            );
        }
    }
}
