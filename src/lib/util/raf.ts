/** requestAnimationFrame helpers. */

/** Resolves on the next animation frame. */
export function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

/** Resolves after two frames: the first paint of the current DOM has happened (`markReady`). */
export async function afterPaint(): Promise<void> {
  await nextFrame()
  await nextFrame()
}

/** Coalesces calls to at most one per animation frame, with the latest arguments. */
export function rafThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
): ((...args: A) => void) & { cancel(): void } {
  let handle: number | null = null
  let latest: A | null = null
  const throttled = (...args: A) => {
    latest = args
    if (handle !== null) return
    handle = requestAnimationFrame(() => {
      handle = null
      const args = latest
      latest = null
      if (args) fn(...args)
    })
  }
  throttled.cancel = () => {
    if (handle !== null) cancelAnimationFrame(handle)
    handle = null
    latest = null
  }
  return throttled
}
