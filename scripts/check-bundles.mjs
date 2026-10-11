#!/usr/bin/env node
// @ts-check
// check-bundles: what the release installers contain (WP13b; ARCHITECTURE §13.4, §13.5, §2.4; WP6b/WP6d requests).
//
//   node scripts/check-bundles.mjs --core placeholder|qul [--bundle-dir <dir>]... [--require <kinds>] [--universal]
//                                  [--arch x64|arm64] [--signed] [--webview <mode>] [--manifest <file>] [--json]
//
// Every installer found under the bundle directories (default: every <target>/release/bundle and
// <target>/<triple>/release/bundle) is unpacked with the platform's own tool and checked. Every binary must be built
// for --arch (default: this machine's): a PE or ELF machine, or the slices of a Mach-O (lipo).
//   nsis      tauri's NSIS script (product, identifier, current-user install, WebView2 bootstrapper, the app icon on
//             the setup and uninstall executables, the files it packs) and, with 7-Zip, the unpacked installer:
//             quran-desktop.exe, data/core.db, data/catalog.json
//   dmg       hdiutil (macOS): Quran.app with the identifier, executable, minimum macOS 13.3, the resources, a
//             universal binary (--universal), a valid code signature with the hardened runtime (ad-hoc or Developer
//             ID), and the /Applications link
//   deb       read here (ar + tar.gz): Package/Version/Architecture, Depends (libayatana-appindicator3-1 or
//             libappindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0, ALSA), /usr/bin/quran-desktop, the resources,
//             /usr/share/applications/Quran.desktop (the MPRIS DesktopEntry WP6d pinned) and one hicolor icon per
//             configured PNG
//   appimage  --appimage-extract (Linux): the binary, the resources, the desktop entry and the bundled appindicator
//   portable  the zips of scripts/make-portable.mjs (bundle/portable/): on Windows `Quran/` with quran-desktop.exe and
//             data/core.db, data/catalog.json (tar, which reads zip); on macOS Quran.app, checked as in the dmg (ditto)
// --signed requires a valid Authenticode signature on Windows (the setup, the portable exe) and a Developer ID one on
// macOS; without it the signature is only reported. --webview names the WebView2 install mode the NSIS script must
// carry when it differs from the config's: `offlineInstaller` for the Microsoft Store's installer (release.yml).
// --core: `placeholder` (CI, §13.3) expects build.rs's 0-byte core.db in every bundle; `qul` (release, §13.4) expects
// a real core.db (> 1 MiB, the core tables, meta.source = 'qul'). Everything unpacked also passes check-artifacts'
// release rules (no QF-derived file, no qdc database, no fixtures or fonts).
//
// --manifest writes a `qd-bundle-check/1` file listing every installer with its size and SHA-256 and whether it passed;
// `check-artifacts.mjs --release --verified <file>` accepts the installers it cannot open itself only from such a
// manifest made with --core qul.
//
// Exit codes: 0 every installer passed (and every --require kind was found), 1 otherwise, 2 bad usage.
import console from 'node:console'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'
import {
  BUNDLE_CHECK_FORMAT,
  bufferSource,
  inspect,
  listAr,
  listTar,
  readSqliteInfo,
} from './check-artifacts.mjs'
import { defaultBundleDirs, findInstallers, MIB } from './size-budget.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KINDS = /** @type {const} */ (['nsis', 'dmg', 'deb', 'appimage', 'portable'])
/** @typedef {(typeof KINDS)[number]} Kind */
/** @typedef {'placeholder' | 'qul'} CoreMode */
export const ARCHES = /** @type {const} */ (['x64', 'arm64'])
/** @typedef {(typeof ARCHES)[number]} Arch */

/** Per architecture: the deb's `Architecture`, tauri's NSIS directory, lipo's slice name. */
const ARCH = /** @type {const} */ ({
  x64: { deb: 'amd64', nsis: 'x64', lipo: 'x86_64' },
  arm64: { deb: 'arm64', nsis: 'arm64', lipo: 'arm64' },
})

/** This machine's architecture, the default of --arch. @returns {Arch} */
export function hostArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

/**
 * What the bundles must say, read from the tauri config (base + per-OS overrides) and package.json.
 * @typedef {{ productName: string, binary: string, identifier: string, version: string, shortDescription: string,
 *   debDepends: string[], linuxIcons: { width: number, height: number, retina: boolean }[],
 *   macMinimum: string, installMode: string, webviewInstallMode: string, installerIcon: string,
 *   uninstallerIcon: string }} Expect
 *   `installerIcon`/`uninstallerIcon`: the NSIS icons, relative to src-tauri ('' when not configured)
 */

