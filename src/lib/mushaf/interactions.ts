/**
 * Pointer interactions on the Mushaf (§8.3, §8.14, §8.17). Owner: WP8d.
 *
 * `interactions` is the Svelte action `GlyphLayer` installs on each interactive rendition (`.mp-glyphs[data-interactive]`):
 * one delegated listener set per rendition that reads `data-w` / `data-a` from the word spans. There is no per-word
 * handler and no per-word reactive state.
 *
 * | Gesture                         | Action                                                                          |
 * |---------------------------------|---------------------------------------------------------------------------------|
 * | hover a word                    | `reader.setHover(ayah, word)`; a header line hovers ayah 1 of its surah         |
 * | move ≥ 4 px onto a word, dwell  | after 450 ms the WBW tooltip (`WordTooltip`); a parked cursor never pops one    |
 * | click                           | select the ayah; 120 ms later the `AyahActionBar` (D26)                         |
 * | Shift+click                     | extend the selection to the ayah                                                |
 * | double-click                    | select and open the side pane on Translation                                   |
 * | Mod+click (Alt+click on Win/mac)| play from the ayah                                                              |
 * | right-click                     | select the ayah unless the selection holds it, then the ayah context menu       |
 * | click an end-of-ayah marker     | select and open the side pane on Tafsir                                         |
 * | click empty paper or canvas     | clear the selection (the action bar goes with it)                               |
 * | drag, zoom ≤ 100 % (the fit)    | horizontal ≥ 80 px turns one page on release, right = next (pan.ts)             |
 * | drag, zoom > 100 %              | moves the canvas (pan.ts)                                                       |
 *
 * A surah header handles its own click and hover (WP8c's `HeaderLine`, which stops them before they reach this
 * delegation); a basmala line hovers ayah 1 of its surah here. Pointer selections made elsewhere on the page (margin
 * markers) can use `selectFromPointer`, which selects like a word click, action bar included. A drag is not a click:
 * pan.ts swallows the click of its release and quiets the hover, the tooltip and a pending action bar while it runs
 * (`pointerDragStarted` / `pointerDragEnded`).
 *
 * Every opener of the ayah context menu (§10.3) goes through `openAyahMenu`: a right-click here or on a verse row,
 * `Shift+F10` / the Menu key, a More button. It selects the ayah first unless the selection holds it, so the menu acts
 * on exactly what the selection tint shows; the selection stays once the menu closes, without the action bar.
 *
 * §8.14: no native text selection starts on the page (the canvas and the glyphs are `user-select: none`); copy goes
 * through the ayah selection. A `mousedown` with `detail ≥ 2` in a rendition still clears any DOM selection, so a
 * double-click never flashes a native word selection over the PUA glyphs.
 *
 * The tooltip and the action bar are separate components (mounted once by the Mushaf view); this module talks to them
 * through window events (`WORD_DWELL_EVENT`, `ACTION_BAR_EVENT`) so it holds no reactive state of its own.
 */
import type { ContextMenuTarget } from '$lib/contracts/stores'
import type { MushafStyle, PageData } from '$lib/ipc/bindings'
import { app } from '$lib/stores/app.svelte'
import { pages } from '$lib/stores/pages.svelte'
import { player } from '$lib/stores/player.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { translations } from '$lib/stores/translations.svelte'
import { ui } from '$lib/stores/ui.svelte'
import { LH } from './geometry'
import { PILL } from './layout'

// --- tunables (§8.17) ----------------------------------------------------------------------------------------------------

/** The pointer must move this far (CSS px) onto a word before the WBW tooltip may show. */
export const TOOLTIP_MOVE_PX = 4
/** …and then rest this long. */
export const TOOLTIP_DWELL_MS = 450
/** The action bar appears this long after a pointer click-selection. */
export const ACTION_BAR_DELAY_MS = 120
/** A press that travels further than this is a drag (pan.ts: a pan or a page turn), not a click on empty paper. */
export const CLICK_SLOP_PX = 4

// --- events --------------------------------------------------------------------------------------------------------------

/** `window` event: show the WBW tooltip for a word (`detail: WordDwell`) or hide it (`detail: null`). */
export const WORD_DWELL_EVENT = 'qd:word-dwell'
/** `window` event: show the action bar for the current selection (`detail: { open: true }`) or dismiss it. */
export const ACTION_BAR_EVENT = 'qd:action-bar'

