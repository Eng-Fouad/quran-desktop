#!/usr/bin/env node
// @ts-check
// Asserts that a core.db is a real build before anything is tested or bundled with it: the file exists, is larger than
// --min-bytes (default 1 MiB; build.rs's placeholder is 0 bytes), is an SQLite database with the core tables (mushaf,
// ayah, word, meta), and, with --source, carries that `meta.source` (`qdc` for development and CI, `qul` for a QUL
// build). --release instead requires a core.db a release may ship (check-artifacts' `isReleaseCore`: a QUL build, or a
// QDC one built for release with QF's permission).
//
//   node .github/actions/core/assert-core.mjs [--db src-tauri/resources/core.db] [--source qdc|qul | --release]
//                                             [--min-bytes N]
//
// Exit codes: 0 the database is what was asked for, 1 it is not, 2 bad usage.
import console from 'node:console'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isReleaseCore, readSqliteFile } from '../../../scripts/check-artifacts.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const REQUIRED_TABLES = ['meta', 'mushaf', 'ayah', 'word']

/**
 * @param {string} db @param {{ source?: string, release?: boolean, minBytes: number }} expect
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function assertCore(db, { source, release = false, minBytes }) {
  /** @type {string[]} */
  const lines = []
  const fail = (/** @type {string} */ why) => ({ ok: false, lines: [...lines, `FAIL ${why}`] })
  if (!fs.existsSync(db) || !fs.statSync(db).isFile())
    return fail(`${db} does not exist (run cargo xtask build-core)`)
  const size = fs.statSync(db).size
  lines.push(`${'size'.padEnd(18)} ${size.toLocaleString('en-US')} bytes`)
  if (size <= minBytes)
    return fail(
      `${db} is ${size} bytes, not more than ${minBytes}: a placeholder or a failed build, never shipped`,
    )
  let info
  try {
    info = readSqliteFile(db)
  } catch (error) {
    return fail(
      `${db} is not a readable SQLite database (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  const tables = new Set(info.tables.map((t) => t.toLowerCase()))
  const missing = REQUIRED_TABLES.filter((t) => !tables.has(t))
  if (missing.length > 0) return fail(`${db} lacks the core tables ${missing.join(', ')}`)
  const meta = info.meta ?? {}
  for (const key of ['source', 'schema_version', 'normalizer_version', 'built_at', 'builder'])
    lines.push(`${key.padEnd(18)} ${meta[key] ?? '(missing)'}`)
  if (!meta.schema_version) return fail('meta.schema_version is missing')
  if (source && meta.source !== source)
    return fail(`meta.source is ${JSON.stringify(meta.source ?? null)}, expected ${JSON.stringify(source)}`)
  if (release && !isReleaseCore(meta))
    return fail(
      `meta.source is ${JSON.stringify(meta.source ?? null)} and this is not a release build ` +
        "(a QUL build, or a QDC one built for release with the Quran Foundation's permission, pnpm core:release)",
    )
  return { ok: true, lines }
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  let values
  try {
    values = parseArgs({
      args: argv,
      options: {
        db: { type: 'string', default: path.join(ROOT, 'src-tauri', 'resources', 'core.db') },
        source: { type: 'string' },
        release: { type: 'boolean', default: false },
        'min-bytes': { type: 'string', default: String(1024 * 1024) },
      },
    }).values
  } catch (error) {
    console.error(`assert-core: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const minBytes = Number(values['min-bytes'])
  if (!Number.isSafeInteger(minBytes) || minBytes < 0) {
    console.error(`assert-core: --min-bytes must be a non-negative integer`)
    return 2
  }
  if (values.source !== undefined && !/^(qdc|qul)$/.test(values.source)) {
    console.error(`assert-core: --source must be qdc or qul`)
    return 2
  }
  const db = path.resolve(values.db)
  if (values.release && values.source !== undefined) {
    console.error(`assert-core: --release and --source are exclusive`)
    return 2
  }
  const result = assertCore(db, { source: values.source, release: values.release, minBytes })
  const rel = path.relative(process.cwd(), db)
  console.log(`assert-core ${rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : db}`)
  for (const line of result.lines) console.log(`  ${line}`)
  if (!result.ok && process.env.GITHUB_ACTIONS === 'true')
    console.log(
      `::error title=core.db::${(result.lines.at(-1) ?? '').replace(/^FAIL /, '').replace(/%/g, '%25')}`,
    )
  console.log(result.ok ? 'assert-core passed' : 'assert-core FAILED')
  return result.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
