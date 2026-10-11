/**
 * `shortcuts` store (§7.3, §7.7): the registry of `ShortcutDef`s, the two window listeners and the labels. Owner:
 * WP0E → WP7c. Layer L0 (imports `app`, `settings`, `i18n`, `ui`). Matching itself is pure and lives in
 * `$lib/shortcuts` (D11 hybrid matching, guards, labels).
 *
 * Listeners (§7.7):
 * 1. **Capture phase** on `window`: only `capture: true` definitions. They run even when a widget has focus. Escape
 *    is the exception: whatever has it first gets it (an open overlay or floating layer, a search field clearing its
 *    text, an editor cancelling, a drag), so a capture Escape is decided after the event has propagated and acts only
 *    if nothing called `preventDefault()` (bits-ui's escape layer does when it closes; so do the fields and widgets
 *    that consume Escape) or stopped it.
 * 2. **Bubble phase** on `window`: everything else, skipped when `e.defaultPrevented || e.isComposing`, so a widget
 *    that handles a key wins.
 *
 * Rules, in order: (1) with a layer open and (2) in an editable target only `allowInInput` definitions run; (3) the
 * widget guard (bubble phase, plain and Shift-only chords); (4) scope; (5) `when()`; (6) a key auto-repeat runs only
 * definitions with `repeat: true` (the repeat is still consumed, so a held Space never scrolls); (7) `run(e)` and
 * `preventDefault()`.
 *
 * **Precedence** when several definitions match one event: an exact chord beats punctuation matched by character
 * (`Mod+Shift+Digit0` beats `Mod+=` where `=` is Shift+0), then the more specific scope wins (`mushaf`/`translation`,
 * then `reader`, then `global`), then the most recently registered. So a reader-scoped `Escape` (clear the selection,
 * WP8e) takes over from the global one (close layers, leave a view, leave zen) whenever its `when()` holds.
 *
 * The store registers `appShortcuts` (`$lib/shortcuts/app`, same owner) in `init`; every other shortcut file is
 * registered by its owner (`shortcuts.register(defs)` returns the unregister function).
 */
import {
  SHORTCUT_GROUPS,
  type ShortcutDef,
  type ShortcutGroup,
  type ShortcutScope,
} from '$lib/contracts/shortcuts'
import type { Store } from '$lib/contracts/stores'
import type { Bootstrap } from '$lib/ipc/bindings'
import {
  type Chord,
  chordAvailable,
  type FormatOptions,
  formatChord,
  installShortcutListeners,
  isEditableTarget,
  isGuardedChord,
  isInertKeyEvent,
  matchQuality,
  type MatchQuality,
  parseChord,
  widgetGuardBlocks,
} from '$lib/shortcuts'
import { appShortcuts } from '$lib/shortcuts/app'
import { app } from './app.svelte'
import { i18n } from './i18n.svelte'
import { settings } from './settings.svelte'
import { ui } from './ui.svelte'

/**
 * macOS: `Shift+F10` and the Menu key open the focused widget's context menu (a library row, a search hit, a surah), as
 * the browser does on Windows and Linux; WebKit and Chromium fire no `contextmenu` for them on macOS. The event has no
 * pointer button and sits at the widget's bottom corner on its inline-start side, like a browser's keyboard menu.
 */
function openContextMenuByKey(e: KeyboardEvent): void {
  const menuKey = e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)
  const target = e.target
  if (!menuKey || e.ctrlKey || e.metaKey || e.altKey || !(target instanceof Element)) return
  e.preventDefault()
  const r = target.getBoundingClientRect()
  const rtl = getComputedStyle(target).direction === 'rtl'
  target.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: Math.round(rtl ? r.right - 1 : r.left + 1),
      clientY: Math.round(r.bottom - 1),
    }),
  )
}

/** Scope specificity for precedence: the narrower context wins. */
const SCOPE_RANK: Readonly<Record<ShortcutScope, number>> = {
  global: 0,
  reader: 1,
  mushaf: 2,
  translation: 2,
}

interface Hit {
  def: ShortcutDef
  chord: Chord
  quality: MatchQuality
  rank: number
}

/** `navigator.keyboard` (Keyboard Map API; Chromium/WebView2 only, absent from the TS DOM library). */
interface KeyboardWithLayoutMap {
  getLayoutMap?: () => Promise<Iterable<[string, string]>>
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
  )
}

