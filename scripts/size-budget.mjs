#!/usr/bin/env node
// @ts-check
// size-budget: the size and runtime targets, measured and enforced.
//
//   node scripts/size-budget.mjs [--bundle-dir <dir>]... [--dist <dir>] [--metrics <file>]
//                                [--placeholder-core <core.db>] [--require <rows>] [--report-only] [--json]
//
// Rows (ids in brackets) and where they are measured:
//   [nsis] [dmg] [deb] [appimage]  the newest installer of each kind under the bundle directories (default: every
//                                  <target>/release/bundle and <target>/<triple>/release/bundle, <target> being
//                                  $CARGO_TARGET_DIR or ./target)
//   [installed]                    what an installation puts on disk, packs excluded: Windows, the release exe and
//                                  the bundled resources next to the bundle directory (what the NSIS script installs);
//                                  macOS, the .app (a universal app, two binary slices, has its own budget:
//                                  INSTALLED_UNIVERSAL); Linux, the deb's Installed-Size
//   [dist]                         dist/ (also enforced by check:dist); not measured when it holds a debug build
//                                  (source maps: `pnpm tauri build --debug`, which the metrics run needs)
//   [cold-start] [rss] [idle-cpu] [playback-cpu-1x] [playback-cpu-1.5x]
//                                  from the report `pnpm shots:app --only metrics` writes (tests/e2e/metrics,
//                                  artifacts/shots/app/metrics-report.json): a debug build on Windows. Memory and
//                                  CPU are the app's and every WebView2 process's together ("webview included"), as
//                                  Task Manager groups them; the app's own share and the breakdown are the notes
//
// --placeholder-core <core.db>: the bundles were built around build.rs's 0-byte core.db placeholder (CI: a qdc core.db
// must never enter a bundle). Each installer then counts the real core.db compressed as that format compresses it: NSIS
// LZMA (solid, 8 MiB dictionary; 7-Zip or xz), deb as its payload is (xz -6 for data.tar.xz, the deb scripts/deb-xz.mjs
// makes and release.yml ships; gzip level 6 for tauri's own data.tar.gz), dmg zlib level 9 (UDZO), AppImage gzip level
// 9 (squashfs; an approximation). The installed footprint counts it uncompressed.
//
// --require <rows>: ids, or the groups `installers`, `runtime` and `all`, that must be measured; a required row that
// is missing fails the run. Without --report-only, any measured row over its budget fails the run.
//
// Budgets: "MB" is read as MiB, as check:dist (6 MiB) and the CI size check always did.
//
// Exit codes: 0 every measured row within budget and every required row measured, 1 otherwise, 2 bad usage.
import { Buffer } from 'node:buffer'
import console from 'node:console'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'
import { bufferSource, listAr, listTar } from './check-artifacts.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const KIB = 1024
export const MIB = 1024 * KIB

/**
 * @typedef {'nsis' | 'dmg' | 'deb' | 'appimage' | 'installed' | 'dist' | 'cold-start' | 'rss' | 'idle-cpu'
 *   | 'playback-cpu-1x' | 'playback-cpu-1.5x'} RowId
 * @typedef {'bytes' | 'ms' | 'percent'} Unit
 * @typedef {{ id: RowId, what: string, spec: string, unit: Unit, max: number }} Budget
 */

