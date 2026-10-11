// @ts-check
// Run results and the HTML report (§12.6; WP13a). Each scenario writes `<out>/<id>.json`; `index.html` and
// `metrics.json` are then rebuilt from every result file in the directory, so runs of different packages that share
// `artifacts/shots/web` (on different ports, at the same time) add to one report instead of overwriting each other.
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export const RESULT_FORMAT = 'qd-qa-result/1'

/** @typedef {'passed' | 'failed' | 'pending'} Status */
/**
 * @typedef {object} ScenarioResult
 * @property {string} format
 * @property {string} id
 * @property {string | null} file
 * @property {'web' | 'app'} mode
 * @property {Status} status
 * @property {string} startedAt
 * @property {number} durationMs
 * @property {{ window: [number, number], ui: string | null, theme: string | null, mode: string, description: string | null }} meta
 * @property {import('../../../tests/e2e/lib/types').BootInfo | null} boot
 * @property {string[]} shots           image file names, relative to the result's directory
 * @property {string[]} errors
 * @property {string[]} warnings
 * @property {string[]} console         printable console lines (errors and warnings, or all with --verbose)
 * @property {import('../../../tests/e2e/lib/types').QdTestMetrics | null} metrics
 * @property {import('./images.mjs').BaselineResult[]} baselines
 * @property {string | null} pendingReason
 * @property {string | null} appLog      the tail of the app's stdout/stderr (app mode, failures and --verbose)
 */

const sleepSync = (/** @type {number} */ ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Writes a file through a temporary name and a rename, retrying while another process holds the target (Windows).
 * @param {string} file
 * @param {string} content
 */
export function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, content)
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file)
      return
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(tmp, { force: true })
        throw e
      }
      sleepSync(50)
    }
  }
}

/**
 * @param {string} outDir
 * @param {ScenarioResult} result
 */
export function writeResult(outDir, result) {
  writeAtomic(join(outDir, `${result.id}.json`), `${JSON.stringify(result, null, 2)}\n`)
}

/**
 * Every result file in `outDir` (other JSON files are ignored).
 * @param {string} outDir
 * @returns {ScenarioResult[]}
 */
export function readResults(outDir) {
  /** @type {ScenarioResult[]} */
  const results = []
  for (const f of readdirSync(outDir)) {
    if (!f.endsWith('.json') || f === 'metrics.json') continue
    try {
      const r = JSON.parse(readFileSync(join(outDir, f), 'utf8'))
      if (r && r.format === RESULT_FORMAT) results.push(r)
    } catch {
      /* a file being written by a concurrent run, or not ours */
    }
  }
  return results.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true, sensitivity: 'base' }))
}

/**
 * Rebuilds `metrics.json` ({ id: metrics }) and `index.html` from the result files in `outDir`.
 * @param {string} outDir
 * @param {string} title
 */
