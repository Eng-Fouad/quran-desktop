/**
 * Floating-layer registration (§7.4, §7.7 rule 1). Every open menu, context menu, popover, select or combobox listbox,
 * and every modal dialog or sheet counts as a layer: while one is open, the shortcut listener runs only `allowInInput`
 * definitions, so typeahead in a menu (`b` → "Bookmark") never toggles a bookmark and arrows in a listbox never turn
 * the page.
 */
import { getContext, setContext, untrack } from 'svelte'
import { i18n } from '$lib/stores/i18n.svelte'
import { ui } from '$lib/stores/ui.svelte'
import type { Dir } from './types'

/**
 * Registers a floating layer with `ui.pushFloating()` while `isOpen()` holds, and unregisters it when it closes or the
 * component is destroyed (push/pop always balance). Call during component initialisation.
 */
export function trackFloating(isOpen: () => boolean): void {
  $effect(() => {
    if (!isOpen()) return
    // `pushFloating` reads the counter it writes: untracked, so the effect depends on `isOpen()` alone.
    untrack(() => ui.pushFloating())
    return () => untrack(() => ui.popFloating())
  })
}

/**
 * Registers a modal layer (a `Dialog` or `Sheet`, whose backdrop covers the whole window) with `ui.pushModal()` while
 * `isOpen()` holds. The title bar's caption buttons are out of reach under it (`ui.captionVisible`). Call during
 * component initialisation, next to `trackFloating`.
 */
export function trackModal(isOpen: () => boolean): void {
  $effect(() => {
    if (!isOpen()) return
    untrack(() => ui.pushModal())
    return () => untrack(() => ui.popModal())
  })
}

/** The direction a primitive passes to bits-ui (§9.5): an explicit override, else the UI direction. */
export function resolveDir(dir: Dir | undefined): Dir {
  return dir ?? i18n.dir
}

/** Context flag set by `TooltipProvider`: tooltips below it share one provider (skip-delay between neighbours). */
export const TOOLTIP_PROVIDER = Symbol('qd.tooltip-provider')

/** A modal stacking layer (§9.4 z-index): dialogs and sheets, or the command palette above them. */
export type ModalLayer = 'dialog' | 'palette'

const MODAL_LAYER = Symbol('qd.modal-layer')

/**
 * `Dialog` and `Sheet`: floating content opened from inside them (call during initialisation) stacks above their
 * layer. Floating content is portalled to `<body>` at `--z-popover` (40) or `--z-menu` (50), below `--z-dialog` (60) and
 * `--z-palette` (70), so without this a select, menu or popover opened in a dialog would render behind it.
 */
export function setModalLayer(layer: () => ModalLayer): void {
  setContext(MODAL_LAYER, layer)
}

/**
 * The z-index of a popover or a menu (menus, select and combobox listboxes) for the floating content's own element
 * (bits-ui copies it to the positioned wrapper): just above the enclosing modal layer, a menu above a popover; inside
 * no modal, `undefined`, and the stylesheet's `--z-popover` / `--z-menu` apply. Call during initialisation.
 */
export function floatingZ(kind: 'popover' | 'menu'): () => string | undefined {
  const layer = getContext<(() => ModalLayer) | undefined>(MODAL_LAYER)
  if (!layer) return () => undefined
  const step = kind === 'popover' ? 1 : 2
  return () => `calc(var(--z-${layer()}) + ${step})`
}