/** The budget table, in order. @type {readonly Budget[]} */
export const BUDGETS = Object.freeze([
  { id: 'nsis', what: 'Windows NSIS installer', spec: '≤ 8 MB', unit: 'bytes', max: 8 * MIB },
  { id: 'dmg', what: 'macOS dmg (universal)', spec: '≤ 25 MB', unit: 'bytes', max: 25 * MIB },
  { id: 'deb', what: 'Linux deb', spec: '≤ 9 MB', unit: 'bytes', max: 9 * MIB },
  { id: 'appimage', what: 'Linux AppImage', spec: '≤ 90 MB', unit: 'bytes', max: 90 * MIB },
  {
    id: 'installed',
    what: 'installed footprint (without packs)',
    spec: '≤ 35 MB',
    unit: 'bytes',
    max: 35 * MIB,
  },
  { id: 'dist', what: 'dist/ (frontend bundle)', spec: '≤ 6 MB', unit: 'bytes', max: 6 * MIB },
  { id: 'cold-start', what: 'cold start to first paint (Windows)', spec: '≤ 800 ms', unit: 'ms', max: 800 },
  {
    id: 'rss',
    what: 'RSS with a spread + playback (webview included)',
    spec: '≤ 350 MB',
    unit: 'bytes',
    max: 350 * MIB,
  },
  // "≈ 0 % (no timers when idle)": a visible, idle window may still be repainted by the compositor now and then.
  {
    id: 'idle-cpu',
    what: 'idle CPU (no playback, window visible, webview included)',
    spec: '≈ 0 %',
    unit: 'percent',
    max: 0.5,
  },
  // Of one core, for the app and its WebView2 processes: the word glide and the scrubber are drawn in the webview.
  {
    id: 'playback-cpu-1x',
    what: 'playback CPU at 1.0× (webview included)',
    spec: '≤ 3 %',
    unit: 'percent',
    max: 3,
  },
  {
    id: 'playback-cpu-1.5x',
    what: 'playback CPU at 1.5× (webview included)',
    spec: '≤ 6 %',
    unit: 'percent',
    max: 6,
  },
])

/**
 * The `installed` row's budget for a universal macOS app (owner decision 2026-10-12): it carries the binary twice, an
 * arm64 and an x86_64 slice, so it gets 40 MB; every single-architecture install keeps the 35 MB above. The row takes
 * it when the measured .app's executable is a fat Mach-O of two or more slices (`macSlices`).
 * @type {Budget}
 */
export const INSTALLED_UNIVERSAL = Object.freeze({
  id: 'installed',
  what: 'installed footprint, macOS universal (without packs)',
  spec: '≤ 40 MB',
  unit: 'bytes',
  max: 40 * MIB,
})

export const INSTALLER_ROWS = /** @type {const} */ (['nsis', 'dmg', 'deb', 'appimage'])
export const RUNTIME_ROWS = /** @type {const} */ ([
  'cold-start',
  'rss',
  'idle-cpu',
  'playback-cpu-1x',
  'playback-cpu-1.5x',
])
/**
 * The format of the runtime report `tests/e2e/metrics/metrics.mjs` writes. Version 2: the playback CPU rows count the
 * app and its WebView2 processes (version 1 counted the app process alone, so a report of that version is refused).
 */
export const METRICS_REPORT_FORMAT = 'qd-metrics-report/2'
/** Earlier formats, and why a report in one of them is not read. @type {Readonly<Record<string, string>>} */
const SUPERSEDED_REPORT_FORMATS = Object.freeze({
  'qd-metrics-report/1':
    'its playback CPU rows count the app process alone, not the webview (re-run `pnpm shots:app --only metrics`)',
})

/**
 * @typedef {{ id: RowId, value: number, source: string, notes?: string[], budget?: Budget }} Measurement
 *   `budget`: the budget this measurement is held to when not its row's (a universal macOS app's footprint)
 * @typedef {{ budget: Budget, measurement: Measurement | null, status: 'ok' | 'over' | 'missing' | 'not measured' }} Row
 */

// ---------------------------------------------------------------------------------------------------------------------
// Compression as each installer format compresses core.db.

/**
 * The size of `file` compressed with LZMA as NSIS's `SetCompressor /SOLID lzma` stores it (8 MiB dictionary), with
 * 7-Zip or xz.
 * @param {string} file @param {string} scratch a directory for 7-Zip's archive
 * @returns {{ bytes: number, tool: string }}
 * @throws {Error} when neither 7-Zip nor xz is installed
 */
export function lzmaSize(file, scratch) {
  const archive = path.join(scratch, `qd-size-${process.pid}.7z`)
  fs.rmSync(archive, { force: true })
  for (const exe of ['7z', '7za']) {
    const run = spawnSync(exe, ['a', '-t7z', '-m0=LZMA:d=8m', '-mx=9', '-bd', archive, file], {
      encoding: 'utf8',
    })
    if (run.status === 0 && fs.existsSync(archive)) {
      const bytes = fs.statSync(archive).size
      fs.rmSync(archive, { force: true })
      return { bytes, tool: `${exe} LZMA d=8m` }
    }
  }
  const xz = spawnSync('xz', ['--format=lzma', '--lzma1=preset=9e,dict=8MiB', '--stdout', file], {
    maxBuffer: 1024 * MIB,
  })
  if (xz.status === 0 && xz.stdout)
    return { bytes: xz.stdout.length, tool: 'xz --format=lzma (9e, dict 8 MiB)' }
  throw new Error('neither 7-Zip (7z) nor xz is installed, so the LZMA size of core.db cannot be measured')
}

