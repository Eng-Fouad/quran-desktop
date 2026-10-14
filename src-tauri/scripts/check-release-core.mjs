#!/usr/bin/env node
// @ts-check
// check-release-core: tauri's `build.beforeBundleCommand` (src-tauri/tauri.conf.json). Every bundle (NSIS installer,
// .app/.dmg, .deb, AppImage) carries src-tauri/resources/core.db, so bundling refuses a core.db that may not be
// distributed: one built from the QDC API (`meta.source = 'qdc'`, `pnpm core:qdc`) is QF-derived, development only.
// `pnpm tauri build --no-bundle` (what QA runs) never gets here.
//
//   node src-tauri/scripts/check-release-core.mjs [core.db]
//
// Accepted:
//   - a release core.db (check-artifacts' `isReleaseCore`): a QUL build (meta.source = 'qul'), or a QDC build made for
//     release with the Quran Foundation's permission (`pnpm core:release`), whose licence note says so;
//   - a 0-byte placeholder (build.rs writes one without a core.db): CI's installer-size check; such a bundle cannot
//     start (release builds refuse the placeholder), so a warning says so.
// Refused (exit 1): a development qdc core.db, any other source, a file that is not a readable core.db, a missing file.
//
// QD_ALLOW_DEV_CORE=1 lets a qdc core.db through for a private preview build, with a loud warning: such a bundle must
// never be published, uploaded or shared. The SQLite reader is check-artifacts' (the CI upload guard), so the two agree.
import console from 'node:console'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { isReleaseCore, readSqliteFile } from '../../scripts/check-artifacts.mjs'

/** src-tauri/resources/core.db, whatever the working directory. */
export const DEFAULT_CORE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'core.db')

/**
 * @typedef {{ ok: boolean, level: 'ok' | 'warn' | 'error', message: string }} Verdict
 */

/**
 * Whether `file` may be bundled.
 * @param {string} file
 * @param {{ allowDevCore?: boolean }} [options]
 * @returns {Verdict}
 */
export function verdict(file, { allowDevCore = false } = {}) {
  /** @type {fs.Stats} */
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return { ok: false, level: 'error', message: `${file} is missing: build core.db first (pnpm core:release)` }
  }
  if (!stat.isFile()) return { ok: false, level: 'error', message: `${file} is not a file` }
  if (stat.size === 0)
    return {
      ok: true,
      level: 'warn',
      message:
        `${file} is the 0-byte placeholder: this bundle is for size checks only and cannot start ` +
        '(build the release core.db with pnpm core:release)',
    }
  /** @type {Record<string, string> | undefined} */
  let meta
  try {
    meta = readSqliteFile(file).meta ?? undefined
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { ok: false, level: 'error', message: `${file} is not a readable core.db (${why})` }
  }
  const source = meta?.source
  if (isReleaseCore(meta))
    return {
      ok: true,
      level: 'ok',
      message:
        source === 'qdc'
          ? `${file}: release core.db (meta.source = 'qdc', built for release with the Quran Foundation's permission)`
          : `${file}: release core.db (meta.source = '${source}')`,
    }
  if (source === 'qdc') {
    if (allowDevCore)
      return {
        ok: true,
        level: 'warn',
        message:
          `${file} is QF-derived (meta.source = 'qdc') and QD_ALLOW_DEV_CORE=1 lets it through: ` +
          'this bundle is a PRIVATE PREVIEW and must never be published, uploaded or shared',
      }
    return {
      ok: false,
      level: 'error',
      message:
        `${file} is a development QF-derived core.db (meta.source = 'qdc'): never bundled. ` +
        'Build the release core.db with pnpm core:release, or set QD_ALLOW_DEV_CORE=1 for a private preview that ' +
        'is never shared.',
    }
  }
  return {
    ok: false,
    level: 'error',
    message: `${file} has meta.source = ${JSON.stringify(source ?? null)}; only a release core.db is bundled`,
  }
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {number} the exit code
 */
export function main(argv, env) {
  const file = argv[0] ?? DEFAULT_CORE
  const result = verdict(file, { allowDevCore: env.QD_ALLOW_DEV_CORE === '1' })
  const line = `check-release-core: ${result.message}`
  if (result.level === 'ok') console.log(line)
  else if (result.level === 'warn') {
    console.warn(`\n${'!'.repeat(100)}\n${line}\n${'!'.repeat(100)}\n`)
    if (env.GITHUB_ACTIONS === 'true') console.log(`::warning title=check-release-core::${result.message}`)
  } else {
    console.error(line)
    if (env.GITHUB_ACTIONS === 'true') console.log(`::error title=check-release-core::${result.message}`)
  }
  return result.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env)
}
