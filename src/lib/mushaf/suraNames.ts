/**
 * The sura-names decor face (§8.5, §9.7): `decor/sura-names.woff2`, CSS family `qd-sura-names`, one calligraphic name
 * per surah for the Index, the command palette and the surah info popover. Owner: WP10a.
 *
 * Rows set the name at their inline end, so the names must line up by their ink, not by their advance:
 * - every glyph keeps 0.17–0.41 em of empty advance on its left (its inline end: the names are right to left);
 * - on the right (its inline start) the ink ends within 0.05 em of the advance, except Yusuf's, whose first letter
 *   reaches 0.25 em past it (6.4 px at 26 px).
 * `SuraName.svelte` boxes each name by its ink (`suraNameInk`), measured from the glyph's origin, so the result does
 * not depend on the advance either: engines that round or hint advances (Chromium on Linux) still line the ink up.
 *
 * Why a table and not a measurement: canvas `measureText` does not give these bounds everywhere. WebKit (WKWebView,
 * WebKitGTK) reports `actualBoundingBoxLeft/Right` only where the ink passes the advance (so every left bearing reads
 * 0 and the 0.05 em inside on the right is lost), and a pixel scan of the 114 glyphs costs tens of milliseconds of main
 * thread. The face is fixed: the catalog pins its SHA-256 (`SURA_NAMES_SHA256`; a unit test compares the two).
 *
 * Pure (no DOM, no stores): the face's readiness is `fonts.status.get(SURA_NAMES_FAMILY) === 'ready'`.
 */

/** The CSS family the fonts store loads the face under (`DECOR_FACES`). */
export const SURA_NAMES_FAMILY = 'qd-sura-names'

/**
 * The sura-names glyph of surah `n` (§9.7): the zero-padded decimal number read as hex, from U+E000 (`uniE001` …
 * `uniE114`; surah 10 is U+E010; U+E000 itself is "سورة").
 */
export function suraNameGlyph(n: number): string {
  return String.fromCodePoint(0xe000 + Number.parseInt(String(n).padStart(3, '0'), 16))
}

/** A glyph's advance and the horizontal extent of its ink, in font units. */
export type SuraNameMetrics = readonly [advance: number, xMin: number, xMax: number]

/** The SHA-256 of the file the table below was read from: the one `src-tauri/resources/catalog.json` pins. */
export const SURA_NAMES_SHA256 = '0d8576e3f343a2a01f56cf12af27acad16e01ab023251d6fd368f5165843878b'

/** Font units per em. */
export const SURA_NAMES_UPM = 1024

/**
 * The face's metrics, numbers only, entry n − 1 for surah n: printed by
 * `python scripts/sura_names_ink.py data/dev-packs/decor/sura-names.woff2` (fontTools: the exact bounds of each outline).
 */