/**
 * The size of `core` compressed as scripts/deb-xz.mjs compresses a deb's payload (xz -6, one thread).
 * @param {Buffer} core @returns {number}
 * @throws {Error} when xz is not installed
 */
export function xzSize(core) {
  const xz = spawnSync('xz', ['-6', '--threads=1', '--compress', '--stdout'], {
    input: core,
    maxBuffer: 2 * core.length + MIB,
  })
  if (xz.status === 0 && xz.stdout) return xz.stdout.length
  throw new Error(
    /** @type {NodeJS.ErrnoException | undefined} */ (xz.error)?.code === 'ENOENT'
      ? 'xz is not installed, so the size of core.db in an xz deb cannot be measured'
      : `xz could not compress core.db (${String(xz.stderr ?? '').trim() || xz.error?.message || `exit ${xz.status}`})`,
  )
}

/**
 * How a deb's payload is compressed: `xz` (data.tar.xz), `gzip` (data.tar.gz), or null when it has no such member.
 * @param {string} deb @returns {'xz' | 'gzip' | null}
 */
export function debPayload(deb) {
  const names = listAr(bufferSource(fs.readFileSync(deb))).map((e) => e.name)
  return names.includes('data.tar.xz') ? 'xz' : names.includes('data.tar.gz') ? 'gzip' : null
}

/**
 * How many bytes `core` adds to an installer of `kind` (compressed as that format does).
 * @param {'nsis' | 'dmg' | 'deb' | 'appimage'} kind @param {Buffer} core @param {string} file the same bytes on disk
 * @param {string} [installer] the placeholder installer (a deb is measured as its payload is compressed)
 * @returns {{ bytes: number, how: string }}
 */
