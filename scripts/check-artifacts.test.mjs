// @ts-check
// node --test scripts/check-artifacts.test.mjs
//
// Builds every kind of artifact the licensing guard must refuse (or allow) in a temporary directory: SQLite databases
// written by node:sqlite (rowid and WITHOUT ROWID meta tables, overflow pages, multi-level b-trees, UTF-16, 512 B and
// 64 KiB pages), fixtures trees, data/cache, bundles, executables, fonts, and zip / ZIP64 / tar / tar.gz / gz archives
// nested inside each other.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import zlib from 'node:zlib'
import {
  bufferSource,
  BUNDLE_CHECK_FORMAT,
  confirmPrivateRepository,
  inspect,
  listAr,
  listTar,
  listZip,
  main,
  readSqliteFile,
  readSqliteInfo,
  readVarint,
} from './check-artifacts.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-artifacts.mjs')

/** @type {typeof import('node:sqlite') | null} */
let sqlite = null
try {
  sqlite = await import('node:sqlite')
} catch {
  sqlite = null // Node < 22.13 without --experimental-sqlite: the database cases are skipped
}
const needsSqlite = sqlite ? {} : { skip: 'node:sqlite is not available in this Node version' }

const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-check-artifacts-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

let counter = 0
/** A fresh directory under the temporary root. */
function freshDir() {
  const dir = path.join(work, `case-${++counter}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** @param {string} file @param {string | Buffer} content */
function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

/**
 * Writes an SQLite database with a `meta` table and returns its path.
 * @param {string} file
 * @param {{ meta?: Record<string, string>, withoutRowid?: boolean, pageSize?: number, encoding?: string,
 *   tables?: string[], fillerRows?: number, noMeta?: boolean }} [options]
 */
function makeDb(file, options = {}) {
  if (!sqlite) throw new Error('node:sqlite unavailable')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new sqlite.DatabaseSync(file)
  try {
    db.exec(`PRAGMA page_size = ${options.pageSize ?? 4096}`)
    if (options.encoding) db.exec(`PRAGMA encoding = '${options.encoding}'`)
    db.exec('PRAGMA journal_mode = DELETE')
    for (const table of options.tables ?? [])
      db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, x TEXT)`)
    if (!options.noMeta) {
      db.exec(
        `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)${options.withoutRowid ? ' STRICT, WITHOUT ROWID' : ''}`,
      )
      const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      db.exec('BEGIN')
      for (const [key, value] of Object.entries(options.meta ?? {})) insert.run(key, value)
      for (let i = 0; i < (options.fillerRows ?? 0); i++)
        insert.run(`filler_${String(i).padStart(5, '0')}`, `value ${i} `.repeat(3))
      db.exec('COMMIT')
    }
  } finally {
    db.close()
  }
  return file
}

// --- minimal archive writers (test-only) -----------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * @typedef {{ name: string, data?: Buffer | string, method?: number, encrypted?: boolean }} ZipInput
 * @param {ZipInput[]} inputs @param {{ zip64?: boolean }} [options]
 */
function makeZip(inputs, { zip64 = false } = {}) {
  /** @type {Buffer[]} */
  const parts = []
  /** @type {Buffer[]} */
  const central = []
  let offset = 0
  for (const input of inputs) {
    const raw = Buffer.from(input.data ?? '')
    const method = input.method ?? (input.name.endsWith('/') ? 0 : 8)
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw
    const name = Buffer.from(input.name, 'utf8')
    const flags = 0x800 | (input.encrypted ? 1 : 0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, body)
    const extra = zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0)
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0)
      extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(raw.length), 4)
      extra.writeBigUInt64LE(BigInt(body.length), 12)
      extra.writeBigUInt64LE(BigInt(offset), 20)
    }
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(45, 4)
    cd.writeUInt16LE(45, 6)
    cd.writeUInt16LE(flags, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc32(raw), 16)
    cd.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20)
    cd.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(extra.length, 30)
    cd.writeUInt32LE(zip64 ? 0xffffffff : offset, 42)
    central.push(cd, name, extra)
    offset += local.length + name.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const tail = []
  if (zip64) {
    const record = Buffer.alloc(56)
    record.writeUInt32LE(0x06064b50, 0)
    record.writeBigUInt64LE(44n, 4)
    record.writeUInt16LE(45, 12)
    record.writeUInt16LE(45, 14)
    record.writeBigUInt64LE(BigInt(inputs.length), 24)
    record.writeBigUInt64LE(BigInt(inputs.length), 32)
    record.writeBigUInt64LE(BigInt(cdBuf.length), 40)
    record.writeBigUInt64LE(BigInt(offset), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeBigUInt64LE(BigInt(offset + cdBuf.length), 8)
    locator.writeUInt32LE(1, 16)
    tail.push(record, locator)
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(zip64 ? 0xffff : inputs.length, 8)
  eocd.writeUInt16LE(zip64 ? 0xffff : inputs.length, 10)
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdBuf.length, 12)
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16)
  return Buffer.concat([...parts, cdBuf, ...tail, eocd])
}

