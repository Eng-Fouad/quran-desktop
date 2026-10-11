/**
 * The audio mock (§5.17, §2.3; WP9a): validation like the commands (WP4d deviation 15), `to` resolution (§5.8), the
 * planner's basmala rule (§2.3.3), statuses (WP4c deviation 6), repeats, gaps, A-B, skips, the end, offline behaviour,
 * stream caching and the reciters' counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, call, initIpc, IpcError } from '$lib/ipc'
import type { AudioSnapshot, AudioTick, PlayRequest } from '$lib/ipc/bindings'
import { state } from '../state'
import { audioChannels, audioMock, LOAD_MS, PREVIOUS_WINDOW_MS, snapshot, TICK_MS } from './audio'
import { packsMock } from './packs'

function request(patch: Partial<PlayRequest> = {}): PlayRequest {
  return {
    reciterId: 7,
    from: { surah: 1, ayah: 1 },
    to: null,
    stopAt: 'end_of_surah',
    layout: 'v2',
    ayahRepeat: 1,
    rangeRepeat: 1,
    gap: { type: 'none' },
    startPaused: false,
    ...patch,
  }
}

let ticks: AudioTick[] = []

async function setup(): Promise<void> {
  localStorage.clear()
  await initIpc()
  audioMock.reset()
  packsMock.reset()
  state.resetAll()
  state.loadAll()
  ticks = []
  const channel = { onmessage: (t: AudioTick) => void ticks.push(t) }
  await call(api.audioSubscribe(channel as never))
  // Fixture modules load in real time: load the ones these tests use before the fake clock runs.
  for (const surah of [1, 2, 3, 9, 112, 113, 114]) await call(api.audioGetTimings(7, surah))
}

async function play(patch: Partial<PlayRequest> = {}): Promise<AudioSnapshot> {
  const s = await call(api.audioPlay(request(patch)))
  await vi.advanceTimersByTimeAsync(LOAD_MS + 1)
  return s
}

async function run(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

async function until(done: () => boolean, maxMs = 60_000): Promise<void> {
  for (let t = 0; t <= maxMs; t += TICK_MS) {
    if (done()) return
    await vi.advanceTimersByTimeAsync(TICK_MS)
  }
  throw new Error(`condition not met within ${maxMs} ms`)
}

async function rejects(p: Promise<unknown>, kind: string): Promise<void> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(IpcError)
  expect((e as IpcError).kind).toBe(kind)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  await setup()
})

afterEach(() => {
  audioMock.reset()
  packsMock.reset()
  state.resetAll()
  vi.useRealTimers()
})

describe('audio mock: validation (WP4d deviation 15)', () => {
  it('rejects bad arguments with invalid_argument', async () => {
    await rejects(call(api.audioSetSpeed(52)), 'invalid_argument')
    await rejects(call(api.audioSetSpeed(250)), 'invalid_argument')
    await rejects(call(api.audioSetVolume(101)), 'invalid_argument')
    await rejects(call(api.audioSetRepeat(100, 1)), 'invalid_argument')
    await rejects(call(api.audioSetGap({ type: 'fixed', data: { ms: 30_001 } })), 'invalid_argument')
    await rejects(call(api.audioSetGap({ type: 'multiplier', data: { pct: 301 } })), 'invalid_argument')
    await rejects(call(api.audioSetAbLoop({ aMs: 1_000, bMs: 1_200 })), 'invalid_argument')
    await rejects(call(api.audioSeek({ type: 'ayah', data: { ayahId: 0 } })), 'invalid_argument')
    await rejects(call(api.audioGetTimings(7, 115)), 'invalid_argument')
    await rejects(call(api.audioPlay(request({ from: { surah: 1, ayah: 8 } }))), 'invalid_argument')
    await rejects(
      call(api.audioPlay(request({ from: { surah: 2, ayah: 5 }, to: { surah: 2, ayah: 4 } }))),
      'invalid_argument',
    )
    await rejects(call(api.audioPlay(request({ reciterId: 9_999 }))), 'not_found')
    // `record` is optional and boolean, as serde reads it.
    await rejects(call(api.audioPlay(request({ record: 'no' as never }))), 'invalid_argument')
  })

  it('takes a preview (`record: false`) like any play', async () => {
    const s = await call(api.audioPlay(request({ record: false, to: { surah: 1, ayah: 1 } })))
    expect(s.status).toBe('loading')
    await run(LOAD_MS + 1)
    await until(() => snapshot().status === 'playing')
    expect(snapshot().range).toEqual({ from: { surah: 1, ayah: 1 }, to: { surah: 1, ayah: 1 } })
  })
})

describe('audio mock: planning and `to` (§2.3.3, §5.8)', () => {
  it('answers the optimistic loading snapshot with the resolved range, then plays', async () => {
    const s = await call(api.audioPlay(request()))
    expect(s.status).toBe('loading')
    expect(s.range).toEqual({ from: { surah: 1, ayah: 1 }, to: { surah: 1, ayah: 7 } })
    await run(LOAD_MS + 1)
    expect(snapshot().status).toBe('playing')
    expect(snapshot().current).toEqual({ surah: 1, ayah: 1 })
  })

  it('puts the basmala before ayah 1 of every surah but 1 and 9, from surah 1’s file', async () => {
    await play({ from: { surah: 112, ayah: 1 }, to: { surah: 114, ayah: 6 } })
    const q = audioMock.queue()
    expect(q[0]).toEqual([112, 0])
    expect(q.filter(([, a]) => a === 0)).toEqual([
      [112, 0],
      [113, 0],
      [114, 0],
    ])
    expect(snapshot().current).toEqual({ surah: 112, ayah: 0 })
    expect(snapshot().currentAyahId).toBe(0)
    await play({ from: { surah: 1, ayah: 1 } })
    expect(audioMock.queue()[0]).toEqual([1, 1])
    await play({ from: { surah: 9, ayah: 1 }, to: { surah: 9, ayah: 2 } })
    expect(audioMock.queue()[0]).toEqual([9, 1])
    await play({ from: { surah: 2, ayah: 3 }, to: { surah: 2, ayah: 4 } })
    expect(audioMock.queue()[0]).toEqual([2, 3])
  })

  it('resolves stop-at units: end of page, juz, Quran, and the settings default', async () => {
    let s = await call(api.audioPlay(request({ stopAt: 'end_of_page', from: { surah: 1, ayah: 3 } })))
    expect(s.range?.to).toEqual({ surah: 1, ayah: 7 })
    s = await call(api.audioPlay(request({ stopAt: 'end_of_juz', from: { surah: 2, ayah: 100 } })))
    expect(s.range?.to).toEqual({ surah: 2, ayah: 141 })
    s = await call(api.audioPlay(request({ stopAt: 'end_of_quran', from: { surah: 114, ayah: 2 } })))
    expect(s.range?.to).toEqual({ surah: 114, ayah: 6 })
    state.settings.update((v) => (v.stopAt = 'end_of_juz'))
    s = await call(api.audioPlay(request({ stopAt: null, from: { surah: 2, ayah: 1 } })))
    expect(s.range?.to).toEqual({ surah: 2, ayah: 141 })
  })

  it('starts paused with startPaused, and a pause sent while loading also starts it paused', async () => {
    await play({ startPaused: true })
    expect(snapshot().status).toBe('paused')
    await call(api.audioPlay(request()))
    await call(api.audioPause())
    await run(LOAD_MS + 1)
    expect(snapshot().status).toBe('paused')
  })
})

describe('audio mock: the clock, ticks and events', () => {
  it('advances by wall time × speed and ticks at ~30 Hz with the word heard', async () => {
    await play()
    ticks = []
    await run(1_000)
    expect(ticks.length).toBeGreaterThanOrEqual(28)
    const last = ticks.at(-1)
    expect(last?.fileMs).toBeGreaterThanOrEqual(950)
    expect(last?.wordPos).toBe(2) // 1:1's words are 680 ms each in the fixture
    await call(api.audioSetSpeed(200))
    const before = snapshot().fileMs
    await run(1_000)
    expect(snapshot().fileMs - before).toBeGreaterThanOrEqual(1_900)
  })

  it('a speed change is a flush (new generation)', async () => {
    await play()
    await run(200)
    const g = ticks.at(-1)?.generation ?? 0
    await call(api.audioSetSpeed(150))
    expect(ticks.at(-1)?.generation).toBe(g + 1)
  })

  it('ends idle keeping the reciter and the range; a stop clears both', async () => {
    await play({ from: { surah: 1, ayah: 6 } })
    await until(() => snapshot().status === 'idle')
    expect(snapshot().range).toEqual({ from: { surah: 1, ayah: 6 }, to: { surah: 1, ayah: 7 } })
    expect(snapshot().current).toBeNull()
    expect(snapshot().reciterId).toBe(7)
    await play()
    await call(api.audioStop())
    expect(snapshot().status).toBe('idle')
    expect(snapshot().range).toBeNull()
  })

  it('a reload starts idle: the slice keeps only the idle snapshot', async () => {
    await play()
    await call(api.audioSetSpeed(125))
    expect(state.audio.value.snapshot.status).toBe('idle')
    expect(state.audio.value.snapshot.speedPct).toBe(125)
  })
})

describe('audio mock: repeats, gaps, A-B and skips', () => {
  it('plays each ayah N times with a gap ×1 after every play but the last', async () => {
    await play({
      from: { surah: 1, ayah: 1 },
      to: { surah: 1, ayah: 2 },
      ayahRepeat: 2,
      gap: { type: 'multiplier', data: { pct: 100 } },
    })
    expect(snapshot().ayahRepeatLeft).toBe(1)
    await until(() => ticks.at(-1)?.inGap === true)
    expect(snapshot().current).toEqual({ surah: 1, ayah: 1 })
    expect(ticks.at(-1)?.wordPos).toBe(0)
    await until(() => ticks.at(-1)?.inGap === false)
    expect(snapshot().ayahRepeatLeft).toBe(0)
    expect(snapshot().current).toEqual({ surah: 1, ayah: 1 })
    await until(() => snapshot().current?.ayah === 2)
    expect(snapshot().ayahRepeatLeft).toBe(1)
    await until(() => snapshot().status === 'idle')
  })

  it('replays the range N times; infinite counters read 0', async () => {
    await play({ from: { surah: 1, ayah: 6 }, rangeRepeat: 2 })
    expect(snapshot().rangeRepeatLeft).toBe(1)
    await until(() => snapshot().rangeRepeatLeft === 0)
    expect(snapshot().current).toEqual({ surah: 1, ayah: 6 })
    await call(api.audioSetRepeat(0, 0))
    expect(snapshot().ayahRepeatLeft).toBe(0)
    expect(snapshot().rangeRepeatLeft).toBe(0)
  })

  it('wraps an A-B loop from B to A and suspends repeats inside it', async () => {
    await play({ ayahRepeat: 3 })
    await call(api.audioSetAbLoop({ aMs: 500, bMs: 1_500 }))
    expect(snapshot().abLoop).toEqual({ aMs: 500, bMs: 1_500 })
    expect(snapshot().ayahRepeatLeft).toBe(0)
    let max = 0
    for (let i = 0; i < 100; i++) {
      await run(TICK_MS)
      max = Math.max(max, snapshot().fileMs)
    }
    expect(max).toBeLessThan(1_500 + TICK_MS * 2)
    await call(api.audioSetAbLoop(null))
    expect(snapshot().abLoop).toBeNull()
  })

  it('skips: previous within 1.5 s goes back, later restarts; next at the end stops; ayah seeks stay in range', async () => {
    await play({ from: { surah: 1, ayah: 2 } })
    await call(api.audioSkip('next'))
    expect(snapshot().current?.ayah).toBe(3)
    await call(api.audioSkip('previous'))
    expect(snapshot().current?.ayah).toBe(2)
    await run(PREVIOUS_WINDOW_MS + 300)
    await call(api.audioSkip('previous'))
    expect(snapshot().current?.ayah).toBe(2)
    await call(api.audioSeek({ type: 'ayah', data: { ayahId: 1 } })) // outside the range: ignored
    expect(snapshot().current?.ayah).toBe(2)
    await call(api.audioSeek({ type: 'ayah', data: { ayahId: 7 } }))
    expect(snapshot().current?.ayah).toBe(7)
    await call(api.audioSkip('next'))
    expect(snapshot().status).toBe('idle')
  })

  it('seeks the file timeline into the segment that holds the time, and holds commands while loading', async () => {
    await call(api.audioPlay(request({ startPaused: true })))
    await call(api.audioSeek({ type: 'file_ms', data: { ms: 3_900 } }))
    await run(LOAD_MS + 1)
    expect(snapshot().status).toBe('paused')
    expect(snapshot().current?.ayah).toBe(2)
    expect(snapshot().fileMs).toBe(3_900)
    expect(ticks.at(-1)?.wordPos).toBe(2)
    await call(api.audioSeek({ type: 'relative_ms', data: { deltaMs: -10_000 } }))
    expect(snapshot().fileMs).toBe(0)
  })
})

describe('audio mock: the engine’s bounds and retries (WP4c deviation 11, `control.rs`)', () => {
  /** An ayah's span in a surah's timings. */
  async function ayah(surah: number, n: number): Promise<{ fromMs: number; toMs: number }> {
    const span = (await call(api.audioGetTimings(7, surah))).ayahs.find((a) => a.ayah === n)
    if (!span) throw new Error(`no timings for ${surah}:${n}`)
    return span
  }
  /** 1:6, 1:7, the basmala of surah 2 (1:1 of the surah-1 file), 2:1, 2:2. */
  const SPAN = { from: { surah: 1, ayah: 6 }, to: { surah: 2, ayah: 2 } }

  it('Next at the last ayah starts the next pass while range repeats remain, else stops', async () => {
    await play({ from: { surah: 1, ayah: 6 }, rangeRepeat: 2 })
    await call(api.audioSkip('next'))
    expect(snapshot().current).toEqual({ surah: 1, ayah: 7 })
    await call(api.audioSkip('next'))
    expect(snapshot()).toMatchObject({
      status: 'playing',
      current: { surah: 1, ayah: 6 },
      rangeRepeatLeft: 0,
    })
    await call(api.audioSkip('next'))
    await call(api.audioSkip('next'))
    expect(snapshot().status).toBe('idle')
    // ∞: every Next at the last ayah is another pass.
    await play({ from: { surah: 1, ayah: 7 }, rangeRepeat: 0 })
    for (let i = 0; i < 3; i++) {
      await call(api.audioSkip('next'))
      expect(snapshot()).toMatchObject({ status: 'playing', current: { surah: 1, ayah: 7 } })
    }
  })

  it('seeks the file timeline within the heard run: never outside the range, nor to the basmala’s 1:1', async () => {
    const [a16, a17, a21] = await Promise.all([ayah(1, 6), ayah(1, 7), ayah(2, 1)])
    await play({ ...SPAN, startPaused: true })
    expect(audioMock.queue()).toEqual([
      [1, 6],
      [1, 7],
      [2, 0],
      [2, 1],
      [2, 2],
    ])
    await call(api.audioSeek({ type: 'ayah', data: { ayahId: 7 } }))
    // The scrubber dragged to 0 from 1:7: 1:6's start, not the 1:1 audio that the basmala plays.
    await call(api.audioSeek({ type: 'file_ms', data: { ms: 0 } }))
    expect(snapshot()).toMatchObject({ current: { surah: 1, ayah: 6 }, fileMs: a16.fromMs })
    // A nudge back at the range's start stays there.
    await call(api.audioSeek({ type: 'relative_ms', data: { deltaMs: -5_000 } }))
    expect(snapshot()).toMatchObject({ current: { surah: 1, ayah: 6 }, fileMs: a16.fromMs })
    // Past the run: its end, in its last segment (never the basmala or another file).
    await call(api.audioSeek({ type: 'file_ms', data: { ms: a17.toMs + 60_000 } }))
    expect(snapshot()).toMatchObject({ current: { surah: 1, ayah: 7 }, fileMs: a17.toMs - 1 })
    // Surah 2's run starts at 2:1.
    await call(api.audioSeek({ type: 'ayah', data: { ayahId: 9 } }))
    await call(api.audioSeek({ type: 'file_ms', data: { ms: 0 } }))
    expect(snapshot()).toMatchObject({ current: { surah: 2, ayah: 1 }, fileMs: a21.fromMs })
  })

  it('bounds an A-B loop to the heard run; one left under 300 ms is ignored and clears the loop in force', async () => {
    const [a16, a17] = await Promise.all([ayah(1, 6), ayah(1, 7)])
    await play({ ...SPAN, startPaused: true })
    await call(api.audioSetAbLoop({ aMs: 0, bMs: a16.fromMs + 1_000 }))
    expect(snapshot().abLoop).toEqual({ aMs: a16.fromMs, bMs: a16.fromMs + 1_000 })
    // Before the range: nothing of it is played, so it is ignored, and the loop in force goes.
    expect(a16.fromMs).toBeGreaterThanOrEqual(300)
    await call(api.audioSetAbLoop({ aMs: 0, bMs: a16.fromMs }))
    expect(snapshot().abLoop).toBeNull()
    // Past the end: bounded to the run's end, and the position moves into the loop.
    await call(api.audioSetAbLoop({ aMs: a17.toMs - 1_000, bMs: a17.toMs + 60_000 }))
    expect(snapshot()).toMatchObject({
      abLoop: { aMs: a17.toMs - 1_000, bMs: a17.toMs },
      current: { surah: 1, ayah: 7 },
      fileMs: a17.toMs - 1_000,
    })
  })

  it('a stalled stream fails the play mid-way; Play continues it from the segment heard, in its pass', async () => {
    // Surah 1 is on disk (1:6, 1:7 and the basmala); surah 2 streams slowly.
    state.packs.update((p) => {
      p.items['audio.qdc.7'] = [{ item: 1, pinned: true, queued: false, kib: 200 }]
    })
    audioMock.setStreamRate(0.5)
    await play({ ...SPAN, rangeRepeat: 2 })
    expect(snapshot().status).toBe('playing')
    state.settings.update((s) => (s.networkAllowed = false))
    await until(() => snapshot().status === 'error')
    expect(snapshot()).toMatchObject({
      reciterId: 7,
      current: { surah: 2, ayah: 1 },
      range: SPAN,
      rangeRepeatLeft: 1,
      error: { kind: 'offline' },
    })
    // A failed play takes no transport command.
    await call(api.audioSkip('next'))
    await call(api.audioSeek({ type: 'file_ms', data: { ms: 0 } }))
    expect(snapshot().current).toEqual({ surah: 2, ayah: 1 })

    // Still offline: Play tries again, fails before it starts, and the failed play stays as it was.
    await call(api.audioResume())
    expect(snapshot()).toMatchObject({ status: 'loading', current: { surah: 2, ayah: 1 }, error: null })
    await run(LOAD_MS + 50)
    expect(snapshot()).toMatchObject({ status: 'error', current: { surah: 2, ayah: 1 }, range: SPAN })

    // Online: Play (toggle) continues at 2:1 in the first pass; the range shown stays the one asked for.
    audioMock.setStreamRate(null)
    state.settings.update((s) => (s.networkAllowed = true))
    await call(api.audioToggle())
    await run(LOAD_MS + 50)
    expect(snapshot()).toMatchObject({
      status: 'playing',
      current: { surah: 2, ayah: 1 },
      range: SPAN,
      rangeRepeatLeft: 1,
      error: null,
    })
    // Then the second pass, from the range's start, and the end.
    await until(() => snapshot().rangeRepeatLeft === 0)
    expect(snapshot().current).toEqual({ surah: 1, ayah: 6 })
    await until(() => snapshot().status === 'idle', 120_000)
  })

  it('a play that fails before it starts keeps its reciter and range with the error', async () => {
    state.settings.update((s) => (s.networkAllowed = false))
    await play({ reciterId: 7, ...SPAN })
    expect(snapshot()).toMatchObject({
      status: 'error',
      reciterId: 7,
      current: null,
      range: SPAN,
      error: { kind: 'offline' },
    })
    // Play has nothing to continue: it stays failed until a new play.
    await call(api.audioResume())
    expect(snapshot().status).toBe('error')
  })
})

