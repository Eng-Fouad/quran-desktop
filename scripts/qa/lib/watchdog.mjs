// @ts-check
// Kills a process tree when its owner dies. Windows never kills a child together with its parent, and a driver killed
// outright (a CI or orchestrator timeout, `taskkill /F`, a closed console) runs no exit handler. app-driver therefore
// starts this detached helper next to each app process, so a killed driver never leaves the app running to block the
// next run (single instance, CDP port, shared WebView2 profile).
//
//   node scripts/qa/lib/watchdog.mjs <ownerPid> <targetPid>
//
// It exits as soon as the target is gone, and kills the target's tree only while the target is still alive and the
// owner is not. Self-contained on purpose: no imports that install signal handlers.
import { spawnSync } from 'node:child_process'

const [owner, target] = process.argv.slice(2).map(Number)
if (!Number.isInteger(owner) || !Number.isInteger(target) || !owner || !target) process.exit(2)

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM'
  }
}

/** @param {number} pid */
const killTree = (pid) => {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  for (const p of [-pid, pid]) {
    try {
      process.kill(p, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}

setInterval(() => {
  if (!alive(/** @type {number} */ (target))) process.exit(0)
  if (!alive(/** @type {number} */ (owner))) {
    killTree(/** @type {number} */ (target))
    process.exit(0)
  }
}, 500)