/**
 * @param {{ name: string, data?: Buffer | string, type?: '0' | '5' | '2', longName?: boolean }[]} inputs
 */
function makeTar(inputs) {
  /** @type {Buffer[]} */
  const blocks = []
  /** @param {string} name @param {Buffer} data @param {string} type */
  const header = (name, data, type) => {
    const h = Buffer.alloc(512)
    h.write(name.slice(0, 100), 0, 'utf8')
    h.write('0000644\0', 100, 'latin1')
    h.write('0000000\0', 108, 'latin1')
    h.write('0000000\0', 116, 'latin1')
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
    h.write('00000000000\0', 136, 'latin1')
    h.write('        ', 148, 'latin1')
    h.write(type, 156, 'latin1')
    h.write('ustar\0', 257, 'latin1')
    h.write('00', 263, 'latin1')
    let sum = 0
    for (const b of h) sum += b
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  for (const input of inputs) {
    const data = Buffer.from(input.data ?? '')
    if (input.longName) header('././@LongLink', Buffer.from(`${input.name}\0`), 'L')
    header(input.longName ? 'truncated' : input.name, data, input.type ?? '0')
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/** @param {string} name @param {number} size a 60-byte ar member header */
function arHeader(name, size) {
  const h = Buffer.alloc(60, 0x20)
  h.write(name, 0, 'latin1')
  h.write('0', 16, 'latin1')
  h.write('0', 28, 'latin1')
  h.write('0', 34, 'latin1')
  h.write('100644', 40, 'latin1')
  h.write(String(size), 48, 'latin1')
  h.write('`\n', 58, 'latin1')
  return h
}

/**
 * A Unix ar archive (a .deb when the members are debian-binary, control.tar.gz, data.tar.gz).
 * @param {{ name: string, data: Buffer | string }[]} members @param {'gnu' | 'bsd'} [names] how long names are stored
 */
function makeAr(members, names = 'gnu') {
  /** @type {Buffer[]} */
  const parts = [Buffer.from('!<arch>\n', 'latin1')]
  const long = members.filter((m) => m.name.length > 15)
  /** @type {Map<string, number>} */
  const offsets = new Map()
  if (names === 'gnu' && long.length) {
    let table = ''
    for (const m of long) {
      offsets.set(m.name, table.length)
      table += `${m.name}/\n`
    }
    parts.push(arHeader('//', table.length), Buffer.from(table, 'latin1'))
    if (table.length % 2) parts.push(Buffer.from('\n'))
  }
  for (const m of members) {
    let data = Buffer.from(m.data)
    let field = `${m.name}/`
    if (m.name.length > 15) {
      if (names === 'gnu') field = `/${offsets.get(m.name)}`
      else {
        field = `#1/${m.name.length}`
        data = Buffer.concat([Buffer.from(m.name, 'utf8'), data])
      }
    }
    parts.push(arHeader(field, data.length), data)
    if (data.length % 2) parts.push(Buffer.from('\n'))
  }
  return Buffer.concat(parts)
}

/** A .deb whose data tree holds `files` (path → content). @param {Record<string, Buffer | string>} files */
function makeDeb(files) {
  const control = makeTar([{ name: './control', data: 'Package: quran\nVersion: 0.1.0\n' }])
  const data = makeTar(Object.entries(files).map(([name, content]) => ({ name, data: content })))
  return makeAr([
    { name: 'debian-binary', data: '2.0\n' },
    { name: 'control.tar.gz', data: zlib.gzipSync(control) },
    { name: 'data.tar.gz', data: zlib.gzipSync(data) },
  ])
}

/** A minimal ELF header (an application binary). */
function fakeElf() {
  const buf = Buffer.alloc(256)
  buf.write('\x7fELF', 0, 'latin1')
  return buf
}

/** A fake but structurally valid PE header (MZ, e_lfanew → "PE\0\0"). @param {boolean} [nsis] */
function fakePe(nsis = false) {
  const buf = Buffer.alloc(4096)
  buf.write('MZ', 0, 'latin1')
  buf.writeUInt32LE(0x80, 0x3c)
  buf.write('PE\0\0', 0x80, 'latin1')
  if (nsis) buf.write('NullsoftInst', 2048, 'latin1')
  return buf
}

/** @param {string[]} args @param {NodeJS.ProcessEnv} [env] @param {string} [cwd] */
function run(args, env = {}, cwd = ROOT) {
  /** @type {string[]} */
  const lines = []
  const code = main(args, {
    env: { ...env },
    cwd,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  })
  return { code, text: lines.join('\n') }
}

/** @param {ReturnType<typeof inspect>} report @param {string} suffix */
function rulesAt(report, suffix) {
  const finding = [...report.forbidden, ...report.allowed].find((f) => f.path.endsWith(suffix))
  return finding ? finding.reasons.map((r) => r.rule).sort() : []
}

// --- tests -------------------------------------------------------------------------------------------------------------

describe('SQLite reader', needsSqlite, () => {
  it('reads a WITHOUT ROWID meta table (the core.db shape) including an overflowing value', () => {
    const dir = freshDir()
    const long = 'DEVELOPMENT BUILD, NEVER DISTRIBUTE. '.repeat(200) // ~7 KB: several overflow pages
    const file = makeDb(path.join(dir, 'core.db'), {
      withoutRowid: true,
      tables: ['mushaf', 'ayah', 'word'],
      meta: { source: 'qdc', schema_version: '1', licence_note: long },
    })
    const info = readSqliteFile(file)
    assert.equal(info.meta?.source, 'qdc')
    assert.equal(info.meta?.licence_note, long)
    assert.deepEqual(info.tables.sort(), ['ayah', 'meta', 'mushaf', 'word'])
  })

  it('reads rowid tables, multi-level b-trees, 512 B and 64 KiB pages, UTF-16LE and UTF-16BE', () => {
    for (const [pageSize, encoding, withoutRowid] of /** @type {const} */ ([
      [512, 'UTF-8', true],
      [512, 'UTF-16le', false],
      [1024, 'UTF-16be', true],
      [65536, 'UTF-8', false],
    ])) {
      const file = makeDb(path.join(freshDir(), 'x.sqlite'), {
        pageSize,
        encoding,
        withoutRowid,
        fillerRows: 3000, // forces interior pages at 512 B
        meta: { source: 'qul', note: 'ملاحظة '.repeat(300) },
      })
      const info = readSqliteFile(file)
      assert.equal(info.pageSize, pageSize)
      assert.equal(info.meta?.source, 'qul', `${pageSize} ${encoding}`)
      assert.equal(info.meta?.note, 'ملاحظة '.repeat(300))
      assert.equal(info.meta?.filler_02999, 'value 2999 '.repeat(3))
      assert.equal(Object.keys(info.meta ?? {}).length, 3002)
    }
  })

  it('agrees with SQLite itself on the real core.db when one is built', (t) => {
    const core = path.join(ROOT, 'src-tauri', 'resources', 'core.db')
    if (!fs.existsSync(core) || fs.statSync(core).size < 1024 * 1024) return t.skip('no real core.db')
    if (!sqlite) return t.skip('node:sqlite unavailable')
    const db = new sqlite.DatabaseSync(core, { readOnly: true })
    const expected = Object.fromEntries(
      db
        .prepare('SELECT key, value FROM meta')
        .all()
        .map((row) => [String(row.key), String(row.value)]),
    )
    db.close()
    assert.deepEqual(readSqliteFile(core).meta, expected)
  })

  it('rejects files that are not SQLite and survives corrupt pages', () => {
    assert.throws(() => readSqliteInfo(bufferSource(Buffer.from('not a database at all'))), /not an SQLite/)
    const file = makeDb(path.join(freshDir(), 'c.db'), { meta: { source: 'qdc' }, fillerRows: 400 })
    const bytes = fs.readFileSync(file)
    bytes.fill(0xee, 4096, 8192) // clobber page 2
    assert.throws(() => readSqliteInfo(bufferSource(bytes)))
  })

  it('decodes 9-byte varints', () => {
    assert.deepEqual(readVarint(Buffer.from([0x7f]), 0), [127, 1])
    assert.deepEqual(readVarint(Buffer.from([0x81, 0x00]), 0), [128, 2])
    assert.deepEqual(
      readVarint(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x81, 0x01]), 0),
      [257, 9],
    )
  })
})

describe('rules', () => {
  it('refuses a qdc core.db, names it QF-derived, and refuses a renamed database too', needsSqlite, () => {
    const dir = freshDir()
    makeDb(path.join(dir, 'core.db'), {
      withoutRowid: true,
      tables: ['mushaf', 'ayah', 'word'],
      meta: { source: 'qdc' },
    })
    makeDb(path.join(dir, 'innocent.bin'), { meta: { source: 'qul' } })
    makeDb(path.join(dir, 'plain.bin'), { noMeta: true, tables: ['t'] })
    const report = inspect(['.'], { cwd: dir })
    assert.equal(report.ok, false)
    assert.deepEqual(rulesAt(report, 'core.db'), ['db-file', 'sqlite'])
    const core = report.forbidden.find((f) => f.path === 'core.db')
    assert.match(
      core?.reasons.find((r) => r.rule === 'sqlite')?.detail ?? '',
      /QF-derived core\.db .*meta\.source = 'qdc'/,
    )
    assert.deepEqual(rulesAt(report, 'innocent.bin'), ['sqlite'])
    assert.match(report.forbidden.find((f) => f.path === 'innocent.bin')?.reasons[0]?.detail ?? '', /'qul'/)
    assert.match(
      report.forbidden.find((f) => f.path === 'plain.bin')?.reasons[0]?.detail ?? '',
      /no meta table/,
    )
  })

  it('refuses a 0-byte core.db placeholder, WAL side files and fixtures trees by name', () => {
    const dir = freshDir()
    put(path.join(dir, 'resources', 'core.db'), '')
    put(path.join(dir, 'resources', 'user.db-wal'), 'x')
    put(path.join(dir, 'src', 'lib', 'ipc', 'mock', 'fixtures', 'pages', 'hafs', 'p001.json'), '{"lines":[]}')
    put(path.join(dir, 'src', 'lib', 'ipc', 'mock', 'fixtures', 'index.json'), '{}')
    put(path.join(dir, 'fixtures-out', 'a.txt'), 'a')
    const report = inspect(['resources', 'src', 'fixtures-out'], { cwd: dir })
    assert.deepEqual(
      report.forbidden.map((f) => [f.path, f.reasons.map((r) => r.rule).join()]),
      [
        ['fixtures-out', 'fixtures'],
        ['resources/core.db', 'db-file'],
        ['resources/user.db-wal', 'db-file'],
        ['src/lib/ipc/mock/fixtures', 'fixtures'],
      ],
    )
  })

  it('reports a tree at the input, never above it, and once', () => {
    const dir = freshDir()
    put(
      path.join(dir, 'data', 'cache', 'qdc', 'by_page', 'm1', 'p001.json'),
      '{"verse_key":"1:1","code_v2":"x"}',
    )
    put(path.join(dir, 'data', 'cache', 'qdc', 'chapters.json'), '{}')
    put(path.join(dir, 'data', 'dev-packs', 'mushaf', 'v2', 'p1.woff2'), 'wOF2xxxxxxxxxxxx')
    const report = inspect(['data/cache/qdc', 'data/dev-packs'], { cwd: dir })
    assert.deepEqual(
      report.forbidden.map((f) => [f.path, f.reasons.map((r) => r.rule).join()]),
      [
        ['data/cache/qdc', 'data-cache'],
        ['data/dev-packs', 'dev-packs'],
      ],
    )
  })

  it('finds QF-derived JSON outside the usual folders', () => {
    const dir = freshDir()
    const word = {
      id: 1,
      ayahId: 1,
      surah: 1,
      ayah: 1,
      position: 1,
      isEnd: false,
      glyph: 'ﱁ',
      text: 'بِسۡمِ',
    }
    put(path.join(dir, 'out', 'page.json'), JSON.stringify({ page: 1, lines: [{ words: [word] }] }))
    put(path.join(dir, 'out', 'm.json'), JSON.stringify({ source: 'qdc', ayahWindows: [[1, 7]] }))
    put(
      path.join(dir, 'out', 'index.json'),
      JSON.stringify({ surahs: [], juz: [], hizb: [], rub: [], manzil: [] }),
    )
    put(
      path.join(dir, 'out', 'raw.json'),
      JSON.stringify({ verses: [{ verse_key: '1:1', words: [{ text_qpc_hafs: 'x' }] }] }),
    )
    put(
      path.join(dir, 'out', 'ch.json'),
      JSON.stringify({ chapters: [{ bismillah_pre: false, revelation_order: 5 }] }),
    )
    put(path.join(dir, 'out', 'metrics.json'), JSON.stringify({ cls: 0, pageRenderMs: [3, 4] }))
    const report = inspect(['out'], { cwd: dir })
    assert.deepEqual(rulesAt(report, 'page.json'), ['fixture-data'])
    assert.deepEqual(rulesAt(report, 'm.json'), ['fixture-data'])
    assert.deepEqual(rulesAt(report, 'index.json'), ['fixture-data'])
    assert.deepEqual(rulesAt(report, 'raw.json'), ['qdc-response'])
    assert.deepEqual(rulesAt(report, 'ch.json'), ['qdc-response'])
    assert.deepEqual(rulesAt(report, 'metrics.json'), [])
  })

  it('refuses bundles, executables and fonts by name and by content', () => {
    const dir = freshDir()
    put(path.join(dir, 'target', 'release', 'bundle', 'nsis', 'readme.txt'), 'x')
    put(path.join(dir, 'Quran.app', 'Contents', 'Info.plist'), '<plist/>')
    put(path.join(dir, 'pkg', 'Quran_0.1.0_amd64.deb'), '!<arch>\n')
    put(path.join(dir, 'pkg', 'Quran_0.1.0_x64.app.tar.gz'), zlib.gzipSync(Buffer.from('not a tar')))
    put(path.join(dir, 'bin', 'setup.bin'), fakePe(true))
    put(path.join(dir, 'bin', 'app.bin'), fakePe())
    put(
      path.join(dir, 'bin', 'linux'),
      Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]),
    )
    put(
      path.join(dir, 'bin', 'mac'),
      Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(60)]),
    )
    put(path.join(dir, 'fonts', 'p1.dat'), Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60)]))
    put(path.join(dir, 'fonts', 'KFGQPC.ttf'), 'not even a font')
    const report = inspect(['.'], { cwd: dir })
    assert.deepEqual(rulesAt(report, 'Quran.app'), ['bundle'])
    assert.deepEqual(rulesAt(report, 'target/release/bundle'), ['bundle'])
    assert.deepEqual(rulesAt(report, '.deb'), ['bundle'])
    assert.ok(rulesAt(report, '.app.tar.gz').includes('bundle'))
    assert.deepEqual(rulesAt(report, 'setup.bin'), ['executable'])
    assert.match(report.forbidden.find((f) => f.path.endsWith('setup.bin'))?.reasons[0]?.detail ?? '', /NSIS/)
    assert.deepEqual(rulesAt(report, 'bin/app.bin'), ['executable'])
    assert.deepEqual(rulesAt(report, 'bin/linux'), ['executable'])
    assert.deepEqual(rulesAt(report, 'bin/mac'), ['executable'])
    assert.deepEqual(rulesAt(report, 'p1.dat'), ['font'])
    assert.deepEqual(rulesAt(report, 'KFGQPC.ttf'), ['font'])
  })

  it('passes ordinary CI outputs (screenshots, reports, logs)', () => {
    const dir = freshDir()
    put(
      path.join(dir, 'artifacts', 'shots', 'web', 'S19.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    )
    put(path.join(dir, 'artifacts', 'shots', 'web', 'index.html'), '<!doctype html><title>report</title>')
    put(
      path.join(dir, 'artifacts', 'shots', 'web', 'S19.json'),
      JSON.stringify({ id: 'S19', status: 'passed' }),
    )
    put(path.join(dir, 'artifacts', 'log.txt'), 'all good\n')
    put(path.join(dir, 'artifacts', 'notes.txt'), 'BZh is not a bzip2 header without its block-size digit\n')
    const report = inspect(['artifacts'], { cwd: dir })
    assert.equal(report.ok, true, JSON.stringify(report.forbidden))
    assert.equal(report.inspectedFiles, 5)
  })
})

