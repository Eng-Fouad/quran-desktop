/**
 * Shortcut registry contract. Definitions live in `src/lib/shortcuts/*.ts`, one file per owning package; the listener
 * and matching rules live in `src/lib/shortcuts/index.ts`.
 */
import type { ShortcutLabelKey } from './i18n'

/** Groups of the shortcut sheet and of `ShortcutTable`. */
export type ShortcutGroup = 'navigation' | 'view' | 'audio' | 'study' | 'memorize' | 'app'

/** Every group, in the order the shortcut sheet lists them. */
export const SHORTCUT_GROUPS = [
  'navigation',
  'view',
  'audio',
  'study',
  'memorize',
  'app',
] as const satisfies readonly ShortcutGroup[]

/**
 * Where a definition is active: `global` everywhere, `reader` when `ui.view === 'reader'`, `mushaf` in the reader in
 * Mushaf mode, `translation` in the reader in translation mode.
 */
export type ShortcutScope = 'global' | 'reader' | 'mushaf' | 'translation'

export interface ShortcutDef {
  /** Stable id, `<area>.<action>`: `'nav.nextPage'`. */
  id: string
  /**
   * Chords in this notation: `[Mod+][Ctrl+][Alt+][Shift+]<key>` where `<key>` is a US character (`'k'`, `'?'`,
   * `'['`), `Digit0`–`Digit9`, or a named key (`ArrowLeft`, `PageDown`, `Space`, `Escape`, `F3`, `ContextMenu`).
   * `Mod` is Ctrl on Windows/Linux and Meta on macOS; `Ctrl+` names the physical Control key (macOS `Mod+Ctrl+f`).
   */
  keys: string[]
  group: ShortcutGroup
  labelKey: ShortcutLabelKey
  scope: ShortcutScope
  /** Runs in the capture-phase listener (only `Mod+K`, `Mod+F`, `Mod+G`, `Mod+Comma`, `Mod+Shift+D`, `Escape`, `F11`). */
  capture?: boolean
  /** Also runs while an editable element has focus or a layer is open (default false). */
  allowInInput?: boolean
  /** Lets key auto-repeat through (page turns and zoom). */
  repeat?: boolean
  when?: () => boolean
  run: (e: KeyboardEvent) => void
}
