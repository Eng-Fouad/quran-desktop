/**
 * `ui` store behaviour that needs runes in the test itself (`$effect.root`), hence the `.svelte.test.ts` name.
 */
import { flushSync } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui } from './ui.svelte'

vi.mock('svelte-sonner', () => {
  const toast = Object.assign(() => 0, {
    error: () => 0,
    warning: () => 0,
    success: () => 0,
    dismiss: () => {},
  })
  return { toast }
})

afterEach(() => {
  ui.reset()
})

describe('ui store inside effects', () => {
  it('never makes an effect depend on the toast list or the floating counter', () => {
    let runs = 0
    const stop = $effect.root(() => {
      $effect(() => {
        runs++
        ui.toast({ message: 'from an effect' })
        ui.toastUndo('undoable', () => {})
        ui.pushFloating()
        ui.popFloating()
      })
    })
    flushSync()
    flushSync()
    expect(runs).toBe(1)
    expect(ui.toasts.length).toBe(2)
    stop()
  })
})