describe('archives', () => {
  it('opens zip, ZIP64, tar, tar.gz and gz, recursively', needsSqlite, () => {
    const dir = freshDir()
    const db = fs.readFileSync(makeDb(path.join(freshDir(), 'core.db'), { meta: { source: 'qdc' } }))
    const innerZip = makeZip([{ name: 'deep/core.sqlite3', data: db }])
    const tar = makeTar([
      { name: 'report/', type: '5' },
      { name: 'report/ok.txt', data: 'fine' },
      { name: `report/${'long-directory-name/'.repeat(8)}inner.zip`, data: innerZip, longName: true },
    ])
    put(path.join(dir, 'bundle.tgz'), zlib.gzipSync(tar))
    put(
      path.join(dir, 'plain.zip'),
      makeZip([{ name: 'fixtures/' }, { name: 'fixtures/pages/p001.json', data: '{}' }]),
    )
    put(
      path.join(dir, 'big.zip'),
      makeZip([{ name: 'data/cache/qdc/chapters.json', data: '{}' }], { zip64: true }),
    )
    put(path.join(dir, 'core.db.gz'), zlib.gzipSync(db))
    const report = inspect(['.'], { cwd: dir })
    const paths = Object.fromEntries(
      report.forbidden.map((f) => [
        f.path,
        f.reasons
          .map((r) => r.rule)
          .sort()
          .join(),
      ]),
    )
    assert.deepEqual(paths, {
      [`bundle.tgz!/report/${'long-directory-name/'.repeat(8)}inner.zip!/deep/core.sqlite3`]:
        'db-file,sqlite',
      'plain.zip!/fixtures': 'fixtures',
      'big.zip!/data/cache': 'data-cache',
      'core.db.gz!/core.db': 'db-file,sqlite',
    })
  })

  it('lists entries with the right names and sizes', () => {
    const zip = makeZip([
      { name: 'a/' },
      { name: 'a/b.txt', data: 'hello' },
      { name: 'c.bin', data: 'x', method: 0 },
    ])
    assert.deepEqual(
      listZip(bufferSource(zip)).map((e) => [e.name, e.isDir, e.size]),
      [
        ['a/', true, 0],
        ['a/b.txt', false, 5],
        ['c.bin', false, 1],
      ],
    )
    const z64 = makeZip([{ name: 'x.txt', data: 'abc' }], { zip64: true })
    assert.deepEqual(
      listZip(bufferSource(z64)).map((e) => [e.name, e.size, e.compressedSize > 0]),
      [['x.txt', 3, true]],
    )
    const tar = makeTar([
      { name: 'd/', type: '5' },
      { name: 'd/f.txt', data: 'abc' },
      { name: 'l', type: '2' },
    ])
    assert.deepEqual(
      listTar(bufferSource(tar)).map((e) => [e.name, e.type, e.size]),
      [
        ['d/', 'dir', 0],
        ['d/f.txt', 'file', 3],
        ['l', 'link', 0],
      ],
    )
  })

  it('fails closed on what it cannot inspect', () => {
    const dir = freshDir()
    put(path.join(dir, 'enc.zip'), makeZip([{ name: 'secret.txt', data: 'x', encrypted: true }]))
    put(path.join(dir, 'bz.zip'), makeZip([{ name: 'a.txt', data: 'x', method: 12 }]))
    put(path.join(dir, 'cut.zip'), makeZip([{ name: 'a.txt', data: 'hello world' }]).subarray(0, 30))
    put(path.join(dir, 'x.7z'), Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]))
    put(path.join(dir, 'renamed.bin'), Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 0]))
    put(path.join(dir, 'bad.gz'), Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]))
    let nested = makeZip([{ name: 'leaf.txt', data: 'leaf' }])
    for (let i = 0; i < 5; i++) nested = makeZip([{ name: `level${i}.zip`, data: nested }])
    put(path.join(dir, 'nested.zip'), nested)
    const report = inspect(['.'], { cwd: dir })
    for (const suffix of ['enc.zip!/secret.txt', 'bz.zip!/a.txt', 'cut.zip', 'x.7z', 'renamed.bin', 'bad.gz'])
      assert.deepEqual(rulesAt(report, suffix), ['uninspectable'], suffix)
    assert.ok(
      report.forbidden.some(
        (f) => f.path.startsWith('nested.zip!/') && /nested deeper/.test(f.reasons[0]?.detail ?? ''),
      ),
      JSON.stringify(report.forbidden),
    )
  })

  it('refuses an entry that inflates beyond what its header declares', () => {
    const dir = freshDir()
    const zip = makeZip([{ name: 'a.txt', data: 'hello world' }])
    const cdAt = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt32LE(3, cdAt + 24) // central directory says 3 bytes
    put(path.join(dir, 'lie.zip'), zip)
    assert.deepEqual(rulesAt(inspect(['lie.zip'], { cwd: dir }), 'lie.zip!/a.txt'), ['uninspectable'])
  })
})