/** @param {string} file */
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** Width and height from a PNG's IHDR. @param {Buffer} png */
export function pngSize(png) {
  if (png.length < 24 || png.toString('latin1', 1, 4) !== 'PNG' || png.toString('latin1', 12, 16) !== 'IHDR')
    throw new Error('not a PNG')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/**
 * The architecture a PE (Windows) or ELF (Linux) binary is built for: `x64`, `arm64`, or a description of anything else.
 * @param {Buffer} bin @returns {string}
 */
export function binaryArch(bin) {
  if (bin.length >= 0x40 && bin.toString('latin1', 0, 2) === 'MZ') {
    const pe = bin.readUInt32LE(0x3c)
    if (pe + 6 <= bin.length && bin.toString('latin1', pe, pe + 4) === 'PE\0\0') {
      const machine = bin.readUInt16LE(pe + 4)
      return machine === 0x8664
        ? 'x64'
        : machine === 0xaa64
          ? 'arm64'
          : `PE machine 0x${machine.toString(16)}`
    }
    return 'a DOS executable without a PE header'
  }
  if (bin.length >= 20 && bin.readUInt32BE(0) === 0x7f454c46) {
    const machine = bin[5] === 2 ? bin.readUInt16BE(18) : bin.readUInt16LE(18)
    return machine === 62 ? 'x64' : machine === 183 ? 'arm64' : `ELF machine ${machine}`
  }
  return 'neither a PE nor an ELF binary'
}

/** @param {Buffer} bin @param {Arch} arch @param {string} what @returns {string[]} */
export function checkBinaryArch(bin, arch, what) {
  const got = binaryArch(bin)
  return got === arch ? [] : [`${what} is built for ${got}, expected ${arch}`]
}

/** @param {string} root the repository @returns {Expect} */
export function expectations(root = ROOT) {
  const dir = path.join(root, 'src-tauri')
  const base = readJson(path.join(dir, 'tauri.conf.json'))
  const linux = readJson(path.join(dir, 'tauri.linux.conf.json'))
  const mac = readJson(path.join(dir, 'tauri.macos.conf.json'))
  const win = readJson(path.join(dir, 'tauri.windows.conf.json'))
  const pkg = readJson(path.join(root, 'package.json'))
  const linuxIcons = (linux.bundle?.icon ?? base.bundle?.icon ?? [])
    .filter((/** @type {string} */ p) => p.endsWith('.png'))
    .map((/** @type {string} */ p) => ({
      ...pngSize(fs.readFileSync(path.join(dir, p))),
      retina: p.includes('@2x'),
    }))
  return {
    productName: base.productName,
    binary: base.mainBinaryName,
    identifier: base.identifier,
    version: base.version ?? pkg.version,
    shortDescription: base.bundle?.shortDescription ?? '',
    debDepends: linux.bundle?.linux?.deb?.depends ?? [],
    linuxIcons,
    macMinimum: mac.bundle?.macOS?.minimumSystemVersion ?? '',
    installMode: win.bundle?.windows?.nsis?.installMode ?? '',
    webviewInstallMode: win.bundle?.windows?.webviewInstallMode?.type ?? '',
    installerIcon: win.bundle?.windows?.nsis?.installerIcon ?? '',
    uninstallerIcon: win.bundle?.windows?.nsis?.uninstallerIcon ?? '',
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure checks (unit-tested).

/**
 * The core.db a bundle carries.
 * @param {Buffer} bytes @param {CoreMode} core @returns {string[]} problems
 */
export function checkCore(bytes, core) {
  if (core === 'placeholder')
    return bytes.length === 0
      ? []
      : [`core.db is ${bytes.length} B; CI bundles carry build.rs's 0-byte placeholder`]
  if (bytes.length <= MIB)
    return [`core.db is ${bytes.length} B: a placeholder or a failed build, never released`]
  try {
    const info = readSqliteInfo(bufferSource(bytes))
    const tables = new Set(info.tables.map((t) => t.toLowerCase()))
    const missing = ['meta', 'mushaf', 'ayah', 'word'].filter((t) => !tables.has(t))
    if (missing.length) return [`core.db lacks the tables ${missing.join(', ')}`]
    if (info.meta?.source !== 'qul')
      return [`core.db has meta.source = ${JSON.stringify(info.meta?.source ?? null)}, not 'qul'`]
    return []
  } catch (error) {
    return [
      `core.db is not a readable SQLite database (${error instanceof Error ? error.message : String(error)})`,
    ]
  }
}

/**
 * A freedesktop desktop entry (§2.4: MPRIS takes the player's name and icon from it).
 * @param {string} text @param {Expect} expect @returns {string[]}
 */
export function checkDesktopEntry(text, expect) {
  /** @type {Record<string, string>} */
  const keys = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line)
    if (m?.[1]) keys[m[1]] = m[2] ?? ''
  }
  /** @type {string[]} */
  const problems = []
  const want = {
    Name: expect.productName,
    Exec: expect.binary,
    Icon: expect.binary,
    StartupWMClass: expect.binary,
    Type: 'Application',
    Terminal: 'false',
  }
  for (const [key, value] of Object.entries(want))
    if (keys[key] !== value)
      problems.push(`desktop entry ${key}=${JSON.stringify(keys[key] ?? null)}, expected ${value}`)
  if (!/(^|;)Education(;|$)/.test(keys.Categories ?? ''))
    problems.push(`desktop entry Categories=${keys.Categories ?? ''} lacks Education`)
  return problems
}

/**
 * The control file of the deb.
 * @param {string} text @param {Expect} expect @param {Arch} [arch] @returns {string[]}
 */
export function checkDebControl(text, expect, arch = 'x64') {
  /** @type {Record<string, string>} */
  const fields = {}
  for (const m of text.matchAll(/^([A-Za-z-]+):\s*(.*)$/gm)) if (m[1]) fields[m[1]] = (m[2] ?? '').trim()
  /** @type {string[]} */
  const problems = []
  if (fields.Version !== expect.version)
    problems.push(`Version ${fields.Version ?? '(none)'}, expected ${expect.version}`)
  if (fields.Architecture !== ARCH[arch].deb)
    problems.push(`Architecture ${fields.Architecture ?? '(none)'}, expected ${ARCH[arch].deb}`)
  if (!fields['Installed-Size']) problems.push('no Installed-Size')
  const depends = (fields.Depends ?? '').split(',').map((d) => d.trim())
  // tauri-cli injects the tray library (the `tray-icon` feature) and the webview; the config adds ALSA (§13.5).
  /** @type {[string, (d: string) => boolean][]} */
  const required = [
    ['an appindicator library (tray, WP6b)', (d) => /^lib(ayatana-)?appindicator3-1\b/.test(d)],
    ['libwebkit2gtk-4.1-0', (d) => d === 'libwebkit2gtk-4.1-0'],
    ['libgtk-3-0', (d) => d === 'libgtk-3-0'],
    ...expect.debDepends.map(
      (want) => /** @type {[string, (d: string) => boolean]} */ ([want, (d) => d === want]),
    ),
  ]
  for (const [what, test] of required)
    if (!depends.some(test)) problems.push(`Depends lacks ${what} (Depends: ${fields.Depends ?? '(none)'})`)
  return problems
}

/**
 * The installed file tree of a Linux bundle (deb data or AppImage usr/), paths relative to its root.
 * @param {Set<string>} files @param {Expect} expect @param {{ appimage?: boolean }} [options] @returns {string[]}
 */
export function checkLinuxTree(files, expect, { appimage = false } = {}) {
  /** @type {string[]} */
  const problems = []
  const need = [
    `usr/bin/${expect.binary}`,
    `usr/lib/${expect.productName}/data/core.db`,
    `usr/lib/${expect.productName}/data/catalog.json`,
    `usr/share/applications/${expect.productName}.desktop`,
  ]
  if (!appimage)
    for (const icon of expect.linuxIcons)
      need.push(
        `usr/share/icons/hicolor/${icon.width}x${icon.height}${icon.retina ? '@2' : ''}/apps/${expect.binary}.png`,
      )
  for (const file of need) if (!files.has(file)) problems.push(`missing ${file}`)
  if (
    appimage &&
    ![...files].some((f) => /^usr\/lib\/([\w-]+-linux-gnu\/)?lib(ayatana-)?appindicator3\.so\.1$/.test(f))
  )
    problems.push(
      'the AppImage bundles no libayatana-appindicator3.so.1 / libappindicator3.so.1 (tray, WP6b)',
    )
  return problems
}

/**
 * Tauri's generated NSIS script.
 * @param {string} text @param {Expect} expect @returns {{ problems: string[], files: { name: string, source: string }[] }}
 */
export function checkNsisScript(text, expect) {
  /** @type {Record<string, string>} */
  const defines = {}
  for (const m of text.matchAll(/^!define (\w+) "([^"]*)"/gm)) if (m[1]) defines[m[1]] = m[2] ?? ''
  /** @type {string[]} */
  const problems = []
  const want = {
    PRODUCTNAME: expect.productName,
    MAINBINARYNAME: expect.binary,
    BUNDLEID: expect.identifier,
    VERSION: expect.version,
    INSTALLMODE: expect.installMode,
    INSTALLWEBVIEW2MODE: expect.webviewInstallMode,
  }
  for (const [key, value] of Object.entries(want))
    if (defines[key] !== value)
      problems.push(
        `NSIS ${key} is ${JSON.stringify(defines[key] ?? null)}, expected ${JSON.stringify(value)}`,
      )
  // The setup and uninstall executables carry the app icon, not NSIS's generic one (tauri writes absolute paths).
  const slashes = (/** @type {string} */ p) => p.replace(/\\/g, '/')
  for (const [key, icon] of /** @type {const} */ ([
    ['INSTALLERICON', expect.installerIcon],
    ['UNINSTALLERICON', expect.uninstallerIcon],
  ]))
    if (icon && !slashes(defines[key] ?? '').endsWith(`/${slashes(icon).replace(/^\.\//, '')}`))
      problems.push(`NSIS ${key} is ${JSON.stringify(defines[key] ?? null)}, expected the app icon ${icon}`)
  const files = [...text.matchAll(/File \/a "\/oname=([^"]+)" "([^"]+)"/g)].map((m) => ({
    name: (m[1] ?? '').replace(/\\/g, '/'),
    source: m[2] ?? '',
  }))
  for (const name of ['data/core.db', 'data/catalog.json'])
    if (!files.some((f) => f.name === name)) problems.push(`the NSIS script does not install ${name}`)
  if (!/^\s*File "\$\{MAINBINARYSRCPATH\}"/m.test(text))
    problems.push('the NSIS script does not install the main binary')
  return { problems, files }
}

/**
 * The parsed Info.plist of the .app.
 * @param {Record<string, unknown>} plist @param {Expect} expect @returns {string[]}
 */
export function checkInfoPlist(plist, expect) {
  /** @type {string[]} */
  const problems = []
  const want = {
    CFBundleIdentifier: expect.identifier,
    CFBundleExecutable: expect.binary,
    CFBundleName: expect.productName,
    CFBundleShortVersionString: expect.version,
    LSMinimumSystemVersion: expect.macMinimum,
  }
  for (const [key, value] of Object.entries(want))
    if (plist[key] !== value)
      problems.push(
        `Info.plist ${key} is ${JSON.stringify(plist[key] ?? null)}, expected ${JSON.stringify(value)}`,
      )
  return problems
}

/**
 * check-artifacts' release rules on an unpacked tree. The 0-byte placeholder core.db is expected in CI bundles.
 * @param {string} dir @param {CoreMode} core @returns {string[]}
 */
export function inspectTree(dir, core) {
  const report = inspect(['.'], { cwd: dir, release: true })
  /** @type {string[]} */
  const problems = []
  for (const finding of report.forbidden) {
    const placeholder =
      core === 'placeholder' &&
      /(^|\/)data\/core\.db$/.test(finding.path) &&
      finding.reasons.every((r) => r.rule === 'db-file') &&
      fs.existsSync(path.join(dir, finding.path)) &&
      fs.statSync(path.join(dir, finding.path)).size === 0
    if (!placeholder)
      problems.push(`${finding.path}: ${finding.reasons.map((r) => `${r.rule} (${r.detail})`).join('; ')}`)
  }
  return problems
}

// ---------------------------------------------------------------------------------------------------------------------
// Per installer.

/** @typedef {{ kind: Kind, file: string, bytes: number, sha256: string, ok: boolean, checks: string[],
 *   problems: string[], notes: string[] }} InstallerResult */

/** @param {string} file */
function sha256Of(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** @param {string} cmd @param {string[]} args @param {import('node:child_process').SpawnSyncOptions} [options] */
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * MIB, ...options })
  return {
    ok: r.status === 0 && !r.error,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    missing: r.error?.message.includes('ENOENT') ?? false,
  }
}

