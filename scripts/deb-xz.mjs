#!/usr/bin/env node
// @ts-check
// deb-xz: recompress the payload of tauri's deb with xz.
//
//   node scripts/deb-xz.mjs [--bundle-dir <dir>]... [<file.deb>...]
//
// tauri-bundler 2.10 always writes the deb's data.tar.gz with gzip at its default level, and nothing configures it.
// That cannot meet the deb's 9 MB size budget: the release binary and core.db come to about 11.4 MiB (measured with the
// 12.5 MB qdc core.db). With xz -6, dpkg-deb's own default, which every dpkg since 1.15.6 unpacks, the same payload is
// about 8 MiB. So CI (.github/actions/size-check) and release.yml run this right after `tauri build`. It replaces
// data.tar.gz with data.tar.xz holding the same tar, byte for byte (checked by decompressing it again). debian-binary,
// control.tar.gz and every member header but the payload's name and size stay as tauri wrote them. A deb whose payload
// is already xz is left alone. The debs are the ones named, else every deb under the bundle directories (default: every
// <target>/release/bundle and <target>/<triple>/release/bundle, <target> being $CARGO_TARGET_DIR or ./target).
//
// Needs the xz tool (xz-utils; on every GitHub Linux runner). Exit codes: 0 every deb is xz, 1 a deb could not be
// recompressed or there is none, 2 bad usage.
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import console from 'node:console'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'
import { unxz } from './check-artifacts.mjs'
import { defaultBundleDirs } from './size-budget.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AR_MAGIC = Buffer.from('!<arch>\n', 'latin1')

/** The xz settings (size-budget.mjs compresses core.db the same way when it adds it to a placeholder deb). */
export const XZ_ARGS = /** @type {const} */ (['-6', '--threads=1'])

/**
 * Compresses with `xz -6`, single-threaded so the output does not depend on the machine's cores.
 * @param {Buffer} input @returns {Buffer}
 * @throws {Error} when xz is not installed or fails
 */
export function xz(input) {
  const run = spawnSync('xz', [...XZ_ARGS, '--compress', '--stdout'], {
    input,
    maxBuffer: 2 * input.length + 1024 * 1024,
  })
  if (/** @type {NodeJS.ErrnoException | undefined} */ (run.error)?.code === 'ENOENT')
    throw new Error('xz is not installed (xz-utils)')
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`xz failed: ${String(run.stderr).trim() || `exit ${run.status}`}`)
  return run.stdout
}

/** @typedef {{ name: string, header: Buffer, data: Buffer }} ArMember */

/**
 * The members of a deb as dpkg-deb and tauri write it: a plain ar archive (names of up to 15 characters, no symbol or
 * name table), anything else is refused.
 * @param {Buffer} deb @returns {ArMember[]}
 */
export function readMembers(deb) {
  if (!deb.subarray(0, AR_MAGIC.length).equals(AR_MAGIC)) throw new Error('not an ar archive')
  /** @type {ArMember[]} */
  const members = []
  for (let at = AR_MAGIC.length; at < deb.length;) {
    if (at + 60 > deb.length) throw new Error(`truncated ar header at byte ${at}`)
    const header = Buffer.from(deb.subarray(at, at + 60))
    if (header.toString('latin1', 58, 60) !== '`\n') throw new Error(`bad ar header at byte ${at}`)
    const name = header.toString('latin1', 0, 16).trimEnd().replace(/\/$/, '')
    if (!/^[\w.+-]+$/.test(name)) throw new Error(`unexpected ar member name ${JSON.stringify(name)}`)
    const sizeField = header.toString('latin1', 48, 58).trim()
    const size = Number(sizeField)
    if (!/^\d+$/.test(sizeField) || at + 60 + size > deb.length)
      throw new Error(`ar member ${name} is truncated`)
    members.push({ name, header, data: deb.subarray(at + 60, at + 60 + size) })
    at += 60 + size + (size % 2)
  }
  return members
}

/**
 * The deb with data.tar.gz replaced by data.tar.xz holding the same tar; null when the payload is already xz.
 * @param {Buffer} deb @param {(tar: Buffer) => Buffer} [compress] @param {(xz: Buffer) => Buffer} [decompress]
 * @returns {Buffer | null}
 * @throws {Error} when the deb is not debian-binary, control.tar.*, data.tar.gz or data.tar.xz, or the round trip fails
 */
