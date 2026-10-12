// @ts-check
// node --test scripts/deb-xz.test.mjs
//
// The ar rewrite runs everywhere with a stand-in compressor; the real xz round trip needs the xz tool (every Linux CI
// runner has it) and is skipped without it.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import zlib from 'node:zlib'
import { unxz } from './check-artifacts.mjs'
import { findDebs, main, readMembers, recompressDeb } from './deb-xz.mjs'

const haveXz = spawnSync('xz', ['--version']).status === 0
const needsXz = haveXz ? {} : { skip: 'xz is not installed' }

const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-deb-xz-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
let counter = 0
const fresh = () => {
  const dir = path.join(work, `case-${++counter}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A 60-byte ar member header as tauri writes it (no trailing slash). @param {string} name @param {number} size */
function header(name, size) {
  const h = Buffer.alloc(60, 0x20)
  h.write(name, 0, 'latin1')
  h.write('1791793859', 16, 'latin1')
  h.write('0', 28, 'latin1')
  h.write('0', 34, 'latin1')
  h.write('100644', 40, 'latin1')
  h.write(String(size), 48, 'latin1')
  h.write('`\n', 58, 'latin1')
  return h
}

/** @param {{ name: string, data: Buffer | string }[]} members */
function ar(members) {
  /** @type {Buffer[]} */
  const parts = [Buffer.from('!<arch>\n', 'latin1')]
  for (const m of members) {
    const data = Buffer.from(m.data)
    parts.push(header(m.name, data.length), data)
    if (data.length % 2) parts.push(Buffer.from('\n'))
  }
  return Buffer.concat(parts)
}

// Stands for a tar: odd-sized, so the ar padding is exercised.
const TAR = Buffer.from('./usr/bin/quran-desktop and some more payload bytes, odd length!')
const CONTROL = zlib.gzipSync(Buffer.from('Package: quran\n'))
const tauriDeb = () =>
  ar([
    { name: 'debian-binary', data: '2.0\n' },
    { name: 'control.tar.gz', data: CONTROL },
    { name: 'data.tar.gz', data: zlib.gzipSync(TAR) },
  ])
/** A reversible stand-in for xz. */
const fakeXz = (/** @type {Buffer} */ b) => Buffer.concat([Buffer.from('XZ'), b])
const fakeUnxz = (/** @type {Buffer} */ b) => b.subarray(2)

describe('readMembers', () => {
  it('lists a deb and refuses what dpkg-deb and tauri never write', () => {
    const members = readMembers(tauriDeb())
    assert.deepEqual(
      members.map((m) => m.name),
      ['debian-binary', 'control.tar.gz', 'data.tar.gz'],
    )
    assert.equal(members[0]?.data.toString(), '2.0\n')
    assert.throws(() => readMembers(Buffer.from('PK\x03\x04')), /not an ar archive/)
    assert.throws(() => readMembers(tauriDeb().subarray(0, 100)), /truncated/)
    const gnu = ar([{ name: '//', data: 'a-long-name.txt/\n' }])
    assert.throws(() => readMembers(gnu), /unexpected ar member name/)
  })
})

describe('recompressDeb', () => {
  it('swaps data.tar.gz for data.tar.xz and keeps everything else', () => {
    const before = tauriDeb()
    const after = recompressDeb(before, fakeXz, fakeUnxz)
    assert.ok(after)
    const old = readMembers(before)
    const members = readMembers(after)
    assert.deepEqual(
      members.map((m) => m.name),
      ['debian-binary', 'control.tar.gz', 'data.tar.xz'],
    )
    for (const i of [0, 1]) {
      assert.ok(members[i]?.header.equals(old[i]?.header ?? Buffer.alloc(0)), `member ${i} header`)
      assert.ok(members[i]?.data.equals(old[i]?.data ?? Buffer.alloc(0)), `member ${i} data`)
    }
    const data = members[2]
    assert.ok(data)
    assert.ok(data.data.equals(fakeXz(TAR)))
    assert.equal(data.header.toString('latin1', 0, 16), 'data.tar.xz     ')
    assert.equal(data.header.toString('latin1', 16, 48), old[2]?.header.toString('latin1', 16, 48))
    assert.equal(Number(data.header.toString('latin1', 48, 58).trim()), fakeXz(TAR).length)
    // Already xz: nothing to do.
    assert.equal(recompressDeb(after, fakeXz, fakeUnxz), null)
  })

  it('keeps a trailing slash in the member name (GNU ar style)', () => {
    const deb = tauriDeb()
    const at = deb.indexOf('data.tar.gz')
    deb.write('data.tar.gz/', at, 'latin1')
    const after = recompressDeb(deb, fakeXz, fakeUnxz)
    const data = readMembers(after ?? Buffer.alloc(0))[2]
    assert.equal(data?.header.toString('latin1', 0, 16), 'data.tar.xz/    ')
  })

  it('refuses another layout and a round trip that does not give the tar back', () => {
    const noData = ar([
      { name: 'debian-binary', data: '2.0\n' },
      { name: 'control.tar.gz', data: CONTROL },
    ])
    assert.throws(() => recompressDeb(noData, fakeXz, fakeUnxz), /expected debian-binary/)
    const zst = ar([
      { name: 'debian-binary', data: '2.0\n' },
      { name: 'control.tar.zst', data: 'x' },
      { name: 'data.tar.zst', data: 'y' },
    ])
    assert.throws(() => recompressDeb(zst, fakeXz, fakeUnxz), /expected debian-binary/)
    assert.throws(
      () => recompressDeb(tauriDeb(), fakeXz, () => Buffer.from('other')),
      /does not decompress to data\.tar/,
    )
  })

  it('compresses with the real xz, and xz gives the same tar back', needsXz, () => {
    const big = Buffer.alloc(256 * 1024, 'quran ')
    const deb = ar([
      { name: 'debian-binary', data: '2.0\n' },
      { name: 'control.tar.gz', data: CONTROL },
      { name: 'data.tar.gz', data: zlib.gzipSync(big) },
    ])
    const after = recompressDeb(deb)
    const data = readMembers(after ?? Buffer.alloc(0))[2]
    assert.equal(data?.name, 'data.tar.xz')
    assert.ok(unxz(data?.data ?? Buffer.alloc(0)).equals(big))
    assert.ok((data?.data.length ?? Infinity) < zlib.gzipSync(big).length)
  })
})

describe('main', () => {
  it('finds the debs of the bundle directories and rewrites them in place', needsXz, () => {
    const bundle = path.join(fresh(), 'target', 'release', 'bundle')
    const file = path.join(bundle, 'deb', 'Quran_0.1.0_amd64.deb')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, tauriDeb())
    fs.writeFileSync(path.join(bundle, 'deb', 'notes.txt'), 'not a deb')
    assert.deepEqual(findDebs([bundle, path.join(bundle, 'missing')]), [file])
    assert.equal(main(['--bundle-dir', bundle]), 0)
    assert.equal(readMembers(fs.readFileSync(file))[2]?.name, 'data.tar.xz')
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['Quran_0.1.0_amd64.deb', 'notes.txt'])
    // A second run leaves it alone; a named file works too.
    const xzBytes = fs.readFileSync(file)
    assert.equal(main([file]), 0)
    assert.ok(fs.readFileSync(file).equals(xzBytes))
  })

  it('fails without a deb, on a broken deb and on bad usage', () => {
    assert.equal(main(['--bundle-dir', fresh()]), 1)
    const broken = path.join(fresh(), 'broken.deb')
    fs.writeFileSync(broken, 'not an ar archive')
    assert.equal(main([broken]), 1)
    assert.equal(main(['--no-such-flag']), 2)
  })
})
