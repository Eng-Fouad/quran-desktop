import { describe, expect, it, vi } from 'vitest'
import { afterPaint, nextFrame, rafThrottle } from './raf'

describe('animation-frame helpers', () => {
  it('resolves on the next frame, and after two frames', async () => {
    const order: string[] = []
    const one = nextFrame().then(() => order.push('frame'))
    const two = afterPaint().then(() => order.push('paint'))
    await Promise.all([one, two])
    expect(order).toEqual(['frame', 'paint'])
  })

  it('coalesces calls to one per frame with the latest arguments', async () => {
    const fn = vi.fn()
    const throttled = rafThrottle(fn)
    throttled(1)
    throttled(2)
    throttled(3)
    expect(fn).not.toHaveBeenCalled()
    await afterPaint()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(3)
  })

  it('cancels a scheduled call', async () => {
    const fn = vi.fn()
    const throttled = rafThrottle(fn)
    throttled('x')
    throttled.cancel()
    await afterPaint()
    expect(fn).not.toHaveBeenCalled()
    throttled('y')
    await afterPaint()
    expect(fn).toHaveBeenCalledWith('y')
  })
})
