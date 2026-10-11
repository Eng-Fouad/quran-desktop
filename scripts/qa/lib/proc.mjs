// @ts-check
// Process plumbing for the QA drivers (WP13a): tree kills, shutdown hooks, ports and the machine-wide app lock.
// Windows is the primary target: `taskkill /T` is the only reliable way to stop a process together with its children
// (WebView2 helpers, a dev server's workers), because Windows never kills children with their parent.
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const isWindows = process.platform === 'win32'
export const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Kills a process and all of its descendants, synchronously (usable from an `exit` handler). POSIX processes must have
 * been spawned `detached` (their own process group) for the group kill to reach the children.
 * @param {number | undefined} pid
 */
export function killTree(pid) {
  if (!pid) return
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      /* already gone, or not a group leader */
    }
  }
}

/** Whether a process exists (signal 0 checks without signalling; EPERM still means it exists). */
export function isPidAlive(/** @type {number} */ pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM'
  }
}

/**
 * PIDs of running processes with this executable name (`quran-desktop.exe`), excluding `exceptPids`.
 * @param {string} imageName
 * @param {number[]} [exceptPids]
 * @returns {number[]}
 */
export function findProcesses(imageName, exceptPids = []) {
  const listing = isWindows
    ? spawnSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      }).stdout
    : spawnSync('pgrep', ['-x', imageName.replace(/\.exe$/i, '')], { encoding: 'utf8' }).stdout
  // tasklist CSV rows: "quran-desktop.exe","1234","Console","1","123,456 K"; pgrep: one PID per line.
  return (listing ?? '')
    .split(/\r?\n/)
    .map((line) => (isWindows ? /^"[^"]*","(\d+)"/.exec(line)?.[1] : line.trim()))
    .filter((x) => x !== undefined && /^\d+$/.test(x))
    .map(Number)
    .filter((pid) => !exceptPids.includes(pid))
}

/** @typedef {() => Promise<void> | void} Cleanup */
/** @type {Set<Cleanup>} */
const cleanups = new Set()
/** @type {Set<() => void>} */
const syncCleanups = new Set()
let shuttingDown = false

/**
 * Registers an async cleanup that runs on `runCleanups()` and on SIGINT/SIGTERM/SIGHUP/SIGBREAK (Ctrl+C or a closed
 * console). Returns the unregister function.
 * @param {Cleanup} fn
 */
export function onShutdown(fn) {
  cleanups.add(fn)
  return () => cleanups.delete(fn)
}

/**
 * Registers a synchronous last-resort cleanup for `process.on('exit')` (kills child trees, removes lock files even
 * when the driver crashes). Returns the unregister function.
 * @param {() => void} fn
 */
export function onExitSync(fn) {
  syncCleanups.add(fn)
  return () => syncCleanups.delete(fn)
}

/** Runs every registered async cleanup (newest first), each bounded to 10 s; errors are reported, never thrown. */
export async function runCleanups() {
  const list = [...cleanups].reverse()
  cleanups.clear()
  for (const fn of list) {
    try {
      await Promise.race([fn(), sleep(10_000)])
    } catch (e) {
      console.error(`[qa] cleanup failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

process.on('exit', () => {
  for (const fn of [...syncCleanups].reverse()) {
    try {
      fn()
    } catch {
      /* best effort while exiting */
    }
  }
})

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'])) {
  try {
    process.on(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      console.error(`\n[qa] ${signal}: stopping…`)
      void runCleanups().finally(() => process.exit(130))
    })
  } catch {
    /* the signal does not exist on this platform */
  }
}

/**
 * Whether `port` can be bound on `host` right now.
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/**
 * The first free port in `from..=to`, or null.
 * @param {number} from
 * @param {number} to
 */
export async function findFreePort(from, to) {
  for (let port = from; port <= to; port++) if (await isPortFree(port)) return port
  return null
}

/**
 * A machine-wide lock file (`<tmp>/quran-desktop-qa/<name>.lock`) holding the owner's PID. A lock whose owner is gone
 * is stale and taken over. `acquire` polls until `timeoutMs`; `release` (also run on exit) removes it if still ours.
 */
export class FileLock {
  /** @param {string} name */
  constructor(name) {
    this.file = join(tmpdir(), 'quran-desktop-qa', `${name}.lock`)
    this.held = false
    /** @type {(() => void) | null} */
    this.unregister = null
  }

  /** @returns {{ pid: number, started: string, what: string } | null} */
  owner() {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * @param {string} what
   * @returns {boolean}
   */
  tryAcquire(what) {
    mkdirSync(dirname(this.file), { recursive: true })
    try {
      const fd = openSync(this.file, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), what }))
      closeSync(fd)
      this.held = true
      this.unregister = onExitSync(() => this.release())
      return true
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e
      const owner = this.owner()
      // Unreadable (being written) or alive: busy. Dead owner: stale, take it over.
      if (owner && !isPidAlive(owner.pid)) {
        rmSync(this.file, { force: true })
        return this.tryAcquire(what)
      }
      return false
    }
  }

  /**
   * @param {string} what  shown to the other drivers waiting for the lock
   * @param {number} timeoutMs
   * @param {(owner: { pid: number, started: string, what: string } | null) => void} [onWait]  called every 30 s while waiting
   */
  async acquire(what, timeoutMs, onWait) {
    const deadline = Date.now() + timeoutMs
    let nextNotice = Date.now()
    while (!this.tryAcquire(what)) {
      if (Date.now() >= deadline) {
        const owner = this.owner()
        throw new Error(
          `timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${this.file}` +
            (owner ? ` (held by PID ${owner.pid} since ${owner.started}: ${owner.what})` : ''),
        )
      }
      if (onWait && Date.now() >= nextNotice) {
        onWait(this.owner())
        nextNotice = Date.now() + 30_000
      }
      await sleep(1000)
    }
  }

  release() {
    if (!this.held) return
    this.held = false
    this.unregister?.()
    this.unregister = null
    if (this.owner()?.pid === process.pid) rmSync(this.file, { force: true })
  }
}
