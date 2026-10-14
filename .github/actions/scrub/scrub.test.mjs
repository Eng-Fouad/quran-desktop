// @ts-check
// node --test .github/actions/scrub/scrub.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { main, scrubTargets } from './scrub.mjs'

const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-scrub-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

/** @param {string} root @param {string} rel */
function put(root, rel) {
  const file = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'x')
}

describe('scrub', () => {
  const root = path.join(work, 'repo')
  for (const rel of [
    'src-tauri/resources/core.db',
    'src-tauri/resources/core.db-wal',
    'src-tauri/resources/catalog.json',
    'src/lib/ipc/mock/fixtures/index.json',
    'data/cache/qdc/chapters.json',
    'data/dev-packs/mushaf/v2/p1.woff2',
    'data/sources/qul/manifest.toml',
    'target/debug/data/core.db',
    'target/debug/data/catalog.json',
    'target/debug/deps/libfoo.rlib',
    'target/release/bundle/nsis/setup.exe',
    'target/universal-apple-darwin/release/bundle/dmg/x.dmg',
    'target/x86_64-pc-windows-msvc/release/data/core.db',
  ])
    put(root, rel)

  it('finds exactly the QF-derived and bundle outputs', () => {
    const found = scrubTargets(root, path.join(root, 'target'))
      .map((p) => path.relative(root, p).split(path.sep).join('/'))
      .sort()
    assert.deepEqual(found, [
      'data/cache',
      'data/dev-packs',
      'src-tauri/resources/core.db',
      'src-tauri/resources/core.db-wal',
      'src/lib/ipc/mock/fixtures',
      'target/debug/data/core.db',
      'target/release/bundle',
      'target/universal-apple-darwin/release/bundle',
      'target/x86_64-pc-windows-msvc/release/data/core.db',
    ])
  })

  it('refuses to delete outside GitHub Actions, dry-runs, then removes in CI', () => {
    assert.equal(main(['--root', root], {}), 2)
    assert.equal(main(['--root', root, '--dry-run'], {}), 0)
    assert.ok(fs.existsSync(path.join(root, 'src-tauri', 'resources', 'core.db')))
    assert.equal(main(['--root', root], { GITHUB_ACTIONS: 'true' }), 0)
    assert.deepEqual(scrubTargets(root, path.join(root, 'target')), [])
    for (const kept of [
      'src-tauri/resources/catalog.json',
      'data/sources/qul/manifest.toml',
      'target/debug/deps/libfoo.rlib',
    ])
      assert.ok(fs.existsSync(path.join(root, ...kept.split('/'))), kept)
  })
})
