/**
 * `ui` store (§7.3, §7.4, §9.6): the canvas view, the overlay stack, floating layers, the context menu, panes, zen and
 * full screen, toasts, the live region and deep-navigation routing. Owner: WP0E → WP7c. Layer L0 (imports `app`,
 * `settings`, `i18n`).
 *
 * - **Overlays** (§7.4) form a stack; `open(kind, props)` moves a kind to the top (opening `palette` while it is on top
 *   closes it). `confirm(opts)` resolves `true` only through `resolveConfirm(true)`; any other way the confirm overlay
 *   closes resolves `false`.
 * - **Floating layers** (menus, popovers, open listboxes) are counted by the `src/components/ui` wrappers through
 *   `pushFloating()/popFloating()`; with the context menu and the overlays they make `layerOpen` (§7.7 rule 1).
 * - **The Settings dialog** (§7.4): the `settings` and `about` views show in a dialog over the reader (`inDialog`),
 *   whose host registers `settingsOpen` (the shortcut allow-list of §7.7) instead of a floating layer, and closes the
 *   floating layers still open as it opens (`dismissFloating`).
 * - **Panes** (§9.6): `sidebarOpen`, `sidePaneOpen`, `paneDocked` and `paneWidthPx` come from the settings and the
 *   window size through `shellLayout()` (side-pane docking with sidebar auto-collapse, then pane shrinking, then the
 *   overlay sheet). The Downloads manager hides the sidebar; opening it (`openSidebar`) returns to the reader.
 * - **Toasts** pass through to svelte-sonner (rendered by the shell's `Toaster`) with the §9.5 durations: 5 s, or at
 *   least 10 s with an action. `toastError(e)` shows the localised `errors.<kind>` message (never the raw developer
 *   message); `toastUndo(message, undo)` is the undo toast of every library change (one at a time). The overlays at
 *   the canvas's bottom centre (§7.5's slot: "Return to recitation", the division and hint chips, the memorisation
 *   bars) publish how far up they reach (`setOverlayReach`), and the toaster stays above `overlayReach`.
 * - **Zen** (§9.6): `pointerIdle` (cursor and turn zones hidden after 2.5 s), `zenDock` / `zenTitleBar` (revealed at the
 *   window edges, or the dock by an audio key through `pokeDock()`), fed by the shell's pointer listener.
 * - **Drafts**: `draft/setDraft/clearDraft` keep unsaved editor text (the note editor's autosave, §10.1).
 * - **Deep navigation** (§7.4): `navigate(target)` switches the view; ayah, page, surah and search targets go to the
 *   handlers registered with `onNavigate()` (reader, search: L1/L2 stores this store cannot import), and a target that
 *   arrives before any handler exists (a tray click during startup) is delivered when one registers.
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tick, untrack } from 'svelte'
import { toast as sonner } from 'svelte-sonner'
import type { ConfirmOptions, OverlayEntry, OverlayKind, OverlayProps } from '$lib/contracts/overlays'
import { defaultSettings, SETTING_LIMITS } from '$lib/contracts/settings'
import type { ContextMenuTarget, Store, ToastOptions } from '$lib/contracts/stores'
import { events, toAppError } from '$lib/ipc'
import type {
  AppView,
  Bootstrap,
  NavTarget,
  SidebarSettings,
  SidebarTab,
  SidePaneSettings,
  SidePaneTab,
} from '$lib/ipc/bindings'
import { paneCanDock } from '$lib/mushaf/geometry'
import { listenEvent } from './app.svelte'
import { i18n } from './i18n.svelte'
import { settings } from './settings.svelte'

/** Fixed shell measures (§9.6): the title bar height and the nav rail width, in CSS px. */
export const TITLEBAR_H = 40
export const RAIL_W = 52
/** Below this window width the sidebar overlays the canvas instead of taking width from it (§9.6). */
export const SIDEBAR_OVERLAY_BELOW = 900

/** Toast durations (§9.5): 5 s, or at least 10 s when the toast carries an action (Undo). */
export const TOAST_MS = 5_000
export const TOAST_ACTION_MIN_MS = 10_000
/** How many toasts the store remembers (the toaster shows fewer). */
const TOAST_HISTORY = 20

/** Elements other packages mark so `ui` can move focus to them (`data-qd-focus`). */
export const FOCUS_TARGETS = {
  /** The sidebar search input (WP10b): `Mod+F` focuses and selects it. */
  search: '[data-qd-focus="search"]',
  /** "Search settings" (WP12b): `Mod+F` focuses it while the Settings dialog is open. */
  settingsSearch: '[data-settings-search]',
  /** The Downloads manager's heading (WP12a): it takes focus when the manager opens. */
  downloads: '[data-qd-focus="downloads"]',
} as const

/**
 * The reading cursor's roving tab stop (§8.15): the Mushaf's accessible ayah item (`.mp-a11y`), or translation mode's
 * verse row (TranslationView). Only one reader body is mounted at a time.
 */
const CURSOR_TAB_STOP =
  '.mp-a11y li[tabindex="0"], [data-qd-view="translation"] article[data-qd-ayah][tabindex="0"]'