/** Every file under `dir`, relative, with forward slashes. @param {string} dir @returns {Set<string>} */
function filesUnder(dir) {
  /** @type {Set<string>} */
  const out = new Set()
  /** @param {string} at */
  const walk = (at) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const p = path.join(at, e.name)
      if (e.isDirectory()) walk(p)
      else out.add(path.relative(dir, p).split(path.sep).join('/'))
    }
  }
  walk(dir)
  return out
}

/**
 * What every check needs besides the installer: the core.db mode, the expectations, the architecture, whether the
 * macOS binary must be universal, whether a signature is required, and a scratch directory.
 * @typedef {{ core: CoreMode, expect: Expect, arch: Arch, universal: boolean, signed: boolean, scratch: string }} Ctx
 */

/**
 * The Authenticode signature of a Windows file (PowerShell's Get-AuthenticodeSignature); null off Windows.
 * @param {string} file @returns {{ valid: boolean, text: string } | null}
 */
function authenticode(file) {
  if (process.platform !== 'win32') return null
  const script =
    '$s = Get-AuthenticodeSignature -LiteralPath $env:QD_SIGNED_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"'
  const ps = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, QD_SIGNED_FILE: file },
  })
  const [status = '', subject = ''] = ps.out.trim().split('|')
  return status === 'Valid'
    ? { valid: true, text: `signed (${subject.trim()})` }
    : { valid: false, text: `not signed (${status || ps.out.trim() || 'unknown'})` }
}

