// @ts-check
// Per-scenario console capture (WP13a). Both drivers feed it: web-shot from Playwright's page events, app-driver from
// its own CDP session (Runtime + Log, which replays what the webview logged before the attach). Page errors and
// console errors fail the scenario unless an allow pattern (meta.allowConsole, ctx.allowConsole, --allow-console)
// matches them; warnings are reported only.

/** @typedef {'error' | 'warning' | 'info' | 'log' | 'debug' | 'pageerror'} Level */
/** @typedef {{ level: Level, text: string, source: string | null, allowed: boolean }} ConsoleEntry */

const MAX_TEXT = 4000

/**
 * Maps a console type (Playwright `ConsoleMessage.type()`, CDP `Runtime.consoleAPICalled.type` or
 * `Log.entryAdded.level`) to a level. `assert` counts as an error, `verbose` as debug.
 * @param {string} type
 * @returns {Level}
 */
export function levelOf(type) {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error'
    case 'warning':
    case 'warn':
      return 'warning'
    case 'info':
      return 'info'
    case 'debug':
    case 'verbose':
      return 'debug'
    default:
      return 'log'
  }
}

export class ConsoleLog {
  /** @param {{ allow?: RegExp[] }} [options] */
  constructor(options = {}) {
    /** @type {RegExp[]} */
    this.allowPatterns = [...(options.allow ?? [])]
    /** @type {ConsoleEntry[]} */
    this.entries = []
  }

  /** @param {RegExp} pattern */
  allow(pattern) {
    this.allowPatterns.push(pattern)
    for (const e of this.entries) if (!e.allowed && this.#matches(e.text)) e.allowed = true
  }

  /**
   * @param {Level} level
   * @param {string} text
   * @param {string | null} [source]  url:line, or the CDP log source (`network`, `security`, …)
   */
  add(level, text, source = null) {
    const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (${text.length} chars)` : text
    this.entries.push({ level, text: clipped, source, allowed: this.#matches(clipped) })
  }

  /** @param {string} text */
  #matches(text) {
    return this.allowPatterns.some((p) => {
      p.lastIndex = 0
      return p.test(text)
    })
  }

  /** Page errors and console errors that no allow pattern matches: each one fails the scenario. */
  get failures() {
    return this.entries.filter((e) => (e.level === 'error' || e.level === 'pageerror') && !e.allowed)
  }

  get warnings() {
    return this.entries.filter((e) => e.level === 'warning')
  }

  /**
   * Printable lines: errors and warnings, or everything when `verbose`. Allowed errors are marked.
   * @param {boolean} [verbose]
   */
  lines(verbose = false) {
    return this.entries
      .filter((e) => verbose || e.level === 'error' || e.level === 'pageerror' || e.level === 'warning')
      .map((e) => `[${e.level}${e.allowed ? ', allowed' : ''}] ${e.text}${e.source ? ` (${e.source})` : ''}`)
  }
}
