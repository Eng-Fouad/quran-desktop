/**
 * The QA hooks' view of `player.isPlaying` (`qdtest.ts` is plain TypeScript, so the rune lives here).
 */
import { untrack } from 'svelte'
import { player } from '$lib/stores'

/**
 * Calls `onChange(playing)` at once and after every change of `player.isPlaying`, until the returned function is
 * called. The glide's frame sampler runs only while audio plays, so the rest of a test session requests no frames
 * (an always-on `requestAnimationFrame` loop distorted the idle CPU and the flip frame times).
 */
export function watchPlaying(onChange: (playing: boolean) => void): () => void {
  return $effect.root(() => {
    $effect(() => {
      const playing = player.isPlaying
      untrack(() => onChange(playing))
    })
  })
}