/**
 * "Skip to Quran text" (§8.15), and every other "back to the reading cursor" (the Downloads manager closing, Escape
 * on the canvas's "Aa" button): the reading cursor's roving item (`CURSOR_TAB_STOP`), else the Mushaf's first ayah
 * item, else the canvas.
 */
export function readingCursor(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(CURSOR_TAB_STOP) ??
    document.querySelector<HTMLElement>('.mp-a11y li') ??
    document.getElementById('qd-main')
  )
}

/**
 * Views shown in the shell's Settings dialog over the reader, which stays mounted under it (§7.4; owner request
 * 2026-10-11), rather than in place of the canvas: Settings, and About in the same frame.
 */
export function inDialog(view: AppView): boolean {
  return view === 'settings' || view === 'about'
}

/** A toast as queued (rendered by the toaster, WP7c). */
export interface ToastEntry extends ToastOptions {
  id: number
}

/** A deep-navigation handler (`onNavigate`): returns `true` when it handled the target. */
export type NavigateHandler = (target: NavTarget) => boolean

export interface ShellInput {
  windowW: number
  windowH: number
  zen: boolean
  sidebar: SidebarSettings
  sidePane: SidePaneSettings
  /** The user reopened the sidebar while the side pane had collapsed it: keep it, shrink or overlay the pane instead. */
  sidebarForced: boolean
  /**
   * Below 900 px the sidebar floats over the canvas, and whether it is shown is session state (default closed), so a
   * narrow window never starts with the page covered; `sidebar.open` is the docked preference. Default `false`.
   */
  overlaySidebarOpen?: boolean
  /**
   * The Downloads manager shows (`ui.view === 'downloads'`): it takes the canvas without the sidebar, whose preference
   * is kept for the reader (owner request 2026-10-11). Default `false`.
   */
  manager?: boolean
}

export interface ShellLayout {
  sidebarOpen: boolean
  /** The sidebar floats over the canvas (narrow window). */
  sidebarOverlay: boolean
  /** The open side pane collapsed the sidebar so that it can dock (restored when the pane closes). */
  sidebarAutoCollapsed: boolean
  sidePaneOpen: boolean
  /** The side pane docks beside the canvas; otherwise it overlays as a sheet. */
  paneDocked: boolean
  /** The side pane's width: the setting, shrunk (down to 320 px) when that lets it dock. */
  paneWidthPx: number
}

/** The widest pane in `[min, max]` that docks, or `null` (`paneCanDock` is monotonic in the pane width). */
function widestDockingPane(canvasW: number, canvasH: number, min: number, max: number): number | null {
  return largestPassing(min, max, (w) => paneCanDock(canvasW, canvasH, w))
}

/**
 * §9.6 shell layout. The side pane docks when the canvas keeps room for a single page beside it (`paneCanDock`).
 * Otherwise, in order: (1) collapse an open sidebar if that lets the pane dock (`sidePane.autoCollapseSidebar`),
 * (2) shrink the pane down to 320 px, (3) overlay the pane as a sheet. Zen hides both panes, the Downloads manager the
 * sidebar. Before the window size is known (0 × 0) the pane is assumed to dock.
 */
export function shellLayout(input: ShellInput): ShellLayout {
  const { windowW, windowH, zen, sidebar, sidePane } = input
  const sidebarOverlay = windowW > 0 && windowW < SIDEBAR_OVERLAY_BELOW
  const sidebarWanted =
    (sidebarOverlay ? input.overlaySidebarOpen === true : sidebar.open) && !zen && input.manager !== true
  const sidePaneOpen = sidePane.open && !zen
  const layout: ShellLayout = {
    sidebarOpen: sidebarWanted,
    sidebarOverlay,
    sidebarAutoCollapsed: false,
    sidePaneOpen,
    paneDocked: true,
    paneWidthPx: sidePane.widthPx,
  }
  if (!sidePaneOpen || windowW <= 0 || windowH <= 0) return layout

  const canvasH = windowH - TITLEBAR_H
  const besideRail = windowW - RAIL_W
  const sidebarW = sidebarWanted && !sidebarOverlay ? sidebar.widthPx : 0
  const canvasW = besideRail - sidebarW
  if (paneCanDock(canvasW, canvasH, sidePane.widthPx)) return layout

  if (
    sidebarW > 0 &&
    sidePane.autoCollapseSidebar &&
    !input.sidebarForced &&
    paneCanDock(besideRail, canvasH, sidePane.widthPx)
  ) {
    return { ...layout, sidebarOpen: false, sidebarAutoCollapsed: true }
  }
  const fit = widestDockingPane(canvasW, canvasH, SETTING_LIMITS.sidePaneWidthPx.min, sidePane.widthPx)
  return fit === null ? { ...layout, paneDocked: false } : { ...layout, paneWidthPx: fit }
}

/** How far the splitters may drag right now (px), so a drag never makes the docked side pane undockable (§9.6). */
export interface PaneLimits {
  sidebarMin: number
  sidebarMax: number
  paneMin: number
  paneMax: number
}

