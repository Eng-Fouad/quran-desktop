#!/usr/bin/env node
// check:dist — guards the production frontend bundle. Run after `pnpm build`.
//
//   node scripts/check-dist.mjs [--dir dist] [--max-mib 6] [--json]
//
// Fails (exit 1) when:
//   - any file path under dist/ matches /fixtures|synthetic|mock/: the IPC mock, the synthetic generator and the
//     QF-derived fixtures must never reach an installer;
//   - a bundle file contains a mock-only marker (the mock state key `qd-mock-v1:`, the synthetic `mock://` audio URL,
//     the dev-packs `/__packs/` route, a `src/lib/ipc/mock/` module path) or an unreplaced `__MOCK_IPC__`;
//   - a source map lists a mock, synthetic or fixture module among its sources (debug builds);
//   - dist/ contains an SQLite database;
//   - dist/index.html contains a <style> element (Tauri would nonce it and CSP3 would then ignore 'unsafe-inline');
//   - dist/ contains a WOFF 1 font or a stylesheet still offers one: every webview reads WOFF2, so a WOFF fallback only
//     adds weight to the installer (`vite/woff2-only.ts` drops Fontsource's fallbacks);
//   - dist/ is larger than 6 MiB.
// Exit 2 when dist/ (or dist/index.html) is missing.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIB = 1024 * 1024

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: 'dist' },
    'max-mib': { type: 'string', default: '6' },
    json: { type: 'boolean', default: false },
  },
})

const distDir = resolve(ROOT, args.dir)
const maxBytes = Number(args['max-mib']) * MIB
if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
  console.error(`check:dist: invalid --max-mib ${args['max-mib']}`)
  process.exit(2)
}

/** Recursively lists files as `{ rel, abs, size }`, rel using forward slashes. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(abs))
    else if (entry.isFile())
      out.push({ rel: relative(distDir, abs).split(sep).join('/'), abs, size: statSync(abs).size })
  }
  return out
}

let files
try {
  files = walk(distDir)
} catch {
  console.error(
    `check:dist: ${relative(ROOT, distDir) || distDir}/ does not exist. Run \`pnpm build\` first.`,
  )
  process.exit(2)
}
if (!files.some((f) => f.rel === 'index.html')) {
  console.error(`check:dist: ${relative(ROOT, distDir)}/index.html is missing. Run \`pnpm build\` first.`)
  process.exit(2)
}

const FORBIDDEN_PATH = /fixtures|synthetic|mock/i
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.svg', '.txt', '.webmanifest'])
const MOCK_MARKERS = ['qd-mock-v1:', 'mock://', '/__packs/', 'src/lib/ipc/mock/', '__MOCK_IPC__']
const MAP_SOURCE = /(^|\/)(ipc\/mock|fixtures|synthetic)(\/|\.|$)/
const SQLITE_MAGIC = 'SQLite format 3\0'

/** @type {{ name: string, ok: boolean, details: string[] }[]} */
const checks = []
const check = (name, details) => checks.push({ name, ok: details.length === 0, details })

check(
  'no file path matches /fixtures|synthetic|mock/',
  files.filter((f) => FORBIDDEN_PATH.test(f.rel)).map((f) => f.rel),
)

const markerHits = []
const mapHits = []
const databases = []
for (const f of files) {
  const ext = extname(f.rel).toLowerCase()
  if (ext === '.map') {
    try {
      const map = JSON.parse(readFileSync(f.abs, 'utf8'))
      for (const source of map.sources ?? []) {
        if (MAP_SOURCE.test(String(source).replaceAll('\\', '/'))) mapHits.push(`${f.rel}: ${source}`)
      }
    } catch {
      mapHits.push(`${f.rel}: not a valid source map`)
    }
    continue
  }
  const head = readFileSync(f.abs).subarray(0, 16).toString('latin1')
  if (head === SQLITE_MAGIC || ['.db', '.sqlite', '.sqlite3'].includes(ext)) {
    databases.push(f.rel)
    continue
  }
  if (!TEXT_EXT.has(ext)) continue
  const text = readFileSync(f.abs, 'utf8')
  for (const marker of MOCK_MARKERS)
    if (text.includes(marker)) markerHits.push(`${f.rel}: contains "${marker}"`)
}
check(`no mock-only markers in the bundle (${MOCK_MARKERS.join(', ')})`, markerHits)
check('no mock, synthetic or fixture module in any source map', mapHits)
check('no SQLite database in dist/', databases)

// WOFF 1: no font file, and no `format("woff")` source left in a stylesheet (a data: URI would hide the file).
const woff = []
for (const f of files) {
  const ext = extname(f.rel).toLowerCase()
  if (ext === '.woff') woff.push(f.rel)
  else if (ext === '.css') {
    const hits = readFileSync(f.abs, 'utf8').match(/format\(\s*["']?woff["']?\s*\)/gi) ?? []
    if (hits.length) woff.push(`${f.rel}: ${hits.length} format("woff") source(s)`)
  }
}
check('no WOFF 1 font in dist/ (WOFF2 only; vite/woff2-only.ts)', woff)

// Comments are not elements; Tauri's nonce injection only touches real <style> elements.
const indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
check('dist/index.html has no <style> element', /<style[\s>/]/i.test(indexHtml) ? ['index.html: <style'] : [])

const total = files.reduce((sum, f) => sum + f.size, 0)
const mib = (n) => `${(n / MIB).toFixed(2)} MiB`
check(
  `size ${mib(total)} <= ${mib(maxBytes)}`,
  total > maxBytes ? [`dist/ is ${mib(total)}, over the ${mib(maxBytes)} budget`] : [],
)

const failed = checks.filter((c) => !c.ok)
const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 8)

if (args.json) {
  console.log(
    JSON.stringify(
      { ok: failed.length === 0, dir: args.dir, files: files.length, bytes: total, checks },
      null,
      2,
    ),
  )
} else {
  console.log(`check:dist  ${args.dir}/  ${files.length} files, ${mib(total)}`)
  for (const c of checks) {
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}`)
    for (const d of c.details.slice(0, 20)) console.log(`          ${d}`)
    if (c.details.length > 20) console.log(`          … ${c.details.length - 20} more`)
  }
  console.log('  largest files:')
  for (const f of largest) console.log(`          ${(f.size / 1024).toFixed(1).padStart(8)} KiB  ${f.rel}`)
  console.log(
    failed.length ? `check:dist FAILED (${failed.length} of ${checks.length} checks)` : 'check:dist passed',
  )
}
process.exit(failed.length ? 1 : 0)
