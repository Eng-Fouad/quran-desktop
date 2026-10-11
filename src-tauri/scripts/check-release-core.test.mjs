// @ts-check
// node --test src-tauri/scripts/check-release-core.test.mjs   (the bundling guard, check-release-core.mjs)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { main, verdict } from './check-release-core.mjs'

/** @type {typeof import('node:sqlite') | null} */
let sqlite = null
try {
  sqlite = await import('node:sqlite')
} catch {
  sqlite = null
}

describe('check-release-core', { skip: sqlite === null && 'node:sqlite is unavailable' }, () => {
  /** @type {string} */
  let dir
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-release-core-'))
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

  /** A core.db-shaped database whose `meta.source` is `source` (no meta row when `null`). */
  const core = (/** @type {string} */ name, /** @type {string | null} */ source) => {
    const file = path.join(dir, name)
    const db = new (/** @type {typeof import('node:sqlite')} */ (sqlite).DatabaseSync)(file)
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID; CREATE TABLE ayah(id INTEGER);')
    if (source !== null) db.prepare('INSERT INTO meta VALUES (?, ?)').run('source', source)
    db.close()
    return file
  }

  it('bundles a qul core.db', () => {
    const v = verdict(core('qul.db', 'qul'))
    assert.equal(v.ok, true)
    assert.equal(v.level, 'ok')
  })

  it('refuses a qdc core.db unless QD_ALLOW_DEV_CORE=1, which warns', () => {
    const file = core('qdc.db', 'qdc')
    const refused = verdict(file)
    assert.equal(refused.ok, false)
    assert.match(refused.message, /QF-derived/)
    const allowed = verdict(file, { allowDevCore: true })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.level, 'warn')
    assert.match(allowed.message, /PRIVATE PREVIEW/)
    assert.equal(main([file], {}), 1)
    assert.equal(main([file], { QD_ALLOW_DEV_CORE: '1' }), 0)
    assert.equal(main([file], { QD_ALLOW_DEV_CORE: 'yes' }), 1, 'only the exact opt-out')
  })

  it('accepts the 0-byte placeholder with a warning (CI size check)', () => {
    const file = path.join(dir, 'empty.db')
    fs.writeFileSync(file, '')
    const v = verdict(file)
    assert.equal(v.ok, true)
    assert.equal(v.level, 'warn')
  })

  it('refuses other sources, a database without meta, garbage and a missing file', () => {
    assert.equal(verdict(core('other.db', 'tanzil')).ok, false)
    assert.equal(verdict(core('nometa.db', null)).ok, false)
    const garbage = path.join(dir, 'garbage.db')
    fs.writeFileSync(garbage, 'not a database at all')
    assert.equal(verdict(garbage).ok, false)
    assert.equal(verdict(path.join(dir, 'missing.db')).ok, false)
    assert.equal(verdict(dir).ok, false)
  })
})
