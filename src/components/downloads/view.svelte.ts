/**
 * Downloads view state that outlives the view (it unmounts when another view shows): which recitation rows show their
 * surah grid. Per session, never persisted.
 */
import { SvelteSet } from 'svelte/reactivity'

class DownloadsViewState {
  /** Recitation packs whose surah grid is open. */
  readonly expanded = new SvelteSet<string>()
  #opened = false

  /** The first visit of a session opens the current reciter's grid (its surahs are what people come to download). */
  openFirst(packId: string | undefined): void {
    if (this.#opened || packId === undefined) return
    this.#opened = true
    this.expanded.add(packId)
  }

  toggle(packId: string): void {
    if (this.expanded.has(packId)) this.expanded.delete(packId)
    else this.expanded.add(packId)
  }

  reset(): void {
    this.expanded.clear()
    this.#opened = false
  }
}

export const downloadsView = new DownloadsViewState()