describe('private-repository rules', () => {
  /** @type {string} */
  let dir
  before(() => {
    dir = freshDir()
    put(path.join(dir, 'src', 'lib', 'ipc', 'mock', 'fixtures', 'index.json'), '{}')
    put(path.join(dir, 'src-tauri', 'resources', 'core.db'), '')
  })

  /** @param {unknown} repository */
  const event = (repository) => put(path.join(freshDir(), 'event.json'), JSON.stringify({ repository }))

  it('allows databases and fixtures when the event payload says private, nothing else', () => {
    const env = { GITHUB_EVENT_PATH: event({ private: true, visibility: 'private' }) }
    const ok = run(['--private', 'src-tauri/resources/core.db', 'src/lib/ipc/mock/fixtures'], env, dir)
    assert.equal(ok.code, 0, ok.text)
    assert.match(ok.text, /ok \(private repository\)\s+src-tauri\/resources\/core\.db/)
    put(path.join(dir, 'data', 'cache', 'x.json'), '{}')
    const still = run(['--private', 'data/cache', 'src/lib/ipc/mock/fixtures'], env, dir)
    assert.equal(still.code, 1, still.text)
    assert.match(still.text, /FAIL {2}data\/cache/)
  })

  it('refuses --private for a public repository or without an event payload', () => {
    for (const env of [
      { GITHUB_EVENT_PATH: event({ private: false, visibility: 'public' }) },
      { GITHUB_EVENT_PATH: event({ private: true, visibility: 'public' }) },
      { GITHUB_EVENT_PATH: path.join(dir, 'missing.json') },
      {},
    ]) {
      const result = run(['--private', 'src-tauri/resources/core.db'], env, dir)
      assert.equal(result.code, 1, result.text)
      assert.match(result.text, /--private refused/)
    }
    assert.deepEqual(confirmPrivateRepository({ GITHUB_EVENT_PATH: event({ private: true }) }), { ok: true })
  })
})

