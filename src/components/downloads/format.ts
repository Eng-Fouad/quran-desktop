/**
 * Formatting for the Downloads manager (§9.7, §11.2): language names, progress pairs ("12.4 of 93.2 MB"), rates,
 * pack subtitles and reciter monograms. Owner: WP12a. Sizes arrive in KiB (§0.2); units follow `i18n.bytes`
 * (kB/MB/GB in the UI language and digits).
 */
import type { JobSnapshot, PackInfo, PackItemState } from '$lib/ipc/bindings'
import { i18n } from '$lib/stores'
import { itemNoun, languageOf } from '$lib/stores/packs.svelte'
import { LRI, PDI } from '$lib/stores/i18n.svelte'

const names = new Map<string, Intl.DisplayNames | null>()

/** The name of a content language in the UI language ("Urdu", "الأردية"); the code itself when unknown. */
export function languageName(code: string | null): string {
  if (!code) return ''
  const locale = i18n.locale
  let display = names.get(locale)
  if (display === undefined) {
    try {
      display = new Intl.DisplayNames([locale], { type: 'language' })
    } catch {
      display = null
    }
    names.set(locale, display)
  }
  try {
    return display?.of(code) ?? code
  } catch {
    return code
  }
}

const UNITS = [
  ['kilobyte', 1, 0],
  ['megabyte', 1024, 1],
  ['gigabyte', 1024 ** 2, 2],
] as const

