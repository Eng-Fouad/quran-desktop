/**
 * Helpers shared by the memorisation surfaces (WP9b): shortcut labels for hints and tooltips, the roving focus of the
 * floating toolbars, and press-and-hold for Peek. Owner: WP9b.
 */
import { memo, shortcuts } from '$lib/stores'

/** The label of a registered shortcut (`shortcuts.format`, the user's keyboard layout), or `undefined`. */
export function keyLabel(id: string): string | undefined {
  const def = shortcuts.defs.find((d) => d.id === id)
  const label = def ? shortcuts.format(def) : ''
  return label === '' ? undefined : label
}

/** The label of the self-test's mistake key (`memo.mistake`, `M`). */
export function mistakeKeyLabel(): string {
  return keyLabel('memo.mistake') ?? 'M'
}

/**
 * A floating toolbar (`role="toolbar"`): one tab stop, ←/→ (mirrored in RTL) and Home/End move between its buttons.
 * Buttons take part when they carry `data-tb`. A mouse press never moves focus into the toolbar, so the reader's keys
 * (W, Q, …) keep working after a click (§7.7 widget guard).
 */
export function toolbar(node: HTMLElement) {
  const items = () =>
    [...node.querySelectorAll<HTMLElement>('[data-tb]')].filter(
      (el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
    )

  /** Exactly one item is tabbable: the focused one, else the first enabled one (disabled ones never are). */
  const sync = (current?: HTMLElement) => {
    const list = items()
    const stop = current && list.includes(current) ? current : list[0]
    for (const el of node.querySelectorAll<HTMLElement>('[data-tb]')) el.tabIndex = el === stop ? 0 : -1
  }

  const onkeydown = (e: KeyboardEvent) => {
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLElement)
    if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return
    const rtl = getComputedStyle(node).direction === 'rtl'
    let next: number
    switch (e.key) {
      case 'ArrowRight':
        next = rtl ? i - 1 : i + 1
        break
      case 'ArrowLeft':
        next = rtl ? i + 1 : i - 1
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
    const target = list[(next + list.length) % list.length]
    if (target) {
      sync(target)
      target.focus()
    }
  }
  const onfocusin = (e: FocusEvent) => sync(e.target as HTMLElement)
  const onmousedown = (e: MouseEvent) => {
    if ((e.target as Element | null)?.closest('[data-tb]')) e.preventDefault()
  }
  const observer = new MutationObserver(() => sync(document.activeElement as HTMLElement))
  observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] })
  node.addEventListener('keydown', onkeydown)
  node.addEventListener('focusin', onfocusin)
  node.addEventListener('mousedown', onmousedown)
  sync()
  return {
    destroy() {
      observer.disconnect()
      node.removeEventListener('keydown', onkeydown)
      node.removeEventListener('focusin', onfocusin)
      node.removeEventListener('mousedown', onmousedown)
    },
  }
}

/**
 * Press-and-hold Peek on a button: pointer down shows every hidden word until the pointer is released (or leaves with
 * the capture lost); Space or Enter held on the focused button does the same.
 */
export function holdToPeek(node: HTMLElement) {
  let held = false
  const start = () => {
    if (held) return
    held = true
    memo.peek(true)
  }
  const end = () => {
    if (!held) return
    held = false
    memo.peek(false)
  }
  const onpointerdown = (e: PointerEvent) => {
    if (e.button !== 0) return
    node.setPointerCapture?.(e.pointerId)
    start()
  }
  const onkeydown = (e: KeyboardEvent) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault()
      start()
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
    }
  }
  const onkeyup = (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      end()
    }
  }
  // A click (pointer or key) never toggles anything: the hold is the whole interaction.
  const onclick = (e: MouseEvent) => e.preventDefault()
  node.addEventListener('pointerdown', onpointerdown)
  node.addEventListener('pointerup', end)
  node.addEventListener('pointercancel', end)
  node.addEventListener('lostpointercapture', end)
  node.addEventListener('keydown', onkeydown)
  node.addEventListener('keyup', onkeyup)
  node.addEventListener('blur', end)
  node.addEventListener('click', onclick)
  return {
    destroy() {
      end()
      node.removeEventListener('pointerdown', onpointerdown)
      node.removeEventListener('pointerup', end)
      node.removeEventListener('pointercancel', end)
      node.removeEventListener('lostpointercapture', end)
      node.removeEventListener('keydown', onkeydown)
      node.removeEventListener('keyup', onkeyup)
      node.removeEventListener('blur', end)
      node.removeEventListener('click', onclick)
    },
  }
}
