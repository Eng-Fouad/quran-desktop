#!/usr/bin/env node
// @ts-check
// Bundles around a placeholder core.db (ARCHITECTURE §13.3 `build` job, §13.6 budgets). Owner: WP-CI; budgets WP13b.
//
// A qdc core.db is QF-derived and must never enter a bundle, even one that is never uploaded. The CI bundles are
// therefore built around build.rs's 0-byte placeholder: this script moves the real core.db aside before
// `pnpm tauri build`, and back afterwards. The budgets (scripts/size-budget.mjs --placeholder-core) add the real
// core.db as each installer format compresses it; scripts/check-bundles.mjs --core placeholder checks the contents.
//
//   node size-check.mjs aside   [--core src-tauri/resources/core.db] [--state <dir>]
//       moves the real core.db to <state>/core.db and prints that path (also `aside=<path>` to $GITHUB_OUTPUT)
//   node size-check.mjs restore [--state <dir>]
//       moves it back over the placeholder (run it with `if: always()`; a second restore is a no-op)
//
// The state lives in --state (default $RUNNER_TEMP/qd-size-check, else the OS temp dir). Nothing is uploaded.
import console from 'node:console'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** @typedef {{ core: string, aside: string, coreBytes: number }} State */

/** @param {string[]} argv @param {NodeJS.ProcessEnv} [env] @returns {number} */
export function main(argv, env = process.env) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        core: { type: 'string', default: path.join(ROOT, 'src-tauri', 'resources', 'core.db') },
        state: { type: 'string', default: path.join(env.RUNNER_TEMP ?? tmpdir(), 'qd-size-check') },
      },
    })
  } catch (error) {
    console.error(`size-check: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const { values, positionals } = parsed
  const command = positionals[0]
  const core = path.resolve(values.core)
  const stateDir = path.resolve(values.state)
  const stateFile = path.join(stateDir, 'state.json')

  if (command === 'aside') {
    if (!fs.existsSync(core) || fs.statSync(core).size === 0) {
      console.error(`size-check: ${core} is missing or a placeholder; build the real core.db first`)
      return 1
    }
    if (fs.existsSync(stateFile)) {
      console.error(
        `size-check: ${stateFile} exists: a core.db is already aside (run \`size-check.mjs restore\`)`,
      )
      return 1
    }
    fs.mkdirSync(stateDir, { recursive: true })
    const aside = path.join(stateDir, 'core.db')
    const coreBytes = fs.statSync(core).size
    fs.rmSync(aside, { force: true })
    fs.renameSync(core, aside)
    /** @type {State} */
    const state = { core, aside, coreBytes }
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2))
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `aside=${aside}\n`)
    console.log(`size-check: core.db (${coreBytes.toLocaleString('en-US')} B) moved aside to ${aside}`)
    console.log(aside)
    return 0
  }

  if (command === 'restore') {
    if (!fs.existsSync(stateFile)) {
      console.log('size-check: nothing to restore')
      return 0
    }
    /** @type {State} */
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (fs.existsSync(state.aside)) {
      fs.rmSync(state.core, { force: true }) // the placeholder build.rs wrote
      fs.renameSync(state.aside, state.core)
      console.log(`size-check: restored ${state.core}`)
    }
    fs.rmSync(stateFile, { force: true })
    return 0
  }

  console.error(
    'usage: size-check.mjs aside|restore [--core <file>] [--state <dir>]  (see the header of this file)',
  )
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
