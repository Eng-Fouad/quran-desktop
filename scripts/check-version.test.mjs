// @ts-check
// node --test scripts/check-version.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { checkTag, declaredVersions } from './check-version.mjs'

const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-check-version-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

/** @param {Record<string, string>} files */
function repo(files) {
  const root = fs.mkdtempSync(path.join(work, 'repo-'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  return root
}

describe('check-version', () => {
  it('reads the three declared versions', () => {
    const root = repo({
      'package.json': JSON.stringify({ version: '1.2.3' }),
      'src-tauri/tauri.conf.json': JSON.stringify({ version: '1.2.3' }),
      'Cargo.toml':
        '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "1.2.4"\nedition = "2024"\n\n[workspace.dependencies]\nversion = "9"\n',
    })
    assert.deepEqual(
      declaredVersions(root).map((d) => d.version),
      ['1.2.3', '1.2.3', '1.2.4'],
    )
  })

  it('agrees with this repository', () => {
    const versions = new Set(declaredVersions().map((d) => d.version))
    assert.equal(versions.size, 1, `the manifests disagree: ${[...versions].join(', ')}`)
    assert.deepEqual(checkTag(`v${[...versions][0]}`, declaredVersions()), [])
  })

  it('names every manifest that disagrees and rejects tags that are not v<semver>', () => {
    const declared = [
      { file: 'package.json', version: '0.1.0' },
      { file: 'Cargo.toml', version: '0.2.0' },
    ]
    assert.deepEqual(checkTag('v0.1.0', declared), ['Cargo.toml declares 0.2.0, the tag says 0.1.0'])
    assert.deepEqual(checkTag('v0.1.0-rc.1', declared).length, 2)
    for (const bad of ['0.1.0', 'v0.1', 'v01.0.0', 'release-1'])
      assert.match(checkTag(bad, declared)[0] ?? '', /is not v<semver>/, bad)
  })
})
