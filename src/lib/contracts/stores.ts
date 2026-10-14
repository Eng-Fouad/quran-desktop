/**
 * Store contract and the small cross-package value types that stores expose.
 */
import type { Bootstrap } from '$lib/ipc/bindings'

/**
 * Every store implements this, so `src/lib/stores/index.ts` never changes when a store grows. `init` may be async;
 * `initStores` awaits each in the fixed order. `reset` returns the store to its pre-`init` state (tests, and the next
 * `init` after a failed bootstrap).
 */
export interface Store {
  init(b: Bootstrap): void | Promise<void>
  reset(): void
}

/** `settings.resolvedTheme`: `system` resolved through the OS preference to the light or dark variant. */
export type ResolvedTheme = 'paper' | 'sepia' | 'night' | 'black' | 'high_contrast'

/** Player dock placement, chosen from geometry only: side card, 64 px bar, or 56 px compact bar. */
export type Dock = 'side' | 'bar' | 'compact'

/** Visual tone of a toast or badge. */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

/**
 * Argument of `ui.toast(...)`. Toasts without an action stay 5 s; with an action at least 10 s, and pause
 * while hovered or focused. Undo toasts name the change ("Highlighted 2:255 yellow · Undo").
 */
export interface ToastOptions {
  message: string
  description?: string
  tone?: Tone
  action?: { label: string; run: () => void }
  /** Overrides the default duration (ms). */
  durationMs?: number
}

/** `ui.contextMenu`: where the ayah context menu opens and for what. */
export interface ContextMenuTarget {
  x: number
  y: number
  ayahId: number
  wordId?: number
}
