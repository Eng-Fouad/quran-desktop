// @ts-check
// Process-tree samples for the runtime rows of the size budgets: the CPU time and working sets of the app and of every
// process it started (WebView2's browser, renderer, GPU and utility processes). Windows only, through CIM (PowerShell),
// like Task Manager's numbers. Every runtime row counts the whole tree ("webview included"); the per-process breakdown
// (`byRole`) says where the time or the memory went. Not a scenario (the registry skips files starting with `_`);
// unit-tested in `process.test.mjs`.
import { execFileSync } from 'node:child_process'

/**
 * @typedef {{ pid: number, ppid: number, name: string, workingSet: number, privateWorkingSet: number,
 *   cpuMs: number, type: string, sub: string }} Proc
 *   `type`: Chromium's `--type=` switch (`renderer`, `gpu-process`, `utility`, … or '' for none); `sub`: its
 *   `--utility-sub-type=` (`network.mojom.NetworkService`, …)
 * @typedef {{ at: number, procs: Proc[] }} Snapshot  `at`: Date.now() in the middle of the query
 * @typedef {{ windowMs: number, treePercent: number, appPercent: number, webviewPercent: number,
 *   byRole: Record<string, number> }} CpuSample  percentages of one core
 * @typedef {{ processes: number, workingSet: number, privateWorkingSet: number, app: number,
 *   byRole: Record<string, number> }} MemorySample  bytes
 */

/**
 * Only the switches are read from a command line (a renderer's runs to kilobytes). The patterns avoid backslashes: this
 * is a JavaScript template literal.
 * @param {boolean} withPrivate also read the private working sets (a slower performance-counter query)
 */
const query = (withPrivate) => `$ErrorActionPreference = 'Stop'
$private = @{}
${withPrivate ? 'Get-CimInstance Win32_PerfRawData_PerfProc_Process | ForEach-Object { $private[[int]$_.IDProcess] = [double]$_.WorkingSetPrivate }' : ''}
Get-CimInstance Win32_Process | ForEach-Object {
  $cl = [string]$_.CommandLine
  $type = if ($cl -match '--type=([A-Za-z0-9_-]+)') { $Matches[1] } else { '' }
  $sub = if ($cl -match '--utility-sub-type=([A-Za-z0-9_.-]+)') { $Matches[1] } else { '' }
  [pscustomobject]@{
    pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name
    ws = [double]$_.WorkingSetSize; pws = [double]$private[[int]$_.ProcessId]
    cpu = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000
    type = $type; sub = $sub
  }
} | ConvertTo-Json -Compress`

/**
 * Every process on the machine (one CIM query; `withPrivate` adds the private working sets, else they are 0).
 * @param {{ withPrivate?: boolean }} [options]
 * @returns {Snapshot}
 */
export function snapshot({ withPrivate = false } = {}) {
  if (process.platform !== 'win32') throw new Error('process samples are implemented for Windows (CIM) only')
  const before = Date.now()
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', query(withPrivate)],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  )
  const after = Date.now()
  /** @type {{ pid: number, ppid: number, name: string, ws: number, pws: number, cpu: number, type?: string,
   *   sub?: string }[]} */
  const rows = JSON.parse(out)
  return {
    at: Math.round((before + after) / 2),
    procs: rows.map((r) => ({
      pid: r.pid,
      ppid: r.ppid,
      name: r.name,
      workingSet: r.ws,
      privateWorkingSet: r.pws,
      cpuMs: r.cpu,
      type: r.type ?? '',
      sub: r.sub ?? '',
    })),
  }
}

/**
 * The process `root` and all its descendants in a snapshot.
 * @param {Snapshot} snap @param {number} root @returns {Proc[]}
 */