/** The largest integer in `[lo, hi]` for which the monotonically decreasing `ok` holds, or `null`. */
function largestPassing(lo: number, hi: number, ok: (v: number) => boolean): number | null {
  if (hi < lo || !ok(lo)) return null
  let a = lo
  let b = hi
  while (a < b) {
    const mid = (a + b + 1) >>> 1
    if (ok(mid)) a = mid
    else b = mid - 1
  }
  return a
}

/**
 * Splitter limits for the current layout: the settings ranges (sidebar 240–420 px, side pane 320–640 px), narrowed while
 * the side pane docks so that neither splitter can push it past the §9.6 docking rule (it would otherwise jump into a
 * sheet mid-drag). The current widths always stay within the limits.
 */
export function paneLimits(input: ShellInput, layout: ShellLayout): PaneLimits {
  const sb = SETTING_LIMITS.sidebarWidthPx
  const sp = SETTING_LIMITS.sidePaneWidthPx
  const limits: PaneLimits = { sidebarMin: sb.min, sidebarMax: sb.max, paneMin: sp.min, paneMax: sp.max }
  if (!layout.sidePaneOpen || !layout.paneDocked || input.windowW <= 0 || input.windowH <= 0) return limits
  const canvasH = input.windowH - TITLEBAR_H
  const besideRail = input.windowW - RAIL_W
  const sidebarW = layout.sidebarOpen && !layout.sidebarOverlay ? input.sidebar.widthPx : 0
  if (sidebarW > 0) {
    const widest = largestPassing(sb.min, sb.max, (s) =>
      paneCanDock(besideRail - s, canvasH, layout.paneWidthPx),
    )
    limits.sidebarMax = Math.max(widest ?? sb.min, Math.min(sb.max, sidebarW))
  }
  const widestPane = widestDockingPane(besideRail - sidebarW, canvasH, sp.min, sp.max)
  limits.paneMax = Math.max(widestPane ?? sp.min, Math.min(sp.max, layout.paneWidthPx))
  return limits
}

const clampTo = (v: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, Math.round(v)))

/** How long the pointer must rest before zen hides the cursor and the turn zones (§9.6). */
export const ZEN_IDLE_MS = 2_500
/** In zen, the dock reappears while the pointer is within this distance of the window's bottom edge (§9.6). */
export const ZEN_DOCK_ZONE_PX = 80
/** In zen, the title bar reappears while the pointer is within the title bar's height of the top edge. */
export const ZEN_TOP_ZONE_PX = TITLEBAR_H
/** How long an audio key keeps the zen dock visible. */
export const ZEN_DOCK_POKE_MS = 3_000

/** localStorage key of the unsaved drafts (per-viewer convenience, never authoritative). */
const DRAFTS_KEY = 'qd-drafts-v1'

class UiStore implements Store {
  view = $state<AppView>('reader')
  overlays = $state.raw<OverlayEntry[]>([])
  /** Open floating layers (menus, popovers, select listboxes), registered by the `ui` wrappers (§7.4). */
  floating = $state(0)
  /** Open modal layers (dialogs and sheets), whose backdrop covers the whole window, the title bar included. */
  modals = $state(0)
  /**
   * The Settings dialog is open (`SettingsDialog`, §7.4). It is neither a floating nor a modal layer: the title bar and
   * the player dock stay usable beside it, and while it is open only its allow-list of shortcuts runs (§7.7).
   */
  settingsOpen = $state(false)
  /** Bumped by `dismissFloating()`: every open floating layer that can close itself does (`trackFloating`). */
  floatingDismissals = $state(0)
  contextMenu = $state.raw<ContextMenuTarget | null>(null)
  zen = $state(false)
  fullscreen = $state(false)
  toasts = $state.raw<ToastEntry[]>([])
  /** The polite announcement (`LiveRegion`, §8.15). */
  announcement = $state('')
  /** The window's CSS size, the input of the §9.6 pane rule. */
  windowSize = $state.raw({ w: 0, h: 0 })

  /** Zen (§9.6): the pointer has rested for `ZEN_IDLE_MS` (the cursor hides; `PageTurnZones` stay hidden). */
  pointerIdle = $state(false)
  /** Zen: the dock is shown (pointer near the bottom edge, or an audio key was just pressed). */
  zenDock = $state(false)
  /** Zen: the title bar is shown (pointer at the top edge). */
  zenTitleBar = $state(false)

