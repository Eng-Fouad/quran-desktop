/**
 * Shared view logic of the recitation dock (§9.7; WP9a): the reciter monogram and labels, what the idle dock offers,
 * the live repeat badge, the collapsed state, and the keycap hints of the audio shortcuts. Used by `PlayerDock`,
 * `SideDockCard` and their parts; the playback state itself lives in the `player` store.
 */
import type { Attachment } from 'svelte/attachments'
import type { GapSetting, ReciterInfo } from '$lib/ipc/bindings'
import { type IdleTarget, isolatedClock, player } from '$lib/stores/player.svelte'
import { audioShortcut, idleTarget } from '$lib/shortcuts/audio'
import { i18n } from '$lib/stores/i18n.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { shortcuts } from '$lib/stores/shortcuts.svelte'

/** Arabic articles that do not make an initial ("Al-Husary" → H). */
const ARTICLE = /^(?:al|el|ar|as|ash|ad|an|at|az|ath|adh)[-‐'’]/i

/**
 * The 36 px monogram (§9.7): Latin initials of the first and last name in the English UI ("MA" for Mishary Rashid
 * Alafasy), the first Arabic letter of the name in the Arabic UI ("م").
 */
export function monogram(reciter: ReciterInfo | null, locale: 'en' | 'ar'): string {
  if (!reciter) return locale === 'ar' ? 'ق' : 'Q'
  if (locale === 'ar') {
    const letter = /\p{Script=Arabic}/u.exec(reciter.name.ar)
    return letter?.[0] ?? reciter.name.ar.slice(0, 1)
  }
  const words = reciter.name.en
    .split(/\s+/u)
    .map((w) => w.replace(ARTICLE, ''))
    .filter((w) => /\p{L}/u.test(w))
  const first = words[0]?.match(/\p{L}/u)?.[0] ?? ''
  const last = words.length > 1 ? (words.at(-1)?.match(/\p{L}/u)?.[0] ?? '') : ''
  return (first + last).toLocaleUpperCase('en') || 'Q'
}

/**
 * Ties popovers to the dock pane that holds their triggers (an attachment on the pane). Their open state lives in the
 * always-mounted dock, the pane does not: when a recitation ends with a popover open, the pane leaves and takes the
 * popover with it. `close` then resets that state, so the popover does not open again by itself (holding the reader's
 * shortcut layer) when the next recitation brings the pane back.
 */
export function closeOnLeave(close: () => void): Attachment<HTMLElement> {
  return () => close
}

/** The reciter's name in the UI language. */
export function reciterName(reciter: ReciterInfo | null): string {
  if (!reciter) return ''
  return reciter.name[i18n.locale] || reciter.name.en
}

/** The reciter's style ("Murattal") in the UI language, if any. */
export function reciterStyle(reciter: ReciterInfo | null): string {
  if (!reciter?.style) return ''
  return reciter.style[i18n.locale] || reciter.style.en
}

/** "Al-Baqarah · 2:255" (or "Al-Baqarah · Basmala"), for an ayah reference. */
export function whereLabel(surah: number, ayah: number): string {
  if (surah === 0) return ''
  const ref = ayah > 0 ? i18n.ref(surah, ayah) : i18n.t('player.basmala')
  return i18n.t('player.where', { surah: quran.surahName(surah), ref })
}

/** What the dock is about now: the heard ayah, else the loading play's first ayah. */
export function nowLabel(): string {
  const h = player.heard
  if (h) return whereLabel(h.surah, h.ayah)
  const from = player.snapshot?.range?.from
  return from ? whereLabel(from.surah, from.ayah) : ''
}

/** The idle dock's offer (§9.7): resume the candidate, else play the reader's target. */
export interface IdleOffer {
  kind: 'resume' | 'play'
  ayahId: number
  target: IdleTarget | null
  /** "Resume Al-Kahf · 18:45" / "Play Al-Fatihah from 1:1". */
  label: string
}

export function idleOffer(): IdleOffer | null {
  const candidate = player.resumeCandidate
  if (candidate) {
    const ref = quran.ayahRef(candidate.ayahId)
    return {
      kind: 'resume',
      ayahId: candidate.ayahId,
      target: null,
      label: i18n.t('player.idle.resume', {
        surah: quran.surahName(ref.surah),
        ref: i18n.ref(ref.surah, ref.ayah),
      }),
    }
  }
  const target = idleTarget()
  if (!target) return null
  const ref = quran.ayahRef(target.from)
  if (ref.surah === 0) return null
  const to = target.to !== undefined ? quran.ayahRef(target.to) : null
  const sameSurah = to !== null && to.surah === ref.surah
  return {
    kind: 'play',
    ayahId: target.from,
    target,
    label: i18n.t('player.idle.play', {
      surah: quran.surahName(ref.surah),
      ref:
        to === null
          ? i18n.ref(ref.surah, ref.ayah)
          : sameSurah
            ? i18n.ref(ref.surah, ref.ayah, to.ayah)
            : i18n.ref(ref.surah, ref.ayah, to.ayah, to.surah),
    }),
  }
}

/** Starts what the idle dock offers (the same as Space with nothing loaded). */
export function playIdleOffer(): void {
  void player.toggle(idleTarget())
}

/** The Repeat button's live badge (§9.7): "2/3" during an ayah or range repeat, "∞", or "A-B". */
export interface RepeatBadge {
  text: string
  /** Tooltip and spoken form ("Ayah 2 of 3"). */
  status: string
}

export function repeatBadge(): RepeatBadge | null {
  const s = player.snapshot
  if (!s || !player.isActive) return null
  if (s.abLoop) {
    return {
      text: i18n.t('player.repeat.badge.ab'),
      status: i18n.t('player.repeat.status.ab', {
        from: isolatedClock(s.abLoop.aMs, s.fileDurationMs),
        to: isolatedClock(s.abLoop.bMs, s.fileDurationMs),
      }),
    }
  }
  const basmala = player.heard?.ayah === 0
  if (s.ayahRepeat !== 1 && !basmala) {
    if (s.ayahRepeat === 0) {
      return {
        text: i18n.t('player.repeat.badge.forever'),
        status: i18n.t('player.repeat.status.ayahForever'),
      }
    }
    const n = Math.min(s.ayahRepeat, Math.max(1, s.ayahRepeat - s.ayahRepeatLeft))
    return {
      text: `${i18n.num(n)}/${i18n.num(s.ayahRepeat)}`,
      status: i18n.t('player.repeat.status.ayah', { n, total: s.ayahRepeat }),
    }
  }
  if (s.rangeRepeat !== 1) {
    if (s.rangeRepeat === 0) {
      return {
        text: i18n.t('player.repeat.badge.forever'),
        status: i18n.t('player.repeat.status.rangeForever'),
      }
    }
    const n = Math.min(s.rangeRepeat, Math.max(1, s.rangeRepeat - s.rangeRepeatLeft))
    return {
      text: `${i18n.num(n)}/${i18n.num(s.rangeRepeat)}`,
      status: i18n.t('player.repeat.status.range', { n, total: s.rangeRepeat }),
    }
  }
  return null
}

/** A repeat count as the popover shows it: Off, ×N, ∞. */
export function repeatText(n: number): string {
  if (n === 1) return i18n.t('player.repeat.off')
  if (n === 0) return '∞'
  return i18n.t('player.repeat.times', { n })
}

/** A gap as the popover shows it. */
export function gapText(gap: GapSetting): string {
  switch (gap.type) {
    case 'none':
      return i18n.t('player.repeat.gapNone')
    case 'fixed':
      return i18n.t('player.repeat.gapSeconds', { n: formatDecimal(gap.data.ms / 1000) })
    case 'multiplier':
      return i18n.t('player.repeat.gapTimes', { n: formatDecimal(gap.data.pct / 100) })
  }
}

/** A decimal in UI digits with at most two fraction digits ("1.5", "١٫٥"). */
export function formatDecimal(n: number): string {
  return new Intl.NumberFormat(i18n.intlLocale, { maximumFractionDigits: 2, useGrouping: false }).format(n)
}

/** The keycap label of an audio shortcut (`Space`, `,`), for tooltips. */
export function keyHint(id: string): string | undefined {
  const def = audioShortcut(id)
  return def ? shortcuts.format(def) : undefined
}

const COLLAPSED_KEY = 'qd-dock-collapsed'

/** Per-viewer dock state: the bar can be minimised to a small pill (§9.7 "Collapse chevron"). */
class DockState {
  collapsed = $state(readCollapsed())

  setCollapsed(on: boolean): void {
    this.collapsed = on
    try {
      if (on) localStorage.setItem(COLLAPSED_KEY, '1')
      else localStorage.removeItem(COLLAPSED_KEY)
    } catch {
      // Blocked storage: the choice lasts for this session.
    }
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export const dock = new DockState()
