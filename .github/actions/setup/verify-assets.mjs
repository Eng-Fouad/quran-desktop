#!/usr/bin/env node
// @ts-check
// Verifies the third-party assets pinned in xtask/assets.lock (size and sha256) before anything builds with them
// (ARCHITECTURE §4.7, D23). CI restores public/fonts/ from a cache keyed by the hash of the lock; the restored files
// are still checked byte for byte here, so a stale or tampered cache entry can never reach dist/ or an installer.
//
//   node .github/actions/setup/verify-assets.mjs [--lock xtask/assets.lock] [--root .] [--quiet]
//
// Exit codes: 0 every pinned file matches, 1 a file is missing or differs, 2 the lock cannot be read or parsed.
import console from 'node:console'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** @typedef {{ file: string, bytes: number, sha256: string, source?: string }} PinnedAsset */

/**
 * Parses the `[[asset]]` tables of xtask/assets.lock (string and integer values; `#` comments).
 * @param {string} text @returns {PinnedAsset[]}
 * @throws {Error} on anything else, with the line number
 */
export function parseAssetsLock(text) {
  /** @type {Record<string, string | number>[]} */
  const tables = []
  /** @type {Record<string, string | number> | null} */
  let current = null
  const lines = text.split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line === '[[asset]]') {
      current = {}
      tables.push(current)
      continue
    }
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(\d+))\s*(?:#.*)?$/.exec(line)
    if (!match || !current) throw new Error(`line ${index + 1}: cannot parse ${JSON.stringify(raw)}`)
    const [, key = '', str, int] = match
    current[key] = str !== undefined ? JSON.parse(`"${str}"`) : Number(int)
  }
  return tables.map((table, i) => {
    const { file, bytes, sha256, source } = table
    if (typeof file !== 'string' || typeof bytes !== 'number' || typeof sha256 !== 'string')
      throw new Error(`asset ${i + 1}: needs file (string), bytes (integer) and sha256 (string)`)
    if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error(`asset ${i + 1}: sha256 is not 64 hex digits`)
    if (path.isAbsolute(file) || file.split('/').includes('..'))
      throw new Error(`asset ${i + 1}: file must be relative to the repository root`)
    return { file, bytes, sha256: sha256.toLowerCase(), ...(typeof source === 'string' ? { source } : {}) }
  })
}

/**
 * Checks every pinned asset under `root`; returns one problem per mismatching file.
 * @param {PinnedAsset[]} assets @param {string} root @returns {string[]}
 */
export function verifyAssets(assets, root) {
  /** @type {string[]} */
  const problems = []
  for (const asset of assets) {
    const file = path.join(root, ...asset.file.split('/'))
    if (!fs.existsSync(file)) {
      problems.push(`${asset.file}: missing`)
      continue
    }
    const bytes = fs.readFileSync(file)
    if (bytes.length !== asset.bytes) {
      problems.push(`${asset.file}: ${bytes.length} bytes, the lock pins ${asset.bytes}`)
      continue
    }
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha !== asset.sha256) problems.push(`${asset.file}: sha256 ${sha}, the lock pins ${asset.sha256}`)
  }
  return problems
}

/** @param {string[]} argv @returns {number} exit code */
export function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  let args
  try {
    args = parseArgs({
      args: argv,
      options: {
        lock: { type: 'string', default: 'xtask/assets.lock' },
        root: { type: 'string', default: root },
        quiet: { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    console.error(`verify-assets: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  /** @type {PinnedAsset[]} */
  let assets
  const lockPath = path.resolve(args.root, args.lock)
  try {
    assets = parseAssetsLock(fs.readFileSync(lockPath, 'utf8'))
  } catch (error) {
    console.error(`verify-assets: ${args.lock}: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const problems = verifyAssets(assets, args.root)
  if (problems.length > 0) {
    if (!args.quiet) for (const p of problems) console.error(`verify-assets: ${p}`)
    return 1
  }
  if (!args.quiet) console.log(`verify-assets: ${assets.length} pinned asset(s) match ${args.lock}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
