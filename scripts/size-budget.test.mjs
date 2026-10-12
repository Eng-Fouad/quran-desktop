// @ts-check
// node --test scripts/size-budget.test.mjs
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import zlib from 'node:zlib'
import {
  BUDGETS,
  compressedCore,
  debInstalledSize,
  debPayload,
  defaultBundleDirs,
  evaluate,
  findInstallers,
  isDebugDist,
  lzmaSize,
  main,
  markdown,
  measure,
  METRICS_REPORT_FORMAT,
  MIB,
  parseRequire,
  readMetricsReport,
  windowsInstalled,
  xzSize,
} from './size-budget.mjs'
import { recompressDeb } from './deb-xz.mjs'

const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-size-budget-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
let counter = 0
const fresh = () => {
  const dir = path.join(work, `case-${++counter}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
/** @param {string} file @param {string | Buffer} content */
function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

/** A ustar archive of regular files (test-only). @param {Record<string, string | Buffer>} files */
function tar(files) {
  /** @type {Buffer[]} */
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const h = Buffer.alloc(512)
    h.write(name, 0, 'utf8')
    h.write('0000644\0', 100, 'latin1')
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
    h.write('00000000000\0', 136, 'latin1')
    h.write('        ', 148, 'latin1')
    h.write('0', 156, 'latin1')
    h.write('ustar\0', 257, 'latin1')
    h.write('00', 263, 'latin1')
    let sum = 0
    for (const b of h) sum += b
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/** A .deb with a control file. @param {string} control */
function deb(control) {
  /** @param {string} name @param {Buffer} data */
  const member = (name, data) => {
    const h = Buffer.alloc(60, 0x20)
    h.write(`${name}/`, 0, 'latin1')
    h.write(String(data.length), 48, 'latin1')
    h.write('`\n', 58, 'latin1')
    return Buffer.concat([h, data, Buffer.alloc(data.length % 2, 0x0a)])
  }
  return Buffer.concat([
    Buffer.from('!<arch>\n', 'latin1'),
    member('debian-binary', Buffer.from('2.0\n')),
    member('control.tar.gz', zlib.gzipSync(tar({ './control': control }))),
    member('data.tar.gz', zlib.gzipSync(tar({}))),
  ])
}

const needsXz = spawnSync('xz', ['--version']).status === 0 ? {} : { skip: 'xz is not installed' }

const haveLzma = (() => {
  try {
    lzmaSize(put(path.join(work, 'probe.bin'), 'probe'), work)
    return true
  } catch {
    return false
  }
})()

describe('budgets', () => {
  it('lists every §13.6 row with its budget in MiB, ms or %', () => {
    assert.deepEqual(
      BUDGETS.map((b) => [b.id, b.unit === 'bytes' ? b.max / MIB : b.max]),
      [
        ['nsis', 8],
        ['dmg', 25],
        ['deb', 9],
        ['appimage', 90],
        ['installed', 35],
        ['dist', 6],
        ['cold-start', 800],
        ['rss', 350],
        ['idle-cpu', 0.5],
        ['playback-cpu-1x', 3],
        ['playback-cpu-1.5x', 6],
      ],
    )
  })

  it('evaluates ok, over, missing and not measured', () => {
    const rows = evaluate(
      BUDGETS,
      [
        { id: 'nsis', value: 8 * MIB, source: 'a' },
        { id: 'deb', value: 9 * MIB + 1, source: 'b' },
      ],
      new Set(['nsis', 'dmg']),
    )
    const status = Object.fromEntries(rows.map((r) => [r.budget.id, r.status]))
    assert.equal(status.nsis, 'ok', 'exactly at the budget is within it')
    assert.equal(status.deb, 'over')
    assert.equal(status.dmg, 'missing')
    assert.equal(status.appimage, 'not measured')
    const md = markdown(rows).join('\n')
    assert.match(
      md,
      /\| Linux deb \| ≤ 9 MB \(9\.00 MiB\) \| 9\.00 MiB \(9,437,185 B\) \| \*\*over\*\* \| b \|/,
    )
  })

  it('expands --require groups and rejects unknown rows', () => {
    assert.deepEqual([...parseRequire(['installers', 'dist'])], ['nsis', 'dmg', 'deb', 'appimage', 'dist'])
    assert.equal(parseRequire(['all']).size, BUDGETS.length)
    assert.deepEqual([...parseRequire(['runtime'])].length, 5)
    assert.throws(() => parseRequire(['nsis,bogus']), /unknown row "bogus"/)
  })
})

