/**
 * Audio shortcuts (Space, ayah steps, seek, repeat, A-B, speed, mute, stop).
 *
 * Every definition is `global` (the dock stays in every view) and belongs to the `audio` group, so the shortcuts store
 * reveals the zen dock for each of them. Keys that only mean something while a play is loaded carry a `when`, so they
 * never swallow the key otherwise. Each action is announced politely (LiveRegion), since the dock may be hidden (zen)
 * and a screen-reader user has no other feedback.
 *
 * The player store must not import the reader, so what Space plays with nothing loaded is decided here
 * ({@link idleTarget}) and handed to `player.toggle()`. The dock registers these definitions while it is mounted
 * ({@link registerAudioShortcuts}, reference-counted across the bar and the side card).
 */
import type { ShortcutDef } from '$lib/contracts/shortcuts'
import { i18n } from '$lib/stores/i18n.svelte'
import {
  type AbStep,
  formatSpeed,
  isolatedClock,
  type IdleTarget,
  player,
  SPEED_MAX,
  SPEED_MIN,
} from '$lib/stores/player.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { shortcuts } from '$lib/stores/shortcuts.svelte'
import { translations } from '$lib/stores/translations.svelte'
import { ui } from '$lib/stores/ui.svelte'

/** `>`/`<` seek by this much. */
export const NUDGE_MS = 5_000

/**
 * What Space (and the idle dock) plays when nothing is loaded and there is no resume candidate: the selection
 * (a range when it spans several ayahs), else the first ayah the reader shows: in Mushaf mode the first ayah of the
 * first visible page; in translation mode the verse at the top of the view (`translations.topAyahId`), never the
 * Mushaf page's first ayah above it, off screen. Until the view has reported its top verse (it is still laying out, or
 * shows no translation yet), the verse it opens at: the reading cursor when it is on the visible pages.
 */
export function idleTarget(): IdleTarget | null {
  const sel = reader.selection
  if (sel) {
    return sel.toAyahId !== sel.fromAyahId
      ? { from: Math.min(sel.fromAyahId, sel.toAyahId), to: Math.max(sel.fromAyahId, sel.toAyahId) }
      : { from: sel.fromAyahId }
  }
  const page = reader.visiblePages[0] ?? reader.page
  if (settings.value.readingMode === 'translation') {
    const top = translations.topAyahId
    if (top !== null && quran.isAyahId(top)) return { from: top }
    const cursor = reader.cursorAyahId
    if (cursor !== null && reader.visiblePages.includes(quran.pageOfAyah(reader.layout, cursor))) {
      return { from: cursor }
    }
  }
  const range = quran.pageRange(reader.layout, page)
  return range.from > 0 ? { from: range.from } : null
}

/** "Al-Baqarah · 2:255" for an ayah id (the announcement of what plays). */
function whereOf(ayahId: number): string {
  const ref = quran.ayahRef(ayahId)
  if (ref.surah === 0) return ''
  return i18n.t('player.where', { surah: quran.surahName(ref.surah), ref: i18n.ref(ref.surah, ref.ayah) })
}

function announce(text: string): void {
  if (text !== '') ui.announce(text)
}

async function playPause(): Promise<void> {
  const before = player.status
  const candidate = player.resumeCandidate
  const target = idleTarget()
  await player.toggle(target)
  if (before === 'playing' || before === 'buffering' || before === 'loading') {
    announce(i18n.t('player.announce.paused'))
  } else if (before === 'paused') {
    const id = player.currentAyahId
    announce(id !== null ? i18n.t('player.announce.playing', { where: whereOf(id) }) : '')
  } else {
    const id = candidate?.ayahId ?? target?.from
    if (id !== undefined) announce(i18n.t('player.announce.playing', { where: whereOf(id) }))
  }
}

async function speed(direction: 1 | -1 | 0, large = false): Promise<void> {
  const current = settings.value.speedPct
  let next = 100
  if (direction === 0) await player.setSpeed(next)
  else next = await player.speedStep(direction, large)
  // At a limit the key still says where the speed is, so a repeated press is never silent.
  const atLimit = (direction > 0 && current >= SPEED_MAX) || (direction < 0 && current <= SPEED_MIN)
  announce(i18n.t('player.announce.speed', { speed: formatSpeed(atLimit ? current : next) }))
}

async function cycleRepeat(): Promise<void> {
  const n = await player.cycleRepeat()
  announce(
    n === 1
      ? i18n.t('player.announce.repeatOff')
      : n === 0
        ? i18n.t('player.announce.repeatForever')
        : i18n.t('player.announce.repeatAyah', { n }),
  )
}

