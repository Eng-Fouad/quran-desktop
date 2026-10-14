/**
 * Page turns with a stand-in reader as the turn host, in jsdom (no View Transitions API, so every turn commits
 * directly): the readiness wait, commits in request order, a single pending turn, superseded requests that never
 * commit, `cancelTurns`, and the `turning` flag.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  cancelTurns,
  isInstantReady,
  setTurnHost,
  turnInProgress,
  turnTo,
  type TurnHost,
} from './transitions'

interface FakeHost extends TurnHost {
  page: number
  commits: number[]
  turning: boolean[]
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    page: 1,
    commits: [],
    turning: [],
    style: () => 'hafs',
    pagesFor: (p) => [p],
    setPageNow(p) {
      host.page = p
      host.commits.push(p)
    },
    canAnimate: () => true,
    setTurning(on) {
      host.turning.push(on)
    },
  }
  return host
}

let release: (() => void) | null = null

afterEach(() => {
  cancelTurns()
  release?.()
  release = null
})

describe('turnTo', () => {
  it('commits the page and reports the turn', async () => {
    const host = fakeHost()
    release = setTurnHost(host)
    const done = turnTo(3, 'next')
    expect(turnInProgress()).toBe(true)
    await done
    expect(host.commits).toEqual([3])
    expect(host.turning).toEqual([true, false])
    expect(turnInProgress()).toBe(false)
  })

  it('keeps one pending turn: the newest request replaces the waiting one', async () => {
    const host = fakeHost()
    release = setTurnHost(host)
    const a = turnTo(3, 'next')
    const b = turnTo(5, 'next')
    const c = turnTo(7, 'next')
    await Promise.all([a, b, c])
    // The first turn was superseded during its readiness wait; 5 was replaced by 7 before it started.
    expect(host.commits).toEqual([7])
    expect(host.page).toBe(7)
    expect(host.turning).toEqual([true, false])
  })

  it('drops everything on cancelTurns, then turns again', async () => {
    const host = fakeHost()
    release = setTurnHost(host)
    const a = turnTo(3, 'next')
    cancelTurns()
    await a
    expect(host.commits).toEqual([])
    await turnTo(9, 'next')
    expect(host.commits).toEqual([9])
  })

  it('resolves without a host, and a removed host no longer commits', async () => {
    await expect(turnTo(3, 'next')).resolves.toBeUndefined()
    const host = fakeHost()
    const remove = setTurnHost(host)
    remove()
    await turnTo(3, 'next')
    expect(host.commits).toEqual([])
  })

  it('reads instant readiness from the page cache and the fonts (hafs needs no font)', () => {
    const host = fakeHost()
    release = setTurnHost(host)
    // Nothing is cached in this test: the page data is missing.
    expect(isInstantReady(3)).toBe(false)
  })
})
