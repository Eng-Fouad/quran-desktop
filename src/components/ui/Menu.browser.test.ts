/**
 * Menu and ContextMenu (§9.5, §10.3): keyboard navigation, typeahead, submenus in both directions, checkbox and radio
 * rows, disabled rows, focus return, the floating-layer registration, and the §7.7 guarantee that typeahead in an open
 * context menu never runs the reader's own letter shortcut.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { ui } from '$lib/stores/ui.svelte'
import { installShortcuts, resetUi, setUi, settle, spyShortcut } from './testing/harness'
import MenuHarness from './testing/MenuHarness.svelte'

const highlighted = () =>
  document.querySelector('[role^="menuitem"][data-highlighted]')?.textContent?.trim() ?? ''
const menus = () => document.querySelectorAll('[role="menu"]')

async function openMenu(onAction = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  await render(MenuHarness, { props: { onAction } })
  const trigger = document.getElementById('trigger')
  trigger?.focus()
  await userEvent.keyboard('{Enter}')
  await settle(150)
  return onAction
}

afterEach(() => resetUi())

describe('Menu', () => {
  it('opens from the keyboard on the first row and moves with the arrows', async () => {
    await openMenu()
    expect(menus()).toHaveLength(1)
    expect(highlighted()).toContain('Play from here')
    await userEvent.keyboard('{ArrowDown}')
    expect(highlighted()).toContain('Repeat')
    await userEvent.keyboard('{ArrowDown}')
    expect(highlighted()).toContain('Bookmark')
    await userEvent.keyboard('{End}')
    expect(highlighted()).toContain('Copy') // the disabled last row is skipped
    await userEvent.keyboard('{Home}')
    expect(highlighted()).toContain('Play from here')
    await userEvent.keyboard('{ArrowUp}')
    expect(highlighted()).toContain('Copy') // loops
  })

  it('jumps by typeahead to a label (never to a shortcut hint)', async () => {
    await openMenu()
    await userEvent.keyboard('c')
    expect(highlighted()).toContain('Copy')
    await settle(1100) // the typeahead buffer clears
    await userEvent.keyboard('b')
    expect(highlighted()).toContain('Bookmark')
    await settle(1100)
    await userEvent.keyboard('fol')
    expect(highlighted()).toContain('Follow recitation')
  })

  it('runs a command on Enter, closes and returns focus to the trigger', async () => {
    const onAction = await openMenu()
    await userEvent.keyboard('b')
    await userEvent.keyboard('{Enter}')
    await settle(200)
    expect(onAction).toHaveBeenCalledWith('bookmark')
    expect(menus()).toHaveLength(0)
    expect(document.activeElement?.id).toBe('trigger')
  })

  it('toggles checkbox rows and picks radio rows', async () => {
    const onAction = await openMenu()
    await userEvent.keyboard('fol')
    await userEvent.keyboard('{Enter}')
    expect(onAction).toHaveBeenCalledWith('follow-true')
    await settle(1100) // the typeahead buffer clears
    document.getElementById('trigger')?.focus()
    await userEvent.keyboard('{Enter}')
    await settle(150)
    await userEvent.keyboard('gr')
    expect(highlighted()).toContain('Green')
    await userEvent.keyboard('{Enter}')
    expect(onAction).toHaveBeenCalledWith('highlight-green')
    await settle(250)
    const radios = document.querySelectorAll('[role="menuitemradio"]')
    expect(radios.length).toBe(0) // closed after the choice
  })

  it('opens submenus with ArrowRight in LTR and closes them with ArrowLeft', async () => {
    const onAction = await openMenu()
    await userEvent.keyboard('{ArrowDown}') // Repeat
    await userEvent.keyboard('{ArrowRight}')
    await settle(150)
    expect(menus()).toHaveLength(2)
    expect(highlighted()).toContain('This ayah ×3')
    await userEvent.keyboard('{ArrowLeft}')
    await settle(150)
    expect(menus()).toHaveLength(1)
    await userEvent.keyboard('{ArrowRight}')
    await settle(150)
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onAction).toHaveBeenCalledWith('repeat-5')
  })

  it('mirrors submenu keys in RTL: ArrowLeft opens, ArrowRight closes', async () => {
    setUi('ar')
    await openMenu()
    expect(menus()[0]?.getAttribute('dir')).toBe('rtl')
    await userEvent.keyboard('{ArrowDown}')
    await userEvent.keyboard('{ArrowLeft}')
    await settle(150)
    expect(menus()).toHaveLength(2)
    const [main, sub] = [...menus()].map((m) => m.getBoundingClientRect())
    expect((sub?.right ?? 0) <= (main?.left ?? 0) + 8).toBe(true) // the submenu opens to the left
    await userEvent.keyboard('{ArrowRight}')
    await settle(150)
    expect(menus()).toHaveLength(1)
  })

  it('does not run disabled rows', async () => {
    const onAction = await openMenu()
    const disabled = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Can not do this'),
    )
    expect(disabled?.hasAttribute('data-disabled')).toBe(true)
    disabled?.click()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('counts as a floating layer while open and closes on Escape', async () => {
    await openMenu()
    expect(ui.floating).toBe(1)
    await userEvent.keyboard('{Escape}')
    await settle(150)
    expect(menus()).toHaveLength(0)
    expect(ui.floating).toBe(0)
    expect(document.activeElement?.id).toBe('trigger')
  })
})

describe('ContextMenu at a point', () => {
  it('opens at the point, and typing b moves to "Bookmark" without toggling a bookmark (§7.7)', async () => {
    const uninstall = installShortcuts()
    const toggleBookmark = spyShortcut(['b'], { scope: 'reader', labelKey: 'shortcuts.study.bookmark' })
    const onAction = vi.fn()
    const onClose = vi.fn()
    await render(MenuHarness, { props: { mode: 'context', onAction, onClose, at: { x: 200, y: 120 } } })
    await settle(150)
    const menu = menus()[0]
    expect(menu).toBeDefined()
    const box = menu?.getBoundingClientRect()
    expect(Math.round(box?.left ?? 0)).toBeGreaterThanOrEqual(200)
    expect(Math.round(box?.top ?? 0)).toBeGreaterThanOrEqual(118)
    expect(menu?.getAttribute('aria-label')).toBe('Ayah 2:255')
    expect(ui.layerOpen).toBe(true)

    await userEvent.keyboard('b')
    expect(highlighted()).toContain('Bookmark')
    expect(toggleBookmark).not.toHaveBeenCalled()

    await userEvent.keyboard('{Enter}')
    await settle(150)
    expect(onAction).toHaveBeenCalledWith('bookmark')
    expect(onClose).toHaveBeenCalledOnce()
    uninstall()
  })

  it('returns focus to where it was when it closes', async () => {
    const onClose = vi.fn()
    const screen = await render(MenuHarness, {
      props: { mode: 'context', onAction: vi.fn(), onClose, at: null },
    })
    const before = document.getElementById('before')
    before?.focus()
    await screen.rerender({ at: { x: 100, y: 100 } })
    await settle(150)
    expect(menus()).toHaveLength(1)
    expect(before).not.toBe(document.activeElement)
    await userEvent.keyboard('{Escape}')
    await screen.rerender({ at: null })
    await settle(150)
    expect(onClose).toHaveBeenCalled()
    expect(document.activeElement).toBe(before)
    expect(ui.floating).toBe(0)
  })

  it('opens to the left of the point in RTL', async () => {
    setUi('ar')
    await render(MenuHarness, { props: { mode: 'context', onAction: vi.fn(), at: { x: 700, y: 100 } } })
    await settle(150)
    const box = menus()[0]?.getBoundingClientRect()
    expect(Math.round(box?.right ?? 9999)).toBeLessThanOrEqual(700)
  })
})
