// @ts-check
// node --test tests/e2e/lib/*.test.mjs scripts/qa/lib/*.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { check, equal, includes, ScenarioAssertionError, waitUntil } from './assert.mjs'
import {
  DEFAULT_WINDOW,
  discover,
  loadScenario,
  parseOnly,
  RegistryError,
  resolveMeta,
  runsIn,
  select,
  siblingSuites,
} from './registry.mjs'

const root = mkdtempSync(join(tmpdir(), 'qd-qa-registry-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

/** @param {string} rel @param {string} body */
function put(rel, body) {
  const file = join(root, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body)
  return file
}

const SCENARIOS = join(root, 'scenarios')
put('scenarios/S10.mjs', 'export default async () => {}\n')
put('scenarios/S02.mjs', "export const meta = { mode: 'both', ui: 'ar' }\nexport default async () => {}\n")
put('scenarios/smoke.mjs', "export const meta = { mode: 'both' }\nexport default async () => {}\n")
put('scenarios/_helpers.mjs', 'export const x = 1\n')
put('scenarios/S03.test.mjs', 'export {}\n')
put('scenarios/notes.md', '# not a scenario\n')
put('scenarios/bad name.mjs', 'export default async () => {}\n')
put('scenarios/nodefault.mjs', 'export const meta = {}\n')
put('metrics/metrics.mjs', "export const meta = { mode: 'app' }\nexport default async () => {}\n")
put('lib/index.mjs', 'export {}\n')
mkdirSync(join(root, 'baselines', 'web'), { recursive: true })

describe('discover', () => {
  it('lists scenario modules in natural order, skipping helpers, tests and bad names', () => {
    assert.deepEqual(
      discover(SCENARIOS).map((e) => e.id),
      ['nodefault', 'S02', 'S10', 'smoke'],
    )
  })

  it('rejects a missing registry', () => {
    assert.throws(() => discover(join(root, 'nope')), RegistryError)
  })

  it('finds the sibling suites, never lib or baselines', () => {
    assert.deepEqual(siblingSuites(SCENARIOS), [join(root, 'metrics')])
  })
})

describe('parseOnly and select', () => {
  it('splits, trims and dedupes ids case-insensitively', () => {
    assert.deepEqual(parseOnly(['S19, S20', 's19', 'smoke,']), ['S19', 'S20', 'smoke'])
    assert.deepEqual(parseOnly(undefined), [])
    assert.deepEqual(parseOnly('a'), ['a'])
  })

  it('keeps the --only order and matches ids case-insensitively', () => {
    const entries = discover(SCENARIOS)
    assert.deepEqual(
      select(entries, ['SMOKE', 's02']).map((e) => e.id),
      ['smoke', 'S02'],
    )
    assert.equal(select(entries, []).length, entries.length)
  })

  it('names every unknown id', () => {
    assert.throws(() => select(discover(SCENARIOS), ['S02', 'S98', 'S99']), /unknown scenarios S98, S99/)
  })
})

describe('resolveMeta', () => {
  it('fills the defaults', () => {
    assert.deepEqual(resolveMeta(undefined, 'x'), {
      window: [...DEFAULT_WINDOW],
      ui: null,
      theme: null,
      mode: 'web',
      settings: null,
      colorScheme: 'light',
      reducedMotion: false,
      dpr: 1,
      timeout: null,
      allowConsole: [],
      expectFatal: false,
      env: {},
      description: null,
    })
  })

  it('accepts every documented key', () => {
    const meta = resolveMeta(
      {
        window: [1024, 700],
        ui: 'ar',
        theme: 'high_contrast',
        mode: 'app',
        settings: { zoomPct: 200 },
        colorScheme: 'dark',
        reducedMotion: true,
        dpr: 2,
        timeout: 5000,
        allowConsole: ['^noise', /other/],
        expectFatal: true,
        env: { QD_AUDIO_SINK: 'wav:x.wav' },
        description: 'd',
      },
      'x',
    )
    assert.deepEqual(meta.window, [1024, 700])
    assert.equal(meta.mode, 'app')
    assert.deepEqual(meta.settings, { zoomPct: 200 })
    assert.equal(meta.allowConsole.length, 2)
    assert.ok(meta.allowConsole[0]?.test('noise here'))
    assert.deepEqual(meta.env, { QD_AUDIO_SINK: 'wav:x.wav' })
  })

  for (const [name, raw, pattern] of /** @type {const} */ ([
    ['unknown key', { windw: [1, 2] }, /unknown meta key "windw"/],
    ['bad window', { window: [100, 100] }, /meta\.window/],
    ['bad ui', { ui: 'fr' }, /meta\.ui must be one of en, ar/],
    ['bad theme', { theme: 'dark' }, /meta\.theme/],
    ['bad mode', { mode: 'all' }, /meta\.mode/],
    ['bad timeout', { timeout: 10 }, /meta\.timeout/],
    ['bad env', { env: { A: 1 } }, /meta\.env\.A/],
    ['bad allowConsole', { allowConsole: 'x' }, /meta\.allowConsole/],
    ['bad flag', { expectFatal: 'yes' }, /meta\.expectFatal/],
    ['not an object', [], /meta must be an object/],
  ])) {
    it(`rejects ${name}`, () => assert.throws(() => resolveMeta(raw, 'S01'), pattern))
  }

  it('selects the runner by mode', () => {
    assert.ok(runsIn(resolveMeta({ mode: 'both' }, 'x'), 'app'))
    assert.ok(runsIn(resolveMeta({}, 'x'), 'web'))
    assert.ok(!runsIn(resolveMeta({}, 'x'), 'app'))
  })
})

describe('loadScenario', () => {
  it('loads the default export and the meta', async () => {
    const s = await loadScenario({ id: 'S02', file: join(SCENARIOS, 'S02.mjs') })
    assert.equal(typeof s.run, 'function')
    assert.equal(s.meta.ui, 'ar')
  })

  it('requires a default export', async () => {
    await assert.rejects(
      loadScenario({ id: 'nodefault', file: join(SCENARIOS, 'nodefault.mjs') }),
      /must export/,
    )
  })
})

describe('assertions', () => {
  it('check, equal and includes throw readable errors', () => {
    assert.throws(() => check(false, 'nope'), ScenarioAssertionError)
    assert.throws(
      () => equal({ a: [1] }, { a: [2] }, 'the thing'),
      /the thing: expected \{ a: \[ 2 \] \}, got \{ a: \[ 1 \] \}/,
    )
    assert.doesNotThrow(() => equal({ a: [1] }, { a: [1] }, 'same'))
    assert.throws(() => includes([1, 2], 3, 'pages'), /pages: expected 3 in \[ 1, 2 \]/)
  })

  it('waitUntil returns the first truthy value or times out', async () => {
    let n = 0
    assert.equal(await waitUntil(() => (++n >= 3 ? 'ok' : null), { interval: 1 }), 'ok')
    await assert.rejects(
      waitUntil(() => 0, { timeout: 30, interval: 5, message: 'never' }),
      /never not met within 30 ms/,
    )
  })
})
