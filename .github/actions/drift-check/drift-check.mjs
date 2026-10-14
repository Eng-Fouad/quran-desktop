#!/usr/bin/env node
// @ts-check
// Drift check for committed generated files (such as `cargo xtask licenses` on src/lib/about/thirdparty.json).
// Git-free, like `bindings:check`: snapshot the files, run the generator, compare, and ALWAYS restore the originals, so
// a failing check never leaves a modified working tree behind. A file that the generator creates, deletes or changes is
// drift.
//
//   node .github/actions/drift-check/drift-check.mjs --path <file> [--path <file>...] [--name <label>] -- <command...>
//
// The command after `--` is executed directly (no shell). In the composite action the command and the paths come from
// QD_DRIFT_COMMAND (one command line, run by the shell; also the way to call a Windows .cmd shim such as pnpm) and
// QD_DRIFT_PATHS (one per line). CRLF and LF line endings compare equal (.gitattributes keeps the committed files LF).
//
// Exit codes: 0 up to date, 1 drift (or the generator failed), 2 bad usage.
import console from 'node:console'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** @typedef {{ file: string, before: Buffer | null, after: Buffer | null }} Snapshot */

/** Escapes a workflow-command message. @param {string} s */
const escapeData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
/** Escapes a workflow-command property value. @param {string} s */
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')

/** @param {Buffer | null} buf */
function normalised(buf) {
  return buf === null ? null : buf.toString('utf8').replace(/\r\n/g, '\n')
}

/** @param {string} file @returns {Buffer | null} */
function readOrNull(file) {
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

/**
 * A short, readable description of how `after` differs from `before` (first differing line with context, plus line
 * counts), enough to act on without dumping a 5,000-line JSON file into the log.
 * @param {string | null} before @param {string | null} after @returns {string[]}
 */
export function describeDrift(before, after) {
  if (before === null) return ['the generator created this file, which is not committed']
  if (after === null) return ['the generator removed this file']
  const a = before.split('\n')
  const b = after.split('\n')
  let first = 0
  while (first < a.length && first < b.length && a[first] === b[first]) first++
  let tailA = a.length - 1
  let tailB = b.length - 1
  while (tailA >= first && tailB >= first && a[tailA] === b[tailB]) {
    tailA--
    tailB--
  }
  const lines = [
    `first difference at line ${first + 1}; committed ${a.length} lines, regenerated ${b.length} lines ` +
      `(${tailA - first + 1} committed line(s) replaced by ${tailB - first + 1})`,
  ]
  const show = (
    /** @type {string} */ sign,
    /** @type {string[]} */ src,
    /** @type {number} */ from,
    /** @type {number} */ to,
  ) => {
    for (let i = from; i <= Math.min(to, from + 7); i++)
      lines.push(`  ${sign}${String(i + 1).padStart(6)} | ${src[i] ?? ''}`)
    if (to > from + 7) lines.push(`  ${sign}   … ${to - from - 7} more`)
  }
  show('-', a, first, tailA)
  show('+', b, first, tailB)
  return lines
}

/**
 * Snapshots `files`, runs `run()`, compares and restores.
 * @param {string[]} files absolute paths
 * @param {() => number} run the generator; returns its exit status
 * @returns {{ status: number, drifted: Snapshot[] }}
 */
export function checkDrift(files, run) {
  /** @type {Snapshot[]} */
  const snapshots = files.map((file) => ({ file, before: readOrNull(file), after: null }))
  let status
  try {
    status = run()
    for (const s of snapshots) s.after = readOrNull(s.file)
  } finally {
    for (const s of snapshots) {
      const now = readOrNull(s.file)
      if (s.before === null) {
        if (now !== null) fs.rmSync(s.file, { force: true })
      } else if (now === null || !now.equals(s.before)) {
        fs.mkdirSync(path.dirname(s.file), { recursive: true })
        fs.writeFileSync(s.file, s.before)
      }
    }
  }
  const drifted = snapshots.filter((s) => normalised(s.before) !== normalised(s.after))
  return { status, drifted }
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} [env] @param {string} [cwd] @returns {number} */
export function main(argv, env = process.env, cwd = process.cwd()) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        path: { type: 'string', multiple: true, default: [] },
        name: { type: 'string' },
      },
    })
  } catch (error) {
    console.error(`drift-check: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const { values, positionals } = parsed
  const paths = [
    ...values.path,
    ...(env.QD_DRIFT_PATHS ?? '')
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean),
  ]
  const shellCommand = env.QD_DRIFT_COMMAND?.trim() ?? ''
  if (paths.length === 0 || (positionals.length === 0 && shellCommand === '')) {
    console.error(
      'usage: drift-check.mjs --path <file>... [--name <label>] -- <command...>  (or QD_DRIFT_PATHS + QD_DRIFT_COMMAND)',
    )
    return 2
  }
  const label = values.name ?? paths.join(', ')
  const commandText = positionals.length > 0 ? positionals.join(' ') : shellCommand
  console.log(`drift-check (${label}): ${commandText}`)
  const files = paths.map((p) => path.resolve(cwd, p))
  const { status, drifted } = checkDrift(files, () => {
    const result =
      positionals.length > 0
        ? spawnSync(positionals[0] ?? '', positionals.slice(1), { cwd, stdio: 'inherit' })
        : spawnSync(shellCommand, { cwd, stdio: 'inherit', shell: true })
    if (result.error) console.error(`drift-check: ${result.error.message}`)
    return result.status ?? 1
  })
  if (status !== 0) {
    console.error(`drift-check (${label}): the generator failed with exit status ${status}; files restored`)
    return 1
  }
  const annotate = env.GITHUB_ACTIONS === 'true'
  for (const s of drifted) {
    const rel = path.relative(cwd, s.file).split(path.sep).join('/')
    const details = describeDrift(normalised(s.before), normalised(s.after))
    console.error(`drift-check: ${rel} is out of date`)
    for (const line of details) console.error(`  ${line}`)
    if (annotate)
      console.log(
        `::error file=${escapeProperty(rel)},title=${escapeProperty(`${label} is out of date`)}::` +
          escapeData(`Run \`${commandText}\` and commit the result. ${details[0] ?? ''}`),
      )
  }
  if (drifted.length > 0) {
    console.error(
      `drift-check (${label}): out of date; run \`${commandText}\` and commit the regenerated file(s)`,
    )
    return 1
  }
  console.log(`drift-check (${label}): up to date`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
