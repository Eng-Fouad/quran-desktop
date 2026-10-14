/** A small least-recently-used map (page cache, font faces). */
export class LRU<K, V> {
  readonly #map = new Map<K, V>()

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`LRU capacity ${capacity}`)
  }

  get size(): number {
    return this.#map.size
  }

  has(key: K): boolean {
    return this.#map.has(key)
  }

  /** Returns the value and marks it most recently used. */
  get(key: K): V | undefined {
    const value = this.#map.get(key)
    if (value !== undefined || this.#map.has(key)) {
      this.#map.delete(key)
      this.#map.set(key, value as V)
    }
    return value
  }

  /** Inserts or refreshes a value; returns the evicted entries (oldest first). */
  set(key: K, value: V): [K, V][] {
    this.#map.delete(key)
    this.#map.set(key, value)
    const evicted: [K, V][] = []
    while (this.#map.size > this.capacity) {
      const oldest = this.#map.entries().next()
      if (oldest.done) break
      this.#map.delete(oldest.value[0])
      evicted.push(oldest.value)
    }
    return evicted
  }

  delete(key: K): boolean {
    return this.#map.delete(key)
  }

  clear(): void {
    this.#map.clear()
  }

  /** Keys from least to most recently used. */
  keys(): K[] {
    return [...this.#map.keys()]
  }
}
