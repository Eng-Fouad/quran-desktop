#!/usr/bin/env node
// @ts-check
// make-portable: the portable builds of a release (release.yml; ARCHITECTURE §13.4), next to the installers in
// <target>[/<triple>]/release/bundle/portable/:
//
//   node scripts/make-portable.mjs --arch x64|arm64 [--target <triple>] [--universal]
//
//   Windows  Quran_<version>_<arch>_portable.zip: Quran/quran-desktop.exe and the bundle resources at the paths the
//            installer gives them (data/core.db, data/catalog.json), so the exe finds them beside itself. It needs the
//            WebView2 runtime (part of Windows 11, and of Windows 10 with Edge), keeps its data in the user's profile
//            like the installed app, and is the very exe tauri built (and signed, when a sign command is configured).
//   macOS    Quran_<version>_<universal | aarch64 | x64>.app.zip: Quran.app as tauri built and signed it, zipped with
//            `ditto -c -k --keepParent` (what Finder's Compress does), which keeps the signature and the stapled
//            notarisation ticket intact.
//   Linux    nothing: the AppImage is the portable build.
//
// scripts/check-bundles.mjs (kind `portable`) then unpacks and checks the zip like the installers.
//
// Exit codes: 0 written (or nothing to do on Linux), 1 a build output is missing, 2 bad usage.
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import console from 'node:console'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARCHES = ['x64', 'arm64']

/** @param {string} file */
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

// ---------------------------------------------------------------------------------------------------------------------
// A minimal zip writer (deflate, no zip64: the entries are tens of MiB).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** @param {Buffer} data @returns {number} */
export function crc32(data) {
  let c = 0xffffffff
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS date and time of `date` (local time, 2 s resolution, 1980 at the earliest). @param {Date} date */
function dosTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * A zip archive of `entries` (forward-slash names), deflated.
 * @param {{ name: string, data: Buffer, mtime?: Date }[]} entries @returns {Buffer}
 */
export function zipFiles(entries) {
  /** @type {Buffer[]} */
  const parts = []
  /** @type {Buffer[]} */
  const central = []
  let offset = 0
  for (const { name, data, mtime = new Date() } of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const packed = zlib.deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const { time, date } = dosTime(mtime)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    parts.push(local, nameBytes, packed)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4) // made by: MS-DOS, 2.0
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(date, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(packed.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, nameBytes)
    offset += local.length + nameBytes.length + packed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

// ---------------------------------------------------------------------------------------------------------------------
// The plan.

/**
 * What goes into the portable build of this platform, from the tauri config.
 * @param {{ root?: string, platform: NodeJS.Platform, target: string, triple?: string, arch: string,
 *   universal?: boolean }} options
 * @returns {{ kind: 'zip', out: string, entries: { name: string, source: string }[] }
 *   | { kind: 'app', out: string, app: string } | { kind: 'none', reason: string }}
 */
export function portablePlan({ root = ROOT, platform, target, triple, arch, universal = false }) {
  const config = readJson(path.join(root, 'src-tauri', 'tauri.conf.json'))
  const product = String(config.productName)
  const binary = String(config.mainBinaryName)
  const version = String(config.version)
  const release = triple ? path.join(target, triple, 'release') : path.join(target, 'release')
  const portable = path.join(release, 'bundle', 'portable')
  if (platform === 'win32') {
    /** @type {Record<string, string>} */
    const resources = config.bundle?.resources ?? {}
    return {
      kind: 'zip',
      out: path.join(portable, `${product}_${version}_${arch}_portable.zip`),
      entries: [
        { name: `${product}/${binary}.exe`, source: path.join(release, `${binary}.exe`) },
        ...Object.entries(resources).map(([from, to]) => ({
          name: `${product}/${to}`,
          source: path.join(root, 'src-tauri', from),
        })),
      ],
    }
  }
  if (platform === 'darwin') {
    const label = universal ? 'universal' : arch === 'arm64' ? 'aarch64' : 'x64'
    return {
      kind: 'app',
      out: path.join(portable, `${product}_${version}_${label}.app.zip`),
      app: path.join(release, 'bundle', 'macos', `${product}.app`),
    }
  }
  return { kind: 'none', reason: 'the AppImage is the portable build on Linux' }
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI.

const USAGE = `Usage: node scripts/make-portable.mjs --arch x64|arm64 [--target <triple>] [--universal]

Writes the portable build next to the installers (see the header of this file). CARGO_TARGET_DIR is honoured.`

/** @param {string[]} argv @param {NodeJS.ProcessEnv} [env] @returns {number} */
export function main(argv, env = process.env) {
  let values
  try {
    values = parseArgs({
      args: argv,
      options: {
        arch: { type: 'string' },
        target: { type: 'string' },
        universal: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values
  } catch (error) {
    console.error(`make-portable: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 2
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  if (!values.arch || !ARCHES.includes(values.arch)) {
    console.error(`make-portable: --arch must be ${ARCHES.join(' or ')}\n\n${USAGE}`)
    return 2
  }
  const plan = portablePlan({
    platform: process.platform,
    target: path.resolve(ROOT, env.CARGO_TARGET_DIR ?? 'target'),
    triple: values.target,
    arch: values.arch,
    universal: values.universal,
  })
  if (plan.kind === 'none') {
    console.log(`make-portable: nothing to do (${plan.reason})`)
    return 0
  }
  fs.mkdirSync(path.dirname(plan.out), { recursive: true })
  fs.rmSync(plan.out, { force: true })
  if (plan.kind === 'zip') {
    const missing = plan.entries.filter((e) => !fs.existsSync(e.source))
    if (missing.length) {
      console.error(`make-portable: missing ${missing.map((e) => e.source).join(', ')} (build first)`)
      return 1
    }
    const entries = plan.entries.map(({ name, source }) => ({
      name,
      data: fs.readFileSync(source),
      mtime: fs.statSync(source).mtime,
    }))
    fs.writeFileSync(plan.out, zipFiles(entries))
    console.log(`make-portable: ${plan.out} (${entries.map((e) => e.name).join(', ')})`)
    return 0
  }
  if (!fs.existsSync(plan.app)) {
    console.error(`make-portable: missing ${plan.app} (build first)`)
    return 1
  }
  const ditto = spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', plan.app, plan.out], {
    encoding: 'utf8',
  })
  if (ditto.status !== 0) {
    console.error(`make-portable: ditto failed: ${ditto.stderr || ditto.error?.message || ditto.status}`)
    return 1
  }
  console.log(`make-portable: ${plan.out}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
