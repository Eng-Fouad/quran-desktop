/**
 * Study shortcuts of §10.1 (bookmark, reading bookmark, highlights, note, copy, side pane, context menu, undo/redo) and
 * the actions behind them, which the ayah context menu (§10.3) shares. Owner: WP11c.
 *
 * Every action works on the **action target** (§8.15): the visible selection, else the visible cursor, else the first
 * visible ayah (`reader.actionTarget`). When the target lies inside the selection the whole selection is the span
 * (highlight, note, copy); a bookmark and the reading bookmark always take the target ayah itself. Every result is
 * toasted with the target named ("Bookmarked Al-Baqarah 2:255").
 *
 * `AyahContextMenu` (mounted once by the App) registers `studyShortcuts` (`registerStudyShortcuts`). The shortcut store
 * keeps them away from text inputs, from focused widgets (§7.7 rule 3) and from open layers, so typing `b` in the open
 * context menu moves to "Bookmark" and never toggles a bookmark (§7.7 rule 1).
 */
import type { ShortcutDef } from '$lib/contracts/shortcuts'
import type { ShortcutLabelKey } from '$lib/contracts/i18n'
import { api, call } from '$lib/ipc'
import type { HighlightColor } from '$lib/ipc/bindings'
import { selectAyah } from '$lib/mushaf/interactions'
import { i18n } from '$lib/stores/i18n.svelte'
import { type AyahSpan, HIGHLIGHT_COLORS, library } from '$lib/stores/library.svelte'
import { quran } from '$lib/stores/quran.svelte'
import { reader } from '$lib/stores/reader.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { shortcuts } from '$lib/stores/shortcuts.svelte'
import { translations } from '$lib/stores/translations.svelte'
import { ui } from '$lib/stores/ui.svelte'

export type { AyahSpan } from '$lib/stores/library.svelte'

/** What a copy puts on the clipboard (§10.3 "Copy ▸"). */
export type CopyMode = 'format' | 'withReference' | 'arabic' | 'withTranslation' | 'reference'

/** The bidi isolates `i18n.ref` wraps references in (§11.3): never copied. */
const ISOLATES = /[\u2066-\u2069]/gu

// --- the action target -------------------------------------------------------------------------------------------------

/** The action target's ayah (§8.15), or `null` when the reader has none. */
export function targetAyah(): number | null {
  const id = reader.actionTarget
  return quran.isAyahId(id) ? id : null
}

/** The span an action applies to: the selection when the target lies inside it, else the target ayah. */
export function targetSpan(): AyahSpan | null {
  const id = targetAyah()
  if (id === null) return null
  return spanAround(id)
}

/** The selection when it contains `ayahId` (the context-menu rule, §10.3), else the ayah alone. */
export function spanAround(ayahId: number): AyahSpan {
  const sel = reader.selection
  return sel && ayahId >= sel.fromAyahId && ayahId <= sel.toAyahId
    ? { from: sel.fromAyahId, to: sel.toAyahId }
    : { from: ayahId, to: ayahId }
}

/** "Al-Baqarah 2:255" or "Al-Baqarah 2:255–257", bidi-isolated. */
export function spanLabel(span: AyahSpan): string {
  return quran.refLabel(span.from, 'long', span.to !== span.from ? span.to : undefined)
}

/** The page of an ayah in the reader's layout (the reading bookmark is stored with its page, §3.2). */
function pageOf(ayahId: number): number {
  return quran.pageOfAyah(reader.layout, ayahId)
}

// --- actions -------------------------------------------------------------------------------------------------------------

export function toggleBookmarkAt(ayahId: number): void {
  void library.toggleBookmark(ayahId)
}

export function moveReadingBookmarkTo(ayahId: number): void {
  void library.moveReadingBookmark(ayahId, reader.layout, pageOf(ayahId))
}

export function highlightSpan(span: AyahSpan, color: HighlightColor): void {
  void library.setHighlight(span.from, span.to, color)
}

export function clearHighlightSpan(span: AyahSpan): void {
  void library.clearHighlight(span.from, span.to)
}

/** Opens the note editor (WP11d) on the span: the span's own note when there is one, else a new note. */
export function editNoteOn(span: AyahSpan): void {
  const note = library.noteFor(span.from, span.to)
  ui.open(
    'note-editor',
    note
      ? { noteId: note.id, fromAyahId: note.fromAyahId, toAyahId: note.toAyahId }
      : { fromAyahId: span.from, toAyahId: span.to },
  )
}

