/**
 * App and view shortcuts owned by app.ts: palette, search, shortcut sheet, settings, downloads, Escape, toasts, UI
 * scale, sidebar and side pane, sidebar tabs, theme, full screen. The `shortcuts` store registers this list in its
 * `init`.
 *
 * Imports L0 stores only (by file: the `shortcuts` store imports this module). Reader-specific steps belong to the
 * reader's own definitions: the `Escape` here closes layers, hides a sidebar floating over a narrow window, leaves a
 * non-reader view and leaves zen; clearing the selection or the search hit is a reader-scoped `Escape`, which wins by
 * scope precedence while it applies.
 *
 * While the Settings dialog is open only `SETTINGS_ALLOWED` and the audio group run (the `shortcuts` store consumes the
 * other global ones), `Mod+F` focuses "Search settings", and `Mod+,` closes the dialog. The macOS app menu's
 * "Settings…" (`settings-requested`, which the `shortcuts` store hears) runs `settingsFromMenu`.
 */
import { SETTING_LIMITS } from '$lib/contracts/settings'
import type { ShortcutDef } from '$lib/contracts/shortcuts'
import type { ShortcutLabelKey } from '$lib/contracts/i18n'
import type { SidebarTab, ThemeMode } from '$lib/ipc/bindings'
import { app } from '$lib/stores/app.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { FOCUS_TARGETS, inDialog, ui } from '$lib/stores/ui.svelte'

/** `Mod+Shift+L`: paper → sepia → night → black → paper. `system` and high contrast continue from what shows. */
export const THEME_CYCLE = ['paper', 'sepia', 'night', 'black'] as const satisfies readonly ThemeMode[]

/** `Mod+Digit1` … `Mod+Digit7`, in rail order. */
export const SIDEBAR_TAB_KEYS: readonly (readonly [SidebarTab, ShortcutLabelKey])[] = [
  ['index', 'shortcuts.view.tabIndex'],
  ['search', 'shortcuts.view.tabSearch'],
  ['bookmarks', 'shortcuts.view.tabBookmarks'],
  ['highlights', 'shortcuts.view.tabHighlights'],
  ['notes', 'shortcuts.view.tabNotes'],
  ['history', 'shortcuts.view.tabHistory'],
  ['memorize', 'shortcuts.view.tabMemorize'],
]

/** The next theme of the `Mod+Shift+L` cycle. */
export function nextTheme(): ThemeMode {
  const { theme } = settings.value
  const shown: string = theme === 'system' ? settings.resolvedTheme : theme
  const i = (THEME_CYCLE as readonly string[]).indexOf(shown)
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length] ?? 'paper'
}

/** UI scale: ±10 % within 80–200 %, or back to 100 %. */
export function stepUiScale(direction: -1 | 0 | 1): void {
  const { min, max, step } = SETTING_LIMITS.uiScalePct
  const current = settings.value.uiScalePct
  const next =
    direction === 0 ? 100 : Math.min(max, Math.max(min, Math.round(current / step) * step + direction * step))
  if (next !== current) void settings.update({ uiScalePct: next })
}

/**
 * The shortcuts that run while the Settings dialog is open (`ui.settingsOpen`), with the whole audio group. The
 * other global ones (`Mod+B`, `Mod+1…7`, F6, `?`, `Mod+G`) are consumed and do nothing: what they act on (the sidebar
 * and its tabs, the toasts, the reader) is under the dialog, and a chord left to the webview could open its own find
 * bar (`Mod+G`). Reader-scoped keys (`Mod+I`, the page keys) never match outside the reader, so they are left alone.
 */
export const SETTINGS_ALLOWED: ReadonlySet<string> = new Set([
  'app.palette',
  'app.search',
  'app.escape',
  'app.settings',
  'app.downloads',
  'view.theme',
  'view.uiScaleUp',
  'view.uiScaleDown',
  'view.uiScaleReset',
  'view.fullscreen',
])

