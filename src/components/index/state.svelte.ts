/**
 * View state of the Index panel that outlives the panel itself (switching sidebar tabs unmounts it): the open tab
 * (remembered across launches in `localStorage`, a per-machine convenience), the filters, and the Continue card the
 * user hid.
 */

export type IndexTab = 'surahs' | 'juz' | 'hizb' | 'pages'

export const INDEX_TABS = ['surahs', 'juz', 'hizb', 'pages'] as const satisfies readonly IndexTab[]

const TAB_KEY = 'qd.index.tab'

const isTab = (v: unknown): v is IndexTab =>
  typeof v === 'string' && (INDEX_TABS as readonly string[]).includes(v)

function readTab(): IndexTab {
  try {
    const v = globalThis.localStorage?.getItem(TAB_KEY)
    return isTab(v) ? v : 'surahs'
  } catch {
    // Storage is unavailable (private mode, blocked site data): start on the surah list.
    return 'surahs'
  }
}

class IndexViewState {
  tab = $state<IndexTab>(readTab())
  /** The surah filter (name, number or a reference). */
  surahQuery = $state('')
  /** The page finder of the Pages tab. */
  pageQuery = $state('')
  /** `updatedAt` of the reading bookmark whose Continue card was hidden; it shows again when the bookmark moves. */
  continueHiddenAt = $state<number | null>(null)

  setTab(tab: IndexTab): void {
    if (!isTab(tab)) return
    this.tab = tab
    try {
      globalThis.localStorage?.setItem(TAB_KEY, tab)
    } catch {
      // Not persisted: the tab is still switched for this session.
    }
  }

  /** Back to the defaults (tests). */
  reset(): void {
    this.tab = 'surahs'
    this.surahQuery = ''
    this.pageQuery = ''
    this.continueHiddenAt = null
  }
}

export const indexView = new IndexViewState()
