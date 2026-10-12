/**
 * Shared helpers for the WP7b browser tests: the UI language and theme on `<html>` and in the settings store, the real
 * shortcut listeners with spy definitions (the §7.7 widget-guard tests), and frame waits.
 */
import { vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { ShortcutDef, ShortcutLabelKey, ShortcutScope } from '$lib/contracts'
import type { Bootstrap } from '$lib/ipc/bindings'
import { settings } from '$lib/stores/settings.svelte'
import { shortcuts } from '$lib/stores/shortcuts.svelte'
import { ui } from '$lib/stores/ui.svelte'

/** UI language (drives `i18n.dir`, which every primitive passes to bits-ui) and theme, as the settings store would. */
export function setUi(lang: 'en' | 'ar', theme = 'paper'): void {
  const html = document.documentElement
  html.lang = lang
  html.dir = lang === 'ar' ? 'rtl' : 'ltr'
  html.dataset.theme = theme
  html.dataset.accent = 'teal'
  settings.value = { ...settings.value, uiLanguage: lang }
}

/** Two animation frames plus `ms`: Svelte effects, bits-ui positioning and short transitions have settled. */
export async function settle(ms = 50): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Rests the mouse in the bottom-right corner of the page, away from where the listboxes and menus under test open. The
 * mouse is shared by every test file of a browser session: left where one of them opens, it can hover a row as it
 * appears (a WebKit run once highlighted the third row of a Select just opened with the keyboard), and the highlighted
 * row is the mouse's, not the keyboard's.
 */
export async function parkPointer(): Promise<void> {
  await userEvent.hover(document.body, { position: { x: innerWidth - 4, y: innerHeight - 4 } })
}

/** Installs the real capture and bubble listeners (§7.7) with the app definitions; returns the uninstaller. */
export function installShortcuts(): () => void {
  shortcuts.init({} as Bootstrap)
  return () => shortcuts.reset()
}

/** Registers a spy definition (a reader shortcut stand-in) and returns its `run` mock. */
export function spyShortcut(
  keys: string[],
  options: { scope?: ShortcutScope; labelKey?: ShortcutLabelKey; id?: string } = {},
): ReturnType<typeof vi.fn<(e: KeyboardEvent) => void>> {
  const run = vi.fn<(e: KeyboardEvent) => void>()
  const def: ShortcutDef = {
    id: options.id ?? `test.${keys.join('+')}`,
    keys,
    group: 'study',
    labelKey: options.labelKey ?? 'shortcuts.study.bookmark',
    scope: options.scope ?? 'global',
    run,
  }
  shortcuts.register([def])
  return run
}

/** Back to the English UI, no layers and no shortcuts. */
export function resetUi(): void {
  shortcuts.reset()
  ui.reset()
  setUi('en')
}
