import { describe, expect, it } from 'vitest'
import { floorIndex, lowerBound, upperBound } from './binsearch'

const id = (n: number) => n
const starts = [1, 8, 15, 15, 22]

describe('binary searches', () => {
  it('lowerBound: the first index whose key is ≥ value', () => {
    expect(lowerBound(starts, 0, id)).toBe(0)
    expect(lowerBound(starts, 1, id)).toBe(0)
    expect(lowerBound(starts, 9, id)).toBe(2)
    expect(lowerBound(starts, 15, id)).toBe(2)
    expect(lowerBound(starts, 23, id)).toBe(5)
  })

  it('upperBound: the first index whose key is > value', () => {
    expect(upperBound(starts, 0, id)).toBe(0)
    expect(upperBound(starts, 15, id)).toBe(4)
    expect(upperBound(starts, 22, id)).toBe(5)
  })

  it('floorIndex: the last index whose key is ≤ value (the word at a playback time)', () => {
    const words = [{ startMs: 0 }, { startMs: 420 }, { startMs: 900 }]
    const key = (w: { startMs: number }) => w.startMs
    expect(floorIndex(words, -1, key)).toBe(-1)
    expect(floorIndex(words, 0, key)).toBe(0)
    expect(floorIndex(words, 899, key)).toBe(1)
    expect(floorIndex(words, 5000, key)).toBe(2)
    expect(floorIndex([], 3, key)).toBe(-1)
  })
})