/**
 * Reports a Windows file's signature; with --signed a missing or invalid one is a problem.
 * @param {string} file @param {string} what @param {Ctx} ctx @param {InstallerResult} r
 */
function windowsSignature(file, what, { signed }, r) {
  const sig = authenticode(file)
  if (!sig) {
    if (signed) r.problems.push(`${what}: an Authenticode signature can only be checked on Windows`)
    return
  }
  r.checks.push(`${what}: ${sig.text}`)
  if (signed && !sig.valid) r.problems.push(`${what} is ${sig.text}; --signed requires a valid signature`)
}

/** @param {string} file @param {Ctx} ctx @param {InstallerResult} r */
function checkDeb(file, { core, expect, arch }, r) {
  const src = bufferSource(fs.readFileSync(file))
  const members = listAr(src)
  const member = (/** @type {RegExp} */ re) => members.find((m) => re.test(m.name))
  const control = member(/^control\.tar\.gz$/)
  const data = member(/^data\.tar\.gz$/)
  if (!control || !data) {
    r.problems.push(
      `members ${members.map((m) => m.name).join(', ')}: expected control.tar.gz and data.tar.gz`,
    )
    return
  }
  const controlTar = bufferSource(zlib.gunzipSync(src.read(control.dataStart, control.size)))
  const controlFile = listTar(controlTar).find((e) => e.type === 'file' && /(^|\/)control$/.test(e.name))
  const text = controlFile ? controlTar.read(controlFile.dataStart, controlFile.size).toString('utf8') : ''
  r.problems.push(...checkDebControl(text, expect, arch))
  r.checks.push(`control: ${text.match(/^Depends:.*$/m)?.[0] ?? 'no Depends'}`)
  const dataTar = bufferSource(zlib.gunzipSync(src.read(data.dataStart, data.size)))
  const entries = listTar(dataTar).filter((e) => e.type === 'file')
  const names = new Map(entries.map((e) => [e.name.replace(/^\.\//, ''), e]))
  r.problems.push(...checkLinuxTree(new Set(names.keys()), expect))
  const binary = names.get(`usr/bin/${expect.binary}`)
  if (binary)
    r.problems.push(
      ...checkBinaryArch(dataTar.read(binary.dataStart, binary.size), arch, `usr/bin/${expect.binary}`),
    )
  const desktop = names.get(`usr/share/applications/${expect.productName}.desktop`)
  if (desktop)
    r.problems.push(
      ...checkDesktopEntry(dataTar.read(desktop.dataStart, desktop.size).toString('utf8'), expect),
    )
  const coreEntry = names.get(`usr/lib/${expect.productName}/data/core.db`)
  if (coreEntry) r.problems.push(...checkCore(dataTar.read(coreEntry.dataStart, coreEntry.size), core))
  r.checks.push(
    `data: ${entries.length} files, ${expect.productName}.desktop, ${expect.linuxIcons.length} hicolor icons, ${arch}`,
  )
  // The deb itself goes through check-artifacts (it opens ar and tar.gz).
  const report = inspect([path.basename(file)], { cwd: path.dirname(file), release: true })
  for (const f of report.forbidden) {
    const placeholder =
      core === 'placeholder' && /data\/core\.db$/.test(f.path) && f.reasons.every((x) => x.rule === 'db-file')
    if (!placeholder) r.problems.push(`${f.path}: ${f.reasons.map((x) => x.rule).join(', ')}`)
  }
}

/** @param {string} file @param {Ctx} ctx @param {InstallerResult} r */
function checkNsis(file, ctx, r) {
  const { core, expect, arch, scratch } = ctx
  // tauri writes the script to <target>[/<triple>]/release/nsis/<x64 | arm64>/installer.nsi.
  const script = path.join(
    path.dirname(path.dirname(path.dirname(file))),
    'nsis',
    ARCH[arch].nsis,
    'installer.nsi',
  )
  if (!fs.existsSync(script)) r.problems.push(`tauri's NSIS script ${script} is missing`)
  else {
    const { problems, files } = checkNsisScript(fs.readFileSync(script, 'utf8'), expect)
    r.problems.push(...problems)
    const coreSource = files.find((f) => f.name === 'data/core.db')?.source
    if (coreSource && fs.existsSync(coreSource))
      r.problems.push(...checkCore(fs.readFileSync(coreSource), core))
    r.checks.push(
      `installer.nsi: ${expect.installMode} install, WebView2 ${expect.webviewInstallMode}, ${files.length} resources`,
    )
  }
  windowsSignature(file, 'the setup', ctx, r)
  const out = path.join(scratch, 'nsis')
  for (const exe of ['7z', '7za', '7zz']) {
    const x = run(exe, ['x', '-y', `-o${out}`, file])
    if (x.missing) continue
    if (!x.ok) {
      r.problems.push(
        `${exe} could not unpack the installer: ${x.out.trim().split('\n').slice(-3).join(' ')}`,
      )
      return
    }
    const files = filesUnder(out)
    for (const need of [`${expect.binary}.exe`, 'data/core.db', 'data/catalog.json'])
      if (!files.has(need))
        r.problems.push(`the installer does not contain ${need} (has ${[...files].slice(0, 12).join(', ')})`)
    const main = path.join(out, `${expect.binary}.exe`)
    if (files.has(`${expect.binary}.exe`)) {
      r.problems.push(...checkBinaryArch(fs.readFileSync(main), arch, `${expect.binary}.exe`))
      windowsSignature(main, `${expect.binary}.exe`, ctx, r)
    }
    if (files.has('data/core.db'))
      r.problems.push(...checkCore(fs.readFileSync(path.join(out, 'data', 'core.db')), core))
    r.problems.push(...inspectTree(out, core))
    r.checks.push(`unpacked with ${exe}: ${files.size} files, ${arch}`)
    return
  }
  const text = 'cannot unpack the installer: 7-Zip (7z) is not installed'
  if (core === 'qul' || process.env.GITHUB_ACTIONS === 'true') r.problems.push(text)
  else r.notes.push(`${text}; checked tauri's NSIS script and the files it packs instead`)
}

/**
 * Quran.app, from the dmg or the portable zip: Info.plist, the binary's slices, the resources, the signature.
 * @param {string} appDir @param {Ctx} ctx @param {InstallerResult} r
 */
function checkApp(appDir, { core, expect, arch, universal, signed }, r) {
  const plist = run('plutil', ['-convert', 'json', '-o', '-', path.join(appDir, 'Contents', 'Info.plist')])
  if (!plist.ok) r.problems.push(`Info.plist: ${plist.out.trim()}`)
  else r.problems.push(...checkInfoPlist(JSON.parse(plist.out), expect))
  const binary = path.join(appDir, 'Contents', 'MacOS', expect.binary)
  if (!fs.existsSync(binary)) r.problems.push(`missing Contents/MacOS/${expect.binary}`)
  else {
    const archs = run('lipo', ['-archs', binary])
    const set = new Set(archs.out.trim().split(/\s+/))
    if (universal) {
      if (!set.has('x86_64') || !set.has('arm64'))
        r.problems.push(`the binary is not universal (lipo -archs: ${archs.out.trim()})`)
      else r.checks.push('universal binary (x86_64 arm64)')
    } else if (!set.has(ARCH[arch].lipo))
      r.problems.push(`the binary has no ${ARCH[arch].lipo} slice (lipo -archs: ${archs.out.trim()})`)
    else r.checks.push(`binary: ${archs.out.trim()}`)
  }
  for (const res of ['data/core.db', 'data/catalog.json'])
    if (!fs.existsSync(path.join(appDir, 'Contents', 'Resources', res)))
      r.problems.push(`missing Contents/Resources/${res}`)
  const coreFile = path.join(appDir, 'Contents', 'Resources', 'data', 'core.db')
  if (fs.existsSync(coreFile)) r.problems.push(...checkCore(fs.readFileSync(coreFile), core))
  const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir])
  if (!verify.ok) r.problems.push(`codesign --verify: ${verify.out.trim()}`)
  const details = run('codesign', ['-dvvv', appDir]).out
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(details)?.[1] ?? ''
  if (!flags.split(',').includes('runtime'))
    r.problems.push(`the signature lacks the hardened runtime (flags: ${flags || 'none'})`)
  const signer = /Authority=Developer ID Application: (.*)/.exec(details)?.[1]
  r.checks.push(
    `signature: ${signer ? `Developer ID (${signer})` : /Signature=adhoc/.test(details) ? 'ad-hoc' : 'unknown'}, flags ${flags}`,
  )
  if (signed && !signer) r.problems.push('--signed requires a Developer ID signature')
  r.problems.push(...inspectTree(appDir, core))
}

/** @param {string} file @param {Ctx} ctx @param {InstallerResult} r */
function checkDmg(file, ctx, r) {
  const { expect, scratch } = ctx
  if (process.platform !== 'darwin') {
    r.problems.push('a dmg can only be unpacked on macOS (hdiutil)')
    return
  }
  const mount = path.join(scratch, 'dmg')
  fs.mkdirSync(mount, { recursive: true })
  const attach = run('hdiutil', [
    'attach',
    '-nobrowse',
    '-readonly',
    '-noautoopen',
    '-mountpoint',
    mount,
    file,
  ])
  if (!attach.ok) {
    r.problems.push(`hdiutil attach failed: ${attach.out.trim()}`)
    return
  }
  try {
    const app = fs.readdirSync(mount).find((n) => n.endsWith('.app'))
    if (app !== `${expect.productName}.app`)
      r.problems.push(`the dmg holds ${app ?? 'no .app'}, expected ${expect.productName}.app`)
    const link = path.join(mount, 'Applications')
    if (!fs.existsSync(link) || !fs.lstatSync(link).isSymbolicLink())
      r.problems.push('the dmg has no /Applications link')
    if (app) checkApp(path.join(mount, app), ctx, r)
  } finally {
    run('hdiutil', ['detach', mount, '-force'])
  }
}

/** @param {string} file @param {Ctx} ctx @param {InstallerResult} r */
function checkAppImage(file, { core, expect, arch, scratch }, r) {
  if (process.platform !== 'linux') {
    r.problems.push('an AppImage can only be unpacked on Linux (--appimage-extract)')
    return
  }
  const cwd = path.join(scratch, 'appimage')
  fs.mkdirSync(cwd, { recursive: true })
  fs.chmodSync(file, 0o755)
  const x = run(file, ['--appimage-extract'], { cwd })
  const root = path.join(cwd, 'squashfs-root')
  if (!x.ok || !fs.existsSync(root)) {
    r.problems.push(`--appimage-extract failed: ${x.out.trim().split('\n').slice(-3).join(' ')}`)
    return
  }
  const files = filesUnder(root)
  r.problems.push(...checkLinuxTree(files, expect, { appimage: true }))
  const binary = path.join(root, 'usr', 'bin', expect.binary)
  if (fs.existsSync(binary))
    r.problems.push(...checkBinaryArch(fs.readFileSync(binary), arch, `usr/bin/${expect.binary}`))
  const desktop = path.join(root, 'usr', 'share', 'applications', `${expect.productName}.desktop`)
  if (fs.existsSync(desktop)) r.problems.push(...checkDesktopEntry(fs.readFileSync(desktop, 'utf8'), expect))
  const coreFile = path.join(root, 'usr', 'lib', expect.productName, 'data', 'core.db')
  if (fs.existsSync(coreFile)) r.problems.push(...checkCore(fs.readFileSync(coreFile), core))
  r.problems.push(...inspectTree(root, core))
  r.checks.push(`unpacked: ${files.size} files, ${arch}`)
}

/**
 * A portable zip (scripts/make-portable.mjs): `Quran.app` on macOS (ditto), else `Quran/` with the exe and its data
 * (Windows' own tar.exe, a bsdtar, which reads zip; the GNU tar of Git's shell does not).
 * @param {string} file @param {Ctx} ctx @param {InstallerResult} r
 */
function checkPortable(file, ctx, r) {
  const { core, expect, arch, scratch } = ctx
  const out = path.join(scratch, 'portable')
  fs.mkdirSync(out, { recursive: true })
  if (/\.app\.zip$/i.test(file)) {
    if (process.platform !== 'darwin') {
      r.problems.push('a macOS app zip can only be unpacked on macOS (ditto)')
      return
    }
    const x = run('ditto', ['-x', '-k', file, out])
    if (!x.ok) {
      r.problems.push(`ditto -x -k failed: ${x.out.trim()}`)
      return
    }
    const app = fs.readdirSync(out).find((n) => n.endsWith('.app'))
    if (app !== `${expect.productName}.app`)
      r.problems.push(`the zip holds ${app ?? 'no .app'}, expected ${expect.productName}.app`)
    if (app) checkApp(path.join(out, app), ctx, r)
    return
  }
  const tar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  const x = run(tar, ['-xf', file, '-C', out])
  if (!x.ok) {
    r.problems.push(`tar could not unpack the zip: ${x.out.trim().split('\n').slice(-3).join(' ')}`)
    return
  }
  const files = filesUnder(out)
  const dir = expect.productName
  for (const need of [`${expect.binary}.exe`, 'data/core.db', 'data/catalog.json'].map((f) => `${dir}/${f}`))
    if (!files.has(need))
      r.problems.push(`the zip does not contain ${need} (has ${[...files].slice(0, 12).join(', ')})`)
  const main = path.join(out, dir, `${expect.binary}.exe`)
  if (fs.existsSync(main)) {
    r.problems.push(...checkBinaryArch(fs.readFileSync(main), arch, `${expect.binary}.exe`))
    windowsSignature(main, `${expect.binary}.exe`, ctx, r)
  }
  const coreFile = path.join(out, dir, 'data', 'core.db')
  if (fs.existsSync(coreFile)) r.problems.push(...checkCore(fs.readFileSync(coreFile), core))
  r.problems.push(...inspectTree(out, core))
  r.checks.push(`unpacked: ${files.size} files under ${dir}/, ${arch}`)
}

/**
 * The newest portable zip in the bundle directories (`bundle/portable/*.zip`, scripts/make-portable.mjs).
 * @param {string[]} bundleDirs @returns {string | undefined}
 */
export function findPortable(bundleDirs) {
  /** @type {string | undefined} */
  let found
  let newest = -1
  for (const dir of bundleDirs) {
    const sub = path.join(dir, 'portable')
    if (!fs.existsSync(sub)) continue
    for (const name of fs.readdirSync(sub)) {
      const file = path.join(sub, name)
      if (!/\.zip$/i.test(name) || !fs.statSync(file).isFile()) continue
      const time = fs.statSync(file).mtimeMs
      if (time > newest) {
        newest = time
        found = file
      }
    }
  }
  return found
}

/**
 * Checks every installer.
 * @param {{ bundleDirs: string[], core: CoreMode, universal: boolean, expect: Expect, arch?: Arch,
 *   signed?: boolean }} options
 * @returns {InstallerResult[]}
 */
export function checkBundles({ bundleDirs, core, universal, expect, arch = hostArch(), signed = false }) {
  /** @type {Partial<Record<Kind, string>>} */
  const found = { ...findInstallers(bundleDirs), portable: findPortable(bundleDirs) }
  /** @type {InstallerResult[]} */
  const results = []
  for (const kind of KINDS) {
    const file = found[kind]
    if (!file) continue
    /** @type {InstallerResult} */
    const r = {
      kind,
      file,
      bytes: fs.statSync(file).size,
      sha256: sha256Of(file),
      ok: false,
      checks: [],
      problems: [],
      notes: [],
    }
    const scratch = fs.mkdtempSync(path.join(tmpdir(), `qd-bundle-${kind}-`))
    /** @type {Ctx} */
    const ctx = { core, expect, arch, universal, signed, scratch }
    try {
      if (kind === 'deb') checkDeb(file, ctx, r)
      else if (kind === 'nsis') checkNsis(file, ctx, r)
      else if (kind === 'dmg') checkDmg(file, ctx, r)
      else if (kind === 'appimage') checkAppImage(file, ctx, r)
      else checkPortable(file, ctx, r)
    } catch (error) {
      r.problems.push(error instanceof Error ? error.message : String(error))
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
    }
    r.ok = r.problems.length === 0
    results.push(r)
  }
  return results
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI.

const USAGE = `Usage: node scripts/check-bundles.mjs --core placeholder|qul [--bundle-dir <dir>]... [--require <kinds>]
                                     [--universal] [--arch x64|arm64] [--signed] [--webview <mode>]
                                     [--manifest <file>] [--json]

Unpacks every installer (nsis, dmg, deb, appimage, portable) and checks its contents (see the header of this file).

  --core placeholder|qul  CI bundles carry the 0-byte placeholder; release bundles a qul core.db
  --bundle-dir <dir>      a tauri bundle directory (repeatable; default: every release bundle dir of the target)
  --require <kinds>       kinds that must be present (comma-separated: nsis, dmg, deb, appimage, portable)
  --universal             the macOS binary must be universal (x86_64 + arm64)
  --arch x64|arm64        the architecture every binary is built for (default: this machine's)
  --signed                require a valid Authenticode (Windows) or Developer ID (macOS) signature
  --webview <mode>        the NSIS WebView2 install mode (default: the config's; the Store build: offlineInstaller)
  --manifest <file>       write the qd-bundle-check/1 manifest (for check-artifacts --release --verified)
  --json                  print the results as JSON

Exit codes: 0 every installer passed, 1 otherwise, 2 bad usage.`

/** @param {string[]} argv @param {NodeJS.ProcessEnv} [env] @returns {number} */
export function main(argv, env = process.env) {
  let values
  try {
    values = parseArgs({
      args: argv,
      options: {
        core: { type: 'string' },
        'bundle-dir': { type: 'string', multiple: true, default: [] },
        require: { type: 'string', multiple: true, default: [] },
        universal: { type: 'boolean', default: false },
        arch: { type: 'string' },
        signed: { type: 'boolean', default: false },
        webview: { type: 'string' },
        manifest: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    console.error(`check-bundles: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 2
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  if (values.core !== 'placeholder' && values.core !== 'qul') {
    console.error(`check-bundles: --core must be placeholder or qul\n\n${USAGE}`)
    return 2
  }
  const required = values.require
    .flatMap((v) => v.split(','))
    .map((k) => k.trim())
    .filter(Boolean)
  const unknown = required.filter((k) => !(/** @type {readonly string[]} */ (KINDS).includes(k)))
  if (unknown.length) {
    console.error(`check-bundles: unknown kind(s) ${unknown.join(', ')} (kinds: ${KINDS.join(', ')})`)
    return 2
  }
  const arch = values.arch ?? hostArch()
  if (!(/** @type {readonly string[]} */ (ARCHES).includes(arch))) {
    console.error(`check-bundles: --arch must be ${ARCHES.join(' or ')}\n\n${USAGE}`)
    return 2
  }
  const core = /** @type {CoreMode} */ (values.core)
  const target = path.resolve(ROOT, env.CARGO_TARGET_DIR ?? 'target')
  const bundleDirs = values['bundle-dir'].length
    ? values['bundle-dir'].map((d) => path.resolve(d))
    : defaultBundleDirs(target)
  const results = checkBundles({
    bundleDirs,
    core,
    universal: values.universal,
    expect: values.webview ? { ...expectations(), webviewInstallMode: values.webview } : expectations(),
    arch: /** @type {Arch} */ (arch),
    signed: values.signed,
  })
  const absent = required.filter((k) => !results.some((r) => r.kind === k))
  const ok = results.length > 0 && results.every((r) => r.ok) && absent.length === 0

  if (values.manifest) {
    const manifest = {
      format: BUNDLE_CHECK_FORMAT,
      core,
      arch,
      createdAt: new Date().toISOString(),
      installers: results.map(({ kind, file, bytes, sha256, ok: passed, checks, problems, notes }) => ({
        kind,
        file: path.relative(ROOT, file).split(path.sep).join('/'),
        bytes,
        sha256,
        ok: passed,
        checks,
        problems,
        notes,
      })),
    }
    fs.mkdirSync(path.dirname(path.resolve(values.manifest)), { recursive: true })
    fs.writeFileSync(path.resolve(values.manifest), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  if (values.json) console.log(JSON.stringify({ ok, core, bundleDirs, absent, results }, null, 2))
  else {
    console.log(
      `check-bundles  core: ${core}  arch: ${arch}  bundle dirs: ${bundleDirs.map((d) => path.relative(ROOT, d) || d).join(', ') || 'none'}`,
    )
    for (const r of results) {
      console.log(
        `  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.kind.padEnd(8)} ${path.basename(r.file)}  ${(r.bytes / MIB).toFixed(2)} MiB  sha256 ${r.sha256.slice(0, 16)}…`,
      )
      for (const c of r.checks) console.log(`          ${c}`)
      for (const n of r.notes) console.log(`          note: ${n}`)
      for (const p of r.problems) console.log(`          FAIL ${p}`)
    }
    if (results.length === 0) console.log('  FAIL  no installer found (build with `pnpm tauri build` first)')
    for (const k of absent) console.log(`  FAIL  no ${k} installer (--require)`)
    console.log(ok ? `check-bundles passed: ${results.length} installer(s)` : 'check-bundles FAILED')
  }
  if (env.GITHUB_ACTIONS === 'true')
    for (const r of results)
      for (const p of r.problems)
        console.log(
          `::error title=check-bundles (${r.kind})::${p.replace(/%/g, '%25').replace(/\n/g, '%0A')}`,
        )
  return ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
