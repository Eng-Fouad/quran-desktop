#!/usr/bin/env node
// @ts-check
// CI policy: structural checks on .github/** that keep the licensing rules and the supply-chain hygiene of the
// workflows from regressing when someone edits them later.
//
//   node .github/actions/policy/policy.mjs [--root .] [--json]
//
//   pinned-actions   every third-party `uses:` is pinned to a full commit SHA with a `# vX.Y.Z` comment; docker:// by
//                    digest
//   guarded-uploads  actions/upload-artifact is used only by .github/actions/upload, after its check-artifacts step
//   release-uploads  `gh release upload` runs only in .github/actions/release-upload, after its check-artifacts
//                    --release step; tauri-action never uploads by itself (no releaseId, tagName, workflow artifacts or
//                    plain binaries); no other release-upload action; `gh release create` makes drafts only and no
//                    workflow publishes or edits a release (a person publishes it)
//   caches           no cache path names core.db, *.db, fixtures, dev-packs, src-tauri/resources, a bundle or target/;
//                    data/cache only behind a `github.event.repository.private` condition
//   fork-guard       in a workflow triggered by pull_request, every job that builds core.db (./.github/actions/core or
//                    `build-core`) is skipped for pull requests from forks
//   triggers         no pull_request_target or workflow_run triggers (fork code with the base repository's secrets
//                    and cache scope)
//   permissions      every workflow declares top-level permissions; a pull_request workflow grants no write
//   icon             src-tauri/icons/icon.png is not Tauri's default icon
//
// Workflow files are read line by line (a small YAML subset: block mappings and sequences, block scalars, flow lists),
// which is all GitHub workflow files here use; there is no YAML dependency (dependencies are frozen).
//
// Exit codes: 0 every check passed, 1 a check failed, 2 bad usage.
import console from 'node:console'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/** sha256 of the `icon.png` that `tauri init` / create-tauri-app ship. */
export const TAURI_DEFAULT_ICON_SHA256 = '6413bfe9d546e5225fc9256a0ecec48df3a1272ea4bdc91c15b8e000222a95d3'
const UPLOAD_ACTION = '.github/actions/upload/action.yml'
const RELEASE_UPLOAD_ACTION = '.github/actions/release-upload/action.yml'
/** Actions that upload release assets themselves, bypassing the guard. */
const RELEASE_UPLOADERS =
  /^(softprops\/action-gh-release|svenstaro\/upload-release-action|actions\/upload-release-asset|ncipollo\/release-action|actions\/create-release)@/i
/** tauri-action inputs that make it upload (a release, workflow artifacts or the plain binary). */
const TAURI_ACTION_UPLOADS = ['releaseId', 'tagName', 'uploadWorkflowArtifacts', 'uploadPlainBinary']
const FORK_GUARD = 'github.event.pull_request.head.repo.full_name == github.repository'
const PRIVATE_GUARD = 'github.event.repository.private'
const QF_CACHE_PATH =
  /core\.db|\.db\b|fixtures|dev-packs|src-tauri\/resources|bundle|(^|[\s/])target(\/|\s|$)/

// ---------------------------------------------------------------------------------------------------------------------
// A line model of a workflow file.

/**
 * @typedef {{ n: number, indent: number, code: string, comment: string, scalar: boolean, dash: boolean,
 *   key: string | null, value: string, keyIndent: number }} Line
 */

/**
 * Splits a line into code and comment (a `#` that starts the line or follows whitespace, outside quotes).
 * @param {string} raw @returns {[string, string]}
 */
function splitComment(raw) {
  /** @type {string | null} */
  let quote = null
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i)
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(raw.charAt(i - 1)))) {
      return [raw.slice(0, i).trimEnd(), raw.slice(i + 1).trim()]
    }
  }
  return [raw.trimEnd(), '']
}

