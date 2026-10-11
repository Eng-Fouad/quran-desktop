// @ts-check
// Scenario registry (§12.6; WP13a). One module per scenario in `tests/e2e/scenarios/`, named by its id (`S19.mjs`,
// `smoke.mjs`), exporting `default async function (ctx)` and `meta`. Each file is owned by the package named in the
// §12.6 table, so files stay disjoint. Files starting with `_` and `*.test.mjs` are not scenarios.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @typedef {import('./types').ScenarioMeta} ScenarioMeta */
/** @typedef {import('./types').ResolvedMeta} ResolvedMeta */
/** @typedef {import('./types').ScenarioFn} ScenarioFn */
/** @typedef {import('./types').RunMode} RunMode */
/** @typedef {{ id: string, file: string }} ScenarioEntry */
/** @typedef {ScenarioEntry & { run: ScenarioFn, meta: ResolvedMeta }} LoadedScenario */

/** §12.6: "window 1600×1000 unless noted". */
export const DEFAULT_WINDOW = /** @type {const} */ ([1600, 1000])
export const MODES = /** @type {const} */ (['web', 'app', 'both'])
export const UI_LANGUAGES = /** @type {const} */ (['en', 'ar'])
/** `ThemeMode` in bindings.ts. */
export const THEMES = /** @type {const} */ (['system', 'paper', 'sepia', 'night', 'black', 'high_contrast'])
export const COLOR_SCHEMES = /** @type {const} */ (['light', 'dark'])

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const META_KEYS = new Set([
  'window',
  'ui',
  'theme',
  'mode',
  'settings',
  'colorScheme',
  'reducedMotion',
  'dpr',
  'timeout',
  'allowConsole',
  'expectFatal',
  'env',
  'description',
])

/** A registry or scenario-module problem (bad id, unknown key in `meta`, missing default export, …). */
export class RegistryError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'RegistryError'
  }
}

/** @param {string} a @param {string} b */
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })

/**
 * Lists the scenario files of a registry directory, sorted naturally (S01 … S37, smoke).
 * @param {string} dir
 * @returns {ScenarioEntry[]}
 */
export function discover(dir) {
  const root = resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new RegistryError(`scenario registry not found: ${root}`)
  return readdirSync(root)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && !f.startsWith('.') && !f.endsWith('.test.mjs'))
    .map((f) => ({ id: f.slice(0, -'.mjs'.length), file: join(root, f) }))
    .filter((e) => ID.test(e.id))
    .sort((a, b) => natural(a.id, b.id))
}

/** Directories next to a registry that are never scenario suites. */
const NOT_SUITES = new Set(['lib', 'baselines', 'node_modules'])

/**
 * The scenario suites next to a registry (`tests/e2e/metrics/` next to `tests/e2e/scenarios/`, owned by WP13b). Their
 * scenarios run only when named with `--only`, so `pnpm shots:app --only metrics` finds `tests/e2e/metrics/metrics.mjs`.
 * @param {string} dir
 * @returns {string[]}
 */
export function siblingSuites(dir) {
  const root = resolve(dir)
  const parent = resolve(root, '..')
  return readdirSync(parent, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        !NOT_SUITES.has(d.name) &&
        !d.name.startsWith('.') &&
        join(parent, d.name) !== root,
    )
    .map((d) => join(parent, d.name))
    .sort()
}

/**
 * Splits `--only` values (`S19,S20`, repeatable) into ids, without duplicates.
 * @param {readonly string[] | string | undefined} only
 * @returns {string[]}
 */
export function parseOnly(only) {
  const values = only === undefined ? [] : typeof only === 'string' ? [only] : only
  /** @type {string[]} */
  const ids = []
  for (const value of values) {
    for (const raw of value.split(',')) {
      const id = raw.trim()
      if (id && !ids.some((x) => x.toLowerCase() === id.toLowerCase())) ids.push(id)
    }
  }
  return ids
}

/**
 * Picks the `--only` ids (case-insensitive, in the order given); every id must exist.
 * @param {ScenarioEntry[]} entries
 * @param {string[]} ids
 * @returns {ScenarioEntry[]}
 */