  /** How far each bottom-centre canvas overlay reaches above the canvas bottom (CSS px), by source. */
  #overlayReach = $state.raw<Readonly<Record<string, number>>>({})
  /** The highest of them (0 with none shown): toasts sit above it, never over it. */
  readonly overlayReach: number = $derived(Math.max(0, ...Object.values(this.#overlayReach)))

  readonly topOverlay: OverlayEntry | null = $derived(this.overlays.at(-1) ?? null)
  /** An overlay, a floating layer or the context menu is open (§7.7 rule 1). */
  readonly layerOpen = $derived(this.overlays.length > 0 || this.floating > 0 || this.contextMenu !== null)
  /**
   * Whether the title bar's caption buttons can be used (§9.6): not while zen hides the title bar, nor while a modal
   * layer's backdrop covers it. The native Snap Layouts target follows it (`window_set_caption`, `TitleBar`).
   */
  readonly captionVisible = $derived(!(this.zen && !this.zenTitleBar) && this.modals === 0)

  #sidebarForced = $state(false)
  #overlaySidebarOpen = $state(false)
  readonly #shellInput: ShellInput = $derived({
    windowW: this.windowSize.w,
    windowH: this.windowSize.h,
    zen: this.zen,
    sidebar: settings.value.sidebar,
    sidePane: settings.value.sidePane,
    sidebarForced: this.#sidebarForced,
    overlaySidebarOpen: this.#overlaySidebarOpen,
    manager: this.view === 'downloads',
  })
  readonly #shell: ShellLayout = $derived(shellLayout(this.#shellInput))
  readonly sidebarOpen = $derived(this.#shell.sidebarOpen)
  readonly sidebarOverlay = $derived(this.#shell.sidebarOverlay)
  readonly sidebarAutoCollapsed = $derived(this.#shell.sidebarAutoCollapsed)
  readonly sidePaneOpen = $derived(this.#shell.sidePaneOpen)
  /** Whether the side pane docks beside the canvas (§9.6 geometry rule); otherwise it is a sheet. */
  readonly paneDocked = $derived(this.#shell.paneDocked)
  readonly paneWidthPx = $derived(this.#shell.paneWidthPx)
  /** How far the splitters may drag now (`PaneLayout`). */
  readonly paneLimits: PaneLimits = $derived(paneLimits(this.#shellInput, this.#shell))

  #toastId = 0
  #undoToastId: number | null = null
  #confirm: ((ok: boolean) => void) | null = null
  #navigators: NavigateHandler[] = []
  #pendingNav: NavTarget | null = null
  #announceTimer: ReturnType<typeof setTimeout> | undefined
  #fullscreenTimer: ReturnType<typeof setTimeout> | undefined
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #pokeTimer: ReturnType<typeof setTimeout> | undefined
  #pointerInDockZone = false
  #drafts: Map<string, string> | null = null
  #disposers: (() => void)[] = []

  init(_b: Bootstrap): void {
    this.#dispose()
    this.view = 'reader'
    settings.setErrorReporter(this.toastError)
    this.#measure()
    const onResize = () => this.#measure()
    window.addEventListener('resize', onResize)
    this.#disposers.push(() => window.removeEventListener('resize', onResize))
    if (__MOCK_IPC__) {
      // The browser mock uses the document Fullscreen API (Escape leaves it natively).
      const onFullscreen = () => (this.fullscreen = document.fullscreenElement !== null)
      document.addEventListener('fullscreenchange', onFullscreen)
      this.#disposers.push(() => document.removeEventListener('fullscreenchange', onFullscreen))
      // Its CSS-zoom UI scale changes the window's CSS size without a resize event (see `#measure`).
      this.#disposers.push(
        $effect.root(() => {
          $effect(() => {
            void settings.value.uiScalePct
            untrack(() => this.#measure())
          })
        }),
      )
    }
    this.#disposers.push(listenEvent(events.navigateRequested, (target) => this.navigate(target)))
  }

  /**
   * Records how far a bottom-centre canvas overlay (`source`) reaches above the canvas bottom, in CSS px; 0 when it
   * shows nothing or is gone (`components/shell/overlayReach.ts` measures it).
   */
  setOverlayReach(source: string, px: number): void {
    const next = Number.isFinite(px) ? Math.max(0, Math.round(px)) : 0
    const current = untrack(() => this.#overlayReach)
    if ((current[source] ?? 0) === next) return
    const updated: Record<string, number> = { ...current }
    if (next > 0) updated[source] = next
    else delete updated[source]
    this.#overlayReach = updated
  }

  // --- overlays and layers (§7.4) ------------------------------------------------------------------------------------

  /** Opens an overlay (§7.9) on top of the stack. Opening `palette` while it is the top overlay closes it (toggle). */
  open<K extends OverlayKind>(kind: K, props: OverlayProps[K]): void {
    if (kind === 'palette' && this.topOverlay?.kind === 'palette') {
      this.close('palette')
      return
    }
    this.contextMenu = null
    const entry = { kind, props } as OverlayEntry
    this.overlays = [...this.overlays.filter((o) => o.kind !== kind), entry]
  }

  /** Closes the given overlay kind, or the top one. Closing `confirm` this way answers "no". */
  close(kind?: OverlayKind): void {
    const target = kind ?? this.topOverlay?.kind
    if (target === undefined || !this.isOpen(target)) return
    this.overlays = this.overlays.filter((o) => o.kind !== target)
    if (target === 'confirm') this.#settleConfirm(false)
  }

  isOpen(kind: OverlayKind): boolean {
    return this.overlays.some((o) => o.kind === kind)
  }

  /**
   * Whether `kind` is the top overlay, i.e. the one `OverlayHost` shows. Overlay components bind their Dialog's `open`
   * to this, so a close animates out while the host keeps the component mounted for its exit transition.
   */
  isTop(kind: OverlayKind): boolean {
    return this.topOverlay?.kind === kind
  }

  /**
   * Closes the top-most layer this store owns (the context menu, else the top overlay). `false` if none was open. The
   * onboarding is never closed this way: it ends through its own Finish (and, on a re-run, Skip or Escape), which also
   * record `onboardingDone` (§9.7); Escape is consumed meanwhile.
   */
  dismissLayer(): boolean {
    if (this.contextMenu !== null) {
      this.contextMenu = null
      return true
    }
    const top = this.topOverlay
    if (top === null) return false
    if (top.kind !== 'onboarding') this.close(top.kind)
    return true
  }

  /** A floating layer opened. Untracked, so a call from inside an `$effect` cannot make the effect depend on the counter. */
  pushFloating(): void {
    untrack(() => (this.floating += 1))
  }

  popFloating(): void {
    untrack(() => (this.floating = Math.max(0, this.floating - 1)))
  }

  /** A modal layer (a dialog or a sheet) opened; untracked like `pushFloating`. */
  pushModal(): void {
    untrack(() => (this.modals += 1))
  }

  popModal(): void {
    untrack(() => (this.modals = Math.max(0, this.modals - 1)))
  }

  /** The Settings dialog opened or closed (registered by its host only). */
  setSettingsOpen(open: boolean): void {
    this.settingsOpen = open
  }

  /**
   * Closes the context menu and every open floating layer (popovers, menus, open listboxes): the Settings dialog does
   * as it opens (§7.4), so nothing left open over the reader or the sidebar stays up, lifted above it with the chrome's
   * floating content, while the dialog takes the keys and the clicks. Untracked like `pushFloating`.
   */
  dismissFloating(): void {
    this.contextMenu = null
    untrack(() => (this.floatingDismissals += 1))
  }

  /**
   * Opens the ayah context menu (§10.3) at a point for an ayah (or word). User-facing openers call `openAyahMenu`
   * (interactions.ts), which selects the ayah first: this store cannot see the reader (§7.2).
   */
  openContextMenu(target: ContextMenuTarget): void {
    this.contextMenu = target
  }

  closeContextMenu(): void {
    this.contextMenu = null
  }

  /**
   * Asks a yes/no question through the `confirm` overlay. Resolves `true` when `ConfirmDialog` calls
   * `resolveConfirm(true)`; `false` when it is cancelled, closed, or replaced by another confirmation.
   */
  confirm(options: ConfirmOptions): Promise<boolean> {
    this.#settleConfirm(false)
    return new Promise<boolean>((resolve) => {
      this.#confirm = resolve
      this.open('confirm', options)
    })
  }

  /** `ConfirmDialog`'s answer: settles the pending `confirm()` and closes the overlay. */
  resolveConfirm(ok: boolean): void {
    this.#settleConfirm(ok)
    this.overlays = this.overlays.filter((o) => o.kind !== 'confirm')
  }

  // --- view, zen, full screen ----------------------------------------------------------------------------------------

  /**
   * Switches the view (§7.4): the reader or Downloads in the canvas, Settings and About in the dialog over the reader.
   * The player dock stays in every view.
   */
  setView(view: AppView): void {
    if (view === this.view) return
    this.view = view
    this.contextMenu = null
  }

  /** Zen mode (§9.6): hides the chrome and both panes. */
  setZen(on: boolean): void {
    if (on === this.zen) return
    this.zen = on
    this.#resetZenChrome()
    if (on) {
      this.contextMenu = null
      this.#armIdle()
    }
  }

  /**
   * Zen pointer tracking (§9.6), fed by the shell's `pointermove` listener: shows the cursor and the turn zones again,
   * reveals the dock near the bottom edge and the title bar at the top edge, and re-arms the 2.5 s idle timer.
   */
  notePointer(clientY: number, viewportH: number): void {
    if (!this.zen) return
    this.pointerIdle = false
    this.#pointerInDockZone = viewportH > 0 && clientY >= viewportH - ZEN_DOCK_ZONE_PX
    this.zenDock = this.#pointerInDockZone || this.#pokeTimer !== undefined
    this.zenTitleBar = clientY <= ZEN_TOP_ZONE_PX
    this.#armIdle()
  }

  /** The pointer left the window: zen hides the revealed chrome. */
  notePointerLeave(): void {
    if (!this.zen) return
    this.#pointerInDockZone = false
    this.zenTitleBar = false
    this.zenDock = this.#pokeTimer !== undefined
  }

  /** An audio key in zen (§9.6): shows the dock for a moment, so the change is visible. */
  pokeDock(): void {
    if (!this.zen) return
    clearTimeout(this.#pokeTimer)
    this.zenDock = true
    this.#pokeTimer = setTimeout(() => {
      this.#pokeTimer = undefined
      if (!this.#pointerInDockZone) this.zenDock = false
    }, ZEN_DOCK_POKE_MS)
  }

  #armIdle(): void {
    clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => {
      if (this.zen) this.pointerIdle = true
    }, ZEN_IDLE_MS)
  }

  #resetZenChrome(): void {
    clearTimeout(this.#idleTimer)
    clearTimeout(this.#pokeTimer)
    this.#idleTimer = undefined
    this.#pokeTimer = undefined
    this.#pointerInDockZone = false
    this.pointerIdle = false
    this.zenDock = false
    this.zenTitleBar = false
  }

  toggleZen(): void {
    this.setZen(!this.zen)
  }

  /** Full screen: the Tauri window (`setFullscreen`); the document Fullscreen API in the browser mock. */
  async setFullscreen(on: boolean): Promise<void> {
    try {
      if (__MOCK_IPC__ && typeof document.documentElement.requestFullscreen === 'function') {
        if (on && document.fullscreenElement === null) await document.documentElement.requestFullscreen()
        else if (!on && document.fullscreenElement !== null) await document.exitFullscreen()
      } else {
        await getCurrentWindow().setFullscreen(on)
      }
      this.fullscreen = on
    } catch (e) {
      console.warn('[qd] full screen could not be changed', e)
    }
  }

  toggleFullscreen(): Promise<void> {
    return this.setFullscreen(!this.fullscreen)
  }

  // --- panes (§9.6) --------------------------------------------------------------------------------------------------

  /** The rail and `Mod+1…7` (§10.1): a tab other than the shown one opens it; the shown tab closes the sidebar. */
  toggleSidebar(tab?: SidebarTab): void {
    const current = settings.value.sidebar
    if (this.sidebarOpen && (tab === undefined || tab === current.tab)) this.closeSidebar()
    else this.openSidebar(tab ?? current.tab)
  }

  /**
   * Shows the sidebar on a tab, leaving zen, and the Downloads manager (which hides the sidebar) for the reader: a rail
   * tab, `Mod+1…7`, `Mod+B` and `Mod+F` all lead there. If the side pane had collapsed the sidebar, it stays open from
   * now on. In a narrow window (overlay sidebar) the shown state is session-only and only the tab is persisted.
   */
  openSidebar(tab?: SidebarTab): void {
    const current = settings.value.sidebar
    this.setZen(false)
    if (this.view === 'downloads') this.setView('reader')
    const next = tab ?? current.tab
    if (this.sidebarOverlay) {
      this.#overlaySidebarOpen = true
      if (next !== current.tab) this.#patchSidebar({ tab: next })
      return
    }
    if (this.sidebarAutoCollapsed) this.#sidebarForced = true
    if (!current.open || next !== current.tab) this.#patchSidebar({ open: true, tab: next })
  }

  closeSidebar(): void {
    this.#sidebarForced = false
    if (this.sidebarOverlay) {
      this.#overlaySidebarOpen = false
      return
    }
    if (settings.value.sidebar.open) this.#patchSidebar({ open: false })
  }

  /** `Mod+I` (§10.1): a tab other than the shown one opens it; otherwise toggles the side pane. */
  toggleSidePane(tab?: SidePaneTab): void {
    const current = settings.value.sidePane
    if (this.sidePaneOpen && (tab === undefined || tab === current.tab)) this.closeSidePane()
    else this.openSidePane(tab ?? current.tab)
  }

  openSidePane(tab?: SidePaneTab): void {
    const current = settings.value.sidePane
    this.setZen(false)
    const next = tab ?? current.tab
    if (!current.open || next !== current.tab) this.#patchSidePane({ open: true, tab: next })
  }

  /** Closes the side pane; a sidebar it had collapsed comes back (§9.6). */
  closeSidePane(): void {
    this.#sidebarForced = false
    if (settings.value.sidePane.open) this.#patchSidePane({ open: false })
  }

  /** Splitter drag (§9.5): clamped to 240–420 px and persisted (writes coalesce while dragging). */
  resizeSidebar(px: number): void {
    const widthPx = clampTo(px, SETTING_LIMITS.sidebarWidthPx)
    if (widthPx !== settings.value.sidebar.widthPx) this.#patchSidebar({ widthPx })
  }

  /** Splitter drag: clamped to 320–640 px. */
  resizeSidePane(px: number): void {
    const widthPx = clampTo(px, SETTING_LIMITS.sidePaneWidthPx)
    if (widthPx !== settings.value.sidePane.widthPx) this.#patchSidePane({ widthPx })
  }

  /** Splitter double-click: back to the default widths. */
  resetSidebarWidth(): void {
    this.resizeSidebar(defaultSettings().sidebar.widthPx)
  }

  resetSidePaneWidth(): void {
    this.resizeSidePane(defaultSettings().sidePane.widthPx)
  }

  /** `Mod+F` (§10.1): the sidebar Search tab with its input focused (closing a palette or Go to on top). */
  focusSearch(): void {
    const top = this.topOverlay?.kind
    if (top === 'palette' || top === 'goto') this.close(top)
    this.contextMenu = null
    this.openSidebar('search')
    void this.focusWhenRendered(FOCUS_TARGETS.search)
  }

  /**
   * Focuses (and selects, for inputs) the first element matching `selector` once Svelte has updated the DOM, waiting
   * up to `frames` frames (default 2) for a panel that mounts late, or for a virtual list's row that only takes focus
   * once it is measured and shown. Resolves whether focus landed on it.
   */
  async focusWhenRendered(selector: string, frames = 2): Promise<boolean> {
    await tick()
    for (let frame = 0; frame <= frames; frame++) {
      const el = document.querySelector<HTMLElement>(selector)
      if (el) {
        el.focus({ preventScroll: true })
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select()
        if (document.activeElement === el || frame === frames) return document.activeElement === el
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    return false
  }

  /**
   * Back in the reader from another view (the Downloads manager closing by Escape, the title bar or the rail): focus
   * the reading cursor (`readingCursor`) once the reader has rendered it, waiting up to `frames` frames for its roving
   * item (the Mushaf's ayah list, or translation mode's verses). It gives up as soon as focus has moved on by itself:
   * anywhere but `from` (where it was when the view changed), the body or the canvas. Resolves whether it moved focus.
   */
  async focusReader(from: Element | null, frames = 30): Promise<boolean> {
    const free = (): boolean => {
      const active = document.activeElement
      return active === null || active === document.body || active === from || active.id === 'qd-main'
    }
    await tick()
    for (let frame = 0; frame <= frames; frame++) {
      if (!free() || this.view !== 'reader') return false
      const cursor = document.querySelector<HTMLElement>(CURSOR_TAB_STOP)
      if (cursor !== null || frame === frames) {
        const target = cursor ?? readingCursor()
        target?.focus({ preventScroll: true })
        return target !== null && document.activeElement === target
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    return false
  }

  // --- toasts and announcements --------------------------------------------------------------------------------------

  /**
   * Shows a toast (§9.5) through svelte-sonner; returns its id. Untracked: a toast raised from inside an `$effect` must
   * not make that effect depend on the toast list (it would toast again on every toast).
   */
  toast(options: ToastOptions): number {
    return untrack(() => this.#toast(options))
  }

  /**
   * An undo toast (§7.3, §9.5): names the change ("Bookmarked 2:255") and offers Undo for at least 10 s. A newer undo
   * toast replaces the previous one, so the stack never fills with stale Undo buttons (the library's undo stack still
   * reaches them through `Mod+Z`).
   */
  toastUndo(
    message: string,
    undo: () => unknown,
    options: Omit<ToastOptions, 'message' | 'action'> = {},
  ): number {
    return untrack(() => {
      if (this.#undoToastId !== null) this.dismissToast(this.#undoToastId)
      const id = this.#toast({
        ...options,
        message,
        action: {
          label: i18n.t('common.undo'),
          run: () => {
            if (this.#undoToastId === id) this.#undoToastId = null
            const result = undo()
            if (result instanceof Promise) result.catch((e: unknown) => this.toastError(e))
          },
        },
      })
      this.#undoToastId = id
      return id
    })
  }

  #toast(options: ToastOptions): number {
    const id = ++this.#toastId
    const entry: ToastEntry = { ...options, id }
    this.toasts = [...this.toasts, entry].slice(-TOAST_HISTORY)
    const duration = options.action
      ? Math.max(TOAST_ACTION_MIN_MS, options.durationMs ?? TOAST_ACTION_MIN_MS)
      : (options.durationMs ?? TOAST_MS)
    const forget = () => (this.toasts = this.toasts.filter((t) => t.id !== id))
    const data = {
      id,
      description: options.description,
      duration,
      important: options.tone === 'danger',
      action: options.action
        ? { label: options.action.label, onClick: () => options.action?.run() }
        : undefined,
      onDismiss: forget,
      onAutoClose: forget,
    }
    switch (options.tone) {
      case 'danger':
        sonner.error(options.message, data)
        break
      case 'warning':
        sonner.warning(options.message, data)
        break
      case 'success':
        sonner.success(options.message, data)
        break
      default:
        sonner(options.message, data)
    }
    return id
  }

  dismissToast(id: number): void {
    untrack(() => {
      if (this.#undoToastId === id) this.#undoToastId = null
      sonner.dismiss(id)
      this.toasts = this.toasts.filter((t) => t.id !== id)
    })
  }

  // --- drafts --------------------------------------------------------------------------------------------------------

  /**
   * An unsaved draft (§10.1: the note editor autosaves its body here, so a `Discard note?` confirmation, or a crash,
   * never loses it). Keys are the owner's choice (`note:<id>`, `note:new:<from>-<to>`). Mirrored to localStorage as
   * a per-viewer convenience; never the source of truth for saved data.
   */
  draft(key: string): string {
    return this.#loadDrafts().get(key) ?? ''
  }

  setDraft(key: string, text: string): void {
    const drafts = this.#loadDrafts()
    if (text === '') drafts.delete(key)
    else drafts.set(key, text)
    this.#saveDrafts()
  }

  clearDraft(key: string): void {
    const drafts = this.#loadDrafts()
    if (drafts.delete(key)) this.#saveDrafts()
  }

  #loadDrafts(): Map<string, string> {
    if (this.#drafts !== null) return this.#drafts
    this.#drafts = new Map()
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}')
      if (typeof raw === 'object' && raw !== null) {
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') this.#drafts.set(k, v)
      }
    } catch {
      // Unreadable or blocked storage: drafts live in memory only.
    }
    return this.#drafts
  }

  #saveDrafts(): void {
    try {
      const drafts = this.#drafts
      if (drafts === null || drafts.size === 0) localStorage.removeItem(DRAFTS_KEY)
      else localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts)))
    } catch {
      // Storage full or blocked: the in-memory draft still survives for the session.
    }
  }

  /** A failed command as an error toast with the localised `errors.<kind>` message (cancellations stay silent). */
  toastError = (e: unknown): void => {
    const err = toAppError(e)
    if (err.kind === 'cancelled') return
    console.warn(`[qd] ${err.kind}: ${err.message}`)
    this.toast({ message: untrack(() => i18n.t(`errors.${err.kind}`)), tone: 'danger' })
  }

  /** `F6` / `Mod+Shift+U` (§9.5): moves focus to the newest toast, else the toast region. `false` if there is none. */
  focusToasts(): boolean {
    const target =
      document.querySelector<HTMLElement>('[data-sonner-toast]') ??
      document.querySelector<HTMLElement>('[data-sonner-toaster]')
    if (!target) return false
    target.focus()
    return true
  }

  /** A polite screen-reader announcement (`LiveRegion`); repeating the same text announces it again. */
  announce(text: string): void {
    clearTimeout(this.#announceTimer)
    if (text !== '' && text === this.announcement) {
      this.announcement = ''
      this.#announceTimer = setTimeout(() => (this.announcement = text), 100)
    } else {
      this.announcement = text
    }
  }

  // --- deep navigation (§7.4) ----------------------------------------------------------------------------------------

  /**
   * Routes a navigation request (tray, `NavigateRequested`, palette): `view` targets switch the view; ayah, page,
   * surah and search targets show the reader (search also the Search tab) and go to the `onNavigate` handlers,
   * newest first. Unhandled targets wait for the next handler that registers.
   */
  navigate(target: NavTarget): void {
    if (target.type === 'view') {
      this.setView(target.data.view)
      return
    }
    this.setView('reader')
    if (target.type === 'search') this.openSidebar('search')
    for (const handler of [...this.#navigators].reverse()) {
      if (handler(target)) {
        this.#pendingNav = null
        return
      }
    }
    this.#pendingNav = target
  }

  /** Registers a deep-navigation handler (the reader for ayah/page/surah, search for queries); returns its remover. */
  onNavigate(handler: NavigateHandler): () => void {
    this.#navigators.push(handler)
    const pending = this.#pendingNav
    if (pending !== null && handler(pending)) this.#pendingNav = null
    return () => {
      this.#navigators = this.#navigators.filter((h) => h !== handler)
    }
  }

  reset(): void {
    this.#dispose()
    this.#settleConfirm(false)
    clearTimeout(this.#announceTimer)
    clearTimeout(this.#fullscreenTimer)
    this.#resetZenChrome()
    if (this.toasts.length > 0) sonner.dismiss()
    this.view = 'reader'
    this.overlays = []
    this.floating = 0
    this.modals = 0
    this.settingsOpen = false
    this.contextMenu = null
    this.zen = false
    this.fullscreen = false
    this.toasts = []
    this.announcement = ''
    this.windowSize = { w: 0, h: 0 }
    this.#sidebarForced = false
    this.#overlaySidebarOpen = false
    this.#overlayReach = {}
    this.#undoToastId = null
    this.#drafts = null
    this.#navigators = []
    this.#pendingNav = null
    settings.setErrorReporter(null)
  }

  #measure(): void {
    // The window in CSS px. The real app's UI scale is webview zoom (D27), which shrinks innerWidth/innerHeight; the
    // browser mock approximates it with CSS zoom on <html> (§12.6), which does not, so the mock divides by it here and
    // the §9.6 rules (sidebar floating below 900 px, the docking rule, the reader's fit) see what the app sees.
    const zoom = __MOCK_IPC__ ? untrack(() => settings.value.uiScalePct) / 100 : 1
    const w = Math.round(window.innerWidth / zoom)
    const h = Math.round(window.innerHeight / zoom)
    if (w !== this.windowSize.w || h !== this.windowSize.h) this.windowSize = { w, h }
    if (!__MOCK_IPC__) {
      // The OS can change full screen on its own (macOS green button): re-read it once resizing settles.
      clearTimeout(this.#fullscreenTimer)
      this.#fullscreenTimer = setTimeout(() => void this.#syncFullscreen(), 250)
    }
  }

  async #syncFullscreen(): Promise<void> {
    try {
      this.fullscreen = await getCurrentWindow().isFullscreen()
    } catch {
      // No window to ask (tests, a browser preview): keep the last known state.
    }
  }

  #patchSidebar(patch: Partial<SidebarSettings>): void {
    void settings.update({ sidebar: { ...settings.value.sidebar, ...patch } })
  }

  #patchSidePane(patch: Partial<SidePaneSettings>): void {
    void settings.update({ sidePane: { ...settings.value.sidePane, ...patch } })
  }

  #settleConfirm(ok: boolean): void {
    const resolve = this.#confirm
    this.#confirm = null
    resolve?.(ok)
  }

  #dispose(): void {
    for (const dispose of this.#disposers.splice(0)) dispose()
  }
}

export const ui = new UiStore()
