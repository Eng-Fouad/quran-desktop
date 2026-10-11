/**
 * Memorisation shortcuts of §10.1 (`e`, `Shift+e`, hold `q`, `w`/`Shift+w`, and `m` in a self-test) and the key release
 * the registry cannot express.
 * Owner: WP9b. Registered by the memo store in `init`, which imports this file: stores are read only inside handlers.
 *
 * - `e` toggles hide mode for the visible selection, else the visible page(s). During a self-test it opens the rating
 *   (the text is shown by finishing the test, never by accident).
 * - `Shift+e` opens the self-test dialog for the selection, else the current surah; during a test, the rating.
 * - `w` / `Shift+w` reveal the next word / ayah while hiding (key repeat allowed: holding `w` reveals word after word).
 * - `q` peeks while held: the registry handles the keydown; the release (`keyup` of the same physical key), a window
 *   blur or a hidden document end it ({@link installMemoKeys}).
 * - `m` counts a mistake while a self-test runs (§8.16's "Mistake (M)"). `m` is also the global mute (WP9a): this
 *   definition is reader-scoped and holds only during a test, so by §7.7 precedence it takes the key then and mute
 *   keeps it otherwise. As a registry definition it is listed in the shortcut sheet and follows every registry rule.
 */
import type { ShortcutDef } from '$lib/contracts/shortcuts'
import { memo } from '$lib/stores/memo.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { ui } from '$lib/stores/ui.svelte'

/** An inclusive ayah-id range. */
export interface MemoTarget {
  from: number
  to: number
}

/** What `e` hides: the selection when it is on screen, else the ayahs of the visible page(s). */
export function hideTarget(): MemoTarget | null {
  const sel = reader.selection
  if (sel && reader.isVisible(sel.fromAyahId, sel.toAyahId)) {
    return { from: Math.min(sel.fromAyahId, sel.toAyahId), to: Math.max(sel.fromAyahId, sel.toAyahId) }
  }
  const range = reader.visibleRange
  return range.from > 0 && range.to >= range.from ? { from: range.from, to: range.to } : null
}

/** What `Shift+e` tests: the selection, else the surah of the reading cursor (else of the first ayah on screen). */
export function testTarget(): MemoTarget | null {
  const sel = reader.selection
  if (sel) return { from: Math.min(sel.fromAyahId, sel.toAyahId), to: Math.max(sel.fromAyahId, sel.toAyahId) }
  const range = quran.surahRange(quran.ayahRef(reader.actionTarget).surah)
  return range.from > 0 && range.to >= range.from ? { from: range.from, to: range.to } : null
}

/** Opens the rating step of the running self-test (the dialog shows it while `memo.test` is set). */
export function openRating(): void {
  const t = memo.test
  if (t) ui.open('self-test', { fromAyahId: t.fromAyahId, toAyahId: t.toAyahId })
}

/** `e`: hide the target, or stop hiding; a running self-test asks for its rating instead. */
export function toggleHide(): void {
  const s = memo.active
  if (s?.mode === 'test') return openRating()
  if (s) return memo.stop()
  const target = hideTarget()
  if (target) memo.startHide(target.from, target.to)
}

/** `Shift+e`: the self-test dialog for the target; during a test, its rating. */
export function selfTest(): void {
  if (memo.test) return openRating()
  const target = testTarget()
  if (target) ui.open('self-test', { fromAyahId: target.from, toAyahId: target.to })
}

/** The physical key (`e.code`) whose release ends the current peek. */
let peekCode: string | null = null

function startPeek(e: KeyboardEvent): void {
  peekCode = e.code || null
  memo.peek(true)
}

function endPeek(): void {
  peekCode = null
  memo.peek(false)
}

const sessionActive = () => memo.active !== null
const testRunning = () => memo.test !== null && memo.active?.mode === 'test'

export const memorizeShortcuts: readonly ShortcutDef[] = [
  {
    id: 'memo.hide',
    keys: ['e'],
    group: 'memorize',
    labelKey: 'shortcuts.memorize.hide',
    scope: 'reader',
    run: () => toggleHide(),
  },
  {
    id: 'memo.selfTest',
    keys: ['Shift+e'],
    group: 'memorize',
    labelKey: 'shortcuts.memorize.selfTest',
    scope: 'reader',
    run: () => selfTest(),
  },
  {
    id: 'memo.peek',
    keys: ['q'],
    group: 'memorize',
    labelKey: 'shortcuts.memorize.peek',
    scope: 'reader',
    when: sessionActive,
    run: (e) => startPeek(e),
  },
  {
    id: 'memo.revealWord',
    keys: ['w'],
    group: 'memorize',
    labelKey: 'shortcuts.memorize.revealWord',
    scope: 'reader',
    repeat: true,
    when: sessionActive,
    run: () => memo.revealNextWord(),
  },
  {
    id: 'memo.revealAyah',
    keys: ['Shift+w'],
    group: 'memorize',
    labelKey: 'shortcuts.memorize.revealAyah',
    scope: 'reader',
    repeat: true,
    when: sessionActive,
    run: () => memo.revealNextAyah(),
  },
  {
    id: 'memo.mistake',
    keys: ['m'],
    group: 'memorize',
    labelKey: 'shortcuts.memorize.mistake',
    scope: 'reader',
    when: testRunning,
    run: () => memo.addMistake(),
  },
]

/**
 * Installs the listeners the registry cannot provide: the peek release (`keyup` of the key that started it, a window
 * blur, a hidden document). Returns the remover.
 */
export function installMemoKeys(target: Window = window): () => void {
  const onKeyup = (e: KeyboardEvent) => {
    if (!memo.peeking) return
    // The key that started the peek; a peek started without one (the toolbar) ends on its own release.
    if (peekCode !== null && e.code === peekCode) endPeek()
  }
  const onBlur = () => {
    if (memo.peeking) endPeek()
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden' && memo.peeking) endPeek()
  }
  target.addEventListener('keyup', onKeyup, true)
  target.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    target.removeEventListener('keyup', onKeyup, true)
    target.removeEventListener('blur', onBlur)
    document.removeEventListener('visibilitychange', onVisibility)
    peekCode = null
  }
}