export function recompressDeb(deb, compress = xz, decompress = unxz) {
  const members = readMembers(deb)
  const names = members.map((m) => m.name)
  const [binary, control, data] = members
  if (
    members.length !== 3 ||
    binary?.name !== 'debian-binary' ||
    !/^control\.tar(\.\w+)?$/.test(control?.name ?? '') ||
    !/^data\.tar\.(gz|xz)$/.test(data?.name ?? '')
  )
    throw new Error(`members ${names.join(', ')}: expected debian-binary, control.tar.*, data.tar.gz`)
  if (!data || data.name === 'data.tar.xz') return null
  const tar = zlib.gunzipSync(data.data)
  const packed = compress(tar)
  if (!decompress(packed).equals(tar)) throw new Error('data.tar.xz does not decompress to data.tar')
  const header = Buffer.from(data.header)
  const slash = header.toString('latin1', 0, 16).trimEnd().endsWith('/')
  header.fill(0x20, 0, 16).write(`data.tar.xz${slash ? '/' : ''}`, 0, 'latin1')
  header.fill(0x20, 48, 58).write(String(packed.length), 48, 'latin1')
  /** @type {Buffer[]} */
  const parts = [AR_MAGIC]
  for (const m of [...members.slice(0, 2), { ...data, header, data: packed }]) {
    parts.push(m.header, m.data)
    if (m.data.length % 2) parts.push(Buffer.from('\n', 'latin1'))
  }
  return Buffer.concat(parts)
}

/** Every deb under the bundle directories' deb/ folders. @param {string[]} bundleDirs @returns {string[]} */
export function findDebs(bundleDirs) {
  /** @type {string[]} */
  const debs = []
  for (const dir of bundleDirs) {
    const sub = path.join(dir, 'deb')
    if (!fs.existsSync(sub)) continue
    for (const name of fs.readdirSync(sub).sort())
      if (name.endsWith('.deb') && fs.statSync(path.join(sub, name)).isFile()) debs.push(path.join(sub, name))
  }
  return debs
}

const USAGE = `Usage: node scripts/deb-xz.mjs [--bundle-dir <dir>]... [<file.deb>...]

Recompresses the payload of tauri's deb (data.tar.gz) with xz -6 (data.tar.xz), the same tar byte for byte, so the deb
meets the size budget. Debs whose payload is already xz are left alone.

  --bundle-dir <dir>  a tauri bundle directory (repeatable; default: every release bundle dir of the target)
  --help

Exit codes: 0 every deb is xz, 1 a deb could not be recompressed or there is none, 2 bad usage.`

/** @param {string[]} argv @param {NodeJS.ProcessEnv} [env] @returns {number} */
export function main(argv, env = process.env) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'bundle-dir': { type: 'string', multiple: true, default: [] },
        help: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    console.error(`deb-xz: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  const bundleDirs = values['bundle-dir'].length
    ? values['bundle-dir'].map((d) => path.resolve(d))
    : defaultBundleDirs(path.resolve(ROOT, env.CARGO_TARGET_DIR ?? 'target'))
  const debs = positionals.length ? positionals.map((f) => path.resolve(f)) : findDebs(bundleDirs)
  if (!debs.length) {
    console.error(`deb-xz: no deb under ${bundleDirs.join(', ') || 'the target directory'}`)
    return 1
  }
  let ok = true
  for (const file of debs) {
    const shown = path.relative(process.cwd(), file) || file
    try {
      const before = fs.readFileSync(file)
      const after = recompressDeb(before)
      if (!after) {
        console.log(`deb-xz: ${shown}: data.tar.xz already`)
        continue
      }
      const temp = `${file}.deb-xz.tmp`
      fs.writeFileSync(temp, after)
      fs.renameSync(temp, file)
      console.log(
        `deb-xz: ${shown}: data.tar.gz → data.tar.xz (xz ${XZ_ARGS.join(' ')}), ` +
          `${before.length.toLocaleString('en-US')} B → ${after.length.toLocaleString('en-US')} B`,
      )
    } catch (error) {
      ok = false
      console.error(`deb-xz: ${shown}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
