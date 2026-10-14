/**
 * The player store against the browser mock: position interpolation, `activeWord` by time (positions that repeat or
 * go backwards, gaps, basmala), `cycleRepeat`, `abMark`, the resume candidate, speed and volume reaching the engine,
 * reciter changes, failures and the `audio` position.
 */
import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, call, initIpc } from '$lib/ipc'
import type { AudioSnapshot, AudioTick, Bootstrap, ReadingPosition, SurahTimings } from '$lib/ipc/bindings'
import { audioChannels, audioMock, TICK_MS } from '$lib/ipc/mock/handlers/audio'
import { packsMock } from '$lib/ipc/mock/handlers/packs'
import { state } from '$lib/ipc/mock/state'
import { app } from './app.svelte'
import {
  activeWordAt,
  AYAH_END_SLACK_MS,
  BACKSTEP_TOLERANCE_MS,
  clampSpeed,
  formatClock,
  formatSpeed,
  interpolate,
  nextAyahRepeat,
  player,
  RESUME_MAX_AGE_S,
} from './player.svelte'
import { quran } from './quran.svelte'
import { settings } from './settings.svelte'
import { ui } from './ui.svelte'

function stubMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

/** Boots the stores the player reads, on the mock's bootstrap (after `seed` prepared the mock's slices). */
async function boot(seed: () => void = () => {}): Promise<Bootstrap> {
  localStorage.clear()
  await initIpc()
  audioMock.reset()
  packsMock.reset()
  state.resetAll()
  state.loadAll()
  seed()
  const b = await call(api.appBootstrap())
  app.init(b)
  settings.init(b)
  quran.init(b)
  ui.init(b)
  // Fixture modules load in real time, which the fake clock does not wait for: load the ones the tests play first.
  for (const surah of [1, 2]) await call(api.audioGetTimings(7, surah)).catch(() => null) // offline seeds refuse
  await player.init(b)
  flushSync()
  return b
}

/** Advances the fake clock in tick-sized steps, flushing promises and effects in between. */
async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += TICK_MS) {
    await vi.advanceTimersByTimeAsync(TICK_MS)
    flushSync()
  }
}

/** Runs the clock until `done()` holds; fails after `maxMs` of simulated time. */
async function until(done: () => boolean, maxMs = 30_000): Promise<void> {
  for (let t = 0; t <= maxMs; t += TICK_MS) {
    flushSync()
    if (done()) return
    await vi.advanceTimersByTimeAsync(TICK_MS)
  }
  throw new Error(`condition not met within ${maxMs} ms`)
}

function tick(patch: Partial<AudioTick>): AudioTick {
  return {
    seq: 1,
    generation: 1,
    status: 'playing',
    surah: 1,
    ayah: 2,
    ayahId: 2,
    fileMs: 0,
    wordPos: 0,
    speedPct: 100,
    inGap: false,
    bufferedPct: 100,
    ...patch,
  }
}

/**
 * Stops the simulated engine and returns a function that sends ticks through the store's channel, as the engine would
 * (the test then drives the position itself).
 */
function takeOver(): (t: AudioTick) => void {
  const channel = audioChannels.tick
  if (!channel) throw new Error('not subscribed')
  audioMock.reset()
  return (t) => {
    channel.onmessage(t)
    flushSync()
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.stubGlobal('requestAnimationFrame', undefined)
  stubMatchMedia()
})

