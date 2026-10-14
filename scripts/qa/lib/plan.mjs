// @ts-check
// What a QA run executes: registry scenarios selected with `--only`, one `--scenario` file, or the implicit single
// screenshot of the legacy `--name` (web-shot) / `--shot` (app-driver) options.
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import {
  discover,
  loadScenario,
  parseOnly,
  RegistryError,
  resolveMeta,
  runsIn,
  select,
  siblingSuites,
} from '../../../tests/e2e/lib/registry.mjs'

/** @typedef {import('./runner.mjs').Planned} Planned */
/** @typedef {import('../../../tests/e2e/lib/types').RunMode} RunMode */
/** @typedef {import('../../../tests/e2e/lib/types').ResolvedMeta} ResolvedMeta */
/** @typedef {import('../../../tests/e2e/lib/types').ScenarioFn} ScenarioFn */

/**
 * @typedef {object} PlanInput
 * @property {RunMode} mode
 * @property {string} root
 * @property {string | undefined} registry      `--registry`
 * @property {string[] | undefined} only         `--only` (repeatable, comma lists)
 * @property {string | undefined} scenario      `--scenario <file>`
 * @property {{ name: string, run: ScenarioFn, window: [number, number] }} implicit  the legacy single shot
 * @property {(meta: ResolvedMeta) => ResolvedMeta} override  applies CLI overrides (--width/--height/--dark/…)
 */

/**
 * Loads a registry scenario. A module that does not import or validate (another package's file mid-edit) becomes a
 * scenario that fails with that error, so one broken file never hides the results of the others.
 * @param {{ id: string, file: string }} entry
 * @returns {Promise<Planned & { broken: boolean }>}
 */
async function loadOrFail(entry) {
  try {
    return { ...(await loadScenario(entry)), broken: false }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    return {
      ...entry,
      run: () => {
        throw error
      },
      meta: resolveMeta({ mode: 'both' }, entry.id),
      broken: true,
    }
  }
}

/**
 * @param {PlanInput} input
 * @returns {Promise<{ planned: Planned[], allIds: string[], registry: string | null }>}
 */
export async function buildPlan(input) {
  const ids = parseOnly(input.only)
  if (input.scenario) {
    if (ids.length) throw new RegistryError('--scenario and --only cannot be combined')
    const file = resolve(input.scenario)
    if (!existsSync(file)) throw new RegistryError(`scenario file not found: ${file}`)
    const loaded = await loadScenario({ id: basename(file).replace(/\.m?js$/, ''), file })
    return {
      planned: [{ ...loaded, meta: input.override(loaded.meta) }],
      allIds: [loaded.id],
      registry: null,
    }
  }

  if (input.registry === undefined && ids.length === 0) {
    const { name, run, window } = input.implicit
    const meta = input.override(resolveMeta({ window, expectFatal: true, mode: 'both' }, name))
    return { planned: [{ id: name, file: null, run, meta }], allIds: [name], registry: null }
  }

  const registry = resolve(input.root, input.registry ?? 'tests/e2e/scenarios')
  const primary = discover(registry)
  const siblings = siblingSuites(registry).flatMap((dir) => discover(dir))
  const allIds = [...new Set([...primary, ...siblings].map((e) => e.id))]
  /** @type {Planned[]} */
  const planned = []
  if (ids.length) {
    // Explicit ids: the registry first, then the sibling suites; every id must exist and run in this mode.
    const pool = [
      ...primary,
      ...siblings.filter((s) => !primary.some((p) => p.id.toLowerCase() === s.id.toLowerCase())),
    ]
    for (const entry of select(pool, ids)) {
      const loaded = await loadOrFail(entry)
      if (!loaded.broken && !runsIn(loaded.meta, input.mode))
        throw new RegistryError(
          `${loaded.id} is ${loaded.meta.mode === 'app' ? 'an' : 'a'} ${loaded.meta.mode} scenario (meta.mode), so it does not run in the ` +
            `${input.mode === 'web' ? 'browser mock (web-shot)' : 'real app (app-driver)'}`,
        )
      planned.push({ ...loaded, meta: input.override(loaded.meta) })
    }
  } else {
    for (const entry of primary) {
      const loaded = await loadOrFail(entry)
      if (loaded.broken || runsIn(loaded.meta, input.mode))
        planned.push({ ...loaded, meta: input.override(loaded.meta) })
    }
    if (planned.length === 0) throw new RegistryError(`no ${input.mode} scenarios in ${registry}`)
  }
  return { planned, allIds, registry }
}