/** Whether `def` runs while the Settings dialog is open. */
export function allowedInSettings(def: ShortcutDef): boolean {
  return def.group === 'audio' || SETTINGS_ALLOWED.has(def.id)
}

/** A sidebar floating over the canvas (narrow window) is open: Escape hides it before anything else in the shell. */
function overlaySidebarShown(): boolean {
  return ui.sidebarOverlay && ui.sidebarOpen
}

/** `Mod+,` and the rail button: open Settings, or close the dialog (Settings or About) when it shows. */
export function toggleSettings(): void {
  ui.setView(inDialog(ui.view) ? 'reader' : 'settings')
}

/**
 * Where `Mod+,` acts: over no other layer (a confirmation, the note editor, the onboarding, an open listbox or popover,
 * a sheet), since the dialog sits under every overlay; the palette alone is the exception (it closes first), and only
 * while the dialog does not show.
 */
function settingsKeyHolds(): boolean {
  return !ui.layerOpen || (paletteAlone() && !inDialog(ui.view))
}

/**
 * The macOS app menu's "Settings…" (⌘,, `settings-requested`): opens Settings where `Mod+,` would, and, a menu command
 * rather than a toggle, leaves the dialog open when it shows Settings (About turns to Settings). WKWebView offers ⌘, to
 * the page first and hands it to the menu only when the page left it unhandled, that is where `Mod+,` declined; the
 * request declines there too, so a key press never acts twice.
 */
export function settingsFromMenu(): void {
  if (ui.view === 'settings' || !settingsKeyHolds()) return
  if (ui.isTop('palette')) ui.close('palette')
  ui.setView('settings')
}

/**
 * The palette is the one layer up (its own dialog counts as one floating and one modal layer; a popover, menu or sheet
 * under it adds another): once it closes nothing is left, so `Mod+,`, or the palette's "Settings" row, which runs after
 * the palette has closed, can show the dialog.
 */
function paletteAlone(): boolean {
  return (
    ui.isTop('palette') &&
    ui.overlays.length === 1 &&
    ui.floating <= 1 &&
    ui.modals <= 1 &&
    ui.contextMenu === null
  )
}

/**
 * `Mod+F`: "Search settings" while the Settings dialog is open (About turns back to Settings for it), else the
 * sidebar's Search tab. Either way a palette or Go to on top closes first.
 */
function search(): void {
  if (!ui.settingsOpen) {
    ui.focusSearch()
    return
  }
  const top = ui.topOverlay?.kind
  if (top === 'palette' || top === 'goto') ui.close(top)
  if (ui.view === 'about') ui.setView('settings')
  void ui.focusWhenRendered(FOCUS_TARGETS.settingsSearch)
}

/**
 * `Escape`: close the top layer → else hide a sidebar floating over the canvas → else return to the reader →
 * else leave zen.
 */
function escape(): void {
  if (ui.layerOpen) ui.dismissLayer()
  else if (overlaySidebarShown()) ui.closeSidebar()
  else if (ui.view !== 'reader') ui.setView('reader')
  else ui.setZen(false)
}

