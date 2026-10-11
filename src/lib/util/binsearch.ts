/** Binary searches over ascending arrays (page starts, word timings, divisions). Owner: WP7c (created by WP0C). */

/** The first index whose key is `>= value` (`arr.length` when none). */
export function lowerBound<T>(arr: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const item = arr[mid]
    if (item !== undefined && key(item) < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The first index whose key is `> value` (`arr.length` when none). */
export function upperBound<T>(arr: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const item = arr[mid]
    if (item !== undefined && key(item) <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The index of the last element whose key is `<= value`, or -1. */
export function floorIndex<T>(arr: readonly T[], value: number, key: (item: T) => number): number {
  return upperBound(arr, value, key) - 1
}