describe('audio mock: network, caching and reciters', () => {
  it('offline: a surah that is not on disk fails the play with offline', async () => {
    state.settings.update((s) => (s.networkAllowed = false))
    await play({ from: { surah: 3, ayah: 1 }, to: { surah: 3, ayah: 2 } })
    expect(snapshot().status).toBe('error')
    expect(snapshot().error?.kind).toBe('offline')
    expect(snapshot().range?.from).toEqual({ surah: 3, ayah: 1 })
  })

  it('offline: an uncached surah 1 skips the basmala with the flag', async () => {
    state.packs.update((p) => {
      p.items['audio.qdc.7'] = [{ item: 112, pinned: true, queued: false, kib: 200 }]
    })
    state.settings.update((s) => (s.networkAllowed = false))
    await play({ from: { surah: 112, ayah: 1 } })
    expect(snapshot().status).toBe('playing')
    expect(snapshot().basmalaSkipped).toBe(true)
    expect(audioMock.queue()[0]).toEqual([112, 1])
  })

  it('streams uncached files and records them as stream-cached when complete', async () => {
    await play({ from: { surah: 112, ayah: 1 } })
    await run(5_000)
    const items = state.packs.value.items['audio.qdc.7'] ?? []
    expect(items.some((i) => i.item === 112 && !i.pinned)).toBe(true)
    expect(items.some((i) => i.item === 1 && !i.pinned)).toBe(true) // the basmala's file
    const reciters = await call(api.audioListReciters())
    expect(reciters.find((r) => r.id === 7)?.cachedSurahs).toBe(2)
  })

  it('buffers when the position catches up with a slow stream', async () => {
    audioMock.setStreamRate(4) // 4 KB/s: slower than the 16 KB/s file
    await play({ from: { surah: 1, ayah: 1 } })
    await until(() => snapshot().status === 'buffering', 10_000)
    expect(snapshot().bufferedPct).toBeLessThan(100)
  })

  it('no output device: error status with the engine message', async () => {
    audioMock.setNoOutput(true)
    expect(snapshot().status).toBe('error')
    expect(snapshot().error).toEqual({ kind: 'audio', message: 'no audio output device' })
    expect(snapshot().device).toBeNull()
    audioMock.setNoOutput(false)
    expect(snapshot().status).toBe('idle')
  })

  it('timings: offline answers offline for timings neither stored nor on disk', async () => {
    state.settings.update((s) => (s.networkAllowed = false))
    await rejects(call(api.audioGetTimings(7, 50)), 'offline')
    expect((await call(api.audioGetTimings(7, 1))).surah).toBe(1) // fetched earlier this session
  })

  it('emits audio-ayah-changed once per heard ayah, not per repeat', async () => {
    const heard: number[] = []
    const { events } = await import('$lib/ipc')
    const off = await events.audioAyahChanged.listen((e) => void heard.push(e.payload.ayah))
    await play({ from: { surah: 1, ayah: 1 }, to: { surah: 1, ayah: 2 }, ayahRepeat: 2 })
    await until(() => snapshot().status === 'idle')
    off()
    expect(heard).toEqual([1, 2])
    expect(audioChannels.tick).not.toBeNull()
  })
})
