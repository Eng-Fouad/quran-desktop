/**
 * The TypeScript twin of `quran_core::normalize`: Arabic search normalisation, Latin folding and tokens.
 *
 * `normalizeAr` MUST produce exactly what the Rust `normalize_ar` produces for every input: both suites read the shared
 * golden file `crates/quran-core/tests/data/normalize_vectors.json`, so neither side can drift silently. The
 * steps, applied in order to each code point of the NFKC form:
 *
 * | Step | Input | Action | Levels |
 * |---|---|---|---|
 * | 0 | whole string | Unicode NFKC (ﷲ → الله; ا+U+0653 → آ; ا+U+0654 → أ; و+U+0654 → ؤ; ي+U+0654 → ئ) | both |
 * | 1 | U+0610–061A, U+064B–065F, U+0670, U+06D6–06ED, U+08D3–08FF, U+0640, U+200B–200F, U+202A–202E, U+2066–2069, U+FEFF | delete | both |
 * | 2 | أ إ آ ٱ ٲ ٳ | → ا | both |
 * | 3 | ى ی | → ي | both |
 * | 4 | ک → ك; ہ ھ → ه; ۃ → ة | map | both |
 * | 5 | ة | → ه | loose |
 * | 6 | ؤ → و; ئ → ي | map | loose |
 * | 7 | ء | delete | loose |
 * | 8 | U+0660–0669, U+06F0–06F9 | → ASCII 0–9 | both |
 * | 9 | whitespace, ASCII punctuation, ، ؛ ؟ ۔ | → one space; collapse runs; trim | both |
 *
 * "Whitespace" is Rust's `char::is_whitespace` (the Unicode `White_Space` property), which differs from the JS `\s`
 * class (U+0085 is whitespace, U+FEFF is not; U+FEFF is deleted by step 1 anyway). Latin letters keep their case:
 * `foldLatin` is the Latin search fold.
 */

/** `strict` keeps hamza seats and teh marbuta (the `strict` FTS column); `loose` folds them too (`smart` search). */
export type NormalizeMode = 'loose' | 'strict'

/** Version of the rules; mirrors `quran_core::NORMALIZER_VERSION` (any output change is a bump on both sides). */
export const NORMALIZER_VERSION = 1

/** Step 1: harakat, Quranic annotation marks, tatweel, zero-width and bidi controls. */
export function isStripped(cp: number): boolean {
  return (
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06ed) ||
    (cp >= 0x08d3 && cp <= 0x08ff) ||
    cp === 0x0640 ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  )
}

/** Rust's `char::is_whitespace`: the Unicode `White_Space` property. */
export function isWhiteSpace(cp: number): boolean {
  return (
    (cp >= 0x0009 && cp <= 0x000d) ||
    cp === 0x0020 ||
    cp === 0x0085 ||
    cp === 0x00a0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  )
}

/** Rust's `char::is_ascii_punctuation`: ``!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~``. */
function isAsciiPunctuation(cp: number): boolean {
  return (
    (cp >= 0x21 && cp <= 0x2f) ||
    (cp >= 0x3a && cp <= 0x40) ||
    (cp >= 0x5b && cp <= 0x60) ||
    (cp >= 0x7b && cp <= 0x7e)
  )
}

/** Steps 2–4 (both levels). */
const BOTH_MAP: ReadonlyMap<number, number> = new Map([
  [0x0623, 0x0627], // أ → ا
  [0x0625, 0x0627], // إ → ا
  [0x0622, 0x0627], // آ → ا
  [0x0671, 0x0627], // ٱ → ا
  [0x0672, 0x0627], // ٲ → ا
  [0x0673, 0x0627], // ٳ → ا
  [0x0649, 0x064a], // ى → ي
  [0x06cc, 0x064a], // ی → ي
  [0x06a9, 0x0643], // ک → ك
  [0x06c1, 0x0647], // ہ → ه
  [0x06be, 0x0647], // ھ → ه
  [0x06c3, 0x0629], // ۃ → ة
])