/** @param {string} text @returns {Line[]} */
export function parseLines(text) {
  /** @type {Line[]} */
  const out = []
  /** @type {number | null} */
  let scalarParent = null // key column of an open block scalar
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const indent = raw.length - raw.trimStart().length
    if (scalarParent !== null && (raw.trim() === '' || indent > scalarParent)) {
      out.push({
        n: i + 1,
        indent,
        code: raw.trim(),
        comment: '',
        scalar: true,
        dash: false,
        key: null,
        value: '',
        keyIndent: indent,
      })
      continue
    }
    scalarParent = null
    const [code, comment] = splitComment(raw)
    const trimmed = code.trim()
    const dash = trimmed.startsWith('- ') || trimmed === '-'
    const body = dash ? trimmed.slice(1).trimStart() : trimmed
    const keyIndent = dash ? indent + (trimmed.length - body.length) : indent
    const match = /^("[^"]*"|'[^']*'|[^\s:"'][^:]*?):(?:\s+(.*))?$/.exec(body)
    const key = match ? (match[1] ?? '').replace(/^["']|["']$/g, '') : null
    const value = match ? (match[2] ?? '').trim() : body
    if (key !== null && /^[|>][-+0-9]*$/.test(value)) scalarParent = keyIndent
    out.push({ n: i + 1, indent, code: trimmed, comment, scalar: false, dash, key, value, keyIndent })
  }
  return out
}

/**
 * The value of the key at `lines[at]`: inline, or the block scalar / nested lines below it, as text.
 * @param {Line[]} lines @param {number} at
 */
function valueOf(lines, at) {
  const line = lines[at]
  if (!line) return ''
  if (line.value && !/^[|>][-+0-9]*$/.test(line.value)) return line.value
  /** @type {string[]} */
  const parts = []
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l) break
    if (!l.scalar && l.code !== '' && l.indent <= line.keyIndent) break
    if (l.code !== '') parts.push(l.code)
  }
  return parts.join('\n')
}

/** End (exclusive) of the block that starts at `start` and contains lines indented deeper than `indent`. */
function blockEnd(/** @type {Line[]} */ lines, /** @type {number} */ start, /** @type {number} */ indent) {
  let i = start + 1
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (l && !l.scalar && l.code !== '' && l.indent <= indent) break
  }
  return i
}

/**
 * @typedef {{ start: number, end: number, keys: Map<string, number> }} Block a mapping: key → line index
 */

/** The mapping (keys at `keyIndent`) between `start` and `end`. */
function mapping(
  /** @type {Line[]} */ lines,
  /** @type {number} */ start,
  /** @type {number} */ end,
  /** @type {number} */ keyIndent,
) {
  /** @type {Map<string, number>} */
  const keys = new Map()
  for (let i = start; i < end; i++) {
    const l = lines[i]
    if (l && !l.scalar && l.key !== null && l.keyIndent === keyIndent && !keys.has(l.key)) keys.set(l.key, i)
  }
  return { start, end, keys }
}

/**
 * Every step (a sequence item whose mapping has `uses` or `run`), with its keys and `with` children.
 * @param {Line[]} lines
 * @returns {{ at: number, end: number, keys: Map<string, number>, with: Map<string, number> }[]}
 */
function steps(lines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l || l.scalar || !l.dash || l.key === null) continue
    const end = blockEnd(lines, i, l.indent)
    const { keys } = mapping(lines, i, end, l.keyIndent)
    if (!keys.has('uses') && !keys.has('run')) continue
    const withAt = keys.get('with')
    const withLine = withAt === undefined ? undefined : lines[withAt]
    /** @type {Map<string, number>} */
    let withKeys = new Map()
    if (withAt !== undefined && withLine) {
      const withEnd = blockEnd(lines, withAt, withLine.keyIndent)
      const child = lines.slice(withAt + 1, withEnd).find((c) => !c.scalar && c.key !== null)
      if (child) withKeys = mapping(lines, withAt + 1, withEnd, child.keyIndent).keys
    }
    found.push({ at: i, end, keys, with: withKeys })
  }
  return found
}