describe('CLI', () => {
  it('exits non-zero on the qdc core.db of this checkout (WP-CI acceptance)', (t) => {
    const core = path.join(ROOT, 'src-tauri', 'resources', 'core.db')
    if (!fs.existsSync(core)) return t.skip('no core.db in this checkout')
    const result = spawnSync(process.execPath, [SCRIPT, 'src-tauri/resources/core.db'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, /FAIL {2}src-tauri\/resources\/core\.db/)
  })

  it('reads paths from the environment, expands globs and rejects exclusions', () => {
    const dir = freshDir()
    put(path.join(dir, 'shots', 'a.png'), 'png')
    put(path.join(dir, 'shots', 'b.db'), '')
    const fromEnv = run(
      ['--from-env', 'PATHS', '--json'],
      { PATHS: '\n  shots/*.png  \n\nmissing.txt\n' },
      dir,
    )
    assert.equal(fromEnv.code, 0, fromEnv.text)
    const report = JSON.parse(fromEnv.text)
    assert.deepEqual([report.inspectedFiles, report.notFound], [1, ['missing.txt']])
    assert.equal(run(['shots/*'], {}, dir).code, 1)
    assert.equal(run(['shots', '!shots/b.db'], {}, dir).code, 2)
    assert.equal(run([], {}, dir).code, 2)
    assert.equal(run(['--from-env', 'UNSET'], {}, dir).code, 2)
    assert.equal(run(['--bogus', 'x'], {}, dir).code, 2)
  })

  it('emits GitHub error annotations inside Actions', () => {
    const dir = freshDir()
    put(path.join(dir, 'fixtures', 'x.json'), '{}')
    const result = run(['fixtures'], { GITHUB_ACTIONS: 'true' }, dir)
    assert.equal(result.code, 1)
    assert.match(result.text, /^::error title=check-artifacts::fixtures: fixtures tree/m)
  })

  it('follows symlinks without looping', (t) => {
    const dir = freshDir()
    put(path.join(dir, 'real', 'fixtures', 'a.json'), '{}')
    try {
      fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'real', 'loop'), 'junction')
      fs.symlinkSync(path.join(dir, 'real', 'fixtures'), path.join(dir, 'link'), 'junction')
    } catch {
      return t.skip('symlinks are not permitted here')
    }
    const report = inspect(['.'], { cwd: dir })
    assert.equal(report.ok, false)
    assert.ok(report.forbidden.some((f) => f.reasons.some((r) => r.rule === 'fixtures')))
  })
})

