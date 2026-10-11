/**
 * Focus helpers for the modal primitives (`Dialog`, `Sheet`, `Popover`): the first control to focus when a layer
 * opens (§7.4: overlays trap focus; the header's close button is never the first stop).
 */

const TABBABLE = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function visible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
}

/**
 * Whether `el` can take focus from the keyboard: visible, enabled and not hidden from assistive tech. `:disabled` is
 * checked on the element itself, so a disabled button that carries a `tabindex` (a tooltip trigger) is skipped too.
 */
function tabbable(el: HTMLElement): boolean {
  return !el.matches(':disabled') && el.closest('[inert], [aria-hidden="true"]') === null && visible(el)
}

/** Every visible, enabled, tabbable element inside `root`, in DOM order. */
function tabbables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(tabbable)
}

/** The first visible, enabled, tabbable element inside `root` (in DOM order), or `null`. */
export function firstTabbable(root: ParentNode): HTMLElement | null {
  for (const el of root.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (tabbable(el)) return el
  }
  return null
}

/** Focuses `el` and reports whether focus actually moved there (`focus()` fails silently, e.g. on an inert node). */
function tryFocus(el: HTMLElement): boolean {
  el.focus({ preventScroll: true })
  return document.activeElement === el
}

/**
 * Focuses the element a layer should start on: an explicit `[data-autofocus]`, else the first tabbable element of the
 * first region that has one (`regions`, in priority order), else `fallback` itself. A candidate that does not take
 * focus is passed over for the next one, so the layer always ends up holding focus. Returns the focused element.
 */
export function focusInitial(
  fallback: HTMLElement,
  regions: readonly (ParentNode | null | undefined)[],
): HTMLElement {
  const explicit = fallback.querySelector<HTMLElement>('[data-autofocus]')
  if (explicit !== null && visible(explicit) && tryFocus(explicit)) return explicit
  for (const region of regions) {
    if (!region) continue
    for (const el of tabbables(region)) if (tryFocus(el)) return el
  }
  // The container itself (bits-ui gives the dialog content `tabindex="-1"`; make sure it can hold focus).
  if (!fallback.hasAttribute('tabindex')) fallback.setAttribute('tabindex', '-1')
  fallback.focus({ preventScroll: true })
  return fallback
}