export const appShortcuts: readonly ShortcutDef[] = [
  {
    id: 'app.palette',
    keys: ['Mod+k'],
    group: 'app',
    labelKey: 'shortcuts.app.palette',
    scope: 'global',
    capture: true,
    allowInInput: true,
    run: () => ui.open('palette', {}),
  },
  {
    id: 'app.search',
    keys: ['Mod+f'],
    group: 'app',
    labelKey: 'shortcuts.app.search',
    scope: 'global',
    capture: true,
    allowInInput: true,
    run: search,
  },
  {
    id: 'app.shortcutSheet',
    keys: ['?'],
    group: 'app',
    labelKey: 'shortcuts.app.shortcutSheet',
    scope: 'global',
    run: () => ui.open('shortcuts', {}),
  },
  {
    id: 'app.settings',
    keys: ['Mod+,'],
    group: 'app',
    labelKey: 'shortcuts.app.settings',
    scope: 'global',
    capture: true,
    // It closes the dialog from "Search settings" too, yet never acts over another layer (`settingsKeyHolds`). The
    // palette alone is the exception, as for Mod+F: the key (or its "Settings" row) closes it first. The palette offers
    // that row only where it would run: not over another layer, nor while the dialog shows.
    allowInInput: true,
    when: settingsKeyHolds,
    run: () => {
      if (ui.isTop('palette')) ui.close('palette')
      toggleSettings()
    },
  },
  {
    id: 'app.downloads',
    keys: ['Mod+Shift+d'],
    group: 'app',
    labelKey: 'shortcuts.app.downloads',
    scope: 'global',
    capture: true,
    run: () => ui.setView('downloads'),
  },
  {
    id: 'app.escape',
    keys: ['Escape'],
    group: 'app',
    labelKey: 'shortcuts.app.escape',
    scope: 'global',
    capture: true,
    allowInInput: true,
    when: () => ui.layerOpen || overlaySidebarShown() || ui.view !== 'reader' || ui.zen,
    run: escape,
  },
  {
    id: 'app.focusToasts',
    keys: ['F6', 'Mod+Shift+u'],
    group: 'app',
    labelKey: 'shortcuts.app.focusToasts',
    scope: 'global',
    run: () => void ui.focusToasts(),
  },
  {
    id: 'view.uiScaleUp',
    keys: ['Mod+Shift+='],
    group: 'view',
    labelKey: 'shortcuts.view.uiScaleUp',
    scope: 'global',
    // The UI scale and theme chords type nothing, so they also run from a field or over a layer: Settings opens on
    // "Search settings", and its rows name these keys.
    allowInInput: true,
    repeat: true,
    run: () => stepUiScale(1),
  },
  {
    id: 'view.uiScaleDown',
    keys: ['Mod+Shift+-'],
    group: 'view',
    labelKey: 'shortcuts.view.uiScaleDown',
    scope: 'global',
    allowInInput: true,
    repeat: true,
    run: () => stepUiScale(-1),
  },
  {
    id: 'view.uiScaleReset',
    keys: ['Mod+Shift+Digit0'],
    group: 'view',
    labelKey: 'shortcuts.view.uiScaleReset',
    scope: 'global',
    allowInInput: true,
    run: () => stepUiScale(0),
  },
  {
    id: 'view.sidebar',
    keys: ['Mod+b'],
    group: 'view',
    labelKey: 'shortcuts.view.sidebar',
    scope: 'global',
    run: () => ui.toggleSidebar(),
  },
  {
    id: 'view.sidePane',
    keys: ['Mod+i'],
    group: 'view',
    labelKey: 'shortcuts.view.sidePane',
    scope: 'reader',
    run: () => ui.toggleSidePane(),
  },
  ...SIDEBAR_TAB_KEYS.map(([tab, labelKey], i): ShortcutDef => ({
    id: `view.sidebarTab.${tab}`,
    keys: [`Mod+Digit${i + 1}`],
    group: 'view',
    labelKey,
    scope: 'global',
    run: () => ui.toggleSidebar(tab),
  })),
  {
    id: 'view.theme',
    keys: ['Mod+Shift+l'],
    group: 'view',
    labelKey: 'shortcuts.view.theme',
    scope: 'global',
    allowInInput: true,
    run: () => void settings.update({ theme: nextTheme() }),
  },
  {
    id: 'view.fullscreen',
    // F11 on Windows/Linux; ⌃⌘F on macOS (F11 shows the desktop there).
    get keys() {
      return app.isMac ? ['Mod+Ctrl+f'] : ['F11']
    },
    group: 'view',
    labelKey: 'shortcuts.view.fullscreen',
    scope: 'global',
    capture: true,
    run: () => void ui.toggleFullscreen(),
  },
]