export function tree(snap, root) {
  /** @type {Map<number, Proc[]>} */
  const children = new Map()
  for (const p of snap.procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  const self = snap.procs.find((p) => p.pid === root)
  if (!self) return []
  /** @type {Proc[]} */
  const out = []
  const stack = [self]
  /** @type {Set<number>} */
  const seen = new Set()
  while (stack.length) {
    const p = /** @type {Proc} */ (stack.pop())
    if (seen.has(p.pid)) continue
    seen.add(p.pid)
    out.push(p)
    // A child started before its parent's PID was reused would be older than the parent: CIM has no start time
    // here, so PID reuse is ignored (the app's tree lives for seconds, not for a PID wrap-around).
    for (const c of children.get(p.pid) ?? []) if (c.pid !== p.pid) stack.push(c)
  }
  return out
}

/**
 * What a process of the app's tree is: `app` (the root: the Rust side, audio engine, IPC, databases), WebView2's
 * `browser`, `renderer` and `gpu`, a utility service by its name (`network`, `storage`, `audio`, …), any other
 * Chromium process by its type, and anything else by its executable name.
 * @param {Proc} p @param {number} root
 */
export function roleOf(p, root) {
  if (p.pid === root) return 'app'
  switch (p.type) {
    case '':
      return /^msedgewebview2\.exe$/i.test(p.name) ? 'browser' : p.name
    case 'gpu-process':
      return 'gpu'
    case 'utility':
      return /^([A-Za-z0-9_]+)\.mojom\./.exec(p.sub)?.[1] ?? 'utility'
    default:
      return p.type
  }
}

/**
 * Memory of the app's tree: the sum of working sets (Task Manager's "Working set") and of private working sets
 * (Task Manager's "Memory"; shared pages counted once), with the private working sets by role.
 * @param {Snapshot} snap @param {number} root @returns {MemorySample}
 */
export function memory(snap, root) {
  const procs = tree(snap, root)
  /** @type {Record<string, number>} */
  const byRole = {}
  for (const p of procs) {
    const role = roleOf(p, root)
    byRole[role] = (byRole[role] ?? 0) + p.privateWorkingSet
  }
  return {
    processes: procs.length,
    workingSet: procs.reduce((s, p) => s + p.workingSet, 0),
    privateWorkingSet: procs.reduce((s, p) => s + p.privateWorkingSet, 0),
    app: procs.find((p) => p.pid === root)?.privateWorkingSet ?? 0,
    byRole,
  }
}

/**
 * CPU use between two snapshots, in % of one core: the whole tree (what the budgets count), the app process alone and
 * the WebView2 processes, and the tree by role. A process that started in between counts from zero; one that exited in
 * between is not in the second snapshot and is not counted.
 * @param {Snapshot} a @param {Snapshot} b @param {number} root @returns {CpuSample}
 */
export function cpu(a, b, root) {
  const ms = b.at - a.at
  if (ms <= 0) throw new Error('the snapshots are not in time order')
  const before = new Map(a.procs.map((p) => [p.pid, p.cpuMs]))
  let total = 0
  let app = 0
  /** @type {Record<string, number>} */
  const byRole = {}
  for (const p of tree(b, root)) {
    const used = Math.max(0, p.cpuMs - (before.get(p.pid) ?? 0))
    total += used
    if (p.pid === root) app = used
    const role = roleOf(p, root)
    byRole[role] = (byRole[role] ?? 0) + (used / ms) * 100
  }
  return {
    windowMs: ms,
    treePercent: (total / ms) * 100,
    appPercent: (app / ms) * 100,
    webviewPercent: ((total - app) / ms) * 100,
    byRole,
  }
}

/**
 * The shares by role, largest first, e.g. "renderer 21.3 %, gpu 8.1 %, app 1.6 %"; shares that `format` shows as
 * zero are left out.
 * @param {Record<string, number>} byRole @param {(value: number) => string} format
 */
export function describeRoles(byRole, format) {
  return (
    Object.entries(byRole)
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([role, value]) => [role, format(value)])
      .filter(([, shown]) => !/^0(\.0+)?(\s|$)/.test(shown ?? ''))
      .map(([role, shown]) => `${role} ${shown}`)
      .join(', ') || 'none'
  )
}

/**
 * Samples the CPU of the app's tree over `ms`; the window is measured between the midpoints of the two queries.
 * @param {number} root @param {number} ms @param {(ms: number) => Promise<void>} wait @returns {Promise<CpuSample>}
 */
export async function sampleCpu(root, ms, wait) {
  const a = snapshot()
  await wait(ms)
  const b = snapshot()
  return cpu(a, b, root)
}

/** The memory of the app's tree now. @param {number} root @returns {MemorySample} */
export function sampleMemory(root) {
  return memory(snapshot({ withPrivate: true }), root)
}