describe('measurement', () => {
  it('finds the newest installer of each kind, also under <target>/<triple>/release/bundle', () => {
    const target = fresh()
    const native = path.join(target, 'release', 'bundle')
    const universal = path.join(target, 'universal-apple-darwin', 'release', 'bundle')
    const old = put(path.join(native, 'nsis', 'Quran_0.0.9_x64-setup.exe'), 'a')
    fs.utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1))
    put(path.join(native, 'nsis', 'Quran_0.1.0_x64-setup.exe'), 'bb')
    put(path.join(native, 'nsis', 'notes.txt'), 'c')
    put(path.join(universal, 'dmg', 'Quran_0.1.0_universal.dmg'), 'ddd')
    put(path.join(target, 'debug', 'bundle', 'deb', 'ignored.deb'), 'e')
    const dirs = defaultBundleDirs(target)
    assert.deepEqual(dirs.map((d) => path.relative(target, d)).sort(), [
      path.join('release', 'bundle'),
      path.join('universal-apple-darwin', 'release', 'bundle'),
    ])
    const found = findInstallers(dirs)
    assert.equal(path.basename(found.nsis ?? ''), 'Quran_0.1.0_x64-setup.exe')
    assert.equal(path.basename(found.dmg ?? ''), 'Quran_0.1.0_universal.dmg')
    assert.equal(found.deb, undefined)
  })

  it("reads a deb's Installed-Size", () => {
    const file = put(
      path.join(fresh(), 'q.deb'),
      deb('Package: quran\nInstalled-Size: 25600\nVersion: 0.1.0\n'),
    )
    assert.equal(debInstalledSize(file), 25600 * 1024)
    const none = put(path.join(fresh(), 'n.deb'), deb('Package: quran\n'))
    assert.equal(debInstalledSize(none), null)
  })

  it('sums the Windows install from the exe and the NSIS script', () => {
    const release = path.join(fresh(), 'release')
    put(path.join(release, 'quran-desktop.exe'), Buffer.alloc(1000))
    const core = put(path.join(release, '..', 'res', 'core.db'), Buffer.alloc(300))
    const catalog = put(path.join(release, '..', 'res', 'catalog.json'), Buffer.alloc(20))
    put(
      path.join(release, 'nsis', 'x64', 'installer.nsi'),
      `  File "\${MAINBINARYSRCPATH}"\n    File /a "/oname=data\\catalog.json" "${catalog}"\n    File /a "/oname=data\\core.db" "${core}"\n`,
    )
    assert.deepEqual(windowsInstalled(path.join(release, 'bundle')), {
      bytes: 1320,
      parts: ['quran-desktop.exe', 'data\\catalog.json', 'data\\core.db'],
    })
    assert.equal(windowsInstalled(path.join(fresh(), 'release', 'bundle')), null)
  })

  it('adds the real core.db as each format compresses it (placeholder bundles)', () => {
    const dir = fresh()
    const coreFile = put(
      path.join(dir, 'core.db'),
      Buffer.concat([Buffer.alloc(256 * 1024, 7), randomBytes(16 * 1024)]),
    )
    const core = fs.readFileSync(coreFile)
    for (const kind of /** @type {const} */ (['deb', 'dmg', 'appimage'])) {
      const { bytes, how } = compressedCore(kind, core, coreFile)
      assert.ok(bytes > 16 * 1024 && bytes < core.length, `${kind}: ${bytes} by ${how}`)
    }
    const bundle = path.join(dir, 'target', 'release', 'bundle')
    put(path.join(bundle, 'deb', 'Quran_0.1.0_amd64.deb'), deb('Installed-Size: 100\n'))
    put(path.join(bundle, 'appimage', 'Quran_0.1.0_amd64.AppImage'), Buffer.alloc(5000))
    const { measurements, problems } = measure({
      bundleDirs: [bundle],
      dist: null,
      metrics: null,
      placeholderCore: coreFile,
    })
    assert.deepEqual(problems, [])
    const byId = Object.fromEntries(measurements.map((m) => [m.id, m]))
    const debBytes = fs.statSync(path.join(bundle, 'deb', 'Quran_0.1.0_amd64.deb')).size
    assert.equal(byId.deb?.value, debBytes + compressedCore('deb', core, coreFile).bytes)
    assert.match(byId.deb?.notes?.[0] ?? '', /\+ core\.db [\d,]+ B by gzip -6/)
    assert.equal(byId.installed?.value, 100 * 1024 + core.length, 'Installed-Size + the uncompressed core.db')
    assert.equal(byId.appimage?.value, 5000 + compressedCore('appimage', core, coreFile).bytes)
  })

  it('adds core.db to an xz deb (scripts/deb-xz.mjs) as xz -6', needsXz, () => {
    const dir = fresh()
    const coreFile = put(
      path.join(dir, 'core.db'),
      Buffer.concat([Buffer.alloc(256 * 1024, 7), randomBytes(16 * 1024)]),
    )
    const core = fs.readFileSync(coreFile)
    const bundle = path.join(dir, 'target', 'release', 'bundle')
    const gz = put(path.join(bundle, 'deb', 'Quran_0.1.0_amd64.deb'), deb('Installed-Size: 100\n'))
    assert.equal(debPayload(gz), 'gzip')
    assert.equal(compressedCore('deb', core, coreFile, gz).how, 'gzip -6 (data.tar.gz)')
    fs.writeFileSync(gz, recompressDeb(fs.readFileSync(gz)) ?? Buffer.alloc(0))
    assert.equal(debPayload(gz), 'xz')
    assert.equal(debInstalledSize(gz), 100 * 1024, 'control.tar.gz is untouched')
    const extra = compressedCore('deb', core, coreFile, gz)
    assert.deepEqual(extra, { bytes: xzSize(core), how: 'xz -6 (data.tar.xz)' })
    assert.ok(extra.bytes < zlib.gzipSync(core, { level: 6 }).length)
    const { measurements } = measure({
      bundleDirs: [bundle],
      dist: null,
      metrics: null,
      placeholderCore: coreFile,
    })
    const row = measurements.find((m) => m.id === 'deb')
    assert.equal(row?.value, fs.statSync(gz).size + extra.bytes)
    assert.match(row?.notes?.[0] ?? '', /\+ core\.db [\d,]+ B by xz -6 \(data\.tar\.xz\)/)
  })

  it('measures the NSIS core.db with LZMA', (t) => {
    if (!haveLzma) return t.skip('neither 7-Zip nor xz is installed')
    const file = put(path.join(fresh(), 'core.db'), Buffer.alloc(512 * 1024, 3))
    const { bytes } = compressedCore('nsis', fs.readFileSync(file), file)
    assert.ok(bytes > 0 && bytes < 16 * 1024, `LZMA of 512 KiB of one byte value: ${bytes}`)
  })

  it('reads the runtime rows of a metrics report', () => {
    const file = put(
      path.join(fresh(), 'metrics-report.json'),
      JSON.stringify({
        format: METRICS_REPORT_FORMAT,
        build: 'debug',
        measuredAt: '2026-10-10T12:00:00Z',
        rows: {
          'cold-start': { value: 412, notes: ['spawn → first paint'] },
          rss: { value: 200 * MIB },
          'idle-cpu': { value: 'nan' },
        },
      }),
    )
    assert.deepEqual(
      readMetricsReport(file).map((m) => [m.id, m.value, m.source]),
      [
        ['cold-start', 412, 'metrics-report.json, debug build, 2026-10-10'],
        ['rss', 200 * MIB, 'metrics-report.json, debug build, 2026-10-10'],
      ],
    )
    assert.throws(() => readMetricsReport(put(path.join(fresh(), 'x.json'), '{}')), /not a qd-metrics-report/)
  })

  it('refuses a version 1 report, whose playback CPU counted the app process alone', () => {
    assert.equal(METRICS_REPORT_FORMAT, 'qd-metrics-report/2')
    const v1 = put(
      path.join(fresh(), 'metrics-report.json'),
      JSON.stringify({
        format: 'qd-metrics-report/1',
        build: 'debug',
        rows: { 'playback-cpu-1x': { value: 1.6, notes: ['app + webview 31.2 %'] } },
      }),
    )
    assert.throws(
      () => readMetricsReport(v1),
      /qd-metrics-report\/1 report: .*app process alone, not the webview/,
    )
    const { measurements, problems } = measure({
      bundleDirs: [],
      dist: null,
      metrics: v1,
      placeholderCore: null,
    })
    assert.deepEqual(measurements, [], 'no row of a superseded report is enforced')
    assert.equal(problems.length, 1, 'and the run fails on it')
  })

  it('does not measure a debug build of dist/ as the production bundle', () => {
    const prod = path.join(fresh(), 'dist')
    put(path.join(prod, 'index.html'), 'x')
    put(path.join(prod, 'assets', 'index.js'), Buffer.alloc(100))
    assert.equal(isDebugDist(prod), false)
    const debug = path.join(fresh(), 'dist')
    put(path.join(debug, 'index.html'), 'x')
    put(path.join(debug, 'assets', 'index.js'), Buffer.alloc(100))
    put(path.join(debug, 'assets', 'index.js.map'), Buffer.alloc(7 * MIB))
    assert.equal(isDebugDist(debug), true)
    const input = { bundleDirs: [], metrics: null, placeholderCore: null }
    assert.deepEqual(
      measure({ ...input, dist: prod }).measurements.map((m) => [m.id, m.value]),
      [['dist', 101]],
    )
    const skipped = measure({ ...input, dist: debug })
    assert.deepEqual(skipped.measurements, [])
    assert.deepEqual(skipped.problems, [])
    assert.match(skipped.notices.join('\n'), /holds a debug build .*`pnpm build`/)
    const required = evaluate(BUDGETS, skipped.measurements, parseRequire(['dist']))
    assert.equal(
      required.find((r) => r.budget.id === 'dist')?.status,
      'missing',
      'a required dist row still fails',
    )
  })

  it('enforces the playback CPU rows on the process tree (webview included)', () => {
    const file = put(
      path.join(fresh(), 'metrics-report.json'),
      JSON.stringify({
        format: METRICS_REPORT_FORMAT,
        build: 'debug',
        measuredAt: '2026-10-10T12:00:00Z',
        rows: {
          'playback-cpu-1x': { value: 31.2, notes: ['app 1.60 % (audio engine, IPC) + WebView2 29.60 %'] },
          'playback-cpu-1.5x': { value: 5.9 },
        },
      }),
    )
    const rows = evaluate(BUDGETS, readMetricsReport(file), new Set())
    const byId = Object.fromEntries(rows.map((r) => [r.budget.id, r]))
    assert.equal(byId['playback-cpu-1x']?.status, 'over')
    assert.equal(byId['playback-cpu-1.5x']?.status, 'ok')
    for (const id of ['rss', 'idle-cpu', 'playback-cpu-1x', 'playback-cpu-1.5x'])
      assert.match(byId[id]?.budget.what ?? '', /webview included/, id)
    assert.match(
      markdown(rows).join('\n'),
      /playback CPU at 1\.0× \(webview included\) \| ≤ 3 %.*\*\*over\*\*/,
    )
  })
})

