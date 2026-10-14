// @ts-check
// node --test .github/actions/core/assert-core.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { QF_RELEASE_NOTE_PREFIX } from '../../../scripts/check-artifacts.mjs'
import { assertCore } from './assert-core.mjs'

/** @type {typeof import('node:sqlite') | null} */
let sqlite = null
try {
  sqlite = await import('node:sqlite')
} catch {
  sqlite = null
}

const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-assert-core-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

/** @param {string} name @param {{ source?: string, tables?: string[], licenceNote?: string }} options */
function makeCore(name, { source, tables = ['mushaf', 'ayah', 'word'], licenceNote }) {
  if (!sqlite) throw new Error('node:sqlite unavailable')
  const file = path.join(work, name)
  const db = new sqlite.DatabaseSync(file)
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID')
  for (const t of tables) db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY)`)
  const insert = db.prepare('INSERT INTO meta VALUES (?, ?)')
  insert.run('schema_version', '1')
  if (source) insert.run('source', source)
  if (licenceNote) insert.run('licence_note', licenceNote)
  db.close()
  return file
}

describe('assert-core', { skip: sqlite ? false : 'node:sqlite is not available' }, () => {
  it('accepts a real core.db with the expected source', () => {
    const file = makeCore('ok.db', { source: 'qdc' })
    const result = assertCore(file, { source: 'qdc', minBytes: 1024 })
    assert.equal(result.ok, true, result.lines.join('\n'))
    assert.ok(result.lines.some((l) => /^source\s+qdc$/.test(l)))
  })

  it("--release takes a QUL build or a QDC one built for release with QF's permission", () => {
    const qul = makeCore('release-qul.db', { source: 'qul' })
    assert.equal(assertCore(qul, { release: true, minBytes: 0 }).ok, true)
    const permitted = makeCore('release-qdc.db', {
      source: 'qdc',
      licenceNote: `${QF_RELEASE_NOTE_PREFIX} (…)`,
    })
    assert.equal(assertCore(permitted, { release: true, minBytes: 0 }).ok, true)
    const development = makeCore('dev-qdc.db', {
      source: 'qdc',
      licenceNote: 'DEVELOPMENT BUILD, NEVER DISTRIBUTE',
    })
    assert.match(
      assertCore(development, { release: true, minBytes: 0 }).lines.at(-1) ?? '',
      /"qdc" and this is not a release build/,
    )
  })

  it('refuses the placeholder, a missing file, a wrong source and a non-core database', () => {
    const placeholder = path.join(work, 'placeholder.db')
    fs.writeFileSync(placeholder, '')
    assert.match(
      assertCore(placeholder, { minBytes: 1024 }).lines.at(-1) ?? '',
      /0 bytes, not more than 1024/,
    )
    assert.match(assertCore(path.join(work, 'nope.db'), { minBytes: 0 }).lines.at(-1) ?? '', /does not exist/)
    const qdc = makeCore('qdc.db', { source: 'qdc' })
    assert.match(
      assertCore(qdc, { source: 'qul', minBytes: 0 }).lines.at(-1) ?? '',
      /meta\.source is "qdc", expected "qul"/,
    )
    const other = makeCore('other.db', { source: 'qdc', tables: ['entry'] })
    assert.match(
      assertCore(other, { minBytes: 0 }).lines.at(-1) ?? '',
      /lacks the core tables mushaf, ayah, word/,
    )
    const text = path.join(work, 'text.db')
    fs.writeFileSync(text, 'x'.repeat(4096))
    assert.match(assertCore(text, { minBytes: 0 }).lines.at(-1) ?? '', /not a readable SQLite database/)
  })
})