/** A word the pointer dwelt on: what the WBW tooltip shows and where. */
export interface WordDwell {
  wordId: number
  ayahId: number
  page: number
  /** The word's QPC Hafs text (shown while its WBW entry loads, or when there is none). */
  text: string
  /** The word pill (§8.7) in viewport px: the tooltip sits above it, or below near the top. */
  anchor: { left: number; top: number; right: number; bottom: number }
}

export interface ActionBarRequest {
  open: boolean
}

declare global {
  interface WindowEventMap {
    [WORD_DWELL_EVENT]: CustomEvent<WordDwell | null>
    [ACTION_BAR_EVENT]: CustomEvent<ActionBarRequest>
  }
}

function emit<K extends typeof WORD_DWELL_EVENT | typeof ACTION_BAR_EVENT>(
  type: K,
  detail: WindowEventMap[K]['detail'],
): void {
  window.dispatchEvent(new CustomEvent(type, { detail }))
}

/** Hides the WBW tooltip (any keydown, page turn, scroll or zoom, §8.17). */
export function hideWordTooltip(): void {
  dwell.cancel()
  if (dwell.shown) {
    dwell.shown = false
    emit(WORD_DWELL_EVENT, null)
  }
}

/** Dismisses the action bar and cancels one that is about to appear. */
export function dismissActionBar(): void {
  clearTimeout(barTimer)
  barTimer = undefined
  emit(ACTION_BAR_EVENT, { open: false })
}

let barTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Shows the action bar `ACTION_BAR_DELAY_MS` after a pointer click-selection (never on hover or keyboard focus, D26),
 * and never under an open context menu: a click that follows the menu's `contextmenu` (macOS Ctrl+click, where a
 * webview may still dispatch one) does not bring the bar up beneath it.
 */
function scheduleActionBar(): void {
  clearTimeout(barTimer)
  barTimer = setTimeout(() => {
    barTimer = undefined
    if (settings.value.ayahActionBar && reader.selection !== null && ui.contextMenu === null)
      emit(ACTION_BAR_EVENT, { open: true })
  }, ACTION_BAR_DELAY_MS)
}

// --- selection --------------------------------------------------------------------------------------------------------

function selectionHas(ayahId: number): boolean {
  const s = reader.selection
  return s !== null && ayahId >= s.fromAyahId && ayahId <= s.toAyahId
}

/**
 * The selection after selecting `ayahId` (§8.15, §8.17): the ayah alone, or with `extend` the range from the current
 * anchor (else the cursor, else the ayah itself) to it. The reader store owns the rule; re-exported for this module's
 * callers.
 */
export { nextSelection } from '$lib/stores/reader.svelte'

/** Selects an ayah (or extends the selection to it) through the reader (§8.15): the cursor moves there. */
export function selectAyah(ayahId: number, extend = false): void {
  reader.select(ayahId, extend)
}

/**
 * A pointer click-selection made outside a glyph layer (a margin marker, WP8c): selects like a click on the ayah's
 * words, including the action bar 120 ms later.
 */
export function selectFromPointer(ayahId: number, opts: { extend?: boolean } = {}): void {
  hideWordTooltip()
  selectAyah(ayahId, opts.extend ?? false)
  scheduleActionBar()
}

/**
 * Opens the ayah context menu (§10.3) for an ayah: a right-click on its words or its verse row, `Shift+F10` / the Menu
 * key, a More button. The ayah is selected first unless the selection already holds it, so the menu acts on exactly
 * what the selection tint shows; a right-click inside a multi-ayah selection keeps it, and modifiers never extend.
 * The selection stays once the menu closes, and the action bar does not come back for it (it follows click-selections,
 * D26). `ui.openContextMenu` alone skips the select-first rule (`ui` is L0 and cannot see the reader, §7.2).
 */
export function openAyahMenu(target: ContextMenuTarget): void {
  hideWordTooltip()
  dismissActionBar()
  if (!selectionHas(target.ayahId)) selectAyah(target.ayahId)
  ui.openContextMenu(target)
}

// --- pointer state ----------------------------------------------------------------------------------------------------

/** The dwell rule's state: the word under the pointer, how far the pointer moved on it, the timer. */
const dwell = {
  word: null as HTMLElement | null,
  /** Path length (px) the pointer travelled while on `word`, including the move that brought it there. */
  travelled: 0,
  /** Where the current rest started; moving `TOOLTIP_MOVE_PX` from here restarts the dwell. */
  restX: 0,
  restY: 0,
  armed: false,
  shown: false,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  },
  reset(word: HTMLElement | null): void {
    this.cancel()
    this.word = word
    this.travelled = 0
    this.armed = false
  },
}