export function writeIndex(outDir, title) {
  const results = readResults(outDir)
  /** @type {Record<string, unknown>} */
  const metrics = {}
  for (const r of results) if (r.metrics) metrics[r.id] = { ...r.metrics, startedAt: r.startedAt }
  writeAtomic(join(outDir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`)
  writeAtomic(join(outDir, 'index.html'), renderHtml(outDir, title, results))
}

/** @param {unknown} s */
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      /** @type {Record<string, string>} */ ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] ?? c,
  )

/** @param {string} p */
const href = (p) => p.split(/[\\/]/).map(encodeURIComponent).join('/')

/**
 * @param {string} outDir
 * @param {string} title
 * @param {ScenarioResult[]} results
 */
function renderHtml(outDir, title, results) {
  const count = (/** @type {Status} */ s) => results.filter((r) => r.status === s).length
  const rows = results
    .map((r) => {
      const baselines = new Map(r.baselines.map((b) => [b.shot, b]))
      const shots = r.shots
        .map((s) => {
          const b = baselines.get(s)
          const badge = b
            ? `<span class="b b-${esc(b.status)}">${esc(b.status)}${
                b.diffRatio !== null ? ` ${(b.diffRatio * 100).toFixed(2)} %` : ''
              }</span>`
            : ''
          const diff = b?.diff ? ` · <a href="${href(relative(outDir, b.diff))}">diff</a>` : ''
          return `<figure><a href="${href(s)}"><img src="${href(s)}" alt="${esc(s)}" loading="lazy"></a>
            <figcaption>${esc(s)} ${badge}${diff}</figcaption></figure>`
        })
        .join('')
      const list = (/** @type {string} */ cls, /** @type {string[]} */ items) =>
        items.length ? `<ul class="${cls}">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''
      const details = [
        r.pendingReason ? `<p class="pending-reason">Pending: ${esc(r.pendingReason)}</p>` : '',
        list('errors', r.errors),
        list('warnings', r.warnings),
        r.console.length
          ? `<details><summary>Console (${r.console.length})</summary><pre>${esc(r.console.join('\n'))}</pre></details>`
          : '',
        r.metrics
          ? `<details><summary>Metrics</summary><pre>${esc(JSON.stringify(r.metrics, null, 2))}</pre></details>`
          : '',
        r.appLog ? `<details><summary>App log</summary><pre>${esc(r.appLog)}</pre></details>` : '',
      ].join('')
      const m = r.meta
      return `<section class="scenario s-${esc(r.status)}" id="${esc(r.id)}">
        <header><h2>${esc(r.id)}</h2><span class="status">${esc(r.status)}</span>
          <span class="dim">${esc(m.window.join('×'))}${m.ui ? ` · ${esc(m.ui)}` : ''}${
            m.theme ? ` · ${esc(m.theme)}` : ''
          } · ${(r.durationMs / 1000).toFixed(1)} s · ${esc(new Date(r.startedAt).toLocaleString('en-GB'))}${
            r.boot?.hook === 'harness' ? ' · hooks installed by the harness' : ''
          }</span></header>
        ${m.description ? `<p class="dim">${esc(m.description)}</p>` : ''}
        ${details}
        <div class="shots">${shots}</div>
      </section>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f5ef; --fg: #1d1b16; --dim: #6b665a; --card: #fff; --line: #e2ddd0;
    --pass: #1e7a46; --fail: #b3261e; --pend: #9a6700; }
  @media (prefers-color-scheme: dark) { :root { --bg: #15140f; --fg: #ece8dd; --dim: #a39d8f; --card: #1f1d17;
    --line: #34312a; --pass: #5cc98a; --fail: #ff8a80; --pend: #f2c14e; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1280px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 0; }
  .summary { color: var(--dim); margin-bottom: 20px; }
  .scenario { background: var(--card); border: 1px solid var(--line); border-inline-start: 4px solid var(--dim);
    border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; }
  .s-passed { border-inline-start-color: var(--pass); } .s-failed { border-inline-start-color: var(--fail); }
  .s-pending { border-inline-start-color: var(--pend); }
  header { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; }
  .status { font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: .04em; }
  .s-passed .status { color: var(--pass); } .s-failed .status { color: var(--fail); } .s-pending .status { color: var(--pend); }
  .dim { color: var(--dim); }
  .errors li { color: var(--fail); } .warnings li { color: var(--pend); } .pending-reason { color: var(--pend); }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; max-height: 360px; overflow: auto;
    background: var(--bg); padding: 8px; border-radius: 6px; }
  .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin-top: 8px; }
  figure { margin: 0; } img { width: 100%; height: auto; border: 1px solid var(--line); border-radius: 4px; }
  figcaption { font-size: 12px; color: var(--dim); overflow-wrap: anywhere; }
  .b { font-size: 11px; padding: 0 6px; border-radius: 10px; border: 1px solid currentColor; }
  .b-changed, .b-size { color: var(--fail); } .b-same { color: var(--pass); } .b-new, .b-updated { color: var(--dim); }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="summary">${results.length} scenario${results.length === 1 ? '' : 's'}: ${count('passed')} passed,
  ${count('failed')} failed, ${count('pending')} pending · rebuilt ${esc(new Date().toLocaleString('en-GB'))}</p>
${rows || '<p class="dim">No results yet.</p>'}
</main>
</body>
</html>
`
}
