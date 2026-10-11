/**
 * The search context of the Settings view (WP12b): rows hide themselves while a search does not match them. The view
 * provides it; rows rendered outside the view (tests, a section on its own) see "not searching".
 */
import { getContext, setContext } from 'svelte'
import type { ShortcutLabelKey } from '$lib/contracts/i18n'
import { shortcuts } from '$lib/stores/shortcuts.svelte'
import type { RowId } from '../meta'

/** The ids a row hands to its control snippet (see `SettingRow`). */
export interface RowIds {
  /** The label element: the control's `aria-labelledby`. */
  labelId: string
  /** The description and note, when there are any: the control's `aria-describedby` (space-separated ids). */
  descriptionId: string | undefined
  /** For the control itself, when the row's label is a `<label for>`. */
  controlId: string
}

export interface SettingsSearch {
  /** A query is typed. */
  readonly active: boolean
  /** Whether a row is shown (always, while not searching). */
  visible(id: RowId): boolean
}

const KEY = Symbol('qd-settings-search')

const NOT_SEARCHING: SettingsSearch = { active: false, visible: () => true }

export function provideSettingsSearch(search: SettingsSearch): void {
  setContext(KEY, search)
}

export function settingsSearch(): SettingsSearch {
  return getContext<SettingsSearch | undefined>(KEY) ?? NOT_SEARCHING
}

/**
 * The keys of the shortcut whose label is `labelKey` (`Ctrl+Shift+=`), or `''` when no package registered it. Matched
 * by label rather than id, so the hint holds whoever owns the definition.
 */
export function shortcutLabel(labelKey: ShortcutLabelKey): string {
  const def = shortcuts.defs.find((d) => d.labelKey === labelKey && shortcuts.isAvailable(d))
  return def ? shortcuts.format(def) : ''
}