/** Opens the side pane (WP11b) for an ayah: selects it unless the selection already holds it. */
export function openPaneFor(ayahId: number, tab?: Parameters<typeof ui.openSidePane>[0]): void {
  const sel = reader.selection
  if (!sel || ayahId < sel.fromAyahId || ayahId > sel.toAyahId) selectAyah(ayahId)
  ui.openSidePane(tab)
}

async function writeClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

/**
 * Copies a span (§5.5 format, through `quran_copy_text`) and toasts what was copied, naming it:
 * - `format`: the user's copy settings (`C`);
 * - `withReference`: the Arabic with its reference, in the user's reference style;
 * - `arabic`: the Arabic only;
 * - `withTranslation`: with the first active translation appended (`Mod+Shift+C`);
 * - `reference`: the reference alone ("Al-Baqarah 2:255", in the user's reference style).
 */
export async function copySpan(span: AyahSpan, mode: CopyMode = 'format'): Promise<boolean> {
  const ref = spanLabel(span)
  const copy = settings.value.copy
  try {
    switch (mode) {
      case 'format':
        await translations.copyAyahs(span.from, span.to)
        break
      case 'withTranslation':
        await translations.copyAyahs(span.from, span.to, true)
        break
      case 'withReference':
      case 'arabic': {
        const text = await call(
          api.quranCopyText(span.from, span.to, {
            includeReference: mode === 'withReference',
            referenceStyle: copy.referenceStyle,
            ayahNumbers: copy.ayahNumbers,
            translationPackId: null,
          }),
        )
        await writeClipboard(text)
        break
      }
      case 'reference': {
        const to = span.to !== span.from ? span.to : undefined
        await writeClipboard(quran.refLabel(span.from, copy.referenceStyle, to).replace(ISOLATES, ''))
        ui.toast({ message: i18n.t('library.toast.copiedReference', { ref }), tone: 'success' })
        return true
      }
    }
    ui.toast({ message: i18n.t('library.toast.copied', { ref }), tone: 'success' })
    return true
  } catch (e) {
    console.warn('[qd] copy failed', e)
    ui.toast({ message: i18n.t('library.toast.copyFailed', { ref }), tone: 'danger' })
    return false
  }
}

/**
 * Where the context menu opens for an ayah without a pointer (`Shift+F10`, the Menu key): under the ayah's first
 * visible word on the page (its first verse row in translation mode), else the middle of the canvas.
 */
export function menuAnchor(ayahId: number): { x: number; y: number } {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight ? r : null
  }
  const candidates = [
    ...document.querySelectorAll(`.mp-glyphs .w[data-a="${ayahId}"]:not(.e)`),
    ...document.querySelectorAll(`[data-qd-ayah="${ayahId}"]`),
  ]
  for (const el of candidates) {
    const r = visible(el)
    if (!r) continue
    const verse = el.matches('[data-qd-ayah]')
    // A verse row is wide: open at its inline start rather than its centre.
    const x = verse ? (i18n.dir === 'rtl' ? r.right - 24 : r.left + 24) : r.left + r.width / 2
    return { x: Math.round(x), y: Math.round(verse ? r.top + 32 : r.bottom + 4) }
  }
  const main = document.querySelector('main')?.getBoundingClientRect()
  return main
    ? { x: Math.round(main.left + main.width / 2), y: Math.round(main.top + main.height / 3) }
    : { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 3) }
}

/** `Shift+F10` / the Menu key (§10.1): the ayah context menu for the cursor or the selection. */
export function openMenuForTarget(): void {
  const id = targetAyah()
  if (id === null) return
  ui.openContextMenu({ ...menuAnchor(id), ayahId: id })
}

/** A non-empty native text selection (the browser's own copy then wins over `Mod+C`, §8.14). */
function hasDomSelection(): boolean {
  const s = window.getSelection()
  return s !== null && !s.isCollapsed && s.toString().trim() !== ''
}

// --- definitions ---------------------------------------------------------------------------------------------------------

const HIGHLIGHT_LABELS: Record<HighlightColor, ShortcutLabelKey> = {
  yellow: 'shortcuts.study.highlightYellow',
  green: 'shortcuts.study.highlightGreen',
  blue: 'shortcuts.study.highlightBlue',
  red: 'shortcuts.study.highlightRed',
  purple: 'shortcuts.study.highlightPurple',
}