/** "12.4 of 93.2 MB": the received amount in the unit of the total, so the pair reads as one quantity. */
export function sizePair(doneKib: number, totalKib: number): string {
  const total = Math.max(0, totalKib)
  let unit: (typeof UNITS)[number] = UNITS[0]
  for (const u of UNITS) if (total >= u[1]) unit = u
  const digits = unit[2]
  const plain = new Intl.NumberFormat(i18n.intlLocale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  const withUnit = new Intl.NumberFormat(i18n.intlLocale, {
    style: 'unit',
    unit: unit[0],
    unitDisplay: i18n.sizeUnitDisplay,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  const done = Math.min(Math.max(0, doneKib), total)
  return i18n.t('downloads.progress.of', {
    done: plain.format(done / unit[1]),
    total: withUnit.format(total / unit[1]),
  })
}

/** "1.9 MB/s". */
export function rate(kibPerSec: number): string {
  return i18n.t('downloads.progress.rate', { size: i18n.bytes(kibPerSec) })
}

/** A version string isolated left-to-right ("1.1.2" stays in order inside Arabic text). */
export function version(v: string): string {
  return `${LRI}${v}${PDI}`
}

/** The progress line of a running job: "12.4 of 93.2 MB · 1.9 MB/s · 0:42 left". */
export function jobLine(job: JobSnapshot): string {
  const sep = i18n.t('downloads.sep')
  switch (job.phase) {
    case 'queued':
      return i18n.t('downloads.progress.queued')
    case 'verifying':
      return i18n.t('downloads.progress.verifying')
    case 'installing':
      return i18n.t('downloads.progress.installing')
    case 'downloading': {
      if (job.totalKib <= 0) return i18n.t('downloads.progress.starting')
      const parts = [sizePair(job.receivedKib, job.totalKib)]
      if (job.rateKibS > 0) parts.push(rate(job.rateKibS))
      if (job.etaS !== null && job.rateKibS > 0) {
        parts.push(i18n.t('downloads.progress.left', { time: i18n.duration(job.etaS * 1000) }))
      }
      return parts.join(sep)
    }
    case 'paused':
      return job.totalKib > 0
        ? [i18n.t('downloads.progress.paused'), sizePair(job.receivedKib, job.totalKib)].join(sep)
        : i18n.t('downloads.progress.paused')
    default:
      return ''
  }
}

/** Present (pinned or fetched) and pinned items of a per-item pack, and what they take. */
export interface ItemCounts {
  present: number
  pinned: number
  cached: number
  queued: number
  /** KiB of every present item, and of the pinned ones. */
  kib: number
  pinnedKib: number
}

export function countItems(items: readonly PackItemState[] | undefined): ItemCounts {
  const out: ItemCounts = { present: 0, pinned: 0, cached: 0, queued: 0, kib: 0, pinnedKib: 0 }
  for (const i of items ?? []) {
    if (i.queued) out.queued++
    if (i.kib <= 0 && i.queued) continue
    out.present++
    out.kib += i.kib
    if (i.pinned) {
      out.pinned++
      out.pinnedKib += i.kib
    } else out.cached++
  }
  return out
}

/** Pinned items from the pack state when its items are not loaded. */
function pinnedFromState(p: PackInfo): number {
  if (p.state.type === 'partial' || p.state.type === 'paused') return p.state.data.itemsPresent
  if (p.state.type === 'installed' || p.state.type === 'update_available') return p.itemCount
  return 0
}

/**
 * A row's subtitle (§9.7: "Saheeh International · English · 0.5 MB" reads title, then this): the language, what is
 * on this computer and the size. `items` are the pack's `packs_items` when loaded.
 */
export function subtitle(p: PackInfo, items: readonly PackItemState[] | undefined): string {
  const sep = i18n.t('downloads.sep')
  const parts: string[] = []
  const language = p.kind === 'recitation' || p.kind === 'mushaf_fonts' ? null : languageOf(p)
  if (language) parts.push(languageName(language))
  if (p.installMode === 'on_demand') {
    const counts = items ? countItems(items) : null
    const present = counts ? (p.kind === 'recitation' ? counts.pinned : counts.present) : pinnedFromState(p)
    if (present > 0) {
      parts.push(
        i18n.tp(`downloads.row.itemsOf.${itemNoun(p.kind)}`, p.itemCount, { present: i18n.num(present) }),
      )
    } else {
      parts.push(i18n.t(p.kind === 'recitation' ? 'downloads.row.asYouListen' : 'downloads.row.asYouRead'))
    }
    // Recitations count what was downloaded (the stream cache is named apart); other packs all they hold.
    const onDisk = counts ? (p.kind === 'recitation' ? counts.pinnedKib : counts.kib) : p.installedKib
    parts.push(
      present > 0 ? i18n.bytes(onDisk) : i18n.t('downloads.row.sizeAll', { size: i18n.bytes(p.sizeKib) }),
    )
    if (p.kind === 'recitation' && counts && counts.cached > 0) {
      parts.push(i18n.tp('downloads.row.cached', counts.cached))
    }
    return parts.join(sep)
  }
  if (p.kind === 'decor') parts.push(i18n.tp('downloads.row.fonts', p.itemCount))
  if (p.state.type === 'update_available') {
    parts.push(
      i18n.t('downloads.row.versions', {
        installed: version(p.state.data.installed),
        latest: version(p.state.data.latest),
      }),
    )
  } else if (p.state.type === 'installed') {
    parts.push(i18n.t('downloads.row.version', { version: version(p.state.data.version) }))
  }
  parts.push(i18n.bytes(p.state.type === 'installed' && p.installedKib > 0 ? p.installedKib : p.sizeKib))
  return parts.join(sep)
}

const PREFIX = /^(?:al|ar|as|ash|ad|at|an|az|aš)-/i

/**
 * A reciter's monogram (§9.7 reciter cell): Latin initials of the first and last name in the English UI ("MA" for
 * Mishary Rashid Alafasy, "MH" for Mahmoud Khalil Al-Husary), the first Arabic letter in the Arabic UI.
 */
export function monogram(p: PackInfo): string {
  if (i18n.locale === 'ar') {
    const first = [...p.title.ar.trim()].find((c) => /\p{L}/u.test(c))
    if (first) return first
  }
  const words = p.title.en
    .replace(/\(.*?\)/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(PREFIX, ''))
    .filter((w) => /\p{L}/u.test(w))
  const firstWord = words[0] ?? ''
  const lastWord = words.length > 1 ? (words.at(-1) ?? '') : ''
  return ((firstWord[0] ?? '') + (lastWord[0] ?? '')).toUpperCase() || '·'
}
