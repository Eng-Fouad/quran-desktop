// @ts-check
// node --test .github/actions/drift-check/drift-check.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { after, describe, it } from 'node:test'
import { checkDrift, describeDrift, main } from './drift-check.mjs'

const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-drift-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

let n = 0
function freshDir() {
  const dir = path.join(work, `case-${++n}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A generator: `node -e <script>` with the script writing files relative to cwd. @param {string} script */
const node = (script) => ['--', process.execPath, '-e', script]

describe('drift-check', () => {
  it('passes when the generator reproduces the committed file (LF vs CRLF ignored)', () => {
    const dir = freshDir()
    fs.writeFileSync(path.join(dir, 'gen.json'), '[\r\n  1\r\n]\r\n')
    const code = main(
      ['--path', 'gen.json', ...node("require('fs').writeFileSync('gen.json','[\\n  1\\n]\\n')")],
      {},
      dir,
    )
    assert.equal(code, 0)
    assert.equal(
      fs.readFileSync(path.join(dir, 'gen.json'), 'utf8'),
      '[\r\n  1\r\n]\r\n',
      'original bytes kept',
    )
  })

  it('fails on a changed, created or deleted file and always restores the originals', () => {
    const dir = freshDir()
    fs.writeFileSync(path.join(dir, 'a.json'), '[]\n')
    fs.writeFileSync(path.join(dir, 'b.json'), 'keep\n')
    const changed = main(
      ['--path', 'a.json', ...node("require('fs').writeFileSync('a.json','[1]\\n')")],
      {},
      dir,
    )
    assert.equal(changed, 1)
    assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), '[]\n')
    const created = main(
      ['--path', 'new.json', ...node("require('fs').writeFileSync('new.json','x')")],
      {},
      dir,
    )
    assert.equal(created, 1)
    assert.equal(fs.existsSync(path.join(dir, 'new.json')), false)
    const deleted = main(['--path', 'b.json', ...node("require('fs').rmSync('b.json')")], {}, dir)
    assert.equal(deleted, 1)
    assert.equal(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'), 'keep\n')
  })

  it('fails when the generator fails, and restores what it half-wrote', () => {
    const dir = freshDir()
    fs.writeFileSync(path.join(dir, 'a.json'), 'orig')
    const code = main(
      ['--path', 'a.json', ...node("require('fs').writeFileSync('a.json','partial'); process.exit(3)")],
      {},
      dir,
    )
    assert.equal(code, 1)
    assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'orig')
  })

  it('takes the command and paths from the environment (composite action)', () => {
    const dir = freshDir()
    fs.writeFileSync(path.join(dir, 'x.txt'), 'same')
    const env = { QD_DRIFT_PATHS: '\nx.txt\n', QD_DRIFT_COMMAND: `"${process.execPath}" -e "0"` }
    assert.equal(main(['--name', 'x'], env, dir), 0)
    assert.equal(main([], {}, dir), 2)
  })

  it('restores even when the generator throws', () => {
    const dir = freshDir()
    const file = path.join(dir, 'f.txt')
    fs.writeFileSync(file, 'one')
    assert.throws(() =>
      checkDrift([file], () => {
        fs.writeFileSync(file, 'two')
        throw new Error('boom')
      }),
    )
    assert.equal(fs.readFileSync(file, 'utf8'), 'one')
  })

  it('describes the first difference compactly', () => {
    const lines = describeDrift('a\nb\nc\nd\n', 'a\nB\nc\nd\n')
    assert.match(
      lines[0] ?? '',
      /first difference at line 2; committed 5 lines, regenerated 5 lines \(1 committed line\(s\) replaced by 1\)/,
    )
    assert.deepEqual(lines.slice(1), ['  -     2 | b', '  +     2 | B'])
    assert.deepEqual(describeDrift(null, 'x'), ['the generator created this file, which is not committed'])
  })
})