/** The last pointer position any rendition saw (synthetic moves after a layout change report the same position). */
let lastX = Number.NaN
let lastY = Number.NaN

/** The word span under an event target, inside this rendition. */
function wordAt(node: HTMLElement, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const w = target.closest<HTMLElement>('.w[data-w]')
  return w && node.contains(w) ? w : null
}

/** A surah-header or basmala line under an event target. */
function headerLineAt(node: HTMLElement, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const ln = target.closest<HTMLElement>('.ln[data-k="surah_name"], .ln[data-k="basmallah"]')
  return ln && node.contains(ln) ? ln : null
}

const num = (v: string | undefined): number => (v === undefined ? Number.NaN : Number(v))

const STYLES: readonly MushafStyle[] = ['hafs', 'qcf_v2', 'qcf_v1', 'qcf_v4']
const isStyle = (s: string | undefined): s is MushafStyle => STYLES.includes(s as MushafStyle)

/** The page section of a rendition: its page number and style. */
function pageOf(node: HTMLElement): { page: number; style: MushafStyle } | null {
  const section = node.closest<HTMLElement>('section.mp')
  const page = num(section?.dataset.page)
  const style = section?.dataset.style
  return Number.isInteger(page) && isStyle(style) ? { page, style } : null
}

/** The page data a rendition was rendered from (the `pages` cache). */
function pageData(node: HTMLElement): PageData | undefined {
  const where = pageOf(node)
  return where ? pages.get(where.style, where.page) : undefined
}

/** The surah a header line introduces, from the page data the line was rendered from. */
function headerSurah(node: HTMLElement, ln: HTMLElement): number | null {
  const line = num(ln.dataset.l)
  if (!Number.isInteger(line)) return null
  return pageData(node)?.lines.find((l) => l.line === line)?.surah ?? null
}

function wbwEnabled(): boolean {
  return settings.value.wbwTooltip && settings.value.wbwPackId !== null
}

/** The WBW entries of a rendition's page are requested once, when the pointer first comes over it. */
const wbwRequested = new WeakSet<HTMLElement>()

function prefetchWbw(node: HTMLElement): void {
  const packId = settings.value.wbwPackId
  if (!packId || !wbwEnabled() || wbwRequested.has(node)) return
  wbwRequested.add(node)
  const spans = node.getElementsByClassName('w')
  const first = num((spans[0] as HTMLElement | undefined)?.dataset.w)
  const last = num((spans[spans.length - 1] as HTMLElement | undefined)?.dataset.w)
  if (!Number.isInteger(first) || !Number.isInteger(last)) return
  translations.wbwForRange(packId, Math.min(first, last), Math.max(first, last)).catch((e: unknown) => {
    // A missing pack or an offline fetch only means no tooltip text; the tooltip says so itself.
    console.debug('[qd] word-by-word entries could not be loaded', e)
  })
}

/** The word pill of a span in viewport px (§8.7: the box ± 0.10·qfs, the line's band). */
function pillOf(span: HTMLElement): WordDwell['anchor'] {
  const r = span.getBoundingClientRect()
  const ln = span.closest('.ln')
  const band = ln?.getBoundingClientRect()
  if (!band || band.height <= 0) return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  const qfs = band.height / LH
  const top = band.top + (0.5 - PILL.halfBand) * band.height
  return {
    left: r.left - PILL.wordPad * qfs,
    right: r.right + PILL.wordPad * qfs,
    top,
    bottom: top + 2 * PILL.halfBand * band.height,
  }
}

function showTooltip(node: HTMLElement, span: HTMLElement): void {
  if (!span.isConnected || !wbwEnabled()) return
  const where = pageOf(node)
  const wordId = num(span.dataset.w)
  const ayahId = num(span.dataset.a)
  if (!where || !Number.isInteger(wordId) || !Number.isInteger(ayahId)) return
  const word = pageData(node)
    ?.lines.flatMap((l) => l.words)
    .find((w) => w.id === wordId)
  dwell.shown = true
  emit(WORD_DWELL_EVENT, { wordId, ayahId, page: where.page, text: word?.text ?? '', anchor: pillOf(span) })
}

function armDwell(node: HTMLElement, span: HTMLElement, x: number, y: number): void {
  dwell.cancel()
  dwell.restX = x
  dwell.restY = y
  dwell.timer = setTimeout(() => {
    dwell.timer = undefined
    if (dwell.word === span) showTooltip(node, span)
  }, TOOLTIP_DWELL_MS)
}

// --- global listeners (installed while at least one rendition is interactive) -----------------------------------------