export const SURA_NAMES_INK: readonly SuraNameMetrics[] = [
  [1943, 292, 1929], // 1
  [1343, 205, 1338], // 2
  [2314, 344, 2266], // 3
  [1763, 264, 1760], // 4
  [1856, 270, 1850], // 5
  [2104, 333, 2099], // 6
  [2030, 309, 2021], // 7
  [2380, 352, 2375], // 8
  [1692, 263, 1680], // 9
  [1518, 235, 1491], // 10
  [1103, 186, 1096], // 11
  [1518, 277, 1770], // 12
  [1774, 264, 1765], // 13
  [2243, 336, 2231], // 14
  [1630, 251, 1624], // 15
  [1618, 256, 1611], // 16
  [1639, 245, 1634], // 17
  [2258, 351, 2251], // 18
  [1806, 266, 1815], // 19
  [1329, 203, 1320], // 20
  [2341, 339, 2330], // 21
  [1577, 231, 1567], // 22
  [2243, 341, 2235], // 23
  [2144, 304, 2137], // 24
  [2353, 352, 2340], // 25
  [1865, 290, 1861], // 26
  [2018, 308, 2012], // 27
  [2155, 326, 2150], // 28
  [2738, 409, 2743], // 29
  [1669, 259, 1659], // 30
  [2155, 326, 2146], // 31
  [2163, 346, 2146], // 32
  [2497, 380, 2478], // 33
  [1487, 223, 1475], // 34
  [1240, 178, 1222], // 35
  [1064, 171, 1062], // 36
  [2435, 353, 2426], // 37
  [1141, 178, 1123], // 38
  [1723, 245, 1715], // 39
  [1497, 232, 1492], // 40
  [2128, 318, 2123], // 41
  [2066, 308, 2062], // 42
  [1716, 259, 1710], // 43
  [2405, 358, 2405], // 44
  [2046, 313, 2048], // 45
  [2262, 342, 2252], // 46
  [1932, 288, 1915], // 47
  [1998, 289, 1981], // 48
  [2165, 317, 2142], // 49
  [1074, 175, 1069], // 50
  [2427, 370, 2405], // 51
  [1790, 271, 1784], // 52
  [1857, 283, 1846], // 53
  [2038, 309, 2033], // 54
  [1907, 290, 1904], // 55
  [2252, 330, 2248], // 56
  [2145, 345, 2139], // 57
  [2355, 346, 2349], // 58
  [1524, 235, 1523], // 59
  [2298, 351, 2293], // 60
  [1904, 290, 1889], // 61
  [1861, 281, 1857], // 62
  [2292, 346, 2287], // 63
  [2211, 342, 2205], // 64
  [2275, 346, 2261], // 65
  [2654, 399, 2628], // 66
  [1525, 225, 1517], // 67
  [2098, 318, 2084], // 68
  [1789, 271, 1784], // 69
  [2109, 318, 2104], // 70
  [1139, 173, 1130], // 71
  [1230, 189, 1220], // 72
  [1850, 271, 1846], // 73
  [1857, 277, 1857], // 74
  [2238, 330, 2228], // 75
  [1862, 283, 1858], // 76
  [2379, 349, 2352], // 77
  [1551, 236, 1528], // 78
  [2284, 340, 2270], // 79
  [1537, 236, 1524], // 80
  [2185, 326, 2180], // 81
  [2360, 415, 2339], // 82
  [2352, 342, 2345], // 83
  [2316, 344, 2309], // 84
  [1723, 269, 1716], // 85
  [2023, 297, 2013], // 86
  [1637, 242, 1611], // 87
  [2265, 334, 2255], // 88
  [1961, 277, 1954], // 89
  [1745, 263, 1735], // 90
  [1911, 291, 1906], // 91
  [1508, 222, 1506], // 92
  [1861, 278, 1866], // 93
  [1692, 247, 1686], // 94
  [1407, 214, 1396], // 95
  [1955, 295, 1953], // 96
  [2025, 302, 2022], // 97
  [1740, 265, 1728], // 98
  [1594, 254, 1592], // 99
  [2479, 361, 2470], // 100
  [2057, 308, 2053], // 101
  [1947, 275, 1936], // 102
  [1776, 268, 1771], // 103
  [1873, 284, 1862], // 104
  [2113, 313, 2106], // 105
  [1468, 209, 1460], // 106
  [2203, 325, 2192], // 107
  [1893, 292, 1887], // 108
  [2369, 360, 2363], // 109
  [1515, 223, 1515], // 110
  [1464, 224, 1465], // 111
  [2387, 350, 2382], // 112
  [1891, 277, 1876], // 113
  [1886, 286, 1882], // 114
]

/**
 * The horizontal extent of surah `n`'s ink, in em from the glyph's origin (the left end of its advance): Yusuf's is
 * 0.270–1.729 em in an advance of 1.482 em. `null` for a number that is not a surah.
 */
export function suraNameInk(n: number): { left: number; right: number } | null {
  const m = SURA_NAMES_INK[n - 1]
  if (!m) return null
  const [, xMin, xMax] = m
  return { left: xMin / SURA_NAMES_UPM, right: xMax / SURA_NAMES_UPM }
}
