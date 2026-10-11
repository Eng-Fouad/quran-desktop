// @ts-check
// node --test tests/e2e/lib/*.test.mjs scripts/qa/lib/*.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { PNG } from 'pngjs'
import { intOption, parseCli, regexOptions, UsageError, viewportOption } from './cli.mjs'
import { ConsoleLog, levelOf } from './console-log.mjs'
import { blankness, compareBaseline } from './images.mjs'
import { FileLock, findFreePort, isPidAlive, isPortFree } from './proc.mjs'
import { readResults, RESULT_FORMAT, writeIndex, writeResult } from './report.mjs'
import { removeStaleOutputs, shotBase } from './runner.mjs'

const root = mkdtempSync(join(tmpdir(), 'qd-qa-harness-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

/**
 * A width×height PNG filled with one colour, with `odd` pixels changed.
 * @param {number} width @param {number} height @param {number} [odd]
 */
function png(width, height, odd = 0) {
  const p = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    const v = i < odd ? 0 : 200
    p.data[i * 4] = v
    p.data[i * 4 + 1] = v
    p.data[i * 4 + 2] = v
    p.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(p)
}

describe('cli', () => {
  const options = /** @type {const} */ ({
    serve: { type: 'string' },
    only: { type: 'string', multiple: true },
    strict: { type: 'boolean' },
  })

  it('keeps the last value of a repeated option and ignores a bare --', () => {
    const v = parseCli(
      ['--serve', '1520', '--', '--only', 'S19', '--serve', '1648', '--only', 'S20'],
      options,
    )
    assert.equal(v.serve, '1648')
    assert.deepEqual(v.only, ['S19', 'S20'])
  })

  it('rejects unknown flags and positionals', () => {
    assert.throws(() => parseCli(['--bogus'], options), UsageError)
    assert.throws(() => parseCli(['S19'], options), UsageError)
  })

  it('validates numbers, viewports and regexes', () => {
    assert.equal(intOption(undefined, 'jobs', 1, 4, 1), 1)
    assert.equal(intOption('3', 'jobs', 1, 4, 1), 3)
    assert.throws(() => intOption('5', 'jobs', 1, 4, 1), /--jobs must be an integer in 1–4/)
    assert.throws(() => intOption('2.5', 'jobs', 1, 4, 1), UsageError)
    assert.deepEqual(viewportOption('1024', '700'), [1024, 700])
    assert.equal(viewportOption(undefined, undefined), null)
    assert.throws(() => viewportOption('1024', undefined), /go together/)
    assert.ok(regexOptions(['^a+$'])[0]?.test('aaa'))
    assert.throws(() => regexOptions(['(']), /invalid regular expression/)
  })
})

describe('console log', () => {
  it('maps console types to levels', () => {
    assert.equal(levelOf('assert'), 'error')
    assert.equal(levelOf('warning'), 'warning')
    assert.equal(levelOf('verbose'), 'debug')
    assert.equal(levelOf('table'), 'log')
  })

  it('fails on page and console errors that no pattern allows', () => {
    const log = new ConsoleLog({ allow: [/^expected/] })
    log.add('error', 'expected noise')
    log.add('error', 'real problem', 'http://x/a.js:3')
    log.add('pageerror', 'TypeError: boom\n    at f (x.js:1)')
    log.add('warning', 'careful')
    log.add('info', 'fyi')
    assert.deepEqual(
      log.failures.map((f) => f.text),
      ['real problem', 'TypeError: boom\n    at f (x.js:1)'],
    )
    log.allow(/real/)
    assert.equal(log.failures.length, 1)
    assert.equal(log.warnings.length, 1)
    assert.deepEqual(log.lines(), [
      '[error, allowed] expected noise',
      '[error, allowed] real problem (http://x/a.js:3)',
      '[pageerror] TypeError: boom\n    at f (x.js:1)',
      '[warning] careful',
    ])
    assert.equal(log.lines(true).length, 5)
  })
})

describe('screenshot names and stale outputs', () => {
  it('prefixes shot names with the scenario id', () => {
    assert.equal(shotBase('S26', undefined), 'S26')
    assert.equal(shotBase('S26', 'S26'), 'S26')
    assert.equal(shotBase('S26', 'dock'), 'S26-dock')
    assert.equal(shotBase('S26', 'S26-dock'), 'S26-dock')
    assert.throws(() => shotBase('S26', '../x'), /invalid screenshot name/)
    assert.throws(() => shotBase('S26', 'a/b'), /invalid screenshot name/)
  })

  it("removes a scenario's previous outputs and keeps everyone else's", () => {
    const out = join(root, 'stale')
    mkdirSync(join(out, 'diff'), { recursive: true })
    const files = [
      'S1.png',
      'S1-dock.png',
      'S1.json',
      'S1-b.png',
      'S1-b-x.png',
      'S1-b.json',
      'S10.png',
      'S1.txt',
      'index.html',
    ]
    for (const f of files) writeFileSync(join(out, f), 'x')
    writeFileSync(join(out, 'diff', 'S1.png'), 'x')
    removeStaleOutputs(out, 'S1', ['S1', 'S1-b', 'S10'])
    assert.deepEqual(readdirSync(out).sort(), [
      'S1-b-x.png',
      'S1-b.json',
      'S1-b.png',
      'S1.txt',
      'S10.png',
      'diff',
      'index.html',
    ])
    assert.deepEqual(readdirSync(join(out, 'diff')), [])
  })
})

describe('images', () => {
  it('detects blank screenshots', () => {
    assert.deepEqual(blankness(png(4, 3)), { blank: true, color: 'rgba(200, 200, 200, 255)' })
    assert.equal(blankness(png(4, 3, 1)).blank, false)
  })

  it('compares with baselines: new, same, changed, size, updated', () => {
    const out = join(root, 'img')
    const baselines = join(out, 'baselines')
    mkdirSync(out, { recursive: true })
    const shot = join(out, 'S01.png')
    writeFileSync(shot, png(100, 100))
    assert.equal(compareBaseline(shot, baselines, join(out, 'diff')).status, 'new')
    assert.equal(compareBaseline(shot, baselines, join(out, 'diff'), { update: true }).status, 'updated')
    assert.ok(existsSync(join(baselines, 'S01.png')))

    writeFileSync(shot, png(100, 100, 40)) // 0.4 % differ: within 0.5 %
    const same = compareBaseline(shot, baselines, join(out, 'diff'))
    assert.equal(same.status, 'same')
    assert.equal(same.diffRatio, 0.004)

    writeFileSync(shot, png(100, 100, 60)) // 0.6 %
    const changed = compareBaseline(shot, baselines, join(out, 'diff'))
    assert.equal(changed.status, 'changed')
    assert.ok(changed.diff && existsSync(changed.diff))

    writeFileSync(shot, png(50, 100))
    assert.equal(compareBaseline(shot, baselines, join(out, 'diff')).status, 'size')
  })
})

describe('report', () => {
  it('writes results and rebuilds the index and metrics from every result file', () => {
    const out = join(root, 'report')
    mkdirSync(out, { recursive: true })
    /** @type {import('./report.mjs').ScenarioResult} */
    const base = {
      format: RESULT_FORMAT,
      id: 'S02',
      file: null,
      mode: 'web',
      status: 'passed',
      startedAt: new Date(0).toISOString(),
      durationMs: 1234,
      meta: { window: [1600, 1000], ui: 'ar', theme: null, mode: 'web', description: '<b>bold</b>' },
      boot: { fatal: null, hook: 'harness' },
      shots: ['S02.png'],
      errors: [],
      warnings: [],
      console: [],
      metrics: null,
      baselines: [],
      pendingReason: null,
      appLog: null,
    }
    writeResult(out, base)
    writeResult(out, {
      ...base,
      id: 'S10',
      status: 'failed',
      errors: ['x < y & "z"'],
      metrics: {
        cls: 0,
        longTasks: 0,
        pageRenderMs: [3],
        glideFps: 0,
        glideMaxFrameMs: 0,
        cspViolations: 0,
        windowMs: 9,
        pageCacheSize: 6,
        qcfFontFaces: { v2: 6 },
      },
    })
    writeFileSync(join(out, 'other.json'), '{"not":"ours"}')
    writeFileSync(join(out, 'broken.json'), '{')
    assert.deepEqual(
      readResults(out).map((r) => r.id),
      ['S02', 'S10'],
    )
    writeIndex(out, 'QA <test>')
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    assert.match(html, /<title>QA &lt;test&gt;<\/title>/)
    assert.match(html, /x &lt; y &amp; &quot;z&quot;/)
    assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/)
    assert.match(html, /2 scenarios: 1 passed,\s+1 failed, 0 pending/)
    assert.match(html, /hooks installed by the harness/)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(out, 'metrics.json'), 'utf8'))), ['S10'])
    assert.ok(!readdirSync(out).some((f) => f.endsWith('.tmp')))
  })
})

