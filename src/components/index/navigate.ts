/**
 * Opening a parsed reference (§10.4) in the reader (§7.4: every jump goes through `reader.goTo*`). Used by the Index
 * panel and the Go to dialog; the command palette (WP10c) may use it too. Owner: WP10a.
 */
import { quran, reader, ui } from '$lib/stores'
import { limits, type ParsedTarget } from '$lib/text/refparse'

export interface OpenTargetOptions {
  /**
   * A jump from an overlay (Go to, the palette): DOM focus moves to the target ayah once it renders (§7.4, §8.15).
   * Index rows leave focus in the list, so the user can keep browsing.
   */
  focus?: boolean
}

/**
 * Shows the reader at a target: an ayah (a range is selected), a page, a surah, a juz or a hizb. Returns `false`, and
 * does nothing, for a target out of range.
 */
export function openTarget(t: ParsedTarget, options: OpenTargetOptions = {}): boolean {
  const focus = options.focus ?? false
  const first = firstAyah(t)
  if (t.type === 'page') {
    if (t.page < 1 || t.page > limits().pages) return false
  } else if (first === 0) {
    return false
  }
  ui.setView('reader')
  switch (t.type) {
    case 'ayah': {
      const to = t.toAyah === undefined ? 0 : quran.ayahId(t.surah, t.toAyah)
      const range = to > first
      reader.goToAyah(first, { select: range, selectTo: range ? to : undefined, flash: true, focus })
      return true
    }
    case 'page':
      reader.goToPage(t.page, { push: true, transition: true })
      return true
    case 'surah':
    case 'juz':
    case 'hizb':
      // `goToSurah/Juz/Hizb` are `goToAyah(first, { flash: true })` (§7.3); a jump also moves focus there.
      if (focus) reader.goToAyah(first, { flash: true, focus: true })
      else if (t.type === 'surah') reader.goToSurah(t.surah)
      else if (t.type === 'juz') reader.goToJuz(t.juz)
      else reader.goToHizb(t.hizb)
      return true
  }
}

/** The first ayah of a target that has one (0 for pages and for targets out of range). */
function firstAyah(t: ParsedTarget): number {
  switch (t.type) {
    case 'ayah':
      return quran.ayahId(t.surah, t.ayah)
    case 'surah':
      return Math.max(0, quran.surahRange(t.surah).from)
    case 'juz':
      return Math.max(0, quran.juzRange(t.juz).from)
    case 'hizb':
      return Math.max(0, quran.hizbRange(t.hizb).from)
    case 'page':
      return 0
  }
}