describe('ar archives (.deb)', () => {
  it('lists GNU and BSD long names and skips symbol tables', () => {
    const members = [
      { name: 'debian-binary', data: '2.0\n' },
      { name: 'a-rather-long-member-name.txt', data: 'odd' },
      { name: 'b', data: 'even' },
    ]
    for (const names of /** @type {const} */ (['gnu', 'bsd'])) {
      const src = bufferSource(makeAr(members, names))
      assert.deepEqual(
        listAr(src).map((e) => [e.name, src.read(e.dataStart, e.size).toString('latin1')]),
        members.map((m) => [m.name, m.data]),
        names,
      )
    }
    const withSymbols = Buffer.concat([
      Buffer.from('!<arch>\n', 'latin1'),
      arHeader('/', 4),
      Buffer.from('\0\0\0\0'),
      arHeader('x.o/', 1),
      Buffer.from('y\n'),
    ])
    assert.deepEqual(
      listAr(bufferSource(withSymbols)).map((e) => e.name),
      ['x.o'],
    )
    assert.throws(() => listAr(bufferSource(Buffer.from('!<arch>\nshort'))), /truncated ar header/)
  })

  it('opens a deb and finds a qdc core.db inside data.tar.gz', needsSqlite, () => {
    const dir = freshDir()
    const db = makeDb(path.join(dir, 'qdc.db'), {
      meta: { source: 'qdc' },
      tables: ['mushaf', 'ayah', 'word'],
    })
    put(
      path.join(dir, 'Quran_0.1.0_amd64.deb'),
      makeDeb({ './usr/lib/Quran/data/core.db': fs.readFileSync(db) }),
    )
    const report = inspect(['Quran_0.1.0_amd64.deb'], { cwd: dir })
    assert.equal(report.ok, false)
    assert.deepEqual(rulesAt(report, 'data.tar.gz!/./usr/lib/Quran/data/core.db'), ['db-file', 'sqlite'])
    assert.deepEqual(rulesAt(report, 'Quran_0.1.0_amd64.deb'), ['bundle'])
  })
})

