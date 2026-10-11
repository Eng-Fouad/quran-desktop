// @ts-check
// node --test .github/actions/policy/policy.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { parseLines, runPolicy, triggersOf } from './policy.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-policy-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

const SHA = 'a'.repeat(40)
let n = 0

/**
 * A minimal repository: a guarded upload action, an icon, and the given workflow files.
 * @param {Record<string, string>} files relative path → content
 */
function repo(files) {
  const dir = path.join(work, `repo-${++n}`)
  const write = (/** @type {string} */ rel, /** @type {string} */ text) => {
    const file = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  write('src-tauri/icons/icon.png', 'brand icon')
  write(
    '.github/actions/upload/action.yml',
    `name: Upload
runs:
  using: composite
  steps:
    - shell: bash
      run: node "$GITHUB_WORKSPACE/scripts/check-artifacts.mjs" --from-env X
    - uses: actions/upload-artifact@${SHA} # v7.0.1
      with:
        path: x
`,
  )
  for (const [rel, text] of Object.entries(files)) write(rel, text)
  return dir
}

/** @param {string} dir @param {Parameters<typeof runPolicy>[1]} [options] */
function failures(dir, options) {
  return Object.fromEntries(
    runPolicy(dir, options)
      .filter((c) => c.problems.length > 0)
      .map((c) => [c.name, c.problems]),
  )
}

const GOOD = `name: CI
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
      - uses: ./.github/actions/core
      - name: Cache
        if: github.event.repository.private
        uses: actions/cache/restore@${SHA} # v6.1.0
        with:
          path: |
            data/cache
          key: k
      - run: |
          echo "uses: actions/upload-artifact@v4 inside a script is only text"
`

describe('policy', () => {
  it('passes on this repository', () => {
    assert.deepEqual(failures(ROOT), {})
  })

  it('passes on a well-formed workflow', () => {
    assert.deepEqual(failures(repo({ '.github/workflows/ci.yml': GOOD })), {})
  })

  it('requires SHA pins with a version comment, and docker digests', () => {
    const wf = GOOD.replace(`actions/checkout@${SHA} # v7.0.1`, 'actions/checkout@v7').replace(
      '- uses: ./.github/actions/core',
      `- uses: ./.github/actions/core\n      - uses: owner/tool@${SHA}\n      - uses: docker://alpine:3.20`,
    )
    const reusable = `${wf}  reuse:\n    uses: owner/repo/.github/workflows/x.yml@main\n`
    const problems = failures(repo({ '.github/workflows/ci.yml': reusable }))['pinned-actions'] ?? []
    assert.equal(problems.length, 4, problems.join('\n'))
    assert.match(problems[0] ?? '', /actions\/checkout@v7 is not pinned to a full commit SHA/)
    assert.match(problems[1] ?? '', /needs a "# vX\.Y\.Z" comment/)
    assert.match(problems[2] ?? '', /docker:\/\/alpine:3\.20 is not pinned by digest/)
    assert.match(problems[3] ?? '', /owner\/repo\/\.github\/workflows\/x\.yml@main is not pinned/)
  })

  it('allows uploads only through the guarded action, after the guard', () => {
    const direct = GOOD.replace(
      '- uses: ./.github/actions/core',
      `- uses: ./.github/actions/core\n      - uses: actions/upload-artifact@${SHA} # v7.0.1\n        with:\n          path: x`,
    )
    assert.match(
      (failures(repo({ '.github/workflows/ci.yml': direct }))['guarded-uploads'] ?? []).join(),
      /ci\.yml:\d+: upload through \.\/\.github\/actions\/upload/,
    )
    const reordered = repo({
      '.github/workflows/ci.yml': GOOD,
      '.github/actions/upload/action.yml': `runs:
  using: composite
  steps:
    - uses: actions/upload-artifact@${SHA} # v7.0.1
      with:
        path: x
    - shell: bash
      run: node scripts/check-artifacts.mjs x
`,
    })
    assert.match((failures(reordered)['guarded-uploads'] ?? []).join(), /must come first/)
  })

  it('allows release assets only through the guarded release upload, and drafts only', () => {
    const RELEASE_UPLOAD = `runs:
  using: composite
  steps:
    - shell: bash
      run: node "$GITHUB_WORKSPACE/scripts/check-artifacts.mjs" --release --verified m.json --from-env F
    - shell: bash
      run: gh release upload "$TAG" a.exe --clobber
`
    const release = (/** @type {string} */ steps) => `name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-22.04
    permissions:
      contents: write
    steps:
${steps}`
    const good = repo({
      '.github/actions/release-upload/action.yml': RELEASE_UPLOAD,
      '.github/workflows/release.yml': release(`      - run: |
          gh release create "$TAG" --draft --verify-tag \\
            --notes-file notes.md
      - uses: tauri-apps/tauri-action@${SHA} # v1.0.0
        with:
          args: --target universal-apple-darwin
          uploadWorkflowArtifacts: false
      - uses: ./.github/actions/release-upload
`),
    })
    assert.deepEqual(failures(good), {})

    const bad = repo({
      '.github/actions/release-upload/action.yml': RELEASE_UPLOAD.replace('--release ', ''),
      '.github/workflows/release.yml': release(`      - run: gh release upload "$TAG" x.dmg
      - run: gh release create "$TAG" --notes x
      - run: gh release edit "$TAG" --draft=false
      - uses: tauri-apps/tauri-action@${SHA} # v1.0.0
        with:
          tagName: v__VERSION__
          uploadPlainBinary: true
      - uses: softprops/action-gh-release@${SHA} # v2.0.0
`),
    })
    const problems = (failures(bad)['release-uploads'] ?? []).join('\n')
    assert.match(
      problems,
      /release\.yml:\d+: upload release assets through \.\/\.github\/actions\/release-upload/,
    )
    assert.match(problems, /gh release create without --draft/)
    assert.match(problems, /never edit or publish a release/)
    assert.match(problems, /tauri-action `tagName` uploads without the guard/)
    assert.match(problems, /tauri-action `uploadPlainBinary` uploads without the guard/)
    assert.match(problems, /softprops\/action-gh-release uploads release assets unguarded/)
    assert.match(
      problems,
      /release-upload\/action\.yml:\d+: the check-artifacts --release step must come first/,
    )
  })

  it('refuses QF-derived cache paths and an unguarded data/cache', () => {
    const wf = GOOD.replace(
      '      - run: |',
      `      - uses: actions/cache@${SHA} # v6.1.0
        with:
          path: src-tauri/resources/core.db
          key: k
      - uses: actions/cache/save@${SHA} # v6.1.0
        with:
          path: data/cache
          key: k
      - uses: Swatinem/rust-cache@${SHA} # v2.9.2
        with:
          cache-directories: |
            src/lib/ipc/mock/fixtures
      - run: |`,
    )
    const problems = failures(repo({ '.github/workflows/ci.yml': wf })).caches ?? []
    assert.equal(problems.length, 3, problems.join('\n'))
    assert.match(problems.join('\n'), /core\.db/)
    assert.match(problems.join('\n'), /data\/cache may be cached only under/)
    assert.match(problems.join('\n'), /fixtures/)
  })

  it('requires the fork guard on pull_request jobs that build core.db, not on tag workflows', () => {
    const wf = GOOD.replace(/ {4}if: github\.event_name.*\n/, '')
    assert.match(
      (failures(repo({ '.github/workflows/ci.yml': wf }))['fork-guard'] ?? []).join(),
      /job "test" builds core\.db/,
    )
    const runBuildCore = GOOD.replace(/ {4}if: github\.event_name.*\n/, '').replace(
      '- uses: ./.github/actions/core',
      '- run: cargo xtask build-core --source qdc',
    )
    assert.ok(failures(repo({ '.github/workflows/ci.yml': runBuildCore }))['fork-guard'])
    const release = `name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: read
jobs:
  release:
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      - run: cargo xtask build-core --source qul
`
    assert.deepEqual(failures(repo({ '.github/workflows/release.yml': release })), {})
  })

  it('refuses pull_request_target, missing permissions and write grants in pull_request workflows', () => {
    const target = GOOD.replace('  pull_request:\n', '  pull_request:\n  pull_request_target:\n')
    assert.match(
      (failures(repo({ '.github/workflows/ci.yml': target })).triggers ?? []).join(),
      /pull_request_target/,
    )
    const flow = GOOD.replace(/on:\n {2}push:\n {2}pull_request:\n/, 'on: [push, workflow_run]\n')
    assert.match((failures(repo({ '.github/workflows/ci.yml': flow })).triggers ?? []).join(), /workflow_run/)
    const missing = GOOD.replace('permissions:\n  contents: read\n', '')
    assert.match(
      (failures(repo({ '.github/workflows/ci.yml': missing })).permissions ?? []).join(),
      /declare top-level permissions/,
    )
    const write = GOOD.replace('  contents: read\n', '  contents: read\n  pull-requests: write\n')
    assert.match(
      (failures(repo({ '.github/workflows/ci.yml': write })).permissions ?? []).join(),
      /must not grant write/,
    )
    const writeAll = GOOD.replace('permissions:\n  contents: read\n', 'permissions: write-all\n')
    assert.ok(failures(repo({ '.github/workflows/ci.yml': writeAll })).permissions)
  })

  it("refuses Tauri's default icon and a missing icon", () => {
    const dir = repo({ '.github/workflows/ci.yml': GOOD })
    const sha = createHash('sha256').update('brand icon').digest('hex')
    assert.match((failures(dir, { defaultIconSha256: sha }).icon ?? []).join(), /default icon/)
    fs.rmSync(path.join(dir, 'src-tauri', 'icons', 'icon.png'))
    assert.match((failures(dir).icon ?? []).join(), /missing/)
  })

  it('parses triggers in every YAML form', () => {
    assert.deepEqual(triggersOf(parseLines('on: push\njobs: {}\n')), ['push'])
    assert.deepEqual(triggersOf(parseLines('on: [push, pull_request]\n')), ['push', 'pull_request'])
    assert.deepEqual(triggersOf(parseLines('on:\n  - push\n  - pull_request\n')), ['push', 'pull_request'])
    assert.deepEqual(triggersOf(parseLines("'on':\n  push:\n    branches: [main]\n  pull_request:\n")), [
      'push',
      'pull_request',
    ])
  })
})
