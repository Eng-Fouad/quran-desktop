/**
 * Dialog and Sheet (§9.5, §7.4): focus trap, initial focus, Escape and outside dismissal, focus restoration, the
 * accessible name and description, and the floating-layer registration that pauses shortcuts (§7.7 rule 1).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-svelte'
import '../../app.css'
import { ui } from '$lib/stores/ui.svelte'
import DialogHarness from './testing/DialogHarness.svelte'
import { installShortcuts, resetUi, setUi, settle, spyShortcut } from './testing/harness'

const byId = (id: string) => document.getElementById(id)
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')

async function openDialog(props: Record<string, unknown> = {}): Promise<void> {
  await render(DialogHarness, { props })
  await userEvent.click(byId('open') as HTMLElement)
  // Past the enter transition (sheets slide for --dur-slow).
  await settle(420)
}

afterEach(() => resetUi())

describe('Dialog', () => {
  it('names itself from the title and description, and starts on the first body control', async () => {
    await openDialog()
    const el = dialog()
    expect(el).not.toBeNull()
    const labelledBy = el?.getAttribute('aria-labelledby') ?? ''
    const describedBy = el?.getAttribute('aria-describedby') ?? ''
    expect(byId(labelledBy)?.textContent).toBe('Rename collection')
    expect(byId(describedBy)?.textContent).toBe('Names show in the library.')
    expect(document.activeElement?.id).toBe('name')
  })

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    await openDialog()
    const el = dialog()
    const visited: string[] = []
    for (let i = 0; i < 7; i++) {
      await userEvent.tab()
      expect(el?.contains(document.activeElement)).toBe(true)
      visited.push(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.id ?? '?')
    }
    // Body → footer → header close button → body again: the cycle wraps without escaping.
    expect(visited.slice(0, 4), visited.join(' ')).toEqual(['Details', 'cancel', 'save', 'Close'])
    expect(visited[4]).toBe('Name')
    for (let i = 0; i < 7; i++) {
      await userEvent.tab({ shift: true })
      expect(el?.contains(document.activeElement)).toBe(true)
    }
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    await openDialog()
    await userEvent.keyboard('{Escape}')
    await settle(300)
    expect(dialog()).toBeNull()
    expect(document.activeElement?.id).toBe('open')
  })

  it('closes on an outside click unless it is not dismissible', async () => {
    await openDialog()
    // The backdrop covers the page: a click in the corner lands on it, outside the dialog.
    await userEvent.click(document.body, { position: { x: 5, y: 5 } })
    await settle(300)
    expect(dialog()).toBeNull()
  })

  it('stays open on Escape and outside clicks when not dismissible', async () => {
    await openDialog({ dismissible: false })
    await userEvent.keyboard('{Escape}')
    await userEvent.click(document.body, { position: { x: 5, y: 5 } })
    await settle(300)
    expect(dialog()).not.toBeNull()
    await userEvent.click(byId('cancel') as HTMLElement)
    await settle(300)
    expect(dialog()).toBeNull()
  })

  it('closes from the header close button', async () => {
    await openDialog()
    const close = dialog()?.querySelector<HTMLElement>('button[aria-label="Close"]')
    expect(close).not.toBeNull()
    await userEvent.click(close as HTMLElement)
    await settle(300)
    expect(dialog()).toBeNull()
    expect(document.activeElement?.id).toBe('open')
  })

  it('adds no landmark: its header and footer are no banner or contentinfo (HTML-AAM)', async () => {
    await openDialog()
    const el = dialog() as HTMLElement
    expect(el.querySelector('.header')).not.toBeNull()
    expect(el.querySelector('.footer')).not.toBeNull()
    // `header`/`footer` outside article/aside/main/nav/section are page landmarks (axe: landmark-no-duplicate-banner).
    expect(el.querySelectorAll('header, footer, [role="banner"], [role="contentinfo"]')).toHaveLength(0)
  })

  it('runs footer actions', async () => {
    const onSave = vi.fn()
    await openDialog({ onSave })
    await userEvent.click(byId('save') as HTMLElement)
    await settle(300)
    expect(onSave).toHaveBeenCalledOnce()
    expect(dialog()).toBeNull()
  })

  it('stacks a select opened inside it above its own layer, where clicks reach the options', async () => {
    await openDialog({ select: true })
    await userEvent.click(byId('colour') as HTMLElement)
    await settle(200)
    const listbox = document.querySelector<HTMLElement>('.qd-listbox')
    expect(listbox).not.toBeNull()
    const z = (el: Element | null) => Number(el ? getComputedStyle(el).zIndex : NaN)
    const backdrop = document.querySelector('.backdrop')
    expect(z(listbox?.parentElement ?? null)).toBeGreaterThan(z(backdrop))
    const box = listbox?.getBoundingClientRect() ?? new DOMRect()
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    expect(listbox?.contains(hit)).toBe(true)
    await userEvent.click([...(listbox?.querySelectorAll('[role="option"]') ?? [])][1] as HTMLElement)
    await settle(120)
    expect(byId('colour')?.textContent).toContain('Gold')
    expect(dialog()).not.toBeNull()
  })

  it('counts as a layer while open, so reader shortcuts pause (§7.7 rule 1)', async () => {
    const uninstall = installShortcuts()
    const nextPage = spyShortcut(['ArrowLeft'], { scope: 'reader', labelKey: 'shortcuts.nav.nextPage' })
    await openDialog()
    expect(ui.floating).toBe(1)
    expect(ui.layerOpen).toBe(true)
    byId('save')?.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(nextPage).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    await settle(300)
    expect(ui.floating).toBe(0)
    uninstall()
  })
})

describe('Sheet', () => {
  it('traps focus, closes on Escape and restores focus', async () => {
    await openDialog({ kind: 'sheet' })
    const el = dialog()
    expect(el).not.toBeNull()
    expect(document.activeElement?.id).toBe('name')
    for (let i = 0; i < 5; i++) {
      await userEvent.tab()
      expect(el?.contains(document.activeElement)).toBe(true)
    }
    expect(ui.floating).toBe(1)
    await userEvent.keyboard('{Escape}')
    await settle(400)
    expect(dialog()).toBeNull()
    expect(document.activeElement?.id).toBe('open')
    expect(ui.floating).toBe(0)
  })

  it('starts on the first enabled control when the first one is a disabled icon button', async () => {
    await openDialog({ kind: 'sheet', disabledFirst: true })
    const previous = byId('previous') as HTMLButtonElement
    expect(previous.disabled).toBe(true)
    // A disabled button carries no tab stop, even as a tooltip trigger.
    expect(previous.hasAttribute('tabindex')).toBe(false)
    expect(document.activeElement?.id).toBe('name')
    expect(dialog()?.contains(document.activeElement)).toBe(true)
  })

  it('holds focus itself when nothing inside can take it', async () => {
    await openDialog({ kind: 'sheet', onlyDisabled: true })
    const el = dialog()
    expect(el).not.toBeNull()
    expect(el?.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.id).not.toBe('open')
  })

  it('sits at the inline end: the right edge in LTR', async () => {
    await openDialog({ kind: 'sheet' })
    const box = dialog()?.getBoundingClientRect()
    expect(Math.abs((box?.right ?? 0) - document.documentElement.clientWidth)).toBeLessThan(1)
  })

  it('sits at the inline end: the left edge in RTL', async () => {
    setUi('ar')
    await openDialog({ kind: 'sheet' })
    const el = dialog()
    expect(el?.getAttribute('dir')).toBe('rtl')
    expect(Math.abs(el?.getBoundingClientRect().left ?? -1)).toBeLessThan(1)
  })
})