function sameMap(a: ReadonlyMap<string, string> | null, b: ReadonlyMap<string, string> | null): boolean {
  if (a === null || b === null) return a === b
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

class ShortcutsStore implements Store {
  defs = $state.raw<ShortcutDef[]>([])
  /** `navigator.keyboard.getLayoutMap()`: `code` → the key the user sees (WebView2); `null` elsewhere (US labels). */
  layoutMap = $state.raw<ReadonlyMap<string, string> | null>(null)

  /** Definitions per group, every group present, in the shortcut sheet's order (§10.1). */
  readonly byGroup: Record<ShortcutGroup, ShortcutDef[]> = $derived.by(() => {
    const groups = Object.fromEntries(SHORTCUT_GROUPS.map((g) => [g, [] as ShortcutDef[]])) as Record<
      ShortcutGroup,
      ShortcutDef[]
    >
    for (const def of this.defs) groups[def.group].push(def)
    return groups
  })

  /** Parsed chords by notation (`null` for an invalid one). */
  #chords = new Map<string, Chord | null>()
  /** An Escape that waits for the layers and elements on its way to handle it first (see the file comment). */
  #deferred: KeyboardEvent | null = null
  #disposers: (() => void)[] = []

  init(_b: Bootstrap): void {
    this.#dispose()
    this.#disposers.push(
      installShortcutListeners({
        capture: (e) => this.handleCapture(e),
        bubble: (e) => this.handleBubble(e),
      }),
      this.register(appShortcuts),
    )
    // The layout can change while the app is in the background (a layout switch in the OS): re-read on focus.
    const onFocus = () => void this.refreshLayoutMap()
    window.addEventListener('focus', onFocus)
    this.#disposers.push(() => window.removeEventListener('focus', onFocus))
    void this.refreshLayoutMap()
  }

  /** Adds definitions (each once); returns the function that removes exactly these again. */
  register(defs: readonly ShortcutDef[]): () => void {
    const added = defs.filter((d, i) => !this.defs.includes(d) && defs.indexOf(d) === i)
    if (import.meta.env.DEV) this.#validate(added)
    this.defs = [...this.defs, ...added]
    return () => {
      this.defs = this.defs.filter((d) => !added.includes(d))
    }
  }

  /** Re-reads the keyboard layout map for labels (`format`). A no-op where the Keyboard Map API is missing. */
  async refreshLayoutMap(): Promise<void> {
    const keyboard = (navigator as Navigator & { keyboard?: KeyboardWithLayoutMap }).keyboard
    if (typeof keyboard?.getLayoutMap !== 'function') return
    try {
      const next = new Map(await keyboard.getLayoutMap())
      if (!sameMap(next, this.layoutMap)) this.layoutMap = next
    } catch {
      // Not permitted here (e.g. a cross-origin frame): keep the US labels.
    }
  }

  /** The capture-phase listener: `capture: true` definitions only. */
  handleCapture(e: KeyboardEvent): void {
    if (e.type !== 'keydown') return
    this.#deferred = null
    if (isInertKeyEvent(e)) return
    const hit = this.#resolve(e, true)
    if (hit === null) return
    if (hit.chord.kind === 'named' && hit.chord.key === 'Escape') {
      this.#deferred = e
      return
    }
    this.#run(hit, e)
  }

  /**
   * The bubble-phase listener (§7.7 rules 1–7), and the second look at a deferred Escape: re-resolved against the
   * state its handlers left (a layer that closed, a field that cleared) and run unless one of them consumed it.
   */
  handleBubble(e: KeyboardEvent): void {
    if (e.type !== 'keydown') return
    if (this.#deferred === e) {
      this.#deferred = null
      if (e.defaultPrevented || isInertKeyEvent(e)) return
      const deferred = this.#resolve(e, true)
      if (deferred !== null) {
        this.#run(deferred, e)
        return
      }
      // Its `when` no longer holds (a handler changed the state): an ordinary Escape may still apply.
    }
    if (e.defaultPrevented || isInertKeyEvent(e)) return
    const hit = this.#resolve(e, false)
    if (hit !== null) this.#run(hit, e)
    else if (app.isMac) openContextMenuByKey(e)
  }

  /** The label of a definition's first chord available on this platform (`Ctrl+K`, `⌘K`); empty if none. */
  format(def: ShortcutDef): string {
    return this.formatAll(def)[0] ?? ''
  }

  /** The labels of every chord of a definition available on this platform (the sheet joins them with "or"). */
  formatAll(def: ShortcutDef): string[] {
    const options = this.#formatOptions()
    const labels: string[] = []
    for (const text of def.keys) {
      const chord = this.#chord(text)
      if (chord !== null && chordAvailable(chord, options.isMac)) labels.push(formatChord(chord, options))
    }
    return labels
  }

  /** Whether a definition has a chord on this platform (the sheet hides the others). */
  isAvailable(def: ShortcutDef): boolean {
    return def.keys.some((text) => {
      const chord = this.#chord(text)
      return chord !== null && chordAvailable(chord, app.isMac)
    })
  }

  reset(): void {
    this.#dispose()
    this.#deferred = null
    this.defs = []
    this.layoutMap = null
  }

  /** The best definition for an event in one phase, after rules 1–5 (see the file comment for precedence). */
  #resolve(e: KeyboardEvent, capturePhase: boolean): Hit | null {
    const isMac = app.isMac
    const restricted = ui.layerOpen || isEditableTarget(e.target)
    let guarded: boolean | null = null
    let best: Hit | null = null
    const defs = this.defs
    for (let i = defs.length - 1; i >= 0; i--) {
      const def = defs[i]
      if (def === undefined || (def.capture === true) !== capturePhase) continue
      if (restricted && def.allowInInput !== true) continue
      if (!this.#inScope(def.scope)) continue
      const rank = SCOPE_RANK[def.scope]
      for (const text of def.keys) {
        const chord = this.#chord(text)
        if (chord === null || !chordAvailable(chord, isMac)) continue
        const quality = matchQuality(chord, e, isMac)
        if (quality === 0) continue
        if (best !== null && !(quality > best.quality || (quality === best.quality && rank > best.rank)))
          break
        if (!capturePhase && isGuardedChord(chord)) {
          guarded ??= widgetGuardBlocks(e.target)
          if (guarded) break
        }
        if (def.when !== undefined && !this.#when(def)) break
        best = { def, chord, quality, rank }
        break
      }
    }
    return best
  }

  #inScope(scope: ShortcutScope): boolean {
    switch (scope) {
      case 'global':
        return true
      case 'reader':
        return ui.view === 'reader'
      case 'mushaf':
        return ui.view === 'reader' && settings.value.readingMode === 'mushaf'
      case 'translation':
        return ui.view === 'reader' && settings.value.readingMode === 'translation'
    }
  }

  #when(def: ShortcutDef): boolean {
    try {
      return def.when?.() ?? true
    } catch (err) {
      console.error(`[qd] shortcut ${def.id}: when() threw`, err)
      return false
    }
  }

  #run({ def }: Hit, e: KeyboardEvent): void {
    e.preventDefault()
    if (e.repeat && def.repeat !== true) return
    // Zen hides the dock; an audio key shows it for a moment, so the change it made is visible (§9.6).
    if (def.group === 'audio') ui.pokeDock()
    try {
      const result: unknown = def.run(e)
      if (isPromiseLike(result)) {
        result.then(undefined, (err: unknown) => console.error(`[qd] shortcut ${def.id} failed`, err))
      }
    } catch (err) {
      console.error(`[qd] shortcut ${def.id} failed`, err)
    }
  }

  #chord(text: string): Chord | null {
    let chord = this.#chords.get(text)
    if (chord === undefined) {
      try {
        chord = parseChord(text)
      } catch {
        chord = null
      }
      this.#chords.set(text, chord)
    }
    return chord
  }

  #formatOptions(): FormatOptions {
    return {
      isMac: app.isMac,
      layoutMap: this.layoutMap,
      keyLabel: (key) => i18n.t(`shortcuts.keys.${key}`),
    }
  }

  /** Development checks: every chord parses and ids are unique. */
  #validate(defs: readonly ShortcutDef[]): void {
    const ids = this.defs.map((d) => d.id)
    for (const def of defs) {
      if (ids.includes(def.id)) console.warn(`[qd] shortcut id "${def.id}" is registered twice`)
      ids.push(def.id)
      for (const text of def.keys) {
        try {
          parseChord(text)
        } catch (err) {
          console.error(`[qd] shortcut ${def.id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  #dispose(): void {
    for (const dispose of this.#disposers.splice(0)) dispose()
  }
}

export const shortcuts = new ShortcutsStore()
