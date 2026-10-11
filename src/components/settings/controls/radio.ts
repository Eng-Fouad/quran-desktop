/**
 * Keyboard behaviour of the card and swatch pickers (APG radio group): the checked radio is the one tab stop; arrow keys
 * move to the next or previous radio and select it, in visual order (mirrored in RTL), wrapping at the ends; Home and
 * End go to the first and last. Radios carry `role="radio"` and `data-value`.
 *
 *   <div role="radiogroup" use:radioGroup={(value) => choose(value)}> … </div>
 */
import type { Action } from 'svelte/action'

export const radioGroup: Action<HTMLElement, (value: string) => void> = (node, initial) => {
  let select = initial

  function radios(): HTMLElement[] {
    return [...node.querySelectorAll<HTMLElement>('[role="radio"]')].filter(
      (r) => r.getAttribute('aria-disabled') !== 'true' && !(r as HTMLButtonElement).disabled,
    )
  }

  function onkeydown(e: KeyboardEvent): void {
    const target = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[role="radio"]') : null
    if (!target || !node.contains(target)) return
    const list = radios()
    const index = list.indexOf(target)
    if (index < 0) return
    const rtl = getComputedStyle(node).direction === 'rtl'
    let next: number
    switch (e.key) {
      case 'ArrowDown':
        next = index + 1
        break
      case 'ArrowUp':
        next = index - 1
        break
      case 'ArrowRight':
        next = rtl ? index - 1 : index + 1
        break
      case 'ArrowLeft':
        next = rtl ? index + 1 : index - 1
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = list.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
    const radio = list.at(((next % list.length) + list.length) % list.length)
    if (!radio) return
    radio.focus()
    const value = radio.dataset.value
    if (value !== undefined) select(value)
  }

  node.addEventListener('keydown', onkeydown)
  return {
    update(next: (value: string) => void) {
      select = next
    },
    destroy() {
      node.removeEventListener('keydown', onkeydown)
    },
  }
}