afterEach(() => {
  player.reset()
  audioMock.reset()
  packsMock.reset()
  ui.reset()
  quran.reset()
  settings.reset()
  app.reset()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------------------------------------------------

describe('interpolate', () => {
  const t = tick({ fileMs: 10_000, speedPct: 100 })

  it('extrapolates the file position by the elapsed time × speed', () => {
    expect(interpolate(t, 1_000, 1_250, 20_000)).toBe(10_250)
    expect(interpolate({ ...t, speedPct: 150 }, 1_000, 1_200, 20_000)).toBe(10_300)
    expect(interpolate({ ...t, speedPct: 50 }, 1_000, 1_400, 20_000)).toBe(10_200)
  })

  it('never goes below the tick, nor past the ayah end + 250 ms', () => {
    expect(interpolate(t, 1_000, 900, 20_000)).toBe(10_000) // a clock before the tick
    expect(interpolate(t, 1_000, 9_000, 10_100)).toBe(10_100 + AYAH_END_SLACK_MS)
  })

  it('keeps the tick when the ayah end is stale (behind the tick)', () => {
    expect(interpolate(t, 1_000, 1_100, 5_000)).toBe(10_000)
  })
})

describe('activeWordAt: by time, positions may repeat or go backwards', () => {
  // The reciter repeats words 2–3 before going on: positions 1, 2, 3, 2, 3, 4 (sorted by start).
  const words = [
    { pos: 1, startMs: 0, endMs: 400 },
    { pos: 2, startMs: 400, endMs: 800 },
    { pos: 3, startMs: 800, endMs: 1_200 },
    { pos: 2, startMs: 1_300, endMs: 1_700 },
    { pos: 3, startMs: 1_700, endMs: 2_100 },
    { pos: 4, startMs: 2_100, endMs: 2_600 },
  ]

  it('takes the last word starting at or before the position', () => {
    expect(activeWordAt(words, 0)?.pos).toBe(1)
    expect(activeWordAt(words, 799)?.pos).toBe(2)
    expect(activeWordAt(words, 800)?.pos).toBe(3)
    expect(activeWordAt(words, 1_350)?.pos).toBe(2) // the backward step is followed
    expect(activeWordAt(words, 1_800)?.pos).toBe(3)
    expect(activeWordAt(words, 9_999)?.pos).toBe(4)
  })

  it('holds the word through an inter-word gap and is null before the first word', () => {
    expect(activeWordAt(words, 1_250)?.pos).toBe(3) // 1,200–1,300 is silence
    expect(activeWordAt([{ pos: 1, startMs: 500, endMs: 900 }], 100)).toBeNull()
    expect(activeWordAt([], 100)).toBeNull()
  })
})

describe('helpers', () => {
  it('cycles repeat off → ×3 → ∞ → off; a custom count moves on to ∞', () => {
    expect(nextAyahRepeat(1)).toBe(3)
    expect(nextAyahRepeat(3)).toBe(0)
    expect(nextAyahRepeat(0)).toBe(1)
    expect(nextAyahRepeat(7)).toBe(0)
  })

  it('clamps speeds to 50–200 % on the 5 % grid', () => {
    expect(clampSpeed(103)).toBe(105)
    expect(clampSpeed(20)).toBe(50)
    expect(clampSpeed(250)).toBe(200)
  })

  it('formats speeds and clocks (mm:ss, h:mm:ss from an hour)', async () => {
    await boot()
    expect(formatSpeed(125)).toBe('1.25×')
    expect(formatSpeed(100)).toBe('1×')
    expect(formatClock(83_000)).toBe('01:23')
    expect(formatClock(83_000, 4_000_000)).toBe('0:01:23')
    expect(formatClock(3_725_000)).toBe('1:02:05')
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe('player store against the mock engine', () => {
  it('subscribes at init and starts idle with the bootstrap reciters', async () => {
    await boot()
    expect(player.status).toBe('idle')
    expect(player.isActive).toBe(false)
    expect(player.reciters.length).toBeGreaterThan(5)
    expect(audioChannels.tick).not.toBeNull()
    expect(player.reciter?.id).toBe(7)
  })

  it('plays: loading → playing, the heard ayah, interpolation and the active word', async () => {
    await boot()
    await player.playFrom({ ayahId: 1 })
    expect(player.status).toBe('loading')
    await until(() => player.status === 'playing')
    expect(player.isPlaying).toBe(true)
    expect(player.currentAyahId).toBe(1)
    expect(player.currentRef).toEqual({ surah: 1, ayah: 1 })
    await until(() => player.timingsForCurrent !== null)

    // Fixture timings of 1:1: four words of 680 ms.
    await run(800)
    expect(player.positionMs).toBeGreaterThan(600)
    expect(player.activeWord).toMatchObject({ ayahId: 1, pos: 2 })
    expect(player.activeWord?.wordId).toBe(quran.firstWordOf(1) + 1)

    // Between ticks a sample extrapolates from the last tick.
    const t = player.tick
    if (!t) throw new Error('no tick')
    player.sample(player.tickAt + 20)
    expect(player.positionMs).toBeCloseTo(t.fileMs + 20, 5)

    await until(() => player.currentAyahId === 2)
    expect(player.activeWord?.ayahId).toBe(2)
  })

  it('moves the position between ticks only when the UI would show a change, never every frame', async () => {
    await boot()
    await player.playFrom({ ayahId: 2 })
    await until(() => player.status === 'playing')
    const push = takeOver()
    player.timings.set('7:1', {
      reciterId: 7,
      surah: 1,
      durationMs: 10_000,
      wordLevel: true,
      ayahs: [
        { ayah: 1, fromMs: 0, toMs: 1_000, words: [{ pos: 1, startMs: 0, endMs: 1_000 }] },
        {
          ayah: 2,
          fromMs: 1_000,
          toMs: 4_000,
          words: [
            { pos: 1, startMs: 1_000, endMs: 1_500 },
            { pos: 2, startMs: 1_500, endMs: 2_100 },
            { pos: 3, startMs: 2_100, endMs: 4_000 },
          ],
        },
      ],
    })
    player.version++
    // The clock's own time too, so a sample lands exactly where it was scheduled.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    })
    const sample = vi.spyOn(player, 'sample')
    const after = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
      flushSync()
    }
    push(tick({ ayah: 2, ayahId: 2, fileMs: 1_000, generation: 9 }))
    expect(player.activeWord?.pos).toBe(1)
    await after(499)
    expect(player.positionMs).toBe(1_000)
    // The next word's start…
    await after(1)
    expect(player.positionMs).toBe(1_500)
    expect(player.activeWord?.pos).toBe(2)
    // …the readouts' next whole second…
    await after(500)
    expect(player.positionMs).toBe(2_000)
    // …and the next word: 1.1 s of recitation took 4 samples, where a frame loop takes 66 (60 Hz) to 132 (120 Hz).
    await after(100)
    expect(player.positionMs).toBe(2_100)
    expect(player.activeWord?.pos).toBe(3)
    expect(sample).toHaveBeenCalledTimes(4)

    // A finer step (the scrubber's device pixel) is honoured while it is asked for, at the speed played (1.5×).
    const release = player.needPosition(300)
    push(tick({ ayah: 2, ayahId: 2, fileMs: 2_100, generation: 9, speedPct: 150 }))
    await after(199)
    expect(player.positionMs).toBe(2_100)
    await after(1)
    expect(player.positionMs).toBe(2_400)
    release()
    push(tick({ ayah: 2, ayahId: 2, fileMs: 2_400, generation: 9, speedPct: 150 }))
    await after(399)
    expect(player.positionMs).toBe(2_400)
    await after(1)
    expect(player.positionMs).toBe(3_000)

    // Paused (or hidden), nothing is scheduled.
    sample.mockClear()
    push(tick({ ayah: 2, ayahId: 2, fileMs: 3_000, generation: 9, status: 'paused' }))
    player.snapshot = { ...(player.snapshot as AudioSnapshot), status: 'paused' }
    flushSync()
    await after(5_000)
    expect(sample).toHaveBeenCalledTimes(1)
  })

  it('reuses the active word object while the word is the same', async () => {
    await boot()
    await player.playFrom({ ayahId: 1 })
    await until(() => player.activeWord !== null && player.timingsForCurrent !== null)
    const first = player.activeWord
    player.sample(player.tickAt + 5)
    expect(player.activeWord).toBe(first)
  })

  it('absorbs small backward tick jitter within a generation, and follows real jumps', async () => {
    await boot()
    await player.playFrom({ ayahId: 1 }, { startPaused: true })
    await until(() => player.status === 'paused')
    const push = takeOver()
    push(tick({ ayah: 1, ayahId: 1, fileMs: 1_000, generation: 5 }))
    expect(player.positionMs).toBe(1_000)
    push(tick({ ayah: 1, ayahId: 1, fileMs: 1_000 - (BACKSTEP_TOLERANCE_MS - 20), generation: 5 }))
    expect(player.positionMs).toBe(1_000)
    push(tick({ ayah: 1, ayahId: 1, fileMs: 200, generation: 5 }))
    expect(player.positionMs).toBe(200)
  })

  it('finds the active word by time with backward positions in the timings', async () => {
    await boot()
    await player.playFrom({ ayahId: 1 }, { startPaused: true })
    await until(() => player.status === 'paused' && player.timingsForCurrent !== null)
    const push = takeOver()
    const custom: SurahTimings = {
      reciterId: 7,
      surah: 1,
      durationMs: 10_000,
      wordLevel: true,
      ayahs: [
        { ayah: 1, fromMs: 0, toMs: 1_000, words: [{ pos: 1, startMs: 0, endMs: 1_000 }] },
        {
          ayah: 2,
          fromMs: 1_000,
          toMs: 4_000,
          words: [
            { pos: 1, startMs: 1_000, endMs: 1_500 },
            { pos: 2, startMs: 1_500, endMs: 2_000 },
            { pos: 1, startMs: 2_100, endMs: 2_600 },
            { pos: 2, startMs: 2_600, endMs: 3_000 },
            { pos: 3, startMs: 3_000, endMs: 4_000 },
          ],
        },
      ],
    }
    player.timings.set('7:1', custom)
    player.version++
    push(tick({ ayah: 2, ayahId: 2, fileMs: 2_200, status: 'paused' }))
    expect(player.activeWord).toMatchObject({ ayahId: 2, pos: 1, wordId: quran.firstWordOf(2) })
    push(tick({ ayah: 2, ayahId: 2, fileMs: 2_050, status: 'paused' })) // the silence after the first pass
    expect(player.activeWord?.pos).toBe(2)
    push(tick({ ayah: 2, ayahId: 2, fileMs: 2_050, status: 'paused', inGap: true }))
    expect(player.activeWord).toBeNull()
  })

  it('falls back to the engine word without timings, and has no word during the basmala', async () => {
    await boot()
    // The fixture modules load in real time, which the fake clock does not wait for: load them first.
    await call(api.audioGetTimings(7, 2))
    await player.playFrom({ ayahId: 8 }, { startPaused: true }) // 2:1, after its basmala
    await until(() => player.status === 'paused')
    expect(player.currentRef).toEqual({ surah: 2, ayah: 0 })
    expect(player.currentAyahId).toBeNull()
    expect(player.activeWord).toBeNull()
    const push = takeOver()
    player.timings.clear()
    player.version++
    push(tick({ surah: 3, ayah: 2, ayahId: quran.ayahId(3, 2), wordPos: 3, status: 'paused' }))
    expect(player.activeWord).toMatchObject({ ayahId: quran.ayahId(3, 2), pos: 3 })
  })

  it('cycleRepeat: off → ayah ×3 → ∞ → off, live and persisted', async () => {
    await boot()
    expect(await player.cycleRepeat()).toBe(3)
    expect(settings.value.ayahRepeat).toBe(3)
    await player.playFrom({ ayahId: 1 })
    await until(() => player.status === 'playing')
    expect(player.snapshot?.ayahRepeat).toBe(3)
    expect(await player.cycleRepeat()).toBe(0)
    await until(() => player.snapshot?.ayahRepeat === 0)
    expect(settings.value.ayahRepeat).toBe(0)
    expect(await player.cycleRepeat()).toBe(1)
    await until(() => player.snapshot?.ayahRepeat === 1)
  })

  it('repeats an ayah ×3 with a gap ×1: the counters read the plays left after the current one', async () => {
    await boot()
    await player.playRange(1, 2, { ayahRepeat: 3, gap: { type: 'multiplier', data: { pct: 100 } } })
    await until(() => player.status === 'playing')
    expect(player.snapshot?.ayahRepeatLeft).toBe(2)
    await until(() => player.inGap)
    expect(player.currentAyahId).toBe(1) // the highlight stays on the finished ayah
    expect(player.activeWord).toBeNull()
    await until(() => player.snapshot?.ayahRepeatLeft === 1)
    expect(player.currentAyahId).toBe(1)
    await until(() => player.currentAyahId === 2, 60_000)
    expect(player.snapshot?.ayahRepeatLeft).toBe(2)
  })

  it('abMark: A, then B (a loop), then clear; a loop under 300 ms is refused', async () => {
    await boot()
    expect(await player.abMark()).toBe('inactive')
    await player.playFrom({ ayahId: 1 })
    await until(() => player.status === 'playing')
    await run(300)
    expect(await player.abMark()).toBe('a')
    const a = player.abPending
    expect(a).not.toBeNull()
    expect(await player.abMark()).toBe('short')
    expect(player.abPending).toBe(a)
    await run(1_200)
    expect(await player.abMark()).toBe('b')
    expect(player.abPending).toBeNull()
    await until(() => player.snapshot?.abLoop != null)
    const loop = player.snapshot?.abLoop
    expect(loop?.aMs).toBe(a)
    expect((loop?.bMs ?? 0) - (loop?.aMs ?? 0)).toBeGreaterThanOrEqual(300)
    // Playback wraps from B to A.
    await run(1_000)
    expect(player.positionMs).toBeLessThan((loop?.bMs ?? 0) + 100)
    expect(await player.abMark()).toBe('cleared')
    await until(() => player.snapshot?.abLoop === null)
  })

  it('speed and volume settings reach the engine; mute keeps the setting', async () => {
    await boot()
    await player.playFrom({ ayahId: 1 })
    await until(() => player.status === 'playing')
    expect(await player.speedStep(1)).toBe(105)
    flushSync()
    await until(() => player.snapshot?.speedPct === 105)
    expect(await player.speedStep(1, true)).toBe(130)
    await player.setSpeed(100)
    flushSync()
    await until(() => player.snapshot?.speedPct === 100)

    await player.toggleMute()
    flushSync()
    await until(() => player.snapshot?.volumePct === 0)
    expect(settings.value.volumePct).toBe(100)
    await player.setVolume(40)
    flushSync()
    await until(() => player.snapshot?.volumePct === 40)
    expect(player.muted).toBe(false)
  })

  it('Space with nothing loaded plays the idle target; with a play loaded it pauses and resumes', async () => {
    await boot()
    await player.toggle({ from: 5 })
    await until(() => player.status === 'playing')
    expect(player.currentAyahId).toBe(5)
    await player.toggle()
    await until(() => player.status === 'paused')
    await player.toggle()
    await until(() => player.status === 'playing')
  })

  it('a stop writes the audio position, which becomes the resume candidate', async () => {
    await boot()
    await player.playFrom({ ayahId: 3 })
    await until(() => player.currentAyahId === 3)
    await run(100)
    await player.stop()
    await until(() => player.status === 'idle')
    expect(player.resumeCandidate?.ayahId).toBe(3)
    await run(100)
    const saved = state.user.value.positions.find((p) => p.context === 'audio')
    expect(saved?.ayahId).toBe(3)
    // Space now resumes it, before any idle target.
    await player.toggle({ from: 100 })
    await until(() => player.status === 'playing')
    expect(player.currentAyahId).toBe(3)
  })

  it('a quit writes the audio position still waiting for its debounce before app_quit', async () => {
    await boot()
    const saved = () => state.user.value.positions.find((p) => p.context === 'audio')?.ayahId
    const atQuit: (number | undefined)[] = []
    const quit = vi.spyOn(api, 'appQuit').mockImplementation(() => {
      atQuit.push(saved())
      return Promise.resolve({ status: 'ok', data: null })
    })
    await player.playFrom({ ayahId: 3 })
    await until(() => player.currentAyahId === 3)
    await run(100)
    expect(saved()).toBeUndefined() // inside the 1 s debounce
    const quitting = app.quit()
    await until(() => quit.mock.calls.length === 1, 2_000)
    await quitting
    expect(atQuit).toEqual([3])
    expect(player.resumeCandidate?.ayahId).toBe(3)
  })

  it('the natural end moves the resume point past the range', async () => {
    await boot()
    await player.playRange(1, 2)
    await until(() => player.status === 'playing')
    await until(() => player.status === 'idle', 60_000)
    expect(player.snapshot?.range).not.toBeNull()
    expect(player.resumeCandidate?.ayahId).toBe(3)
  })

  it('offers a resume candidate from the bootstrap only for 7 days', async () => {
    const position = (age: number): ReadingPosition => ({
      context: 'audio',
      layout: 'v2',
      page: 293,
      ayahId: quran.ayahId(18, 45) || 2_185,
      scrollPx: null,
      updatedAt: Math.floor(Date.now() / 1000) - age,
    })
    await boot(() => state.user.update((u) => u.positions.push(position(3_600))))
    expect(player.resumeCandidate?.ayahId).toBe(quran.ayahId(18, 45))
    player.dismissResume()
    expect(player.resumeCandidate).toBeNull()
    player.reset()
    await boot(() => state.user.update((u) => u.positions.push(position(RESUME_MAX_AGE_S + 60))))
    expect(player.resumeCandidate).toBeNull()
  })

  it('an offline play of a surah that is not on disk fails with the offline copy', async () => {
    await boot(() => state.settings.update((s) => (s.networkAllowed = false)))
    await player.playFrom({ ayahId: quran.ayahId(36, 1) })
    await until(() => player.error !== null)
    expect(player.error?.kind).toBe('offline')
    expect(player.error?.surah).toBe(36)
    player.dismissError()
    expect(player.error).toBeNull()
  })

  it('a rejected play keeps its request for Retry', async () => {
    await boot()
    audioMock.failNextPlay('network', 'boom')
    await player.playFrom({ ayahId: 1 })
    expect(player.error?.kind).toBe('other')
    expect(player.error?.error.kind).toBe('network')
    await player.retry()
    await until(() => player.status === 'playing')
    expect(player.error).toBeNull()
  })

  it('setReciter persists the choice and moves a loaded play over at the heard ayah', async () => {
    await boot()
    await player.playFrom({ ayahId: 2 }, { startPaused: true })
    await until(() => player.status === 'paused')
    await player.setReciter(3)
    expect(settings.value.reciterId).toBe(3)
    await until(() => player.status === 'paused' && player.snapshot?.reciterId === 3)
    expect(player.currentAyahId).toBe(2)
    expect(player.snapshot?.range?.to).toEqual({ surah: 1, ayah: 7 })
  })

  it('a preview is no part of the listening: no position, no resume candidate, Space plays the page', async () => {
    await boot()
    expect(player.resumeCandidate).toBeNull()
    const audioPlay = vi.spyOn(api, 'audioPlay')
    await player.preview(7, { surah: 1, ayah: 1 })
    expect(player.previewing).toBe(true)
    // The app records no listen history for it and never replays it from a media key (`record: false`).
    expect(audioPlay.mock.calls[0]?.[0]).toMatchObject({ reciterId: 7, record: false })
    audioPlay.mockRestore()
    await until(() => player.status === 'playing' && player.currentAyahId === 1)
    // Its natural end (the ayah after the range would be the resume point of a real play).
    await until(() => player.status === 'idle', 60_000)
    await run(1_500)
    expect(player.previewing).toBe(false)
    expect(player.resumeCandidate).toBeNull()
    expect(player.audioPosition).toBeNull()
    expect(state.user.value.positions.some((p) => p.context === 'audio')).toBe(false)
    // Space plays the visible page's ayah, never the preview again.
    await player.toggle({ from: 100 })
    await until(() => player.status === 'playing')
    expect(player.currentAyahId).toBe(100)
  })

  it('a stopped preview leaves the resume point of the last real play alone', async () => {
    await boot()
    await player.playFrom({ ayahId: 3 })
    await until(() => player.currentAyahId === 3)
    await player.stop()
    await until(() => player.status === 'idle')
    expect(player.resumeCandidate?.ayahId).toBe(3)
    await player.preview(2, { surah: 1, ayah: 1 })
    await until(() => player.status === 'playing')
    await player.stopPreview()
    await until(() => player.status === 'idle')
    await run(1_500)
    expect(player.resumeCandidate?.ayahId).toBe(3)
    expect(state.user.value.positions.find((p) => p.context === 'audio')?.ayahId).toBe(3)
  })

  it('a play started over the preview counts again', async () => {
    await boot()
    await player.preview(7, { surah: 1, ayah: 1 })
    await until(() => player.status === 'playing')
    await player.playFrom({ ayahId: 5 })
    expect(player.previewing).toBe(false)
    await until(() => player.currentAyahId === 5)
    await player.stop()
    await until(() => player.status === 'idle')
    expect(player.resumeCandidate?.ayahId).toBe(5)
  })

  it('clears an offline failure once network use is possible again', async () => {
    await boot(() => state.settings.update((s) => (s.networkAllowed = false)))
    await player.playFrom({ ayahId: quran.ayahId(36, 1) })
    await until(() => player.error !== null)
    expect(player.error?.kind).toBe('offline')
    await settings.update({ networkAllowed: true })
    await until(() => player.error === null)
    // Another kind of failure stays until dismissed or retried.
    audioMock.failNextPlay('network', 'boom')
    await player.playFrom({ ayahId: 1 })
    expect(player.error?.kind).toBe('other')
    await settings.update({ networkAllowed: false })
    await settings.update({ networkAllowed: true })
    flushSync()
    expect(player.error?.kind).toBe('other')
  })

  it('keeps at most 12 surahs of timings, never those of the loaded play', async () => {
    await boot()
    await player.playRange(quran.ayahId(2, 1), quran.ayahId(2, 3), {})
    await until(() => player.status === 'playing' && player.heard?.surah === 2)
    const keys = () => player.timings.keys()
    const fake = (surah: number): SurahTimings =>
      ({ reciterId: 9, surah, ayahs: [] }) as unknown as SurahTimings
    const getTimings = vi
      .spyOn(api, 'audioGetTimings')
      .mockImplementation(async (reciterId, surah) => ({ status: 'ok', data: { ...fake(surah), reciterId } }))
    for (let surah = 50; surah < 70; surah++) await player.ensureTimings(9, surah)
    expect(getTimings).toHaveBeenCalledTimes(20)
    expect(keys().length).toBeLessThanOrEqual(12)
    expect(keys()).toContain('7:2')
    expect(keys()).toContain('9:69')
    expect(keys()).not.toContain('9:50')
    expect(player.timingsFor(7, 2)).not.toBeNull()
  })

  it('reads the audio position of a restored library', async () => {
    await boot()
    await player.playFrom({ ayahId: 3 })
    await until(() => player.currentAyahId === 3)
    await player.stop()
    await until(() => player.status === 'idle')
    await run(100)
    const path = 'D:/Backups/before.qdb'
    await call(api.userBackupCreate(path))
    await player.playFrom({ ayahId: 6 })
    await until(() => player.currentAyahId === 6)
    await player.stop()
    await until(() => player.resumeCandidate?.ayahId === 6)
    await run(100)
    await call(api.userBackupRestore(path))
    await until(() => player.resumeCandidate?.ayahId === 3)
  })

  it('next/prev skip ayahs; seekAyah and nudge move inside the range', async () => {
    await boot()
    await player.playFrom({ ayahId: 1 }, { startPaused: true })
    await until(() => player.status === 'paused')
    await player.next()
    await until(() => player.currentAyahId === 2)
    await player.seekAyah(5)
    await until(() => player.currentAyahId === 5)
    await player.prev() // at the start of 5: within 1.5 s → 4
    await until(() => player.currentAyahId === 4)
    const before = player.positionMs
    await player.nudge(1_000)
    await until(() => player.positionMs >= before + 999)
  })

  it('a play that failed mid-way names the surah that failed; Space and Retry continue it where it stopped', async () => {
    // Surah 1 is on disk (1:6, 1:7 and the basmala of surah 2); surah 2 streams, slowly.
    await boot(() =>
      state.packs.update((p) => {
        p.items['audio.qdc.7'] = [{ item: 1, pinned: true, queued: false, kib: 200 }]
      }),
    )
    audioMock.setStreamRate(0.5)
    await player.playRange(quran.ayahId(1, 6), quran.ayahId(2, 2))
    await until(() => player.status === 'playing')
    // Network use goes off while surah 1 plays: surah 2's stream stalls, and the play fails when it gets there.
    await settings.update({ networkAllowed: false })
    await until(() => player.status === 'error', 60_000)
    expect(player.snapshot?.current).toEqual({ surah: 2, ayah: 1 })
    expect(player.snapshot?.range).toEqual({ from: { surah: 1, ayah: 6 }, to: { surah: 2, ayah: 2 } })
    expect(player.error?.kind).toBe('offline')
    expect(player.error?.surah).toBe(2) // not the range's first surah

    // Still offline: Space (even with an idle target) tries again from the same place in the engine, and the failed
    // play stays as it was.
    player.dismissResume()
    const resume = vi.spyOn(api, 'audioResume')
    const play = vi.spyOn(api, 'audioPlay')
    await player.toggle({ from: 100 })
    await until(() => player.status === 'loading')
    await until(() => player.status === 'error')
    expect(resume).toHaveBeenCalledTimes(1)
    expect(play).not.toHaveBeenCalled()
    expect(player.snapshot?.current).toEqual({ surah: 2, ayah: 1 })
    expect(player.error?.surah).toBe(2)

    // Back online (the offline copy clears itself): Retry continues at 2:1, never from the range's start.
    audioMock.setStreamRate(null)
    await settings.update({ networkAllowed: true })
    await until(() => player.error === null)
    await player.retry()
    await until(() => player.status === 'playing')
    expect(resume).toHaveBeenCalledTimes(2)
    expect(play).not.toHaveBeenCalled()
    expect(player.snapshot?.current).toEqual({ surah: 2, ayah: 1 })
    expect(player.snapshot?.range?.from).toEqual({ surah: 1, ayah: 6 })
  })
})
