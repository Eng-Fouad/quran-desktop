// @ts-check
// node --test tests/e2e/metrics/*.test.mjs
// The process-tree arithmetic behind the runtime rows of the size budgets (`_process.mjs`), on synthetic CIM snapshots:
// every row counts the app and its WebView2 processes, and the breakdown names them.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cpu, describeRoles, memory, roleOf, tree } from './_process.mjs'

/** @typedef {import('./_process.mjs').Proc} Proc */

const APP = 100
const MIB = 1024 * 1024

/**
 * @param {number} pid @param {number} ppid @param {string} name @param {number} cpuMs
 * @param {{ type?: string, sub?: string, pws?: number }} [extra]
 * @returns {Proc}
 */
const proc = (pid, ppid, name, cpuMs, { type = '', sub = '', pws = 0 } = {}) => ({
  pid,
  ppid,
  name,
  cpuMs,
  type,
  sub,
  workingSet: 2 * pws,
  privateWorkingSet: pws,
})
const WEBVIEW = 'msedgewebview2.exe'

/** The app, its WebView2 tree, and an unrelated Edge renderer. @param {Record<number, number>} cpuMs */
const procs = (cpuMs) => [
  proc(1, 0, 'explorer.exe', cpuMs[1] ?? 0),
  proc(APP, 1, 'quran-desktop.exe', cpuMs[APP] ?? 0, { pws: 26 * MIB }),
  proc(200, APP, WEBVIEW, cpuMs[200] ?? 0, { pws: 40 * MIB }),
  proc(201, 200, WEBVIEW, cpuMs[201] ?? 0, { type: 'gpu-process', pws: 120 * MIB }),
  proc(202, 200, WEBVIEW, cpuMs[202] ?? 0, {
    type: 'utility',
    sub: 'network.mojom.NetworkService',
    pws: 10 * MIB,
  }),
  proc(203, 200, WEBVIEW, cpuMs[203] ?? 0, { type: 'renderer', pws: 250 * MIB }),
  proc(204, 200, WEBVIEW, cpuMs[204] ?? 0, { type: 'crashpad-handler', pws: 2 * MIB }),
  proc(300, 1, 'msedge.exe', cpuMs[300] ?? 0, { type: 'renderer', pws: 500 * MIB }),
]

describe('the app process tree', () => {
  it('holds the app and every WebView2 process it started, nothing else', () => {
    const pids = tree({ at: 0, procs: procs({}) }, APP).map((p) => p.pid)
    assert.deepEqual(pids.sort(), [APP, 200, 201, 202, 203, 204])
    assert.deepEqual(tree({ at: 0, procs: procs({}) }, 999), [], 'a root that is gone has no tree')
  })

  it('names each process by its role', () => {
    const roles = tree({ at: 0, procs: procs({}) }, APP).map((p) => [p.pid, roleOf(p, APP)])
    assert.deepEqual(Object.fromEntries(roles), {
      [APP]: 'app',
      200: 'browser',
      201: 'gpu',
      202: 'network',
      203: 'renderer',
      204: 'crashpad-handler',
    })
    assert.equal(roleOf(proc(5, APP, 'conhost.exe', 0), APP), 'conhost.exe')
    assert.equal(roleOf(proc(6, 200, WEBVIEW, 0, { type: 'utility' }), APP), 'utility')
  })
})

describe('CPU between two snapshots', () => {
  const a = { at: 1000, procs: procs({ [APP]: 5000, 200: 800, 201: 9000, 203: 20000, 300: 0 }) }
  // 10 s later: the app used 0.2 s, the webview 3 s (browser 0.1 s, GPU 0.9 s, renderer 2 s), and a new utility
  // process 0.05 s from its start; the unrelated Edge renderer's 9 s is not the app's.
  const b = {
    at: 11_000,
    procs: procs({ [APP]: 5200, 200: 900, 201: 9900, 202: 50, 203: 22_000, 300: 9000 }),
  }

  it('counts the app and its webview: the playback and idle rows are the tree', () => {
    const s = cpu(a, b, APP)
    assert.equal(s.windowMs, 10_000)
    assert.ok(Math.abs(s.treePercent - 32.5) < 1e-9, `tree ${s.treePercent}`)
    assert.ok(Math.abs(s.appPercent - 2) < 1e-9, `app ${s.appPercent}`)
    assert.ok(Math.abs(s.webviewPercent - 30.5) < 1e-9, `webview ${s.webviewPercent}`)
    assert.ok(Math.abs(s.treePercent - s.appPercent - s.webviewPercent) < 1e-9)
  })

  it('breaks the tree down by role, and a process started in between counts from zero', () => {
    const s = cpu(a, b, APP)
    const rounded = Object.fromEntries(
      Object.entries(s.byRole).map(([k, v]) => [k, Math.round(v * 100) / 100]),
    )
    assert.deepEqual(rounded, {
      app: 2,
      browser: 1,
      gpu: 9,
      network: 0.5,
      renderer: 20,
      'crashpad-handler': 0,
    })
    assert.equal(
      describeRoles(s.byRole, (v) => `${v.toFixed(1)} %`),
      'renderer 20.0 %, gpu 9.0 %, app 2.0 %, browser 1.0 %, network 0.5 %',
    )
  })

  it('refuses snapshots out of order', () => {
    assert.throws(() => cpu(b, a, APP), /not in time order/)
  })
})

describe('memory', () => {
  it('sums the private working sets of the tree, by role', () => {
    const m = memory({ at: 0, procs: procs({}) }, APP)
    assert.equal(m.processes, 6)
    assert.equal(m.privateWorkingSet, (26 + 40 + 120 + 10 + 250 + 2) * MIB)
    assert.equal(m.workingSet, 2 * m.privateWorkingSet)
    assert.equal(m.app, 26 * MIB)
    assert.equal(m.byRole.renderer, 250 * MIB)
    assert.equal(
      describeRoles(m.byRole, (v) => `${Math.round(v / MIB)} MiB`),
      'renderer 250 MiB, gpu 120 MiB, browser 40 MiB, app 26 MiB, network 10 MiB, crashpad-handler 2 MiB',
    )
  })
})
