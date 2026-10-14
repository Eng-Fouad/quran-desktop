import { describe, expect, it } from 'vitest'
import { LRU } from './lru'

describe('LRU', () => {
  it('evicts the least recently used entries beyond its capacity, oldest first', () => {
    const lru = new LRU<number, string>(3)
    expect(lru.set(1, 'a')).toEqual([])
    lru.set(2, 'b')
    lru.set(3, 'c')
    expect(lru.get(1)).toBe('a') // 1 is now the most recent
    expect(lru.set(4, 'd')).toEqual([[2, 'b']])
    expect(lru.keys()).toEqual([3, 1, 4])
    expect(lru.size).toBe(3)
  })

  it('refreshes an existing key on set, and keeps undefined values', () => {
    const lru = new LRU<string, number | undefined>(2)
    lru.set('x', 1)
    lru.set('y', undefined)
    lru.set('x', 2)
    expect(lru.keys()).toEqual(['y', 'x'])
    expect(lru.has('y')).toBe(true)
    expect(lru.get('y')).toBeUndefined()
    expect(lru.keys()).toEqual(['x', 'y'])
    expect(lru.set('z', 3)).toEqual([['x', 2]])
  })

  it('deletes and clears', () => {
    const lru = new LRU<number, number>(4)
    lru.set(1, 1)
    lru.set(2, 2)
    expect(lru.delete(1)).toBe(true)
    expect(lru.delete(1)).toBe(false)
    lru.clear()
    expect(lru.size).toBe(0)
    expect(lru.get(2)).toBeUndefined()
  })

  it('rejects a capacity that is not a positive integer', () => {
    expect(() => new LRU(0)).toThrow(RangeError)
    expect(() => new LRU(1.5)).toThrow(RangeError)
    expect(() => new LRU(Number.NaN)).toThrow(RangeError)
  })
})