export function select(entries, ids) {
  if (ids.length === 0) return entries
  const unknown = ids.filter((id) => !entries.some((e) => e.id.toLowerCase() === id.toLowerCase()))
  if (unknown.length)
    throw new RegistryError(
      `unknown scenario${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} ` +
        `(registry has: ${entries.map((e) => e.id).join(', ') || 'nothing'})`,
    )
  return ids.map(
    (id) => /** @type {ScenarioEntry} */ (entries.find((e) => e.id.toLowerCase() === id.toLowerCase())),
  )
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * @template {string} T
 * @param {string} where @param {string} key @param {unknown} value @param {readonly T[]} allowed
 * @returns {T}
 */
function oneOf(where, key, value, allowed) {
  if (typeof value === 'string' && /** @type {readonly string[]} */ (allowed).includes(value))
    return /** @type {T} */ (value)
  throw new RegistryError(
    `${where}: meta.${key} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`,
  )
}

/**
 * Validates a scenario's `meta` export and fills the defaults. Unknown keys are errors, so a typo never silently
 * changes what a scenario renders.
 * @param {unknown} raw
 * @param {string} where  the scenario id or file, for messages
 * @returns {ResolvedMeta}
 */
export function resolveMeta(raw, where) {
  const meta = raw === undefined ? {} : raw
  if (!isRecord(meta)) throw new RegistryError(`${where}: meta must be an object`)
  for (const key of Object.keys(meta))
    if (!META_KEYS.has(key))
      throw new RegistryError(`${where}: unknown meta key "${key}" (allowed: ${[...META_KEYS].join(', ')})`)

  /** @type {[number, number]} */
  let window = [DEFAULT_WINDOW[0], DEFAULT_WINDOW[1]]
  if (meta.window !== undefined) {
    const w = meta.window
    if (!Array.isArray(w) || w.length !== 2 || !w.every((n) => Number.isInteger(n) && n >= 320 && n <= 7680))
      throw new RegistryError(`${where}: meta.window must be [width, height] in px, 320–7680`)
    window = [w[0], w[1]]
  }

  /** @type {Record<string, unknown> | null} */
  let settings = null
  if (meta.settings !== undefined) {
    if (!isRecord(meta.settings))
      throw new RegistryError(`${where}: meta.settings must be a Settings patch object`)
    settings = { ...meta.settings }
  }

  let dpr = 1
  if (meta.dpr !== undefined) {
    if (typeof meta.dpr !== 'number' || !(meta.dpr >= 0.5 && meta.dpr <= 4))
      throw new RegistryError(`${where}: meta.dpr must be a number in 0.5–4`)
    dpr = meta.dpr
  }

  /** @type {number | null} */
  let timeout = null
  if (meta.timeout !== undefined) {
    if (!Number.isInteger(meta.timeout) || /** @type {number} */ (meta.timeout) < 1000)
      throw new RegistryError(`${where}: meta.timeout must be an integer number of ms ≥ 1000`)
    timeout = /** @type {number} */ (meta.timeout)
  }

  /** @type {RegExp[]} */
  const allowConsole = []
  if (meta.allowConsole !== undefined) {
    if (!Array.isArray(meta.allowConsole))
      throw new RegistryError(`${where}: meta.allowConsole must be an array of strings or RegExps`)
    for (const p of meta.allowConsole) {
      if (p instanceof RegExp) allowConsole.push(p)
      else if (typeof p === 'string' && p) allowConsole.push(new RegExp(p))
      else throw new RegistryError(`${where}: meta.allowConsole entries must be strings or RegExps`)
    }
  }

  /** @type {Record<string, string>} */
  const env = {}
  if (meta.env !== undefined) {
    if (!isRecord(meta.env)) throw new RegistryError(`${where}: meta.env must be an object of strings`)
    for (const [k, v] of Object.entries(meta.env)) {
      if (typeof v !== 'string') throw new RegistryError(`${where}: meta.env.${k} must be a string`)
      env[k] = v
    }
  }

  for (const key of /** @type {const} */ (['reducedMotion', 'expectFatal']))
    if (meta[key] !== undefined && typeof meta[key] !== 'boolean')
      throw new RegistryError(`${where}: meta.${key} must be a boolean`)
  if (meta.description !== undefined && typeof meta.description !== 'string')
    throw new RegistryError(`${where}: meta.description must be a string`)

  return {
    window,
    ui: meta.ui === undefined ? null : oneOf(where, 'ui', meta.ui, UI_LANGUAGES),
    theme: meta.theme === undefined ? null : oneOf(where, 'theme', meta.theme, THEMES),
    mode: meta.mode === undefined ? 'web' : oneOf(where, 'mode', meta.mode, MODES),
    settings,
    colorScheme:
      meta.colorScheme === undefined ? 'light' : oneOf(where, 'colorScheme', meta.colorScheme, COLOR_SCHEMES),
    reducedMotion: meta.reducedMotion === true,
    dpr,
    timeout,
    allowConsole,
    expectFatal: meta.expectFatal === true,
    env,
    description: typeof meta.description === 'string' ? meta.description : null,
  }
}

/**
 * Whether a scenario runs in this runner (`web-shot` → web, `app-driver` → app; `both` runs in each).
 * @param {ResolvedMeta} meta
 * @param {RunMode} mode
 */
export function runsIn(meta, mode) {
  return meta.mode === 'both' || meta.mode === mode
}

/**
 * Imports a scenario module and validates its exports.
 * @param {ScenarioEntry} entry
 * @returns {Promise<LoadedScenario>}
 */
export async function loadScenario(entry) {
  /** @type {Record<string, unknown>} */
  let mod
  try {
    mod = await import(pathToFileURL(entry.file).href)
  } catch (e) {
    throw new RegistryError(
      `${entry.id}: cannot import ${entry.file}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (typeof mod.default !== 'function')
    throw new RegistryError(
      `${entry.id}: ${basename(entry.file)} must export \`default async function (ctx)\``,
    )
  return { ...entry, run: /** @type {ScenarioFn} */ (mod.default), meta: resolveMeta(mod.meta, entry.id) }
}