describe('CLI', () => {
  /** @param {string[]} args */
  const quiet = (args) => {
    const log = console.log
    console.log = () => {}
    try {
      return main(args, {})
    } finally {
      console.log = log
    }
  }

  it('fails over budget or on a missing required row, passes otherwise', () => {
    const bundle = path.join(fresh(), 'bundle')
    const dist = path.join(fresh(), 'dist')
    put(path.join(dist, 'index.html'), 'x')
    put(path.join(bundle, 'nsis', 'Quran_0.1.0_x64-setup.exe'), Buffer.alloc(1024))
    const base = ['--bundle-dir', bundle, '--dist', dist]
    assert.equal(quiet(base), 0)
    assert.equal(quiet([...base, '--require', 'nsis,dist']), 0)
    assert.equal(quiet([...base, '--require', 'deb']), 1)
    assert.equal(quiet([...base, '--require', 'deb', '--report-only']), 0)
    fs.truncateSync(path.join(bundle, 'nsis', 'Quran_0.1.0_x64-setup.exe'), 8 * MIB + 1)
    assert.equal(quiet(base), 1)
    assert.equal(quiet([...base, '--require', 'bogus']), 2)
    assert.equal(quiet([...base, '--placeholder-core', path.join(bundle, 'missing.db')]), 2)
    assert.equal(quiet(['--bogus']), 2)
  })
})
