// @ts-check
// node --test .github/actions/size-check/size-check.test.mjs
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { CRATES_IO_SOURCES, main, releaseRustflags } from './size-check.mjs'

const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-size-check-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

describe('size-check', () => {
  it('moves core.db aside (reporting the path), refuses a second aside, and moves it back', () => {
    const core = path.join(work, 'repo', 'core.db')
    fs.mkdirSync(path.dirname(core), { recursive: true })
    const content = Buffer.concat([Buffer.alloc(1024 * 1024, 7), randomBytes(64 * 1024)])
    fs.writeFileSync(core, content)
    const state = path.join(work, 'state')
    const output = path.join(work, 'github-output')
    assert.equal(main(['aside', '--core', core, '--state', state], { GITHUB_OUTPUT: output }), 0)
    assert.equal(fs.existsSync(core), false, 'moved aside')
    assert.equal(fs.readFileSync(output, 'utf8'), `aside=${path.join(state, 'core.db')}\n`)
    assert.deepEqual(fs.readFileSync(path.join(state, 'core.db')), content)
    fs.writeFileSync(core, '') // what build.rs writes
    assert.equal(
      main(['aside', '--core', core, '--state', state], {}),
      1,
      'the placeholder is never moved aside',
    )
    assert.equal(main(['restore', '--state', state], {}), 0)
    assert.deepEqual(fs.readFileSync(core), content)
    assert.equal(main(['restore', '--state', state], {}), 0, 'a second restore is a no-op')
    assert.equal(main(['aside', '--core', core, '--state', state], {}), 0, 'aside again after a restore')
    fs.writeFileSync(core, Buffer.alloc(10, 1))
    assert.equal(
      main(['aside', '--core', core, '--state', state], {}),
      1,
      'a second aside never overwrites the first',
    )
    assert.equal(main(['restore', '--state', state], {}), 0)
    assert.deepEqual(fs.readFileSync(core), content)
  })

  it('refuses a missing or placeholder core.db and bad usage', () => {
    const placeholder = path.join(work, 'placeholder.db')
    fs.writeFileSync(placeholder, '')
    assert.equal(main(['aside', '--core', placeholder, '--state', path.join(work, 's2')], {}), 1)
    assert.equal(
      main(['aside', '--core', path.join(work, 'none.db'), '--state', path.join(work, 's3')], {}),
      1,
    )
    assert.equal(main(['report'], {}), 2)
    assert.equal(main(['bogus'], {}), 2)
    assert.equal(main(['--nope'], {}), 2)
  })

  it('remaps the cargo registry sources in release RUSTFLAGS, crates.io last, after any RUSTFLAGS', () => {
    const posix = '/Users/runner/.cargo/registry/src'
    assert.equal(
      releaseRustflags({}, '/Users/runner', path.posix),
      `--remap-path-prefix=${posix}/= --remap-path-prefix=${posix}/${CRATES_IO_SOURCES}/=`,
    )
    const win = 'C:\\Users\\runneradmin\\.cargo\\registry\\src'
    assert.equal(
      releaseRustflags(
        { CARGO_HOME: 'C:\\Users\\runneradmin\\.cargo', RUSTFLAGS: ' -Dwarnings ' },
        'C:\\Users\\someone',
        path.win32,
      ),
      `-Dwarnings --remap-path-prefix=${win}\\= --remap-path-prefix=${win}\\${CRATES_IO_SOURCES}\\=`,
    )
    assert.equal(releaseRustflags({}, '/home/a b', path.posix), null, 'RUSTFLAGS cannot carry whitespace')
    assert.equal(main(['rustflags'], { CARGO_HOME: path.join(work, 'cargo') }), 0)
  })
})
