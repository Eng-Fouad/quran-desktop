// @ts-check
// node --test scripts/make-portable.test.mjs
//
// The zip writer, read back with check-artifacts' own zip reader and inflated, and the plan per platform. Packing a
// real exe and ditto's app zip run in release.yml, where check-bundles unpacks them.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import zlib from 'node:zlib'
import { bufferSource, listZip } from './check-artifacts.mjs'
import { crc32, main, portablePlan, zipFiles } from './make-portable.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-make-portable-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

describe('zipFiles', () => {
  it('computes the CRC-32 of the zip format', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
    assert.equal(crc32(Buffer.alloc(0)), 0)
  })

  it('writes a zip that reads back entry for entry', () => {
    const entries = [
      { name: 'Quran/quran-desktop.exe', data: Buffer.from('MZ'.padEnd(5000, 'x')) },
      { name: 'Quran/data/core.db', data: Buffer.alloc(0) },
      { name: 'Quran/data/catalog.json', data: Buffer.from('{"packs":[]}') },
    ]
    const zip = zipFiles(entries)
    const src = bufferSource(zip)
    const listed = listZip(src)
    assert.deepEqual(
      listed.map((e) => e.name),
      entries.map((e) => e.name),
    )
    for (const entry of listed) {
      const original = entries.find((e) => e.name === entry.name)?.data ?? Buffer.alloc(0)
      // The local header: 30 bytes, the name and the (empty) extra field, then the deflated data.
      const local = src.read(entry.localHeader, 30)
      const start = entry.localHeader + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      const data = zlib.inflateRawSync(src.read(start, local.readUInt32LE(18)))
      assert.deepEqual(data, original, entry.name)
      assert.equal(local.readUInt32LE(14), crc32(original), `${entry.name} CRC`)
    }
  })
})

describe('portablePlan', () => {
  const target = path.join(work, 'target')

  it('Windows: the exe and every bundle resource at its installed path, under Quran/', () => {
    const plan = portablePlan({ platform: 'win32', target, triple: 'aarch64-pc-windows-msvc', arch: 'arm64' })
    assert.equal(plan.kind, 'zip')
    if (plan.kind !== 'zip') return
    const release = path.join(target, 'aarch64-pc-windows-msvc', 'release')
    assert.equal(
      plan.out,
      path.join(release, 'bundle', 'portable', `${config.productName}_${config.version}_arm64_portable.zip`),
    )
    assert.deepEqual(plan.entries[0], {
      name: `${config.productName}/${config.mainBinaryName}.exe`,
      source: path.join(release, `${config.mainBinaryName}.exe`),
    })
    assert.deepEqual(
      plan.entries.slice(1).map((e) => e.name),
      Object.values(config.bundle.resources).map((to) => `${config.productName}/${to}`),
    )
    assert.ok(plan.entries.some((e) => e.name.endsWith('/data/core.db')))
  })

  it('macOS: the .app of the bundle, named like the dmg', () => {
    const plan = portablePlan({
      platform: 'darwin',
      target,
      triple: 'universal-apple-darwin',
      arch: 'arm64',
      universal: true,
    })
    assert.equal(plan.kind, 'app')
    if (plan.kind !== 'app') return
    const bundle = path.join(target, 'universal-apple-darwin', 'release', 'bundle')
    assert.equal(plan.app, path.join(bundle, 'macos', `${config.productName}.app`))
    assert.equal(
      plan.out,
      path.join(bundle, 'portable', `${config.productName}_${config.version}_universal.app.zip`),
    )
    const arm = portablePlan({ platform: 'darwin', target, arch: 'arm64' })
    assert.ok(arm.kind === 'app' && arm.out.endsWith(`_${config.version}_aarch64.app.zip`))
  })

  it('Linux: nothing, the AppImage is portable', () => {
    assert.equal(portablePlan({ platform: 'linux', target, arch: 'x64' }).kind, 'none')
  })
})

describe('the CLI', () => {
  it('needs --arch and reports a build that is not there', () => {
    assert.equal(main([]), 2)
    assert.equal(main(['--arch', 'ia64']), 2)
    const empty = path.join(work, 'empty-target')
    const code = main(['--arch', 'x64'], { CARGO_TARGET_DIR: empty })
    assert.equal(code, process.platform === 'linux' ? 0 : 1)
  })
})
