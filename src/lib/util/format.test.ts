import { describe, expect, it } from 'vitest'
import { baseName, clamp, clock, speedLabel, splitAround } from './format'

describe('format', () => {
  it('clock: m:ss below an hour, h:mm:ss from one hour', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(83_999)).toBe('1:23')
    expect(clock(432_000)).toBe('7:12')
    expect(clock(3_600_000)).toBe('1:00:00')
    expect(clock(3_725_500)).toBe('1:02:05')
    expect(clock(-5)).toBe('0:00')
    expect(clock(Number.NaN)).toBe('0:00')
  })

  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-1, 0, 3)).toBe(0)
    expect(clamp(2, 0, 3)).toBe(2)
  })

  it('speedLabel: the dock speed (§9.7)', () => {
    expect(speedLabel(100)).toBe('1×')
    expect(speedLabel(125)).toBe('1.25×')
    expect(speedLabel(150)).toBe('1.5×')
    expect(speedLabel(50)).toBe('0.5×')
    expect(speedLabel(200)).toBe('2×')
    expect(speedLabel(105)).toBe('1.05×')
  })

  it('splitAround: a message around one placeholder', () => {
    expect(splitAround('Press {key} anytime', 'key')).toEqual(['Press ', ' anytime'])
    expect(splitAround('{key} first', 'key')).toEqual(['', ' first'])
    expect(splitAround('اضغط {key} في أي وقت', 'key')).toEqual(['اضغط ', ' في أي وقت'])
    expect(splitAround('No placeholder', 'key')).toBeNull()
  })

  it('baseName: the last path segment with either separator', () => {
    expect(baseName('C:\\Users\\x\\AppData\\user.db.corrupt-1760083200000')).toBe(
      'user.db.corrupt-1760083200000',
    )
    expect(baseName('/home/x/.local/share/user.db.corrupt-1')).toBe('user.db.corrupt-1')
    expect(baseName('C:/mock/com.quran.labs.desktop/')).toBe('com.quran.labs.desktop')
    expect(baseName('user.db')).toBe('user.db')
  })
})
