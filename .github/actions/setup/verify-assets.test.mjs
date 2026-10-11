// @ts-check
// node --test .github/actions/setup/verify-assets.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { parseAssetsLock, verifyAssets } from './verify-assets.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-verify-assets-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex')

describe('verify-assets', () => {
  it('parses the committed xtask/assets.lock', () => {
    const assets = parseAssetsLock(fs.readFileSync(path.join(ROOT, 'xtask', 'assets.lock'), 'utf8'))
    assert.ok(assets.length >= 1)
    const font = assets.find((a) => a.file === 'public/fonts/KFGQPC-Hafs-V30.ttf')
    assert.equal(font?.bytes, 301356)
    assert.match(font?.sha256 ?? '', /^[0-9a-f]{64}$/)
  })

  it('accepts a matching file and reports a missing, short or different one', () => {
    const lock = `# comment\n\n[[asset]]\nfile = "a/x.bin"\nsource = "https://example.invalid/x"\nbytes = 5\nsha256 = "${sha('hello')}"\n`
    const assets = parseAssetsLock(lock)
    assert.deepEqual(verifyAssets(assets, work), ['a/x.bin: missing'])
    fs.mkdirSync(path.join(work, 'a'), { recursive: true })
    fs.writeFileSync(path.join(work, 'a', 'x.bin'), 'hello')
    assert.deepEqual(verifyAssets(assets, work), [])
    fs.writeFileSync(path.join(work, 'a', 'x.bin'), 'hell')
    assert.match(verifyAssets(assets, work)[0] ?? '', /4 bytes, the lock pins 5/)
    fs.writeFileSync(path.join(work, 'a', 'x.bin'), 'HELLO')
    assert.match(verifyAssets(assets, work)[0] ?? '', /sha256 [0-9a-f]{64}, the lock pins/)
  })

  it('rejects malformed locks', () => {
    assert.throws(() => parseAssetsLock('file = "x"\n'), /line 1/)
    assert.throws(() => parseAssetsLock('[[asset]]\nfile = "x"\nbytes = 1\n'), /needs file/)
    assert.throws(() => parseAssetsLock('[[asset]]\nfile = "x"\nbytes = 1\nsha256 = "abc"\n'), /64 hex/)
    assert.throws(
      () => parseAssetsLock(`[[asset]]\nfile = "../x"\nbytes = 1\nsha256 = "${sha('x')}"\n`),
      /relative/,
    )
  })
})
