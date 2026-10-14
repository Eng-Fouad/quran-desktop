#!/usr/bin/env node
// @ts-check
// Bundles around a placeholder core.db, for the bundle checks and the size budgets.
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
//   node size-check.mjs rustflags
//       prints the RUSTFLAGS of a release build (this one and release.yml's): $RUSTFLAGS plus `--remap-path-prefix`
//       for the cargo registry sources (see `releaseRustflags`)
//
// The state lives in --state (default $RUNNER_TEMP/qd-size-check, else the OS temp dir). Nothing is uploaded.
import console from 'node:console'
import fs from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** @typedef {{ core: string, aside: string, coreBytes: number }} State */

/** Cargo's source directory for crates.io (`$CARGO_HOME/registry/src/<this>`, cargo 1.85 and later). */
export const CRATES_IO_SOURCES = 'index.crates.io-1949cf8c6b5b557f'

/**
 * RUSTFLAGS for a release build: `env.RUSTFLAGS` plus `--remap-path-prefix` for the cargo registry sources. A
 * dependency's panic locations then read `tokio-1.53.2/src/…` instead of
 * `$CARGO_HOME/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.53.2/src/…`: about 55 KB less per binary, 108 KB
 * of the universal macOS app (the installed-footprint budget). rustc applies the last matching prefix, so crates.io's
 * directory is mapped after the registry-wide fallback. Returns null when the path has whitespace, which RUSTFLAGS
 * cannot carry.
 * @param {NodeJS.ProcessEnv} env @param {string} home @param {path.PlatformPath} [p] the platform's path module
 * @returns {string | null}
 */
export function releaseRustflags(env, home, p = path) {
  const sources = p.join(env.CARGO_HOME || p.join(home, '.cargo'), 'registry', 'src')
  if (/\s/.test(sources)) return null
  const remap = [sources, p.join(sources, CRATES_IO_SOURCES)].map(
    (from) => `--remap-path-prefix=${from}${p.sep}=`,
  )
  return [env.RUSTFLAGS?.trim() ?? '', ...remap].filter(Boolean).join(' ')
}

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

  if (command === 'rustflags') {
    const flags = releaseRustflags(env, homedir())
    if (flags === null) {
      console.error('size-check: CARGO_HOME has whitespace; the registry paths stay unmapped')
      console.log(env.RUSTFLAGS ?? '')
    } else console.log(flags)
    return 0
  }

  console.error(
    'usage: size-check.mjs aside|restore|rustflags [--core <file>] [--state <dir>]  (see the header of this file)',
  )
  return 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
