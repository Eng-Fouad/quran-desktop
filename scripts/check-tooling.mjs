#!/usr/bin/env node
// check:tooling — asserts that every command named in an acceptance line resolves (ARCHITECTURE §13.1, §14.1).
//
//   node scripts/check-tooling.mjs [--strict] [--xtask] [--json] [--verbose]
//
// The command list is read from docs/ARCHITECTURE.md itself: every §14.3 "Acceptance:" line, the §14.4 definition of
// done and the §13.3 CI job table. Each backticked command is resolved:
//   pnpm <script>          the script exists in package.json (what `pnpm run` lists), and a `node <file>` it runs exists
//   pnpm exec <bin>        node_modules/.bin/<bin> exists; `vitest --project <name>` names a project in vitest.config.ts
//   cargo <sub>            <sub> is in `cargo --list` (built-ins and the .cargo/config.toml aliases); `-p <crate>` is a
//                          workspace member (`cargo metadata --no-deps`); `cargo xtask <cmd>` is checked with --xtask
//   node <file>            the file exists
//   git, rg, …             the tool is on PATH
// A file or crate that is missing is classified by the package that owns it (its "Owns:"/"Creates" list in §14.3):
// owned by a wave-0 package → FAIL (the wave-0 exit gate); owned by a later wave → "pending" (FAIL with --strict).
// Environment checks: node and pnpm versions (engines, packageManager), installed node_modules, cargo on PATH with the
// rust-toolchain.toml version, `.gitattributes` giving bindings.ts eol=lf, and (warning only) a local Edge/Chrome.
//
// Options: --strict  pending items fail too (use from wave 3 on)
//          --xtask   also build xtask and check every `cargo xtask <cmd>` against `cargo xtask --help` (slow on a fresh clone)
//          --json    machine-readable report
//          --verbose also list the items that resolved
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SPEC = join(ROOT, 'docs', 'ARCHITECTURE.md')
const isWindows = process.platform === 'win32'

const { values: opts } = parseArgs({
  options: {
    strict: { type: 'boolean', default: false },
    xtask: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
})

// ---------------------------------------------------------------------------------------------------------------------
// Results

/** @typedef {'ok' | 'warn' | 'pending' | 'fail'} Status */
/** @type {{ status: Status, subject: string, detail: string, source?: string }[]} */
const results = []
/** @param {Status} status @param {string} subject @param {string} detail @param {string} [source] */
const record = (status, subject, detail, source) => {
  const s = status === 'pending' && opts.strict ? 'fail' : status
  results.push({ status: s, subject, detail, source })
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

/** Runs a command without a shell; returns trimmed stdout, or null when it can't be run or exits non-zero. */
function run(file, args, { cwd = ROOT, shell = false } = {}) {
  const r = spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    shell,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error || r.status !== 0) return null
  return r.stdout.trim()
}

/** Finds an executable on PATH (honouring PATHEXT on Windows). */
function which(name) {
  const exts = isWindows
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())
    : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Compares dotted versions: negative when a < b. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Splits a shell command line on `&&`, `||`, `|` and `;` outside quotes, then into argv words. */
function splitCommands(line) {
  const commands = []
  let words = []
  let word = ''
  let quote = ''
  const pushWord = () => {
    if (word) words.push(word)
    word = ''
  }
  const pushCommand = () => {
    pushWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = ''
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '&' && line[i + 1] === '&') {
      pushCommand()
      i++
    } else if (c === '|' || c === ';') {
      pushCommand()
      if (line[i + 1] === '|') i++
    } else if (/\s/.test(c)) {
      pushWord()
    } else {
      word += c
    }
  }
  pushCommand()
  return commands
}

// ---------------------------------------------------------------------------------------------------------------------
// Spec parsing: packages, waves, owned paths and acceptance commands

const COMMAND_WORDS = new Set(['pnpm', 'cargo', 'node', 'git', 'rg'])

/** Joins wrapped Markdown lines so a backticked command split over two lines is read whole. */
const unwrap = (text) => text.replace(/\n[ \t]+/g, ' ')