async function abLoop(): Promise<void> {
  const pending = player.abPending
  const here = player.positionMs
  const step: AbStep = await player.abMark()
  switch (step) {
    case 'a':
      announce(i18n.t('player.announce.abA', { time: isolatedClock(player.abPending ?? here) }))
      return
    case 'b': {
      const a = pending ?? here
      const from = isolatedClock(Math.min(a, here))
      const to = isolatedClock(Math.max(a, here))
      announce(i18n.t('player.announce.abSet', { from, to }))
      return
    }
    case 'cleared':
      announce(i18n.t('player.announce.abCleared'))
      return
    case 'short':
      announce(i18n.t('player.announce.abShort'))
      return
    case 'inactive':
      announce(i18n.t('player.announce.nothingPlaying'))
  }
}

async function mute(): Promise<void> {
  await player.toggleMute()
  announce(i18n.t(player.muted ? 'player.announce.muted' : 'player.announce.unmuted'))
}

async function stop(): Promise<void> {
  await player.stop()
  announce(i18n.t('player.announce.stopped'))
}

const loaded = (): boolean => player.isActive

export const audioShortcuts: readonly ShortcutDef[] = [
  {
    id: 'audio.playPause',
    keys: ['Space'],
    group: 'audio',
    labelKey: 'shortcuts.audio.playPause',
    scope: 'global',
    run: () => void playPause(),
  },
  {
    id: 'audio.nextAyah',
    keys: ['.'],
    group: 'audio',
    labelKey: 'shortcuts.audio.nextAyah',
    scope: 'global',
    when: loaded,
    run: () => void player.next(),
  },
  {
    id: 'audio.prevAyah',
    keys: [','],
    group: 'audio',
    labelKey: 'shortcuts.audio.prevAyah',
    scope: 'global',
    when: loaded,
    run: () => void player.prev(),
  },
  {
    id: 'audio.seekForward',
    keys: ['>'],
    group: 'audio',
    labelKey: 'shortcuts.audio.seekForward',
    scope: 'global',
    repeat: true,
    when: loaded,
    run: () => void player.nudge(NUDGE_MS),
  },
  {
    id: 'audio.seekBack',
    keys: ['<'],
    group: 'audio',
    labelKey: 'shortcuts.audio.seekBack',
    scope: 'global',
    repeat: true,
    when: loaded,
    run: () => void player.nudge(-NUDGE_MS),
  },
  {
    id: 'audio.repeat',
    keys: ['r'],
    group: 'audio',
    labelKey: 'shortcuts.audio.repeat',
    scope: 'global',
    run: () => void cycleRepeat(),
  },
  {
    id: 'audio.abLoop',
    keys: ['l'],
    group: 'audio',
    labelKey: 'shortcuts.audio.abLoop',
    scope: 'global',
    run: () => void abLoop(),
  },
  {
    id: 'audio.faster',
    keys: [']'],
    group: 'audio',
    labelKey: 'shortcuts.audio.faster',
    scope: 'global',
    repeat: true,
    run: () => void speed(1),
  },
  {
    id: 'audio.slower',
    keys: ['['],
    group: 'audio',
    labelKey: 'shortcuts.audio.slower',
    scope: 'global',
    repeat: true,
    run: () => void speed(-1),
  },
  {
    id: 'audio.muchFaster',
    keys: ['}'],
    group: 'audio',
    labelKey: 'shortcuts.audio.muchFaster',
    scope: 'global',
    run: () => void speed(1, true),
  },
  {
    id: 'audio.muchSlower',
    keys: ['{'],
    group: 'audio',
    labelKey: 'shortcuts.audio.muchSlower',
    scope: 'global',
    run: () => void speed(-1, true),
  },
  {
    id: 'audio.normalSpeed',
    keys: ['\\'],
    group: 'audio',
    labelKey: 'shortcuts.audio.normalSpeed',
    scope: 'global',
    run: () => void speed(0),
  },
  {
    id: 'audio.mute',
    keys: ['m'],
    group: 'audio',
    labelKey: 'shortcuts.audio.mute',
    scope: 'global',
    run: () => void mute(),
  },
  {
    id: 'audio.stop',
    keys: ['Mod+Shift+.'],
    group: 'audio',
    labelKey: 'shortcuts.audio.stop',
    scope: 'global',
    when: loaded,
    run: () => void stop(),
  },
]

/** The definition of a shortcut id (labels and keycap hints in the dock). */
export function audioShortcut(id: string): ShortcutDef | undefined {
  return audioShortcuts.find((d) => d.id === id)
}

let users = 0
let unregister: (() => void) | null = null

/**
 * Registers the audio shortcuts while at least one caller holds them (the bar and the side card each do while mounted,
 * so switching placement never drops them). Returns the release function (idempotent).
 */
export function registerAudioShortcuts(): () => void {
  users++
  if (users === 1) unregister = shortcuts.register(audioShortcuts)
  let released = false
  return () => {
    if (released) return
    released = true
    users--
    if (users === 0) {
      unregister?.()
      unregister = null
    }
  }
}
