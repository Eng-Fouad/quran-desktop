/**
 * App and view shortcuts of §10.1 owned by app.ts: palette, search, shortcut sheet, settings, downloads, Escape,
 * toasts, UI scale, sidebar and side pane, sidebar tabs, theme, full screen. Owner: WP0E → WP7c. The `shortcuts` store
 * registers this list in its `init`.
 *
 * Imports L0 stores only (by file: the `shortcuts` store imports this module). Reader-specific steps belong to the
 * reader's own definitions: the `Escape` here closes layers, hides a sidebar floating over a narrow window, leaves a
 * non-reader view and leaves zen; clearing the selection or the search hit is a reader-scoped `Escape` (WP8e), which
 * wins by scope precedence while it applies.
 */
import { SETTING_LIMITS } from '$lib/contracts/settings'
import type { ShortcutDef } from '$lib/contracts/shortcuts'
import type { ShortcutLabelKey } from '$lib/contracts/i18n'
import type { SidebarTab, ThemeMode } from '$lib/ipc/bindings'
import { app } from '$lib/stores/app.svelte'
import { settings } from '$lib/stores/settings.svelte'
import { ui } from '$lib/stores/ui.svelte'

/** `Mod+Shift+L` (§10.1): paper → sepia → night → black → paper. `system` and high contrast continue from what shows. */
export const THEME_CYCLE = ['paper', 'sepia', 'night', 'black'] as const satisfies readonly ThemeMode[]

/** `Mod+Digit1` … `Mod+Digit7` (§10.1), in rail order. */
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

/** UI scale (D27): ±10 % within 80–200 %, or back to 100 %. */
export function stepUiScale(direction: -1 | 0 | 1): void {
  const { min, max, step } = SETTING_LIMITS.uiScalePct
  const current = settings.value.uiScalePct
  const next =
    direction === 0 ? 100 : Math.min(max, Math.max(min, Math.round(current / step) * step + direction * step))
  if (next !== current) void settings.update({ uiScalePct: next })
}

/** A sidebar floating over the canvas (narrow window, §9.6) is open: Escape hides it before anything else in the shell. */
function overlaySidebarShown(): boolean {
  return ui.sidebarOverlay && ui.sidebarOpen
}

/**
 * `Escape` (§10.1): close the top layer → else hide a sidebar floating over the canvas → else return to the reader →
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
    run: () => ui.focusSearch(),
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
    run: () => ui.setView('settings'),
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
    repeat: true,
    run: () => stepUiScale(1),
  },
  {
    id: 'view.uiScaleDown',
    keys: ['Mod+Shift+-'],
    group: 'view',
    labelKey: 'shortcuts.view.uiScaleDown',
    scope: 'global',
    repeat: true,
    run: () => stepUiScale(-1),
  },
  {
    id: 'view.uiScaleReset',
    keys: ['Mod+Shift+Digit0'],
    group: 'view',
    labelKey: 'shortcuts.view.uiScaleReset',
    scope: 'global',
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