let installed = 0
let removeGlobal: (() => void) | null = null
/** The primary press that may become a click on empty paper. */
let press: { x: number; y: number; layerOpen: boolean } | null = null

/** Interactive elements (and Mushaf parts with their own click) that a click "on empty paper" must not be inside. */
const NOT_BLANK = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'label',
  '[contenteditable]',
  '[role]:not([role="presentation"]):not([role="none"])',
  '[tabindex]:not([tabindex="-1"])',
  '[data-qd-region]',
  '[data-qd-keep-selection]',
  '.w',
  '.ln[data-k="surah_name"]',
  '.ln[data-k="basmallah"]',
  '.mp-margin',
].join(', ')

function isBlankCanvasTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const main = target.closest('main')
  if (!main) return false
  const hit = target.closest(NOT_BLANK)
  return hit === null || !main.contains(hit)
}

function hasTextSelection(): boolean {
  const s = window.getSelection()
  return s !== null && !s.isCollapsed && s.toString().trim() !== ''
}

/**
 * A drag on the canvas started (pan.ts): no tooltip, no hover tint, no pending action bar, and its release is no click
 * on empty paper. Under pointer capture the engines differ in the boundary events the rendition gets, so this does not
 * wait for them.
 */
export function pointerDragStarted(): void {
  hideWordTooltip()
  dwell.reset(null)
  clearTimeout(barTimer)
  barTimer = undefined
  press = null
  if (reader.hover !== null) reader.setHover(null, null)
}

/**
 * …and ended at (`x`, `y`): the pointer counts as parked there, so the first `pointerover` after the release never
 * counts the drag as travel, and no tooltip pops until the pointer moves 4 px onto a word (§8.17).
 */
export function pointerDragEnded(x: number, y: number): void {
  lastX = x
  lastY = y
  dwell.reset(null)
}

function installGlobal(): void {
  const onKey = (): void => hideWordTooltip()
  const onScroll = (): void => hideWordTooltip()
  const onPointerDown = (e: PointerEvent): void => {
    press = e.button === 0 && e.isPrimary ? { x: e.clientX, y: e.clientY, layerOpen: ui.layerOpen } : null
  }
  const onClick = (e: MouseEvent): void => {
    const p = press
    press = null
    if (e.button !== 0 || !p || p.layerOpen) return
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP_PX) return
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
    if (!isBlankCanvasTarget(e.target) || hasTextSelection()) return
    if (ui.view !== 'reader' || reader.selection === null) return
    dismissActionBar()
    reader.clearSelection()
  }
  window.addEventListener('keydown', onKey, true)
  document.addEventListener('scroll', onScroll, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('click', onClick)
  removeGlobal = () => {
    window.removeEventListener('keydown', onKey, true)
    document.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('click', onClick)
  }
}

// --- the action ------------------------------------------------------------------------------------------------------

/** Ctrl on Windows/Linux, ⌘ on macOS; Alt is an alias on Windows and macOS only (Linux WMs take Alt+drag, §8.17). */
function isPlayClick(e: MouseEvent): boolean {
  const mod = app.isMac ? e.metaKey : e.ctrlKey
  return mod || (e.altKey && !app.isLinux)
}

