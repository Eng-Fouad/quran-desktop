/**
 * Cross-package component contract (§7.9; WP0C, frozen). A component used by another package takes exactly the props
 * declared here, so no package edits another package's file to change a prop. Components not listed here are either
 * prop-less (every view, panel, dock, pane and chip reads stores) or used only inside their owning package, whose owner
 * may shape their props freely.
 */
import type { MushafLayout, PageData, PageLine, TaggableKind } from '$lib/ipc/bindings'
import type { ShortcutGroup } from './shortcuts'
import type { OverlayProps } from './overlays'

/** Which page of a spread (book side); single-page mode uses `odd ? 'right' : 'left'` (§8.10). */
export type PageSide = 'right' | 'left'

/** `MushafPage.svelte` (WP8a). Onboarding thumbnails and the Settings preview render it with `interactive={false}`. */
export interface MushafPageProps {
  data: PageData
  /** Quran font size in CSS px: the unit of all page geometry (§8.2). */
  qfs: number
  side: PageSide
  /** Pointer interactions, roving a11y items, hover and selection (default true). */
  interactive?: boolean
  /** Frame, running head, footer and margin furniture (default true). */
  furniture?: boolean
  /**
   * Draw the decor ornaments (surah-header and basmala calligraphy, the juz calligraphy, the margin ornaments) once
   * their fonts are loaded; default: the `ornateHeaders` setting. The onboarding's preview shows the choice before it
   * is saved.
   */
  ornaments?: boolean
}

/** `ShortcutTable.svelte` (WP7c), embedded by Settings › Keyboard (WP12b) and the shortcut sheet. */
export interface ShortcutTableProps {
  /** Groups to list, in this order (default: all, `SHORTCUT_GROUPS` order). */
  groups?: ShortcutGroup[]
}

/** `SafeHtml.svelte` (WP0C, frozen; §7.6): the only renderer of HTML strings. */
export interface SafeHtmlProps {
  html: string
  /** A reference button (`data-ref="s:a[-b]"`) was activated. */
  onref?: (ref: string) => void
  /** A footnote marker (`sup.fn[data-fn]`) was activated. */
  onfootnote?: (id: string) => void
}

// ---------------------------------------------------------------------------------------------------------------------
// Mushaf page internals that cross package boundaries (MushafPage is WP8a; its layers belong to WP8b, WP8c and WP8d).

/** A measured word box in px relative to `.mp-block`, line-fit transforms included (§8.7, `layout.ts`, WP8d). */
export interface WordBox {
  id: number
  ayahId: number
  line: number
  x: number
  y: number
  w: number
  h: number
}

/** A highlight rectangle in px relative to `.mp-block`. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
  /** Corner radius in px. */
  r: number
}

/** Which glyph source a rendition uses: the page's QCF font, or the bundled Hafs fallback (D13, §8.5). */
export type RenditionKind = 'qcf' | 'fallback'

/** `RenditionStack.svelte` (WP8b), rendered by `MushafPage` inside `.mp-block`. */
export interface RenditionStackProps {
  data: PageData
  qfs: number
  /** Called with the word boxes of the visible rendition after line-fit, and again after a `qfs` change. */
  onmeasure?: (boxes: WordBox[]) => void
}

/** `GlyphLayer.svelte` (WP8a), one `.mp-glyphs` rendition, mounted by `RenditionStack` (WP8b). */
export interface GlyphLayerProps {
  data: PageData
  rendition: RenditionKind
  /** CSS font family of this rendition: `qcf-v2-p262`, or `qd-hafs` for the fallback and the hafs style. */
  family: string
  /** `--glyph-scale` of the style (`metrics.ts`). */
  glyphScale: number
  /** `--center-gap` in em for centred lines (`metrics.ts`). */
  centerGap: number
  /** Bindable: the `.mp-glyphs` element, for `fitLines` and `measure`. */
  element?: HTMLElement | null
}

/** `HighlightLayer.svelte` (WP8d), the `.mp-hl` layer behind the glyphs (§8.7). */
export interface HighlightLayerProps {
  data: PageData
  qfs: number
  boxes: readonly WordBox[]
}

/** `A11yLayer.svelte` (WP8d), the visually hidden ayah list of a page (§8.15). */
export interface A11yLayerProps {
  data: PageData
}

/** Page furniture (WP8c): `PageFrame`, `RunningHead`, `PageFooter`, `MarginMarkers`, `MarginMarks`. */
export interface PageFurnitureProps {
  data: PageData
  qfs: number
  side: PageSide
}

/** Header lines inside a rendition (WP8c, rendered by `GlyphLayer`): `HeaderLine` (surah_name) and `BasmalaLine`. */
export interface HeaderLineProps {
  line: PageLine
  qfs: number
  layout: MushafLayout
}

/** `SurahCartouche.svelte` (WP8c), also used by the translation-mode `SurahCard` (WP11a) at a smaller `qfs`. */
export interface SurahCartoucheProps {
  surah: number
  qfs: number
}

// ---------------------------------------------------------------------------------------------------------------------
// Dialogs, pickers and editors used across packages

/** The overlay component for kind `K` (rendered by `OverlayHost`, WP7c) takes exactly `OverlayProps[K]`. */
export type OverlayComponentProps<K extends keyof OverlayProps> = OverlayProps[K]

/** `NoteEditorDialog.svelte` (WP11d): the overlay props, plus `compact` for the inline editor of the side pane's Notes tab. */
export type NoteEditorProps = OverlayProps['note-editor'] & { compact?: boolean }

/** `CollectionsPicker.svelte` (WP11d), used by the bookmark panel and menus (WP11c). */
export interface CollectionsPickerProps {
  bookmarkId: string
  selected: readonly string[]
  onchange?: (collectionIds: string[]) => void
}

/** `TagPicker.svelte` (WP11d), used by the library panels (WP11c) and the note editor. */
export interface TagPickerProps {
  kind: TaggableKind
  itemId: string
  selected: readonly string[]
  onchange?: (tagIds: string[]) => void
}
