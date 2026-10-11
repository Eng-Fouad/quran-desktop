/**
 * Test double of the `player` store for `HighlightLayer.glide.browser.test.ts` (mock playback): the fields the Mushaf
 * reads (`isActive`, `isPlaying`, `currentAyahId`, `currentRef`, `activeWord`) as plain reactive state the test drives
 * directly, word by word, without an audio engine.
 */
import type { AudioSnapshot, AyahRef, ReciterInfo, SurahTimings } from '$lib/ipc/bindings'
import type { ActiveWord } from '$lib/stores/player.svelte'

class TestPlayer {
  snapshot = $state.raw<AudioSnapshot | null>(null)
  isPlaying = $state(false)
  isActive = $state(false)
  currentAyahId = $state<number | null>(null)
  currentRef = $state.raw<AyahRef | null>(null)
  activeWord = $state.raw<ActiveWord | null>(null)
  positionMs = $state(0)
  version = $state(0)
  timings = new Map<string, SurahTimings>()
  reciters: ReciterInfo[] = []
  /** Calls the Mushaf made (`playFrom`, `playRange`). */
  calls: string[] = []

  init(): void {}
  reset(): void {
    this.isPlaying = false
    this.isActive = false
    this.currentAyahId = null
    this.currentRef = null
    this.activeWord = null
    this.calls = []
  }
  async playFrom(target: { ayahId: number }): Promise<void> {
    this.calls.push(`playFrom ${target.ayahId}`)
  }
  async playRange(from: number, to: number): Promise<void> {
    this.calls.push(`playRange ${from}-${to}`)
  }
}

export const testPlayer = new TestPlayer()
