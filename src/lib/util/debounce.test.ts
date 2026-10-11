import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { debounce } from './debounce'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('debounce', () => {
  it('runs once on the trailing edge with the latest arguments', () => {
    const fn = vi.fn()
    const d = debounce(fn, 120)
    d('a')
    vi.advanceTimersByTime(100)
    d('ab')
    vi.advanceTimersByTime(100)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('ab')
  })

  it('cancels a pending call', () => {
    const fn = vi.fn()
    const d = debounce(fn, 50)
    d(1)
    d.cancel()
    vi.advanceTimersByTime(100)
    expect(fn).not.toHaveBeenCalled()
  })

  it('flushes a pending call at once, and flushing nothing does nothing', () => {
    const fn = vi.fn()
    const d = debounce(fn, 1000)
    d.flush()
    expect(fn).not.toHaveBeenCalled()
    d(7)
    d.flush()
    expect(fn).toHaveBeenCalledWith(7)
    vi.advanceTimersByTime(2000)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