/** Backticked spans of `text` that start (after env assignments) with a command word. */
function commandSpans(text) {
  const spans = []
  for (const m of unwrap(text).matchAll(/`([^`]+)`/g)) {
    const span = m[1].trim()
    const first = span.split(/\s+/).find((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w))
    if (first && COMMAND_WORDS.has(first)) spans.push(span)
  }
  return spans
}

/** Text between a heading line starting with `start` and the next heading of the same or higher level (fences skipped). */
function section(markdown, start) {
  const lines = markdown.split(/\r?\n/)
  const from = lines.findIndex((l) => l.startsWith(start))
  if (from < 0) return ''
  const level = start.match(/^#+/)?.[0].length ?? 3
  let fenced = false
  let to = lines.length
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trimStart().startsWith('```')) fenced = !fenced
    const heading = fenced ? null : line.match(/^(#+) /)
    if (heading && (heading[1]?.length ?? 9) <= level) {
      to = i
      break
    }
  }
  return lines.slice(from + 1, to).join('\n')
}

/** The full text of a "- Label:" bullet (continuation lines are indented). */
function bullet(block, label) {
  const m = block.match(new RegExp(`^- ${label}:([\\s\\S]*?)(?=^- |^\\*\\*WP|^#|(?![\\s\\S]))`, 'm'))
  return m ? m[1] : ''
}

/** @type {{ id: string, wave: number, owns: string, acceptance: string }[]} */
const packages = []
/** @type {{ span: string, source: string }[]} */
const specCommands = []

let spec = ''
try {
  spec = readFileSync(SPEC, 'utf8')
} catch {
  record('fail', 'docs/ARCHITECTURE.md', 'not found: the command list is read from the spec')
}

if (spec) {
  const s143 = section(spec, '### 14.3')
  let wave = 0
  let current = null
  for (const line of s143.split(/\r?\n/)) {
    const waveHeading = line.match(/^#### Wave (\d+)/)
    if (waveHeading) wave = Number(waveHeading[1])
    const pkg = line.match(/^\*\*(WP[\w-]+):/)
    if (pkg) {
      current = { id: pkg[1], wave, text: '' }
      packages.push(current)
    }
    if (current) current.text += line + '\n'
  }
  for (const p of packages) {
    // "Owns:", "Owns (frozen):" or "Owns (then hands to …):"; the bullet includes "Creates and hands over: …".
    p.owns = unwrap(bullet(p.text, 'Owns[^:\\n]*'))
    p.acceptance = bullet(p.text, 'Acceptance')
    for (const span of commandSpans(p.acceptance)) specCommands.push({ span, source: `§14.3 ${p.id}` })
    delete p.text
  }
  for (const span of commandSpans(section(spec, '### 14.4'))) specCommands.push({ span, source: '§14.4 DoD' })
  for (const span of commandSpans(section(spec, '### 13.3'))) specCommands.push({ span, source: '§13.3 CI' })
  if (!packages.length || !specCommands.length) {
    record('fail', 'docs/ARCHITECTURE.md', 'could not find the §14.3 packages or their acceptance lines')
  }
}

/** Expands `a/{b, c}.ts` into `a/b.ts`, `a/c.ts` (one level, as used in the spec's ownership lists). */
function expandBraces(pattern) {
  const m = pattern.match(/^(.*?)\{([^{}]*)\}(.*)$/)
  if (!m) return [pattern]
  return m[2].split(',').flatMap((alt) => expandBraces(`${m[1]}${alt.trim()}${m[3]}`))
}

/** The wave-earliest package whose ownership list covers `path` (exact, `dir/**`, or a brace list). */
function ownerOf(path) {
  let best = null
  for (const p of packages) {
    for (const m of p.owns.matchAll(/`([^`]+)`/g)) {
      const covers = expandBraces(m[1]).some((pattern) => {
        const pat = pattern.split(/\s+/)[0]
        if (pat.endsWith('/**')) return path.startsWith(pat.slice(0, -2))
        return pat === path
      })
      if (covers && (!best || p.wave < best.wave)) best = p
    }
  }
  return best
}

/** Records a missing file or crate according to the wave of its owner. */
function missing(subject, what, source) {
  const owner = ownerOf(subject)
  if (!owner) record('fail', subject, `${what} is missing and no §14.3 package owns it`, source)
  else if (owner.wave === 0) record('fail', subject, `${what} is missing (owner ${owner.id}, wave 0)`, source)
  else record('pending', subject, `${what} not delivered yet (owner ${owner.id}, wave ${owner.wave})`, source)
}

// ---------------------------------------------------------------------------------------------------------------------
// Environment

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const scripts = pkg.scripts ?? {}

{
  const want = String(pkg.engines?.node ?? '').match(/>=\s*([\d.]+)/)?.[1]
  const have = process.versions.node
  if (!want) record('warn', 'node', 'package.json has no engines.node ">=" range')
  else if (compareVersions(have, want) < 0)
    record('fail', 'node', `v${have} does not satisfy engines.node >=${want}`)
  else record('ok', 'node', `v${have} satisfies >=${want}`)
}

{
  const want = String(pkg.packageManager ?? '').match(/^pnpm@([\d.]+)/)?.[1]
  const fromAgent = (process.env.npm_config_user_agent ?? '').match(/pnpm\/([\d.]+)/)?.[1]
  const have = fromAgent ?? run(isWindows ? 'pnpm.cmd' : 'pnpm', ['--version'], { shell: isWindows })
  if (!want) record('fail', 'pnpm', 'package.json packageManager is not pnpm@x.y.z')
  else if (!have)
    record('fail', 'pnpm', `not found (packageManager pins pnpm@${want}; run \`corepack enable\`)`)
  else if (have.split('.')[0] !== want.split('.')[0])
    record('fail', 'pnpm', `${have} differs in major from pnpm@${want}`)
  else if (have !== want) record('warn', 'pnpm', `${have} differs from packageManager pnpm@${want}`)
  else record('ok', 'pnpm', `${have} matches packageManager`)
}

const modulesInstalled = existsSync(join(ROOT, 'node_modules', '.modules.yaml'))
record(
  modulesInstalled ? 'ok' : 'fail',
  'node_modules',
  modulesInstalled ? 'installed' : 'missing: run `pnpm i --frozen-lockfile`',
)

/** cargo: must be on PATH for the pnpm scripts; fall back to ~/.cargo/bin to keep checking. */
let cargo = which('cargo')
if (cargo) {
  record('ok', 'cargo', `on PATH (${cargo})`)
} else {
  const home = process.env.CARGO_HOME ?? join(homedir(), '.cargo')
  const fallback = join(home, 'bin', isWindows ? 'cargo.exe' : 'cargo')
  if (existsSync(fallback)) {
    cargo = fallback
    record(
      'fail',
      'cargo',
      `not on PATH (found ${fallback}); pnpm scripts that call cargo will not resolve. Add ${dirname(fallback)} to PATH`,
    )
  } else {
    record('fail', 'cargo', 'not found: install rustup (docs/DEVELOPING.md)')
  }
}

/** @type {Set<string>} */
const cargoSubcommands = new Set()
/** @type {Set<string> | null} */
let workspaceCrates = null
if (cargo) {
  const channel = readFileSync(join(ROOT, 'rust-toolchain.toml'), 'utf8').match(
    /channel\s*=\s*"([^"]+)"/,
  )?.[1]
  const version = run(cargo, ['--version'])?.match(/^cargo (\S+)/)?.[1]
  if (!version)
    record('fail', 'rust toolchain', '`cargo --version` failed (is the pinned toolchain installed?)')
  else if (channel && /^\d/.test(channel) && version !== channel)
    record('fail', 'rust toolchain', `cargo ${version} but rust-toolchain.toml pins ${channel}`)
  else
    record('ok', 'rust toolchain', `cargo ${version}${channel ? ` (rust-toolchain.toml: ${channel})` : ''}`)

  const list = run(cargo, ['--list'])
  if (list === null) record('fail', 'cargo --list', 'failed')
  for (const line of (list ?? '').split(/\r?\n/).slice(1)) {
    const name = line.trim().split(/\s+/)[0]
    if (name) cargoSubcommands.add(name)
  }
  const metadata = run(cargo, ['metadata', '--no-deps', '--format-version', '1', '--offline'])
  if (metadata === null) {
    record('fail', 'cargo metadata', 'failed: the workspace manifests do not parse')
  } else {
    try {
      workspaceCrates = new Set(
        JSON.parse(metadata).packages.map((/** @type {{ name: string }} */ p) => p.name),
      )
    } catch {
      record('fail', 'cargo metadata', 'returned invalid JSON')
    }
  }
}

if (which('git')) {
  const eol = run('git', ['check-attr', 'eol', '--', 'src/lib/ipc/bindings.ts'])
  record(
    eol?.endsWith(': lf') ? 'ok' : 'fail',
    '.gitattributes',
    eol?.endsWith(': lf')
      ? 'bindings.ts checks out with eol=lf'
      : `bindings.ts eol is not lf (${eol ?? 'git failed'})`,
  )
} else {
  record('fail', 'git', 'not on PATH (pnpm bindings:check needs it)')
}

if (isWindows) {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(
    Boolean,
  )
  const browsers = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ]
  const found = roots.flatMap((r) => browsers.map((b) => join(String(r), ...b))).find((p) => existsSync(p))
  record(
    found ? 'ok' : 'warn',
    'local browser',
    found
      ? `${found} (scripts/qa and the vitest browser project use it; no download)`
      : 'Edge/Chrome not found: scripts/qa need --channel or a Playwright browser',
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Command resolution

const vitestConfig = existsSync(join(ROOT, 'vitest.config.ts'))
  ? readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
  : ''
const vitestProjects = new Set([...vitestConfig.matchAll(/\bname:\s*['"]([\w-]+)['"]/g)].map((m) => m[1]))
const PNPM_BUILTINS = new Set([
  'i',
  'install',
  'add',
  'remove',
  'update',
  'dlx',
  'licenses',
  'why',
  'list',
  'ls',
])

const seen = new Set()
const once = (key) => (seen.has(key) ? false : (seen.add(key), true))

/** @type {Map<string, string>} xtask subcommand → first source */
const xtaskCommands = new Map()

/** Resolves a `node <file>` invocation. */
function checkNodeFile(file, source) {
  if (!file || !once(`node:${file}`)) return
  if (existsSync(join(ROOT, file))) record('ok', `node ${file}`, 'file exists', source)
  else missing(file, 'script file', source)
}

/** Resolves a binary in node_modules/.bin. */
function checkBin(bin, source) {
  if (!once(`bin:${bin}`)) return
  const ok =
    existsSync(join(ROOT, 'node_modules', '.bin', bin)) ||
    existsSync(join(ROOT, 'node_modules', '.bin', `${bin}.CMD`))
  record(ok ? 'ok' : 'fail', `pnpm exec ${bin}`, ok ? 'binary installed' : 'not in node_modules/.bin', source)
}

/** Resolves `vitest ... --project <name>`. */
function checkVitestProjects(words, source) {
  for (let i = 0; i < words.length; i++) {
    const name =
      words[i] === '--project' ? words[i + 1] : words[i]?.startsWith('--project=') ? words[i].slice(10) : null
    if (!name || !once(`vitest-project:${name}`)) continue
    const ok = vitestProjects.has(name)
    record(
      ok ? 'ok' : 'fail',
      `vitest --project ${name}`,
      ok ? 'project defined in vitest.config.ts' : 'no such project',
      source,
    )
  }
}

/** Resolves a pnpm script, including the local file it runs. */
function checkScript(name, source) {
  if (!once(`script:${name}`)) return
  const body = scripts[name]
  if (body === undefined) {
    record('fail', `pnpm ${name}`, 'no such script in package.json', source)
    return
  }
  record('ok', `pnpm ${name}`, body, source)
  for (const words of splitCommands(body)) resolveCommand(words, `script ${name}`)
}

/** Resolves `cargo <sub> [-p crate]...`. */
function checkCargo(words, source) {
  const sub = words[1]
  if (!sub || sub.startsWith('-')) return
  if (cargoSubcommands.size && once(`cargo:${sub}`)) {
    const ok = cargoSubcommands.has(sub)
    record(
      ok ? 'ok' : 'fail',
      `cargo ${sub}`,
      ok ? 'in cargo --list' : 'not a cargo subcommand or alias',
      source,
    )
  }
  if (sub === 'xtask' && words[2] && !words[2].startsWith('-') && !xtaskCommands.has(words[2])) {
    xtaskCommands.set(words[2], source)
  }
  if (!workspaceCrates) return
  for (let i = 0; i < words.length; i++) {
    const crate = words[i] === '-p' || words[i] === '--package' ? words[i + 1] : null
    if (!crate || crate.includes('<') || !once(`crate:${crate}`)) continue
    if (workspaceCrates.has(crate)) record('ok', `-p ${crate}`, 'workspace member', source)
    else
      missing(
        crate === 'quran-desktop' ? 'src-tauri/Cargo.toml' : `crates/${crate}/Cargo.toml`,
        `crate ${crate}`,
        source,
      )
  }
}

/** Resolves one argv; leading `NAME=value` environment assignments are skipped. */
function resolveCommand(argv, source) {
  const start = argv.findIndex((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w))
  if (start < 0) return
  const words = argv.slice(start)
  const [tool, ...rest] = words
  if (!tool) return
  switch (tool) {
    case 'pnpm': {
      let [first, second] = rest
      if (first === 'run' || first === 'run-script') [first, second] = [second, rest[2]]
      if (!first) return
      if (first === 'exec') {
        if (second) checkBin(second, source)
        if (second === 'vitest') checkVitestProjects(rest, source)
      } else if (!PNPM_BUILTINS.has(first)) {
        checkScript(first, source)
      }
      return
    }
    case 'cargo':
      return checkCargo(words, source)
    case 'node':
      return checkNodeFile(
        rest.find((w) => !w.startsWith('-')),
        source,
      )
    case 'vite':
    case 'vitest':
    case 'eslint':
    case 'prettier':
    case 'svelte-check':
    case 'tsc':
    case 'tauri':
    case 'playwright':
      checkBin(tool, source)
      if (tool === 'vitest') checkVitestProjects(rest, source)
      return
    default:
      if (once(`tool:${tool}`)) {
        const found = which(tool)
        // Tools outside node/pnpm/cargo are developer conveniences (e.g. rg in §14.4): warn only.
        record(
          found ? 'ok' : tool === 'git' ? 'fail' : 'warn',
          tool,
          found ? `on PATH (${found})` : 'not on PATH',
          source,
        )
      }
  }
}

for (const { span, source } of specCommands)
  for (const argv of splitCommands(span)) resolveCommand(argv, source)
// Every script must resolve too, not only those the spec names.
for (const name of Object.keys(scripts)) checkScript(name, 'package.json')

if (opts.xtask && cargo) {
  const help = run(cargo, ['xtask', '--help'])
  if (help === null) {
    record('fail', 'cargo xtask --help', 'xtask did not build or run')
  } else {
    for (const [cmd, source] of xtaskCommands) {
      const ok = new RegExp(`^\\s+${cmd}\\b`, 'm').test(help)
      record(
        ok ? 'ok' : 'fail',
        `cargo xtask ${cmd}`,
        ok ? 'listed by xtask --help' : 'not an xtask subcommand',
        source,
      )
    }
  }
} else if (xtaskCommands.size) {
  record(
    'ok',
    'cargo xtask <cmd>',
    `${xtaskCommands.size} subcommands named (${[...xtaskCommands.keys()].join(', ')}); verify with --xtask`,
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Report

const count = (s) => results.filter((r) => r.status === s).length
const failed = count('fail')
if (opts.json) {
  console.log(JSON.stringify({ ok: failed === 0, strict: opts.strict, results }, null, 2))
} else {
  const label = { ok: 'ok     ', warn: 'warn   ', pending: 'pending', fail: 'FAIL   ' }
  console.log(
    `check:tooling  ${specCommands.length} commands from docs/ARCHITECTURE.md (§13.3, §14.3, §14.4)`,
  )
  for (const r of results) {
    if (r.status === 'ok' && !opts.verbose) continue
    console.log(`  ${label[r.status]}  ${r.subject}: ${r.detail}${r.source ? `  [${r.source}]` : ''}`)
  }
  console.log(
    `${failed ? 'check:tooling FAILED' : 'check:tooling passed'}: ${count('ok')} ok, ${count('pending')} pending, ` +
      `${count('warn')} warnings, ${failed} failed${opts.verbose ? '' : ' (--verbose lists the ok items)'}`,
  )
}
process.exit(failed ? 1 : 0)