/** Steps 5–6 (loose only); step 7 (ء) is a deletion. */
const LOOSE_MAP: ReadonlyMap<number, number> = new Map([
  [0x0629, 0x0647], // ة → ه
  [0x0624, 0x0648], // ؤ → و
  [0x0626, 0x064a], // ئ → ي
])

const DROP = -1
const SPACE = -2

/** Steps 1–9 for one NFKC code point: the code point it becomes, `DROP` or `SPACE`. */
function foldCodePoint(input: number, loose: boolean): number {
  if (isStripped(input)) return DROP
  let cp = BOTH_MAP.get(input) ?? input
  if (loose) {
    if (cp === 0x0621) return DROP
    cp = LOOSE_MAP.get(cp) ?? cp
  }
  if (cp >= 0x0660 && cp <= 0x0669) cp = 0x30 + (cp - 0x0660)
  else if (cp >= 0x06f0 && cp <= 0x06f9) cp = 0x30 + (cp - 0x06f0)
  if (
    isWhiteSpace(cp) ||
    isAsciiPunctuation(cp) ||
    cp === 0x060c ||
    cp === 0x061b ||
    cp === 0x061f ||
    cp === 0x06d4
  ) {
    return SPACE
  }
  return cp
}

/**
 * Normalises Arabic text for indexing, search and name matching (the twin of `normalize_ar`). Never split the
 * *source* text of an ayah on spaces to recover words; split only normalised text, with `tokens`.
 */
export function normalizeAr(text: string, mode: NormalizeMode = 'loose'): string {
  const loose = mode === 'loose'
  let out = ''
  let pendingSpace = false
  for (const ch of text.normalize('NFKC')) {
    const cp = foldCodePoint(ch.codePointAt(0) ?? 0, loose)
    if (cp === DROP) continue
    if (cp === SPACE) {
      // Step 9: a run of separators becomes one space, and only between two kept characters (collapse + trim).
      pendingSpace = out !== ''
      continue
    }
    if (pendingSpace) {
      out += ' '
      pendingSpace = false
    }
    out += String.fromCodePoint(cp)
  }
  return out
}

const NONSPACING_MARK = /^\p{Mn}$/u

/**
 * Latin search folding (the twin of `fold_latin`): Unicode NFKD, nonspacing marks (`General_Category = Mn`) dropped,
 * Unicode lowercase per code point (so a final sigma stays σ, as in Rust), whitespace runs collapsed to one space and
 * trimmed. Used for surah-name matching with `-`/`'` removed by the caller.
 */
export function foldLatin(text: string): string {
  let out = ''
  let pendingSpace = false
  for (const ch of text.normalize('NFKD')) {
    if (NONSPACING_MARK.test(ch)) continue
    if (isWhiteSpace(ch.codePointAt(0) ?? 0)) {
      pendingSpace = out !== ''
      continue
    }
    if (pendingSpace) {
      out += ' '
      pendingSpace = false
    }
    out += ch.toLowerCase()
  }
  return out
}

/** The tokens of an already normalised string (`normalizeAr` or `foldLatin` output): split on U+0020, empties skipped. */
export function tokens(normalized: string): string[] {
  return normalized.split(' ').filter((t) => t !== '')
}

/** Arabic-Indic (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9) digits → ASCII, nothing else touched. */
export function asciiDigits(text: string): string {
  return text.replace(/[\u0660-\u0669\u06f0-\u06f9]/gu, (d) => {
    const cp = d.codePointAt(0) ?? 0x30
    return String.fromCodePoint(0x30 + (cp >= 0x06f0 ? cp - 0x06f0 : cp - 0x0660))
  })
}

/** Whether the text contains an Arabic-script letter (U+0600–06FF, U+0750–077F, U+08A0–08FF, presentation forms). */
export function hasArabic(text: string): boolean {
  return /[\u0620-\u064a\u066e-\u06d3\u06fa-\u06ff\u0750-\u077f\u08a0-\u08c9\ufb50-\ufdff\ufe70-\ufefc]/u.test(
    text,
  )
}
