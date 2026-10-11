/**
 * The end-of-ayah mark in running ayah text (§9.3, §11.3). An ayah's text ends in "word ۝N" (U+06DD with the ayah's
 * number, after an ordinary space), sometimes with a standalone sign between them (the sajda mark ۩). Wrapped
 * lines may break at that space, so the mark could open a line of its own, leaving a gap in a row that plays. These
 * helpers glue the tail to the last word with no-break spaces (U+00A0, which the text shaper draws with the font's
 * space glyph, so nothing else changes).
 */

/** U+00A0 NO-BREAK SPACE. */
export const NBSP = String.fromCharCode(0xa0)

/** Standalone Quranic annotation signs: U+06D6–U+06ED without the end mark (U+06DD) and ۞ (U+06DE, opens a quarter). */
const SIGN = '[\\u06D6-\\u06DC\\u06DF-\\u06ED]'

/** A token that never starts a line: the end mark with its number, or a standalone sign (the sajda mark ۩). */
const TAIL_TOKEN = new RegExp(`^(?:\\u06DD|${SIGN}+$)`, 'u')

/** The ayah text's tail: the spaces before standalone signs and the end mark (with its number) at the very end. */
const TAIL = new RegExp(`\\s+((?:${SIGN}+\\s+)*\\u06DD\\S*)\\s*$`, 'u')

/** `text` with its end mark (and any sign before it) bound to the last word by no-break spaces. */
export function bindEndMark(text: string): string {
  return text.replace(TAIL, (_whole, tail: string) => NBSP + tail.replace(/\s+/gu, NBSP))
}

/** Whether the word must stay on the line of the word before it (the end mark, a standalone sign). */
export function bindsToPrevious(word: string | undefined): boolean {
  return word !== undefined && TAIL_TOKEN.test(word)
}