describe('processes, ports and the lock', () => {
  it('finds free ports and notices busy ones', async () => {
    const port = await findFreePort(43000, 43100)
    assert.ok(port !== null)
    const server = createServer()
    await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(undefined)))
    try {
      assert.equal(await isPortFree(/** @type {number} */ (port)), false)
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    }
    assert.equal(await isPortFree(/** @type {number} */ (port)), true)
  })

  it('tells live processes from dead ones', async () => {
    assert.ok(isPidAlive(process.pid))
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const pid = /** @type {number} */ (child.pid)
    await new Promise((resolve) => child.once('exit', resolve))
    assert.equal(isPidAlive(pid), false)
  })

  it('holds the lock exclusively and takes over a stale one', async () => {
    const name = `test-${process.pid}`
    const a = new FileLock(name)
    const b = new FileLock(name)
    try {
      assert.ok(a.tryAcquire('a'))
      assert.equal(b.tryAcquire('b'), false)
      await assert.rejects(b.acquire('b', 50), /timed out after 0 s waiting for .* \(held by PID \d+/)
      a.release()
      assert.ok(b.tryAcquire('b'))
      b.release()

      // A lock left by a process that no longer exists.
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
      await new Promise((resolve) => child.once('exit', resolve))
      mkdirSync(join(a.file, '..'), { recursive: true })
      writeFileSync(a.file, JSON.stringify({ pid: child.pid, started: 'then', what: 'dead' }))
      assert.ok(a.tryAcquire('a'))
      assert.equal(a.owner()?.pid, process.pid)
    } finally {
      a.release()
      b.release()
    }
    assert.equal(existsSync(a.file), false)
  })
})