/** The Svelte action on a rendition (`use:interactions`, installed by `GlyphLayer` while the page is interactive). */
export function interactions(node: HTMLElement): { destroy(): void } {
  if (installed++ === 0) installGlobal()

  const setHoverFor = (word: HTMLElement | null, header: HTMLElement | null): void => {
    if (word) {
      const ayahId = num(word.dataset.a)
      const wordId = num(word.dataset.w)
      if (Number.isInteger(ayahId) && Number.isInteger(wordId)) {
        if (reader.hover?.wordId !== wordId) reader.setHover(ayahId, wordId)
        return
      }
    }
    if (header) {
      // §8.8: hovering a surah header or its basmala tints ayah 1 of that surah.
      const surah = headerSurah(node, header)
      if (surah !== null) {
        const ayahId = quran.ayahId(surah, 1)
        if (ayahId > 0) {
          const wordId = quran.firstWordOf(ayahId)
          if (reader.hover?.ayahId !== ayahId || reader.hover.wordId !== wordId)
            reader.setHover(ayahId, wordId)
          return
        }
      }
    }
    if (reader.hover !== null) reader.setHover(null, null)
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return
    const moved = Number.isNaN(lastX) ? 0 : Math.hypot(e.clientX - lastX, e.clientY - lastY)
    lastX = e.clientX
    lastY = e.clientY
    const word = wordAt(node, e.target)
    if (word !== dwell.word) {
      if (dwell.shown) hideWordTooltip()
      dwell.reset(word)
      setHoverFor(word, word ? null : headerLineAt(node, e.target))
      prefetchWbw(node)
    }
    if (!word || word.classList.contains('e') || dwell.shown || e.buttons !== 0) return
    dwell.travelled += moved
    if (!dwell.armed) {
      if (dwell.travelled >= TOOLTIP_MOVE_PX && wbwEnabled()) {
        dwell.armed = true
        armDwell(node, word, e.clientX, e.clientY)
      }
    } else if (Math.hypot(e.clientX - dwell.restX, e.clientY - dwell.restY) >= TOOLTIP_MOVE_PX) {
      // Still travelling across the word: the rest starts again where the pointer is now.
      armDwell(node, word, e.clientX, e.clientY)
    }
  }

  const onPointerLeave = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return
    hideWordTooltip()
    dwell.reset(null)
    if (reader.hover !== null) reader.setHover(null, null)
  }

  const onPointerDown = (): void => {
    hideWordTooltip()
    clearTimeout(barTimer)
    barTimer = undefined
  }

  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return
    // §8.14: never flash a native word selection over the PUA glyphs on a double-click; Shift+click extends the ayah
    // selection, not the DOM selection.
    if (e.detail >= 2 || (e.shiftKey && wordAt(node, e.target))) {
      e.preventDefault()
      if (e.detail >= 2) window.getSelection()?.removeAllRanges()
    }
  }

  const onClick = (e: MouseEvent): void => {
    if (e.button !== 0) return
    // Not a word: empty line space is "empty paper" (the document listener clears the selection); a surah header
    // handles its own click (WP8c's HeaderLine opens the surah info popover).
    // A DOM selection elsewhere (the side pane) never stops it: no native selection can end on the glyphs any more.
    const word = wordAt(node, e.target)
    if (!word) return
    const ayahId = num(word.dataset.a)
    if (!Number.isInteger(ayahId)) return
    if (isPlayClick(e)) {
      e.preventDefault()
      dismissActionBar()
      player.playFrom({ ayahId }).catch(ui.toastError)
      return
    }
    if (word.classList.contains('e') && !e.shiftKey) {
      // The end-of-ayah marker opens the ayah's tafsir (§8.17).
      dismissActionBar()
      selectAyah(ayahId, false)
      ui.openSidePane('tafsir')
      return
    }
    selectAyah(ayahId, e.shiftKey)
    scheduleActionBar()
  }

  const onDblClick = (e: MouseEvent): void => {
    if (e.button !== 0 || isPlayClick(e)) return
    const word = wordAt(node, e.target)
    if (!word || word.classList.contains('e')) return
    const ayahId = num(word.dataset.a)
    if (!Number.isInteger(ayahId)) return
    dismissActionBar()
    if (!selectionHas(ayahId)) selectAyah(ayahId, false)
    ui.openSidePane('translation')
  }

  const onContextMenu = (e: MouseEvent): void => {
    const word = wordAt(node, e.target)
    if (!word) return
    const ayahId = num(word.dataset.a)
    const wordId = num(word.dataset.w)
    if (!Number.isInteger(ayahId)) return
    e.preventDefault()
    openAyahMenu({ x: e.clientX, y: e.clientY, ayahId, ...(Number.isInteger(wordId) ? { wordId } : {}) })
  }

  node.addEventListener('pointerover', onPointerMove)
  node.addEventListener('pointermove', onPointerMove)
  node.addEventListener('pointerleave', onPointerLeave)
  node.addEventListener('pointerdown', onPointerDown)
  node.addEventListener('mousedown', onMouseDown)
  node.addEventListener('click', onClick)
  node.addEventListener('dblclick', onDblClick)
  node.addEventListener('contextmenu', onContextMenu)

  return {
    destroy() {
      node.removeEventListener('pointerover', onPointerMove)
      node.removeEventListener('pointermove', onPointerMove)
      node.removeEventListener('pointerleave', onPointerLeave)
      node.removeEventListener('pointerdown', onPointerDown)
      node.removeEventListener('mousedown', onMouseDown)
      node.removeEventListener('click', onClick)
      node.removeEventListener('dblclick', onDblClick)
      node.removeEventListener('contextmenu', onContextMenu)
      if (dwell.word && node.contains(dwell.word)) {
        hideWordTooltip()
        dwell.reset(null)
      }
      if (--installed === 0) {
        removeGlobal?.()
        removeGlobal = null
        press = null
        lastX = Number.NaN
        lastY = Number.NaN
      }
    },
  }
}
