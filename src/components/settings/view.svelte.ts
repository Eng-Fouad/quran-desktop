/**
 * State of the Settings view that outlives it (WP12b): the open section, the search query and a row to bring into
 * view. Opening Settings again in the same session returns to the section that was open; a new session starts on
 * Appearance. Other packages may deep-link: `settingsView.open('storage', 'clearCache')` then `ui.setView('settings')`.
 */
import { searchRows, type RowId, type SettingsSection, SETTINGS_SECTIONS } from './meta'

/** The id of the view's "Settings" heading, which names the Settings dialog (§7.4). */
export const SETTINGS_TITLE_ID = 'settings-title'

class SettingsViewState {
  section = $state<SettingsSection>('appearance')
  query = $state('')
  /** A row to scroll to and briefly mark once its section renders (a search result or a deep link). */
  target = $state<RowId | null>(null)

  readonly searching = $derived(this.query.trim() !== '')

  /** Shows a section (and optionally points at one of its rows), leaving search. */
  open(section: SettingsSection, row?: RowId): void {
    if (!SETTINGS_SECTIONS.includes(section)) return
    this.section = section
    this.query = ''
    this.target = row ?? null
  }

  /** The rows matching the query in a UI language (empty while not searching). */
  matches(locale: 'en' | 'ar'): Set<RowId> {
    return searchRows(this.query, locale)
  }

  reset(): void {
    this.section = 'appearance'
    this.query = ''
    this.target = null
  }
}

export const settingsView = new SettingsViewState()
