/** Trailing-edge debounce with `cancel` and `flush` (search input 120 ms, positions 1 s). */
export interface Debounced<A extends unknown[]> {
  (...args: A): void
  cancel(): void
  /** Runs a pending call now. */
  flush(): void
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null
  const run = () => {
    timer = null
    const args = pending
    pending = null
    if (args) fn(...args)
  }
  const debounced = (...args: A) => {
    pending = args
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(run, waitMs)
  }
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    pending = null
  }
  debounced.flush = () => {
    if (timer !== null) clearTimeout(timer)
    run()
  }
  return debounced
}