export function compressedCore(kind, core, file, installer) {
  switch (kind) {
    case 'nsis': {
      const { bytes, tool } = lzmaSize(file, tmpdir())
      return { bytes, how: tool }
    }
    case 'deb':
      return installer && debPayload(installer) === 'xz'
        ? { bytes: xzSize(core), how: 'xz -6 (data.tar.xz)' }
        : { bytes: zlib.gzipSync(core, { level: 6 }).length, how: 'gzip -6 (data.tar.gz)' }
    case 'dmg':
      return { bytes: zlib.deflateSync(core, { level: 9 }).length, how: 'zlib -9 (UDZO)' }
    case 'appimage':
      return { bytes: zlib.gzipSync(core, { level: 9 }).length, how: 'gzip -9 (squashfs, approximate)' }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Discovery.

/** @param {string} dir @returns {string[]} */
function list(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * The bundle directories of a cargo target dir: `release/bundle` and `<triple>/release/bundle`.
 * @param {string} target
 */
export function defaultBundleDirs(target) {
  const dirs = [path.join(target, 'release', 'bundle')]
  for (const name of list(target)) {
    const candidate = path.join(target, name, 'release', 'bundle')
    if (name !== 'release' && name !== 'debug' && fs.existsSync(candidate)) dirs.push(candidate)
  }
  return dirs.filter((d) => fs.existsSync(d))
}

/** @type {Record<'nsis' | 'dmg' | 'deb' | 'appimage', { sub: string, ext: RegExp }>} */
const INSTALLER_LAYOUT = {
  nsis: { sub: 'nsis', ext: /\.exe$/i },
  dmg: { sub: 'dmg', ext: /\.dmg$/i },
  deb: { sub: 'deb', ext: /\.deb$/i },
  appimage: { sub: 'appimage', ext: /\.appimage$/i },
}

/**
 * The newest installer of each kind in the bundle directories.
 * @param {string[]} bundleDirs
 * @returns {Partial<Record<'nsis' | 'dmg' | 'deb' | 'appimage', string>>}
 */
export function findInstallers(bundleDirs) {
  /** @type {Partial<Record<'nsis' | 'dmg' | 'deb' | 'appimage', string>>} */
  const found = {}
  /** @type {Partial<Record<string, number>>} */
  const newest = {}
  for (const dir of bundleDirs)
    for (const kind of INSTALLER_ROWS) {
      const { sub, ext } = INSTALLER_LAYOUT[kind]
      for (const name of list(path.join(dir, sub))) {
        const file = path.join(dir, sub, name)
        if (!ext.test(name) || !fs.statSync(file).isFile()) continue
        const time = fs.statSync(file).mtimeMs
        if (time > (newest[kind] ?? -1)) {
          newest[kind] = time
          found[kind] = file
        }
      }
    }
  return found
}

/**
 * The architecture slices of a macOS app's executables (Contents/MacOS): a fat Mach-O names its count, a thin one is
 * one; the most among them, 0 when there is no Mach-O.
 * @param {string} appDir @returns {number}
 */
export function macSlices(appDir) {
  const dir = path.join(appDir, 'Contents', 'MacOS')
  let most = 0
  for (const name of list(dir)) {
    const head = Buffer.alloc(8)
    try {
      const fd = fs.openSync(path.join(dir, name), 'r')
      try {
        if (fs.readSync(fd, head, 0, 8, 0) < 8) continue
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      continue
    }
    const magic = head.readUInt32BE(0)
    if (magic === 0xcafebabe || magic === 0xcafebabf) most = Math.max(most, head.readUInt32BE(4))
    else if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) most = Math.max(most, 1)
  }
  return most
}

/** Total size of the files under `p` (or of `p`). @param {string} p @returns {number} */
export function treeSize(p) {
  const stat = fs.lstatSync(p)
  if (stat.isSymbolicLink()) return 0
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const name of list(p)) total += treeSize(path.join(p, name))
  return total
}

/**
 * The `Installed-Size` (KiB) of a deb, from control.tar.gz.
 * @param {string} deb @returns {number | null} bytes
 */
export function debInstalledSize(deb) {
  const src = bufferSource(fs.readFileSync(deb))
  const member = listAr(src).find((e) => /^control\.tar(\.gz)?$/.test(e.name))
  if (!member) return null
  let tar = src.read(member.dataStart, member.size)
  if (member.name.endsWith('.gz')) tar = zlib.gunzipSync(tar)
  const tarSrc = bufferSource(tar)
  const control = listTar(tarSrc).find((e) => e.type === 'file' && /(^|\/)control$/.test(e.name))
  if (!control) return null
  const text = tarSrc.read(control.dataStart, control.size).toString('utf8')
  const kib = /^Installed-Size:\s*(\d+)\s*$/m.exec(text)?.[1]
  return kib === undefined ? null : Number(kib) * KIB
}

/**
 * The Windows install footprint: the release exe and the bundled resources the NSIS script installs, next to a
 * `…/release/bundle` directory (the uninstaller NSIS writes at install time, about 0.1 MB, is not counted). Null
 * when there is no exe.
 * @param {string} bundleDir
 * @returns {{ bytes: number, parts: string[] } | null}
 */
export function windowsInstalled(bundleDir) {
  const release = path.dirname(bundleDir)
  const exe = 'quran-desktop.exe'
  const script = path.join(release, 'nsis', 'x64', 'installer.nsi')
  if (!fs.existsSync(path.join(release, exe))) return null
  let bytes = fs.statSync(path.join(release, exe)).size
  const parts = [exe]
  // `File /a "/oname=data\core.db" "<source>"`: the resources the installer copies, read from tauri's NSIS script.
  if (fs.existsSync(script)) {
    for (const match of fs.readFileSync(script, 'utf8').matchAll(/File \/a "\/oname=([^"]+)" "([^"]+)"/g)) {
      const source = match[2] ?? ''
      if (fs.existsSync(source)) {
        bytes += fs.statSync(source).size
        parts.push(match[1] ?? source)
      }
    }
  }
  return { bytes, parts }
}

// ---------------------------------------------------------------------------------------------------------------------
// Evaluation.

/**
 * @param {readonly Budget[]} budgets @param {Measurement[]} measurements @param {Set<RowId>} required
 * @returns {Row[]}
 */
export function evaluate(budgets, measurements, required) {
  return budgets.map((row) => {
    const measurement = measurements.find((m) => m.id === row.id) ?? null
    const budget = measurement?.budget ?? row
    /** @type {Row['status']} */
    const status = measurement
      ? measurement.value <= budget.max
        ? 'ok'
        : 'over'
      : required.has(row.id)
        ? 'missing'
        : 'not measured'
    return { budget, measurement, status }
  })
}

/** @param {number} value @param {Unit} unit */
export function formatValue(value, unit) {
  if (unit === 'ms') return `${Math.round(value)} ms`
  if (unit === 'percent') return `${value.toFixed(2)} %`
  return `${(value / MIB).toFixed(2)} MiB (${Math.round(value).toLocaleString('en-US')} B)`
}

/** @param {Row[]} rows @returns {string[]} markdown */
export function markdown(rows) {
  const lines = [
    '### Size and runtime budgets',
    '',
    '| Target | Budget | Measured | Status | Source |',
    '|---|---|---|---|---|',
  ]
  for (const { budget, measurement, status } of rows) {
    const value = measurement ? formatValue(measurement.value, budget.unit) : '–'
    const mark = { ok: 'ok', over: '**over**', missing: '**missing**', 'not measured': 'not measured' }[
      status
    ]
    const limit = `${budget.spec} (${formatValue(budget.max, budget.unit).replace(/ \(.*\)$/, '')})`
    const source = measurement ? [measurement.source, ...(measurement.notes ?? [])].join('; ') : ''
    lines.push(`| ${budget.what} | ${limit} | ${value} | ${mark} | ${source.replace(/\|/g, '\\|')} |`)
  }
  return lines
}

/**
 * Expands `--require` values into row ids.
 * @param {string[]} values @returns {Set<RowId>}
 * @throws {Error} on an unknown id
 */
export function parseRequire(values) {
  /** @type {Set<RowId>} */
  const out = new Set()
  for (const raw of values.flatMap((v) => v.split(','))) {
    const id = raw.trim()
    if (!id) continue
    if (id === 'all') BUDGETS.forEach((b) => out.add(b.id))
    else if (id === 'installers') INSTALLER_ROWS.forEach((r) => out.add(r))
    else if (id === 'runtime') RUNTIME_ROWS.forEach((r) => out.add(r))
    else {
      const budget = BUDGETS.find((b) => b.id === id)
      if (!budget)
        throw new Error(
          `unknown row "${id}" (rows: ${BUDGETS.map((b) => b.id).join(', ')}; groups: installers, runtime, all)`,
        )
      out.add(budget.id)
    }
  }
  return out
}

/**
 * Reads the runtime rows of a metrics report.
 * @param {string} file @returns {Measurement[]}
 * @throws {Error} when the file is not a metrics report
 */
export function readMetricsReport(file) {
  /** @type {any} */
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (report?.format !== METRICS_REPORT_FORMAT) {
    const why = SUPERSEDED_REPORT_FORMATS[String(report?.format)]
    throw new Error(
      why
        ? `${file} is a ${report.format} report: ${why}`
        : `${file} is not a ${METRICS_REPORT_FORMAT} report`,
    )
  }
  /** @type {Measurement[]} */
  const out = []
  const where = `${path.basename(file)}, ${report.build ?? 'unknown'} build, ${String(report.measuredAt ?? '').slice(0, 10)}`
  for (const id of RUNTIME_ROWS) {
    const row = report.rows?.[id]
    if (row && typeof row.value === 'number' && Number.isFinite(row.value))
      out.push({
        id,
        value: row.value,
        source: where,
        notes: Array.isArray(row.notes) ? row.notes : undefined,
      })
  }
  return out
}

/**
 * Whether `dir` holds a debug build of the frontend: `pnpm tauri build --debug` builds dist/ with source maps and
 * without minification (vite.config.ts, `TAURI_ENV_DEBUG`), which is not the production bundle the dist row budgets.
 * @param {string} dir
 */
export function isDebugDist(dir) {
  /** @param {string} d @returns {boolean} */
  const hasMap = (d) =>
    list(d).some((name) => {
      const p = path.join(d, name)
      return name.endsWith('.map') || (fs.statSync(p).isDirectory() && hasMap(p))
    })
  return hasMap(dir)
}

/**
 * Measures every row it finds. `notices` say why a row that could have been measured was not.
 * @param {{ bundleDirs: string[], dist: string | null, metrics: string | null, placeholderCore: string | null }} input
 * @returns {{ measurements: Measurement[], problems: string[], notices: string[] }}
 */
export function measure({ bundleDirs, dist, metrics, placeholderCore }) {
  /** @type {Measurement[]} */
  const measurements = []
  /** @type {string[]} */
  const problems = []
  /** @type {string[]} */
  const notices = []
  const core = placeholderCore ? fs.readFileSync(placeholderCore) : null
  const installers = findInstallers(bundleDirs)
  for (const kind of INSTALLER_ROWS) {
    const file = installers[kind]
    if (!file) continue
    const bytes = fs.statSync(file).size
    if (!core || !placeholderCore) {
      measurements.push({ id: kind, value: bytes, source: path.basename(file) })
      continue
    }
    try {
      const extra = compressedCore(kind, core, placeholderCore, file)
      measurements.push({
        id: kind,
        value: bytes + extra.bytes,
        source: `${path.basename(file)} with the placeholder core.db (${bytes.toLocaleString('en-US')} B)`,
        notes: [`+ core.db ${extra.bytes.toLocaleString('en-US')} B by ${extra.how}`],
      })
    } catch (error) {
      problems.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Installed footprint: macOS .app, else the deb's Installed-Size, else the Windows install.
  const coreBytes = core?.length ?? 0
  const coreNote = core
    ? [`+ core.db ${coreBytes.toLocaleString('en-US')} B (placeholder in the bundle)`]
    : undefined
  /** @type {Measurement | null} */
  let installed = null
  for (const dir of bundleDirs) {
    const app = list(path.join(dir, 'macos')).find((n) => n.endsWith('.app'))
    if (app) {
      const appDir = path.join(dir, 'macos', app)
      const slices = macSlices(appDir)
      installed = {
        id: 'installed',
        value: treeSize(appDir) + coreBytes,
        source: app,
        notes: coreNote,
      }
      if (slices > 1) {
        installed.budget = INSTALLED_UNIVERSAL
        installed.notes = [...(coreNote ?? []), `universal: ${slices} architecture slices`]
      }
      break
    }
  }
  if (!installed && installers.deb) {
    try {
      const bytes = debInstalledSize(installers.deb)
      if (bytes !== null)
        installed = {
          id: 'installed',
          value: bytes + coreBytes,
          source: `Installed-Size of ${path.basename(installers.deb)}`,
          notes: coreNote,
        }
    } catch (error) {
      problems.push(`installed: ${installers.deb}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!installed && installers.nsis) {
    const win = windowsInstalled(path.dirname(path.dirname(installers.nsis)))
    if (win)
      installed = {
        id: 'installed',
        value: win.bytes + coreBytes,
        source: win.parts.join(' + '),
        notes: coreNote,
      }
  }
  if (installed) measurements.push(installed)

  if (dist && fs.existsSync(dist)) {
    const where = path.relative(ROOT, dist) || dist
    if (isDebugDist(dist))
      notices.push(
        `dist: ${where} holds a debug build (source maps, not minified: \`pnpm tauri build --debug\`), not the ` +
          'production bundle; `pnpm build` makes the one this row measures',
      )
    else measurements.push({ id: 'dist', value: treeSize(dist), source: where })
  }
  if (metrics) {
    try {
      measurements.push(...readMetricsReport(metrics))
    } catch (error) {
      problems.push(`metrics: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { measurements, problems, notices }
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI.

const USAGE = `Usage: node scripts/size-budget.mjs [--bundle-dir <dir>]... [--dist <dir>] [--metrics <file>]
                                    [--placeholder-core <core.db>] [--require <rows>] [--report-only] [--json]

Measures the size and runtime targets and fails when one is over its budget (see the header of this file).

  --bundle-dir <dir>         a tauri bundle directory (repeatable; default: every release bundle dir of the target)
  --dist <dir>               the frontend bundle (default dist/)
  --metrics <file>           the runtime report of \`pnpm shots:app --only metrics\`
                             (default artifacts/shots/app/metrics-report.json when present)
  --placeholder-core <file>  the bundles hold build.rs's placeholder: add this core.db as each format compresses it
  --require <rows>           rows that must be measured: ids or installers, runtime, all (repeatable, comma-separated)
  --report-only              print the table, never fail
  --json                     print the rows as JSON

Exit codes: 0 within budget, 1 over budget or a required row missing, 2 bad usage.`

/** @param {string[]} argv @param {NodeJS.ProcessEnv} [env] @returns {number} */
export function main(argv, env = process.env) {
  let values
  try {
    values = parseArgs({
      args: argv,
      options: {
        'bundle-dir': { type: 'string', multiple: true, default: [] },
        dist: { type: 'string', default: path.join(ROOT, 'dist') },
        metrics: { type: 'string' },
        'placeholder-core': { type: 'string' },
        require: { type: 'string', multiple: true, default: [] },
        'report-only': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    console.error(`size-budget: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 2
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  /** @type {Set<RowId>} */
  let required
  try {
    required = parseRequire(values.require)
  } catch (error) {
    console.error(`size-budget: --require: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const target = path.resolve(ROOT, env.CARGO_TARGET_DIR ?? 'target')
  const bundleDirs = values['bundle-dir'].length
    ? values['bundle-dir'].map((d) => path.resolve(d))
    : defaultBundleDirs(target)
  const placeholderCore = values['placeholder-core'] ? path.resolve(values['placeholder-core']) : null
  if (placeholderCore && (!fs.existsSync(placeholderCore) || fs.statSync(placeholderCore).size === 0)) {
    console.error(
      `size-budget: --placeholder-core ${placeholderCore} is missing or empty (it must be the real core.db)`,
    )
    return 2
  }
  const defaultMetrics = path.join(ROOT, 'artifacts', 'shots', 'app', 'metrics-report.json')
  const metrics = values.metrics
    ? path.resolve(values.metrics)
    : fs.existsSync(defaultMetrics)
      ? defaultMetrics
      : null

  const { measurements, problems, notices } = measure({
    bundleDirs,
    dist: path.resolve(values.dist),
    metrics,
    placeholderCore,
  })
  const rows = evaluate(BUDGETS, measurements, required)
  const failed = rows.filter((r) => r.status === 'over' || r.status === 'missing')
  const ok = failed.length === 0 && problems.length === 0

  if (values.json) {
    console.log(JSON.stringify({ ok, bundleDirs, rows, problems, notices }, null, 2))
  } else {
    console.log(
      `size-budget  bundle dirs: ${bundleDirs.map((d) => path.relative(ROOT, d) || d).join(', ') || 'none'}`,
    )
    const width = Math.max(...rows.map((r) => r.budget.what.length))
    for (const { budget, measurement, status } of rows) {
      const tag = { ok: 'ok     ', over: 'OVER   ', missing: 'MISSING', 'not measured': '-      ' }[status]
      const value = measurement ? formatValue(measurement.value, budget.unit) : 'not measured'
      console.log(`  ${tag}  ${budget.what.padEnd(width)}  ${value.padEnd(30)}  budget ${budget.spec}`)
      if (measurement && (status !== 'ok' || measurement.notes)) {
        console.log(`           ${''.padEnd(width)}  ${measurement.source}`)
        for (const note of measurement.notes ?? []) console.log(`           ${''.padEnd(width)}  ${note}`)
      }
    }
    for (const n of notices) console.log(`  NOTE     ${n}`)
    for (const p of problems) console.log(`  FAIL     ${p}`)
    console.log(
      ok
        ? `size-budget passed: ${rows.filter((r) => r.status === 'ok').length} row(s) within budget`
        : `size-budget FAILED: ${failed
            .map((r) => `${r.budget.id} ${r.status}`)
            .concat(problems.length ? ['measurement problems'] : [])
            .join(', ')}`,
    )
  }
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown(rows).join('\n')}\n\n`)
  if (env.GITHUB_ACTIONS === 'true')
    for (const r of failed)
      console.log(
        `::${values['report-only'] ? 'warning' : 'error'} title=Size budget (${r.budget.id})::${r.budget.what}: ${
          r.measurement
            ? `${formatValue(r.measurement.value, r.budget.unit)} > ${r.budget.spec}`
            : 'not measured'
        }`,
      )
  if (values['report-only']) return 0
  return ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
