#!/usr/bin/env node
// @ts-check
// Removes QF-derived and distributable outputs at the end of a CI job, before the post-job steps of the caching actions
// run: rust-cache stores target/ and must never see the core.db that tauri-build copies next to the binaries
// (target/<profile>/data/core.db) or a bundle built around it.
//
//   node .github/actions/scrub/scrub.mjs [--root .] [--target-dir <dir>] [--dry-run] [--force]
//
// Removes, when present: src-tauri/resources/core.db (+ -wal/-shm/-journal/.tmp), src/lib/ipc/mock/fixtures/,
// data/cache/, data/dev-packs/, and in the cargo target directory ($CARGO_TARGET_DIR, else target/) every
// <profile>/data/core.db* and <profile>/bundle/, also under <triple>/<profile>/. It refuses to run outside GitHub
// Actions unless --force (or --dry-run) is given, because locally these are a developer's working files.
import console from 'node:console'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CORE_SUFFIXES = ['', '-wal', '-shm', '-journal', '.tmp']

/**
 * Every existing path that the scrub removes.
 * @param {string} root @param {string} targetDir @returns {string[]}
 */
export function scrubTargets(root, targetDir) {
  /** @type {string[]} */
  const found = []
  const add = (/** @type {string} */ p) => {
    if (fs.existsSync(p)) found.push(p)
  }
  for (const suffix of CORE_SUFFIXES) add(path.join(root, 'src-tauri', 'resources', `core.db${suffix}`))
  add(path.join(root, 'src', 'lib', 'ipc', 'mock', 'fixtures'))
  add(path.join(root, 'data', 'cache'))
  add(path.join(root, 'data', 'dev-packs'))
  /** @param {string} dir */
  const profileOutputs = (dir) => {
    for (const suffix of CORE_SUFFIXES) add(path.join(dir, 'data', `core.db${suffix}`))
    add(path.join(dir, 'bundle'))
  }
  for (const child of listDirs(targetDir)) {
    const dir = path.join(targetDir, child)
    profileOutputs(dir)
    // Cross-compiled outputs live one level deeper: target/<triple>/<profile>/.
    for (const grandchild of listDirs(dir)) profileOutputs(path.join(dir, grandchild))
  }
  return found
}

/** @param {string} dir @returns {string[]} */
function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** @param {string} p @returns {number} bytes */
function sizeOf(p) {
  try {
    const stat = fs.lstatSync(p)
    if (!stat.isDirectory()) return stat.size
    return fs.readdirSync(p).reduce((sum, name) => sum + sizeOf(path.join(p, name)), 0)
  } catch {
    return 0
  }
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} [env] @returns {number} */
export function main(argv, env = process.env) {
  let values
  try {
    values = parseArgs({
      args: argv,
      options: {
        root: { type: 'string', default: ROOT },
        'target-dir': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    console.error(`scrub: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  if (env.GITHUB_ACTIONS !== 'true' && !values.force && !values['dry-run']) {
    console.error(
      'scrub: refusing to delete local working files outside GitHub Actions (use --dry-run or --force)',
    )
    return 2
  }
  const root = path.resolve(values.root)
  const targetDir = path.resolve(root, values['target-dir'] ?? env.CARGO_TARGET_DIR ?? 'target')
  const targets = scrubTargets(root, targetDir)
  for (const p of targets) {
    const shown = path.relative(root, p) || p
    console.log(`scrub: ${values['dry-run'] ? 'would remove' : 'removing'} ${shown} (${sizeOf(p)} bytes)`)
    if (!values['dry-run']) fs.rmSync(p, { recursive: true, force: true })
  }
  console.log(`scrub: ${targets.length === 0 ? 'nothing to remove' : `${targets.length} path(s)`}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