/** Runs `fn` with the target span when the reader has a target. */
function onSpan(fn: (span: AyahSpan) => void): () => void {
  return () => {
    const span = targetSpan()
    if (span) fn(span)
  }
}

const hasTarget = () => targetAyah() !== null

export const studyShortcuts: readonly ShortcutDef[] = [
  {
    id: 'study.bookmark',
    keys: ['b'],
    group: 'study',
    labelKey: 'shortcuts.study.bookmark',
    scope: 'reader',
    when: hasTarget,
    run: () => {
      const id = targetAyah()
      if (id !== null) toggleBookmarkAt(id)
    },
  },
  {
    id: 'study.readingBookmark',
    keys: ['Shift+b'],
    group: 'study',
    labelKey: 'shortcuts.study.readingBookmark',
    scope: 'reader',
    when: hasTarget,
    run: () => {
      const id = targetAyah()
      if (id !== null) moveReadingBookmarkTo(id)
    },
  },
  ...HIGHLIGHT_COLORS.map((color, i): ShortcutDef => ({
    id: `study.highlight.${color}`,
    keys: [`Digit${i + 1}`],
    group: 'study',
    labelKey: HIGHLIGHT_LABELS[color],
    scope: 'reader',
    when: hasTarget,
    run: onSpan((span) => highlightSpan(span, color)),
  })),
  {
    id: 'study.removeHighlight',
    keys: ['Digit0'],
    group: 'study',
    labelKey: 'shortcuts.study.removeHighlight',
    scope: 'reader',
    when: hasTarget,
    run: onSpan(clearHighlightSpan),
  },
  {
    id: 'study.note',
    keys: ['n'],
    group: 'study',
    labelKey: 'shortcuts.study.note',
    scope: 'reader',
    when: hasTarget,
    run: onSpan(editNoteOn),
  },
  {
    id: 'study.copy',
    keys: ['c'],
    group: 'study',
    labelKey: 'shortcuts.study.copy',
    scope: 'reader',
    when: hasTarget,
    run: onSpan((span) => void copySpan(span, 'format')),
  },
  {
    // With a native text selection the browser's copy (and the Mushaf's copy handler, §8.14) runs instead.
    id: 'study.copySelection',
    keys: ['Mod+c'],
    group: 'study',
    labelKey: 'shortcuts.study.copySelection',
    scope: 'reader',
    when: () => reader.selection !== null && !hasDomSelection(),
    run: () => {
      const sel = reader.selection
      if (sel) void copySpan({ from: sel.fromAyahId, to: sel.toAyahId }, 'format')
    },
  },
  {
    id: 'study.copyWithTranslation',
    keys: ['Mod+Shift+c'],
    group: 'study',
    labelKey: 'shortcuts.study.copyWithTranslation',
    scope: 'reader',
    when: hasTarget,
    run: onSpan((span) => void copySpan(span, 'withTranslation')),
  },
  {
    id: 'study.openSidePane',
    keys: ['Enter'],
    group: 'study',
    labelKey: 'shortcuts.study.openSidePane',
    scope: 'reader',
    when: hasTarget,
    run: () => {
      const id = targetAyah()
      if (id !== null) openPaneFor(id)
    },
  },
  {
    id: 'study.contextMenu',
    keys: ['Shift+F10', 'ContextMenu'],
    group: 'study',
    labelKey: 'shortcuts.study.contextMenu',
    scope: 'reader',
    when: hasTarget,
    run: openMenuForTarget,
  },
  {
    id: 'app.undo',
    keys: ['Mod+z'],
    group: 'app',
    labelKey: 'shortcuts.app.undo',
    scope: 'reader',
    run: () => void library.undo(),
  },
  {
    id: 'app.redo',
    keys: ['Mod+Shift+z'],
    group: 'app',
    labelKey: 'shortcuts.app.redo',
    scope: 'reader',
    run: () => void library.redo(),
  },
]

/** Registers the study shortcuts (once, by `AyahContextMenu`); returns the unregister function. */
export function registerStudyShortcuts(): () => void {
  return shortcuts.register(studyShortcuts)
}

/** The shortcut label of a study definition (`Kbd` hints in menus): `shortcuts.format`, or `undefined`. */
export function studyKey(id: string): string | undefined {
  const def = studyShortcuts.find((d) => d.id === id)
  return def ? shortcuts.format(def) : undefined
}
