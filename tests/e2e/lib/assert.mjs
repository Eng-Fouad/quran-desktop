// @ts-check
// Assertions for e2e scenarios. Plain functions that throw `ScenarioAssertionError` with a readable message, so a
// failed check reads well in the run summary and the HTML report.
import { isDeepStrictEqual, inspect } from 'node:util'

/** A failed scenario expectation. */
export class ScenarioAssertionError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'ScenarioAssertionError'
  }
}

/**
 * Thrown by `ctx.pending(reason)`: the scenario cannot run yet because a feature it needs is still a stub. The run
 * reports it as `pending` (a failure with `--strict`), never as passed.
 */
export class ScenarioPending extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason)
    this.name = 'ScenarioPending'
  }
}

/** @param {unknown} value */
const show = (value) => inspect(value, { depth: 4, breakLength: Infinity, maxArrayLength: 20 })

/**
 * Fails unless `condition` is truthy.
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
export function check(condition, message) {
  if (!condition) throw new ScenarioAssertionError(message)
}

/**
 * Fails unless `actual` deep-equals `expected`.
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} what  what is compared ("the theme after relaunch")
 */
export function equal(actual, expected, what) {
  if (!isDeepStrictEqual(actual, expected))
    throw new ScenarioAssertionError(`${what}: expected ${show(expected)}, got ${show(actual)}`)
}

/**
 * Fails unless `list` includes `item`.
 * @template T
 * @param {readonly T[]} list
 * @param {T} item
 * @param {string} what
 */
export function includes(list, item, what) {
  if (!list.includes(item))
    throw new ScenarioAssertionError(`${what}: expected ${show(item)} in ${show(list)}`)
}

/**
 * Polls `probe` (run in Node, typically a `page.evaluate`) until it returns a truthy value, and returns that value.
 * Rejects with `message` and the last value seen after `timeout` ms.
 * @template T
 * @param {() => Promise<T> | T} probe
 * @param {{ timeout?: number, interval?: number, message?: string }} [options]
 * @returns {Promise<NonNullable<T>>}
 */
export async function waitUntil(probe, options = {}) {
  const timeout = options.timeout ?? 10_000
  const interval = options.interval ?? 100
  const deadline = Date.now() + timeout
  /** @type {T | undefined} */
  let last
  for (;;) {
    last = await probe()
    if (last) return /** @type {NonNullable<T>} */ (last)
    if (Date.now() >= deadline)
      throw new ScenarioAssertionError(
        `${options.message ?? 'condition'} not met within ${timeout} ms (last value: ${show(last)})`,
      )
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}
