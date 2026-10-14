// @ts-check
// Command-line parsing for the QA drivers.
import { parseArgs } from 'node:util'

/** A bad command line: the drivers print it with the usage text and exit 2. */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/**
 * Strict parsing: unknown flags are errors; a repeated single-value option keeps its **last** value, so
 * `pnpm shots:web --serve 1648` overrides the script's built-in `--serve 1520`; `multiple` options accumulate; a bare
 * `--` (which pnpm forwards to the script) is ignored.
 * @template {import('node:util').ParseArgsOptionsConfig} T
 * @param {string[]} argv
 * @param {T} options
 */
export function parseCli(argv, options) {
  try {
    return parseArgs({ args: argv.filter((a) => a !== '--'), options, strict: true, allowPositionals: false })
      .values
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e))
  }
}

/**
 * An integer option in `min..=max`, or `fallback` when absent.
 * @template {number | null} F
 * @param {string | undefined} value
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @param {F} fallback
 * @returns {number | F}
 */
export function intOption(value, name, min, max, fallback) {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max)
    throw new UsageError(`--${name} must be an integer in ${min}–${max} (got "${value}")`)
  return n
}

/**
 * `--allow-console` values (regular-expression sources) as RegExps.
 * @param {string[] | undefined} values
 */
export function regexOptions(values) {
  return (values ?? []).map((source) => {
    try {
      return new RegExp(source)
    } catch (e) {
      throw new UsageError(`--allow-console: invalid regular expression "${source}": ${String(e)}`)
    }
  })
}

/**
 * A viewport from `--width`/`--height`: both, or neither (null).
 * @param {string | undefined} width
 * @param {string | undefined} height
 * @returns {[number, number] | null}
 */
export function viewportOption(width, height) {
  if (width === undefined && height === undefined) return null
  if (width === undefined || height === undefined) throw new UsageError('--width and --height go together')
  return [
    /** @type {number} */ (intOption(width, 'width', 320, 7680, 0)),
    /** @type {number} */ (intOption(height, 'height', 240, 4320, 0)),
  ]
}