/** Top-level keys (indent 0). @param {Line[]} lines */
function topLevel(lines) {
  return mapping(lines, 0, lines.length, 0).keys
}

/**
 * The triggers of a workflow (`on:` as a string, a flow list, a block sequence or a mapping).
 * @param {Line[]} lines @returns {string[]}
 */
export function triggersOf(lines) {
  const at = topLevel(lines).get('on')
  const line = at === undefined ? undefined : lines[at]
  if (at === undefined || !line) return []
  if (line.value)
    return line.value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  const end = blockEnd(lines, at, 0)
  const child = lines.slice(at + 1, end).find((c) => !c.scalar && c.code !== '')
  if (!child) return []
  return lines
    .slice(at + 1, end)
    .filter((c) => !c.scalar && c.indent === child.indent)
    .map((c) => (c.dash ? c.code.replace(/^-\s*/, '') : (c.key ?? '')))
    .filter(Boolean)
}

/**
 * The jobs of a workflow: id, line range and job-level keys.
 * @param {Line[]} lines
 */
function jobsOf(lines) {
  const at = topLevel(lines).get('jobs')
  if (at === undefined) return []
  const end = blockEnd(lines, at, 0)
  const first = lines.slice(at + 1, end).find((c) => !c.scalar && c.key !== null)
  if (!first) return []
  return [...mapping(lines, at + 1, end, first.keyIndent).keys].map(([id, start]) => {
    const jobEnd = blockEnd(lines, start, first.keyIndent)
    const inner = lines.slice(start + 1, jobEnd).find((c) => !c.scalar && c.key !== null)
    const keys = inner ? mapping(lines, start + 1, jobEnd, inner.keyIndent).keys : new Map()
    return { id, start, end: jobEnd, keys }
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// The checks.

/** @typedef {{ name: string, title: string, problems: string[] }} Check */

/** @param {string} dir @returns {string[]} files under `dir` (recursive), sorted */
function walk(dir) {
  /** @type {string[]} */
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out.sort()
}

/**
 * Runs every check on the repository at `root`.
 * @param {string} root @param {{ defaultIconSha256?: string }} [options] (tests substitute the default icon's hash)
 * @returns {Check[]}
 */
export function runPolicy(root, { defaultIconSha256 = TAURI_DEFAULT_ICON_SHA256 } = {}) {
  const rel = (/** @type {string} */ p) => path.relative(root, p).split(path.sep).join('/')
  const workflows = walk(path.join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f))
  const actions = walk(path.join(root, '.github', 'actions')).filter((f) => /(^|[\\/])action\.ya?ml$/.test(f))
  /** @type {Map<string, Line[]>} */
  const parsed = new Map(
    [...workflows, ...actions].map((f) => [rel(f), parseLines(fs.readFileSync(f, 'utf8'))]),
  )

  /** @type {Check[]} */
  const checks = []
  const check = (/** @type {string} */ name, /** @type {string} */ title) => {
    /** @type {Check} */
    const c = { name, title, problems: [] }
    checks.push(c)
    return c.problems
  }

  const pinned = check(
    'pinned-actions',
    'third-party actions are pinned to commit SHAs (with a version comment)',
  )
  const uploads = check(
    'guarded-uploads',
    `actions/upload-artifact only through ${UPLOAD_ACTION}, after the guard`,
  )
  const releases = check(
    'release-uploads',
    `release assets only through ${RELEASE_UPLOAD_ACTION}, after check-artifacts --release; drafts only`,
  )
  const caches = check('caches', 'no QF-derived path is cached; data/cache only in a private repository')
  const fork = check('fork-guard', 'jobs that build core.db never run for pull requests from forks')
  const triggers = check('triggers', 'no pull_request_target / workflow_run triggers')
  const permissions = check(
    'permissions',
    'top-level permissions everywhere; no write in pull_request workflows',
  )
  const icon = check('icon', "src-tauri/icons/icon.png is not Tauri's default icon")

  for (const [file, lines] of parsed) {
    // Every `uses:`: steps, and jobs that call reusable workflows.
    for (const line of lines) {
      if (line.scalar || line.key !== 'uses') continue
      const uses = line.value.replace(/^["']|["']$/g, '')
      const where = `${file}:${line.n}`
      if (uses.startsWith('docker://')) {
        if (!/@sha256:[0-9a-f]{64}$/.test(uses)) pinned.push(`${where}: ${uses} is not pinned by digest`)
      } else if (!uses.startsWith('./')) {
        if (!/^[\w.-]+\/[\w.-]+(\/[^@\s]+)?@[0-9a-f]{40}$/.test(uses))
          pinned.push(`${where}: ${uses} is not pinned to a full commit SHA`)
        else if (!/^v?\d+(\.\d+)*\b/.test(line.comment))
          pinned.push(`${where}: ${uses} needs a "# vX.Y.Z" comment naming the pinned release`)
      }
    }
    for (const step of steps(lines)) {
      const usesAt = step.keys.get('uses')
      const usesLine = usesAt === undefined ? undefined : lines[usesAt]
      const uses = usesLine?.value.replace(/^["']|["']$/g, '') ?? ''
      const where = `${file}:${(usesLine ?? lines[step.at])?.n ?? '?'}`
      const runAt = step.keys.get('run')
      if (runAt !== undefined) {
        const script = valueOf(lines, runAt)
        const at = `${file}:${lines[runAt]?.n ?? '?'}`
        if (/\bgh\s+release\s+upload\b/.test(script)) {
          if (file !== RELEASE_UPLOAD_ACTION)
            releases.push(`${at}: upload release assets through ./.github/actions/release-upload instead`)
          else {
            const guard = steps(lines).find((s) => {
              const guardRun = s.keys.get('run')
              const text = guardRun === undefined ? '' : valueOf(lines, guardRun)
              return /check-artifacts\.mjs/.test(text) && /--release\b/.test(text)
            })
            if (!guard || guard.at > step.at)
              releases.push(`${at}: the check-artifacts --release step must come first`)
          }
        }
        for (const create of script.match(/\bgh\s+release\s+create\b[^\n]*(?:\\\n[^\n]*)*/g) ?? [])
          if (!/--draft\b/.test(create))
            releases.push(`${at}: gh release create without --draft (a person publishes)`)
        if (/\bgh\s+release\s+edit\b/.test(script) || /\bgh\s+api\b[^\n]*\/releases\b/.test(script))
          releases.push(
            `${at}: workflows never edit or publish a release (a person does, after the checklist)`,
          )
      }
      if (usesLine && uses) {
        if (RELEASE_UPLOADERS.test(uses))
          releases.push(`${where}: ${uses.split('@')[0]} uploads release assets unguarded`)
        if (/^tauri-apps\/tauri-action@/i.test(uses))
          for (const input of TAURI_ACTION_UPLOADS) {
            const inputAt = step.with.get(input)
            if (inputAt === undefined) continue
            const value = valueOf(lines, inputAt).replace(/^["']|["']$/g, '')
            if (input.startsWith('upload') ? value !== 'false' : value !== '')
              releases.push(
                `${where}: tauri-action \`${input}\` uploads without the guard; upload through ./.github/actions/release-upload`,
              )
          }
        if (/^actions\/upload-artifact@/.test(uses)) {
          if (file !== UPLOAD_ACTION)
            uploads.push(`${where}: upload through ./.github/actions/upload instead`)
          else {
            const guard = steps(lines).find((s) => {
              const runAt = s.keys.get('run')
              return runAt !== undefined && /check-artifacts\.mjs/.test(valueOf(lines, runAt))
            })
            if (!guard || guard.at > step.at)
              uploads.push(`${where}: the check-artifacts step must come first`)
          }
        }
        const pathAt = /^actions\/cache(\/(restore|save))?@/.test(uses)
          ? step.with.get('path')
          : /^swatinem\/rust-cache@/i.test(uses)
            ? step.with.get('cache-directories')
            : undefined
        if (pathAt !== undefined) {
          const cached = valueOf(lines, pathAt)
          if (QF_CACHE_PATH.test(cached))
            caches.push(`${where}: caches ${JSON.stringify(cached)} (QF-derived or a bundle)`)
          if (/data\/cache/.test(cached)) {
            const ifAt = step.keys.get('if')
            if (ifAt === undefined || !valueOf(lines, ifAt).includes(PRIVATE_GUARD))
              caches.push(`${where}: data/cache may be cached only under \`if: ${PRIVATE_GUARD}\``)
          }
        }
      }
    }
  }

  for (const file of workflows.map(rel)) {
    const lines = parsed.get(file) ?? []
    const on = triggersOf(lines)
    for (const t of on)
      if (t === 'pull_request_target' || t === 'workflow_run')
        triggers.push(`${file}: "${t}" runs fork code with the base repository's secrets and cache scope`)
    const top = topLevel(lines)
    const permAt = top.get('permissions')
    if (permAt === undefined) permissions.push(`${file}: declare top-level permissions (e.g. contents: read)`)
    const pullRequest = on.includes('pull_request')
    if (pullRequest) {
      for (const [i, l] of lines.entries()) {
        if (l.scalar || l.key === null) continue
        const v = l.value
        if (
          (l.key === 'permissions' && /write-all/.test(v)) ||
          (v === 'write' && isUnderPermissions(lines, i))
        )
          permissions.push(`${file}:${l.n}: a pull_request workflow must not grant write permissions`)
      }
      for (const job of jobsOf(lines)) {
        const text = lines
          .slice(job.start, job.end)
          .map((l) => l.code)
          .join('\n')
        if (!/\.\/\.github\/actions\/core\b|build-core/.test(text)) continue
        const ifAt = job.keys.get('if')
        if (ifAt === undefined || !valueOf(lines, ifAt).replace(/\s+/g, ' ').includes(FORK_GUARD))
          fork.push(`${file}: job "${job.id}" builds core.db; add \`if: … ${FORK_GUARD}\``)
      }
    }
  }

  const iconPath = path.join(root, 'src-tauri', 'icons', 'icon.png')
  if (!fs.existsSync(iconPath)) icon.push('src-tauri/icons/icon.png is missing')
  else if (createHash('sha256').update(fs.readFileSync(iconPath)).digest('hex') === defaultIconSha256)
    icon.push("src-tauri/icons/icon.png is Tauri's default icon; regenerate it from assets/brand")

  return checks
}

/** Whether the key at `lines[i]` sits inside a `permissions:` mapping. @param {Line[]} lines @param {number} i */
function isUnderPermissions(lines, i) {
  const line = lines[i]
  if (!line) return false
  for (let j = i - 1; j >= 0; j--) {
    const l = lines[j]
    if (!l || l.scalar || l.key === null || l.keyIndent >= line.keyIndent) continue
    return l.key === 'permissions'
  }
  return false
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  let values
  try {
    values = parseArgs({
      args: argv,
      options: {
        root: {
          type: 'string',
          default: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
        },
        json: { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    console.error(`policy: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  const checks = runPolicy(path.resolve(values.root))
  const failed = checks.filter((c) => c.problems.length > 0)
  if (values.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
  } else {
    console.log('policy  .github/**')
    for (const c of checks) {
      console.log(`  ${c.problems.length === 0 ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.title}`)
      for (const p of c.problems) console.log(`          ${p}`)
    }
    console.log(
      failed.length ? `policy FAILED (${failed.length} of ${checks.length} checks)` : 'policy passed',
    )
  }
  if (process.env.GITHUB_ACTIONS === 'true')
    for (const c of failed)
      for (const p of c.problems)
        console.log(`::error title=CI policy (${c.name})::${p.replace(/%/g, '%25')}`)
  return failed.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