describe('release rules', () => {
  /** @type {string} */
  let dir
  /** @type {Buffer} */
  let qul = Buffer.alloc(0)
  before(() => {
    dir = freshDir()
    if (!sqlite) return
    const tables = ['mushaf', 'ayah', 'word']
    qul = fs.readFileSync(
      makeDb(path.join(dir, 'qul.db'), { tables, meta: { source: 'qul', schema_version: '1' } }),
    )
    makeDb(path.join(dir, 'qdc.db'), { tables, meta: { source: 'qdc' } })
    makeDb(path.join(dir, 'pack.db'), { meta: { source: 'qul', pack_id: 'tr.en' } })
  })

  it('allows a qul core.db, installers and executables; refuses everything QF-derived', needsSqlite, () => {
    put(
      path.join(dir, 'deb', 'Quran_0.1.0_amd64.deb'),
      makeDeb({ './usr/lib/Quran/data/core.db': qul, './usr/bin/quran-desktop': fakeElf() }),
    )
    const ok = inspect(['deb', 'qul.db'], { cwd: dir, release: true })
    assert.equal(ok.ok, true, JSON.stringify(ok.forbidden))
    assert.equal(ok.rules, 'release')
    assert.deepEqual(rulesAt(ok, 'qul.db'), ['db-file', 'sqlite'])
    assert.deepEqual(rulesAt(ok, 'data.tar.gz!/./usr/bin/quran-desktop'), ['executable'])
    // The same deb is refused under the public rules.
    assert.equal(inspect(['deb'], { cwd: dir }).ok, false)

    put(path.join(dir, 'placeholder', 'core.db'), '')
    put(path.join(dir, 'fx', 'fixtures', 'p1.json'), '{}')
    put(path.join(dir, 'font', 'p1.woff2'), Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60)]))
    for (const bad of ['qdc.db', 'pack.db', 'placeholder/core.db', 'fx', 'font/p1.woff2'])
      assert.equal(inspect([bad], { cwd: dir, release: true }).ok, false, bad)
  })

  it('refuses an installer it cannot open unless check-bundles verified it by size and SHA-256', () => {
    const installer = put(path.join(dir, 'nsis', 'Quran_0.1.0_x64-setup.exe'), fakePe(true))
    const refused = inspect(['nsis'], { cwd: dir, release: true })
    assert.equal(refused.ok, false)
    assert.deepEqual(rulesAt(refused, 'Quran_0.1.0_x64-setup.exe'), ['executable', 'uninspectable'])
    const bytes = fs.statSync(installer).size
    const sha256 = createHash('sha256').update(fs.readFileSync(installer)).digest('hex')
    assert.equal(inspect(['nsis'], { cwd: dir, release: true, verified: [{ sha256, bytes }] }).ok, true)
    assert.equal(
      inspect(['nsis'], { cwd: dir, release: true, verified: [{ sha256, bytes: bytes + 1 }] }).ok,
      false,
    )
    put(path.join(dir, 'dmg', 'Quran_0.1.0_universal.dmg'), Buffer.alloc(4096, 1))
    assert.equal(inspect(['dmg'], { cwd: dir, release: true }).ok, false)
    assert.throws(() => inspect(['nsis'], { cwd: dir, release: true, privateRepo: true }), /exclusive/)
  })

  it('reads the check-bundles manifest on the command line', () => {
    const installer = path.join(dir, 'nsis', 'Quran_0.1.0_x64-setup.exe')
    if (!fs.existsSync(installer)) put(installer, fakePe(true))
    const sha256 = createHash('sha256').update(fs.readFileSync(installer)).digest('hex')
    const entry = { file: installer, kind: 'nsis', bytes: fs.statSync(installer).size, sha256, ok: true }
    const manifest = (/** @type {string} */ core, ok = true) =>
      put(
        path.join(freshDir(), 'bundle-check.json'),
        JSON.stringify({ format: BUNDLE_CHECK_FORMAT, core, installers: [{ ...entry, ok }] }),
      )
    const pass = run(['--release', '--verified', manifest('qul'), 'nsis'], {}, dir)
    assert.equal(pass.code, 0, pass.text)
    assert.match(pass.text, /release rules/)
    assert.match(pass.text, /check-artifacts passed \(release\)/)
    assert.equal(run(['--release', '--verified', manifest('qul', false), 'nsis'], {}, dir).code, 1)
    const placeholder = run(['--release', '--verified', manifest('placeholder'), 'nsis'], {}, dir)
    assert.equal(placeholder.code, 1)
    assert.match(placeholder.text, /a release needs --core qul/)
    assert.equal(run(['--release', '--private', 'nsis'], {}, dir).code, 2)
    assert.equal(run(['--verified', manifest('qul'), 'nsis'], {}, dir).code, 2)
    assert.equal(run(['--release', '--verified', path.join(dir, 'missing.json'), 'nsis'], {}, dir).code, 1)
  })
})
