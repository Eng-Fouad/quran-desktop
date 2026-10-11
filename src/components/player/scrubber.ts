/**
 * Geometry of the ayah-tick scrubber (§9.7; WP9a), kept pure for unit tests.
 *
 * Tick density: a 1×6 px tick at each ayah start when their mean spacing is at least {@link MIN_TICK_SPACING} px;
 * otherwise a tick every 10 ayahs, or at page boundaries when those are sparser. On a track of at least
 * {@link LABEL_TRACK_MIN} px, the ticks of every tenth ayah are 1×10 px and carry the ayah number, thinned so that
 * labels never collide ({@link MIN_LABEL_SPACING}).
 */

/** Ticks closer than this (mean spacing, px) are thinned out. */
export const MIN_TICK_SPACING = 4
/** From this track width (px) the every-10 ticks are tall and labelled. */
export const LABEL_TRACK_MIN = 480
/** Labels closer than this (px, centre to centre) are skipped. */
export const MIN_LABEL_SPACING = 30
/** Labels are kept this far (px) from the track ends, so they never overhang it. */
export const LABEL_EDGE = 8

/** One ayah start of the file. */
export interface AyahStart {
  /** Ayah number in the surah (1-based). */
  ayah: number
  /** Start in the file (ms). */
  fromMs: number
  /** Mushaf page of the ayah's first word (for page-boundary ticks). */
  page: number
}

export interface TickPlan {
  /** SVG path data of the 1×6 ticks (track coordinates: y 0–6). */
  small: string
  /** SVG path data of the 1×10 ticks (y −2–8). */
  tall: string
  /** Labelled ticks: x (px) and the ayah number. */
  labels: { x: number; ayah: number }[]
  /** Which rule chose the ticks (tests, debugging). */
  mode: 'ayah' | 'ten' | 'page' | 'none'
}

const EMPTY: TickPlan = { small: '', tall: '', labels: [], mode: 'none' }

/** The ticks of a file timeline `durationMs` long drawn `width` px wide. Ticks at the very ends are left out. */
export function planTicks(starts: readonly AyahStart[], durationMs: number, width: number): TickPlan {
  if (starts.length < 2 || durationMs <= 0 || width <= 0) return EMPTY
  const x = (ms: number) => Math.round((ms / durationMs) * width * 2) / 2
  const inner = (px: number) => px >= 1 && px <= width - 1
  const labelled = width >= LABEL_TRACK_MIN

  let mode: TickPlan['mode']
  let chosen: AyahStart[]
  if (width / starts.length >= MIN_TICK_SPACING) {
    mode = 'ayah'
    chosen = [...starts]
  } else {
    const tens = starts.filter((s) => s.ayah % 10 === 0)
    const pages = starts.filter((s, i) => i > 0 && s.page !== starts[i - 1]?.page)
    if (pages.length > 0 && pages.length < tens.length) {
      mode = 'page'
      chosen = pages
    } else {
      mode = 'ten'
      chosen = tens
    }
  }

  const small: string[] = []
  const tall: string[] = []
  const labels: { x: number; ayah: number }[] = []
  // Tall, labelled ticks: every tenth ayah on a wide track, when the ticks are per ayah or per ten ayahs.
  const tallTens = labelled && mode !== 'page'
  if (tallTens) {
    const step = labelStep(starts.length, width)
    let lastLabel = Number.NEGATIVE_INFINITY
    for (const s of starts) {
      if (s.ayah % 10 !== 0) continue
      const px = x(s.fromMs)
      if (!inner(px)) continue
      tall.push(`M${px + 0.5} -2v10`)
      const fits = px - lastLabel >= MIN_LABEL_SPACING && px >= LABEL_EDGE && px <= width - LABEL_EDGE
      if (s.ayah % step === 0 && fits) {
        labels.push({ x: px, ayah: s.ayah })
        lastLabel = px
      }
    }
  }
  for (const s of chosen) {
    if (tallTens && s.ayah % 10 === 0) continue
    const px = x(s.fromMs)
    if (inner(px)) small.push(`M${px + 0.5} 0v6`)
  }
  return { small: small.join(''), tall: tall.join(''), labels, mode }
}

/** Label every `step` ayahs (10, 20, 50, 100 or 200): the smallest step whose labels are ~30 px apart on average. */
export function labelStep(ayahCount: number, width: number): number {
  for (const step of [10, 20, 50, 100, 200]) {
    if ((width * step) / Math.max(1, ayahCount) >= MIN_LABEL_SPACING) return step
  }
  return 200
}

/** The index of the ayah whose span holds `ms` (the last start at or before it), or -1. */
export function ayahIndexAt(starts: readonly { fromMs: number }[], ms: number): number {
  let lo = 0
  let hi = starts.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = starts[mid]
    if (s !== undefined && s.fromMs <= ms) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** The ayah start nearest to `ms` within `[min, max]` (Shift-snapping), or `ms` itself when there is none. */
export function snapToAyah(
  starts: readonly { fromMs: number }[],
  ms: number,
  min: number,
  max: number,
): number {
  let best = ms
  let distance = Number.POSITIVE_INFINITY
  for (const s of starts) {
    if (s.fromMs < min || s.fromMs > max) continue
    const d = Math.abs(s.fromMs - ms)
    if (d < distance) {
      best = s.fromMs
      distance = d
    }
  }
  return best
}
