/**
 * Keyboard movement inside the Index lists and the page grid (one Tab stop per list, arrows inside it).
 * Items are the container's `[data-roving]` elements that are not disabled.
 */

/** Rows a PageUp/PageDown press moves. */
export const PAGE_STEP = 8

function items(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-roving]')].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true',
  )
}

function focusItem(el: HTMLElement | undefined): boolean {
  if (!el) return false
  el.focus({ preventScroll: true })
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  return true
}

/** The item in the next row above (`-1`) or below (`1`) whose centre is closest horizontally (grids). */
function verticalNeighbour(list: HTMLElement[], from: HTMLElement, delta: 1 | -1): HTMLElement | undefined {
  const origin = from.getBoundingClientRect()
  const cx = origin.left + origin.width / 2
  let rowTop: number | null = null
  let best: HTMLElement | undefined
  let bestDx = Number.POSITIVE_INFINITY
  const ordered = delta === 1 ? list : [...list].reverse()
  for (const el of ordered) {
    const r = el.getBoundingClientRect()
    const beyond = delta === 1 ? r.top >= origin.bottom - 1 : r.bottom <= origin.top + 1
    if (!beyond) continue
    if (rowTop === null) rowTop = r.top
    else if (Math.abs(r.top - rowTop) > 1) break
    const dx = Math.abs(r.left + r.width / 2 - cx)
    if (dx < bestDx) {
      bestDx = dx
      best = el
    }
  }
  return best
}

export interface RovingOptions {
  /** Two-dimensional: Left/Right move along the reading direction, Up/Down by row. */
  grid?: boolean
  /** The UI direction (Left/Right in a grid follow it). */
  dir?: 'ltr' | 'rtl'
  /** ArrowUp on the first item (e.g. back to the filter input). */
  onBeforeFirst?: () => void
}

/**
 * Handles a keydown inside a roving list: ArrowDown/ArrowUp (and Left/Right in grids), Home/End, PageDown/PageUp.
 * Returns whether the key was used (the caller's handler then needs nothing else; `preventDefault` is called here).
 */
export function rovingKeydown(
  e: KeyboardEvent,
  container: HTMLElement,
  options: RovingOptions = {},
): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return false
  const list = items(container)
  if (list.length === 0) return false
  const active = document.activeElement
  const index = list.findIndex((el) => el === active || el.contains(active))
  const at = (i: number) => list[Math.max(0, Math.min(list.length - 1, i))]
  const current = index < 0 ? undefined : list[index]
  /** One step down (1) or up (-1): the next item of a list, the nearest item of the next row of a grid. */
  const step = (delta: 1 | -1) => {
    if (current === undefined) return at(0)
    return options.grid ? verticalNeighbour(list, current, delta) : at(index + delta)
  }
  let target: HTMLElement | undefined
  const forward = options.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight'
  const backward = options.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
  switch (e.key) {
    case 'ArrowDown':
      target = step(1)
      break
    case 'ArrowUp':
      if (
        options.onBeforeFirst &&
        (index === 0 || (options.grid && current && !verticalNeighbour(list, current, -1)))
      ) {
        e.preventDefault()
        options.onBeforeFirst()
        return true
      }
      target = step(-1)
      break
    case 'Home':
      target = at(0)
      break
    case 'End':
      target = at(list.length - 1)
      break
    case 'PageDown':
      target = at(index + PAGE_STEP * (options.grid ? gridColumns(list) : 1))
      break
    case 'PageUp':
      target = at(index - PAGE_STEP * (options.grid ? gridColumns(list) : 1))
      break
    default:
      if (options.grid && (e.key === forward || e.key === backward)) {
        target = at(index + (e.key === forward ? 1 : -1))
        break
      }
      return false
  }
  e.preventDefault()
  if (target && target !== active) focusItem(target)
  return true
}

/** Items in the first row of a grid (at least 1). */
function gridColumns(list: HTMLElement[]): number {
  const top = list[0]?.getBoundingClientRect().top ?? 0
  let n = 0
  for (const el of list) {
    if (Math.abs(el.getBoundingClientRect().top - top) > 1) break
    n++
  }
  return Math.max(1, n)
}

/**
 * Type to filter: a printable character typed on a list item goes to the list's filter input instead (focused, with
 * the character appended). Returns whether it did (Space still activates the item; chords are left alone).
 */
export function typeIntoFilter(
  e: KeyboardEvent,
  input: HTMLInputElement | null,
  append: (ch: string) => void,
): boolean {
  if (input === null || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false
  if (e.key.length !== 1 && [...e.key].length !== 1) return false
  if (/\s/u.test(e.key)) return false
  e.preventDefault()
  append(e.key)
  input.focus()
  return true
}

/** Scrolls a scroll container so that `el` is centred (no animation; for opening a list at the current item). */
export function centerInView(container: HTMLElement, el: HTMLElement): void {
  const c = container.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  container.scrollTop += r.top - c.top - (c.height - r.height) / 2
}

/** Centres `el` in `container` when it is not fully visible; leaves the scroll position alone otherwise. */
export function keepInView(container: HTMLElement, el: HTMLElement): void {
  const c = container.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  if (r.top < c.top || r.bottom > c.bottom) centerInView(container, el)
}
