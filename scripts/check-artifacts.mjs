#!/usr/bin/env node
// @ts-check
// check-artifacts: the licensing guard that runs before every CI upload (ARCHITECTURE §13.3, risk R19).
//
//   node scripts/check-artifacts.mjs [--private | --release [--verified <bundle-check.json>]] [--json] [--from-env VAR]
//                                    [--] <path | glob>...
//
// A qdc-built core.db, its fixtures, raw QF API responses and any bundle containing them are QF-derived (BRIEF §4,
// FACT §2.1). Nothing of that kind may leave CI while the repository is public. Every argument is a file, a directory
// (walked recursively; hidden files and symlink targets included) or a glob, like actions/upload-artifact's `path`.
// zip, tar, tar.gz/tgz, gz, xz (with the `xz` tool) and ar (.deb) archives are opened, and their entries are checked the
// same way, nested archives included. The guard fails closed: whatever it cannot inspect is refused (an xz stream too,
// where `xz` is not installed).
//
// Rules (a finding names its rule):
//   sqlite         any SQLite database, whatever its name. meta.source is read to name a QF-derived (qdc) core.db
//   db-file        a *.db / *.sqlite / *.sqlite3 file or its -wal/-shm/-journal, even a 0-byte placeholder
//   fixtures       a fixtures/ (or fixtures-out/) tree: browser-mock fixtures exported from core.db (§4.6)
//   fixture-data   JSON shaped like the exported fixtures (page words, the fixture manifest, the Quran index)
//   qdc-response   a raw QDC API response (verses/by_page, chapters), wherever it lives
//   data-cache     anything under data/cache/ (raw QF responses, §4.2)
//   dev-packs      anything under data/dev-packs/ (QCF fonts may not be redistributed as an asset package, §4.8)
//   bundle         an installer or application bundle (.msi, .dmg, .deb, .AppImage, .app/, target/**/bundle/, …)
//   executable     a PE, ELF or Mach-O binary (an application build or an installer)
//   font           a font binary (QCF page and decor fonts; the KFGQPC TTF is never a CI artifact: it ships inside the
//                  installer and, unmodified, as the repository's xtask/assets/ copy, LEAD 24)
//   uninspectable  an unsupported, encrypted, corrupt, too deeply nested or oversized archive, or an unreadable file
//
// --private applies the private-repository rules of §13.3. While the repository and its Actions are private, CI may
// upload core.db and fixtures/ as 1-day artifacts, so `sqlite`, `db-file`, `fixtures` and `fixture-data` are then
// allowed and listed. Every other rule still refuses. The flag is honoured only when the GitHub event payload
// ($GITHUB_EVENT_PATH) says `repository.private: true`, so a public repository can never opt out.
//
// --release applies the release rules of §13.4 (release.yml, before the installers go to the draft release): installers
// and executables are what is published, so `bundle` and `executable` are allowed; an SQLite database is allowed only
// when it is a core.db whose `meta.source` is 'qul' (a .db name only together with such content); every other rule
// still refuses. A deb is opened (ar → data.tar.gz or data.tar.xz). An installer the guard cannot open (NSIS, dmg, AppImage) is
// refused unless --verified names a `qd-bundle-check/1` manifest from `scripts/check-bundles.mjs --core qul` that
// lists it by size and SHA-256 as verified: check-bundles unpacks it with the platform tool and runs these same rules
// on what is inside.
//
// --from-env VAR reads more paths from the environment variable VAR, one per line (the upload-artifact `path` syntax;
// blank lines are ignored). `!exclude` patterns are refused: the guard checks exactly what would be uploaded.
//
// Exit codes: 0 nothing forbidden, 1 something forbidden (or --private refused), 2 bad usage.
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import zlib from 'node:zlib'

const KIB = 1024
const MIB = 1024 * KIB
const GIB = 1024 * MIB

/** Archives nested deeper than this are refused. */
export const MAX_ARCHIVE_DEPTH = 4
/** Largest single archive entry (or gzip or xz stream) that is decompressed for inspection. */
export const MAX_ENTRY_BYTES = 512 * MIB
/** Total bytes decompressed for one invocation; beyond it, archives are refused. */
export const MAX_TOTAL_DECOMPRESSED = 2 * GIB
/** JSON files are scanned up to this many bytes for QF-derived shapes. */
const MAX_JSON_SCAN = 64 * MIB

/**
 * @typedef {'sqlite' | 'db-file' | 'fixtures' | 'fixture-data' | 'qdc-response' | 'data-cache' | 'dev-packs'
 *   | 'bundle' | 'executable' | 'font' | 'uninspectable'} RuleId
 * @typedef {{ title: string, privateAllowed: boolean, releaseAllowed: boolean }} Rule
 */

// Under the release rules `sqlite` and `db-file` are decided per file (a qul core.db only), see `Inspector.refuses`.
/** @type {Record<RuleId, Rule>} */
export const RULES = {
  sqlite: { title: 'SQLite database', privateAllowed: true, releaseAllowed: false },
  'db-file': { title: 'database file', privateAllowed: true, releaseAllowed: false },
  fixtures: { title: 'fixtures tree (exported from core.db)', privateAllowed: true, releaseAllowed: false },
  'fixture-data': {
    title: 'fixture-shaped JSON (exported from core.db)',
    privateAllowed: true,
    releaseAllowed: false,
  },
  'qdc-response': { title: 'raw QDC API response', privateAllowed: false, releaseAllowed: false },
  'data-cache': { title: 'data/cache (raw QF responses)', privateAllowed: false, releaseAllowed: false },
  'dev-packs': { title: 'data/dev-packs (QCF fonts)', privateAllowed: false, releaseAllowed: false },
  bundle: { title: 'installer or application bundle', privateAllowed: false, releaseAllowed: true },
  executable: { title: 'executable binary', privateAllowed: false, releaseAllowed: true },
  font: { title: 'font binary', privateAllowed: false, releaseAllowed: false },
  uninspectable: { title: 'cannot be inspected (refused)', privateAllowed: false, releaseAllowed: false },
}

/**
 * Content findings that only repeat a tree finding with the same verdict are not listed per file (a fixtures/ tree is
 * one finding, not one per page file).
 * @type {Partial<Record<RuleId, RuleId>>}
 */
const SUBSUMED_BY = { 'fixture-data': 'fixtures', 'qdc-response': 'data-cache', font: 'dev-packs' }

/**
 * @typedef {{ rule: RuleId, detail: string, qul?: boolean }} Reason  `qul`: an SQLite core.db with meta.source = 'qul'
 * @typedef {{ path: string, reasons: Reason[] }} Finding
 * @typedef {'public' | 'private' | 'release'} Rules
 * @typedef {{
 *   ok: boolean, private: boolean, rules: Rules, inputs: string[], inspectedFiles: number, notFound: string[],
 *   forbidden: Finding[], allowed: Finding[]
 * }} Report
 * @typedef {{ bytes: number, sha256: string }} VerifiedInstaller  an installer check-bundles unpacked and verified
 */

// ---------------------------------------------------------------------------------------------------------------------
// Random-access byte sources (files, buffers, slices), so archives and databases are never read whole without need.

/**
 * @typedef {{ size: number, read(offset: number, length: number): Buffer }} ByteSource
 */

/** @param {Buffer} buf @returns {ByteSource} */
export function bufferSource(buf) {
  return {
    size: buf.length,
    read: (offset, length) =>
      buf.subarray(clamp(offset, 0, buf.length), clamp(offset + length, 0, buf.length)),
  }
}

/** @param {ByteSource} src @param {number} start @param {number} size @returns {ByteSource} */
function sliceSource(src, start, size) {
  const end = Math.min(src.size, start + size)
  const length = Math.max(0, end - start)
  return {
    size: length,
    read: (offset, len) => {
      const from = clamp(offset, 0, length)
      return src.read(start + from, clamp(len, 0, length - from))
    },
  }
}

/** @param {number} fd @param {number} size @returns {ByteSource} */
function fdSource(fd, size) {
  return {
    size,
    read(offset, length) {
      const from = clamp(offset, 0, size)
      const n = clamp(length, 0, size - from)
      const out = Buffer.alloc(n)
      let done = 0
      while (done < n) {
        const got = fs.readSync(fd, out, done, n - done, from + done)
        if (got === 0) break
        done += got
      }
      return out.subarray(0, done)
    },
  }
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

/** @param {ByteSource} src @returns {Buffer} the whole source; callers bound `src.size` first */
function readAll(src) {
  return src.read(0, src.size)
}

// ---------------------------------------------------------------------------------------------------------------------
// SQLite: a minimal, defensive reader of the file format (https://sqlite.org/fileformat2.html), enough to list the
// tables and read a small `meta(key, value)` table, rowid or WITHOUT ROWID, in any text encoding.

export const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')

class SqliteFormatError extends Error {}

/**
 * @typedef {{ pageSize: number, encoding: 'utf8' | 'utf16le' | 'utf16be', tables: string[],
 *   meta: Record<string, string> | null }} SqliteInfo
 */

/**
 * Reads the table list and the `meta` table of an SQLite database.
 * @param {ByteSource} src
 * @returns {SqliteInfo}
 * @throws {Error} when the file is not a readable SQLite database
 */
export function readSqliteInfo(src) {
  const header = src.read(0, 100)
  if (header.length < 100 || !header.subarray(0, 16).equals(SQLITE_MAGIC))
    throw new SqliteFormatError('not an SQLite 3 database')
  const rawPageSize = header.readUInt16BE(16)
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0)
    throw new SqliteFormatError(`invalid page size ${rawPageSize}`)
  const usable = pageSize - header.readUInt8(20)
  if (usable < 480) throw new SqliteFormatError(`invalid reserved space ${header.readUInt8(20)}`)
  const encodingId = header.readUInt32BE(56)
  /** @type {SqliteInfo['encoding']} */
  const encoding = encodingId === 2 ? 'utf16le' : encodingId === 3 ? 'utf16be' : 'utf8'
  const pageCount = Math.floor(src.size / pageSize)
  if (pageCount < 1) throw new SqliteFormatError('truncated database')

  const db = { src, pageSize, usable, pageCount, encoding }
  /** @type {{ type: unknown, name: unknown, root: unknown }[]} */
  const schema = []
  walkBtree(db, 1, (record) => {
    const [type, name, , root] = decodeRecord(record, encoding)
    schema.push({ type, name, root })
  })
  const tables = schema
    .filter((row) => row.type === 'table' && typeof row.name === 'string')
    .map((row) => String(row.name))
  const metaRow = schema.find(
    (row) => row.type === 'table' && typeof row.name === 'string' && row.name.toLowerCase() === 'meta',
  )
  if (!metaRow) return { pageSize, encoding, tables, meta: null }
  const root = typeof metaRow.root === 'number' ? metaRow.root : Number.NaN
  if (!Number.isInteger(root) || root < 1) throw new SqliteFormatError('meta has no root page')
  /** @type {Record<string, string>} */
  const meta = {}
  walkBtree(db, root, (record) => {
    const [key, value] = decodeRecord(record, encoding)
    if (typeof key === 'string') meta[key] = value === null || value === undefined ? '' : String(value)
  })
  return { pageSize, encoding, tables, meta }
}

/**
 * @typedef {{ src: ByteSource, pageSize: number, usable: number, pageCount: number,
 *   encoding: SqliteInfo['encoding'] }} Db
 */

/** @param {Db} db @param {number} pgno */
function readPage(db, pgno) {
  if (!Number.isInteger(pgno) || pgno < 1 || pgno > db.pageCount)
    throw new SqliteFormatError(`page ${pgno} out of range`)
  const page = db.src.read((pgno - 1) * db.pageSize, db.pageSize)
  if (page.length !== db.pageSize) throw new SqliteFormatError(`page ${pgno} truncated`)
  return page
}

const MAX_BTREE_DEPTH = 40
const MAX_RECORDS = 1_000_000

/**
 * Visits every record of the b-tree rooted at `root` (table or index b-tree) in key order.
 * @param {Db} db @param {number} root @param {(payload: Buffer) => void} visit
 */
function walkBtree(db, root, visit) {
  const seen = new Set()
  let records = 0
  /** @param {number} pgno @param {number} depth */
  const walk = (pgno, depth) => {
    if (depth > MAX_BTREE_DEPTH) throw new SqliteFormatError('b-tree too deep')
    if (seen.has(pgno)) throw new SqliteFormatError(`page ${pgno} visited twice`)
    seen.add(pgno)
    const page = readPage(db, pgno)
    const h = pgno === 1 ? 100 : 0
    const kind = page.readUInt8(h)
    const interior = kind === 0x02 || kind === 0x05
    if (kind !== 0x02 && kind !== 0x05 && kind !== 0x0a && kind !== 0x0d)
      throw new SqliteFormatError(`page ${pgno} is not a b-tree page (type ${kind})`)
    const cells = page.readUInt16BE(h + 3)
    const pointers = h + (interior ? 12 : 8)
    for (let i = 0; i < cells; i++) {
      const cell = page.readUInt16BE(pointers + 2 * i)
      if (cell >= db.pageSize) throw new SqliteFormatError(`cell offset ${cell} out of page ${pgno}`)
      if (kind === 0x05) {
        walk(page.readUInt32BE(cell), depth + 1) // table interior: left child + rowid key
        continue
      }
      let pos = cell
      if (kind === 0x02) {
        walk(page.readUInt32BE(cell), depth + 1) // index interior: left child, then the key record itself
        pos += 4
      }
      const [payloadSize, n1] = readVarint(page, pos)
      pos += n1
      if (kind === 0x0d) pos += readVarint(page, pos)[1] // table leaf: skip the rowid
      if (++records > MAX_RECORDS) throw new SqliteFormatError('too many records')
      visit(readPayload(db, page, pos, payloadSize, kind === 0x0d))
    }
    if (interior) walk(page.readUInt32BE(h + 8), depth + 1)
  }
  walk(root, 0)
}

/**
 * The cell payload, following overflow pages when it spills (file format §1.6).
 * @param {Db} db @param {Buffer} page @param {number} pos @param {number} size @param {boolean} tableLeaf
 */
function readPayload(db, page, pos, size, tableLeaf) {
  const u = db.usable
  if (size > 64 * MIB) throw new SqliteFormatError(`payload of ${size} bytes`)
  const maxLocal = tableLeaf ? u - 35 : Math.floor(((u - 12) * 64) / 255) - 23
  if (size <= maxLocal) return checkedSlice(page, pos, size)
  const minLocal = Math.floor(((u - 12) * 32) / 255) - 23
  const k = minLocal + ((size - minLocal) % (u - 4))
  const local = k <= maxLocal ? k : minLocal
  const parts = [checkedSlice(page, pos, local)]
  let next = page.readUInt32BE(pos + local)
  let remaining = size - local
  const seen = new Set()
  while (remaining > 0) {
    if (seen.has(next)) throw new SqliteFormatError('overflow chain loops')
    seen.add(next)
    const overflow = readPage(db, next)
    const chunk = Math.min(remaining, u - 4)
    parts.push(overflow.subarray(4, 4 + chunk))
    remaining -= chunk
    next = overflow.readUInt32BE(0)
  }
  return Buffer.concat(parts)
}

/** @param {Buffer} buf @param {number} start @param {number} length */
function checkedSlice(buf, start, length) {
  if (start < 0 || length < 0 || start + length > buf.length)
    throw new SqliteFormatError('cell overflows its page')
  return buf.subarray(start, start + length)
}

/**
 * SQLite varint (1–9 bytes, big-endian base 128; the 9th byte contributes 8 bits). Exact below 2^53.
 * @param {Buffer} buf @param {number} pos @returns {[number, number]} value and length
 */
export function readVarint(buf, pos) {
  let value = 0
  for (let i = 0; i < 9; i++) {
    const byte = buf.readUInt8(pos + i)
    if (i === 8) return [value * 256 + byte, 9]
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) return [value, i + 1]
  }
  return [value, 9]
}

/**
 * Decodes a record into JS values (NULL → null, integers → number, text → string, blob → Buffer).
 * @param {Buffer} buf @param {SqliteInfo['encoding']} encoding @returns {unknown[]}
 */
function decodeRecord(buf, encoding) {
  const [headerSize, n] = readVarint(buf, 0)
  if (headerSize > buf.length) throw new SqliteFormatError('record header overflows its payload')
  /** @type {number[]} */
  const types = []
  for (let pos = n; pos < headerSize;) {
    const [type, len] = readVarint(buf, pos)
    types.push(type)
    pos += len
  }
  /** @type {unknown[]} */
  const values = []
  let pos = headerSize
  for (const type of types) {
    if (type === 0 || type === 8 || type === 9) {
      values.push(type === 0 ? null : type - 8)
    } else if (type >= 1 && type <= 6) {
      const width = [0, 1, 2, 3, 4, 6, 8][type] ?? 8
      if (pos + width > buf.length) throw new SqliteFormatError('integer overflows its record')
      values.push(width === 8 ? Number(buf.readBigInt64BE(pos)) : buf.readIntBE(pos, width))
      pos += width
    } else if (type === 7) {
      if (pos + 8 > buf.length) throw new SqliteFormatError('real overflows its record')
      values.push(buf.readDoubleBE(pos))
      pos += 8
    } else if (type >= 12) {
      const length = Math.floor((type - 12) / 2)
      const bytes = checkedSlice(buf, pos, length)
      values.push(type % 2 === 0 ? Buffer.from(bytes) : decodeText(bytes, encoding))
      pos += length
    } else {
      throw new SqliteFormatError(`reserved serial type ${type}`)
    }
  }
  return values
}

/** @param {Buffer} bytes @param {SqliteInfo['encoding']} encoding */
function decodeText(bytes, encoding) {
  if (encoding === 'utf8') return bytes.toString('utf8')
  if (encoding === 'utf16le') return bytes.toString('utf16le')
  const swapped = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)))
  return swapped.swap16().toString('utf16le')
}

/**
 * `readSqliteInfo` of a file on disk (reads only the pages it needs).
 * @param {string} file @returns {SqliteInfo}
 */
export function readSqliteFile(file) {
  const fd = fs.openSync(file, 'r')
  try {
    return readSqliteInfo(fdSource(fd, fs.fstatSync(fd).size))
  } finally {
    fs.closeSync(fd)
  }
}

/** @param {ByteSource} src @returns {{ detail: string, qul: boolean }} */
function describeSqlite(src) {
  /** @type {SqliteInfo} */
  let info
  try {
    info = readSqliteInfo(src)
  } catch (error) {
    return {
      detail: `SQLite database whose schema cannot be read (${message(error)}); every database is refused`,
      qul: false,
    }
  }
  const tables = new Set(info.tables.map((t) => t.toLowerCase()))
  const meta = info.meta ?? {}
  const kind =
    tables.has('word') && tables.has('ayah') && tables.has('mushaf')
      ? 'core.db'
      : meta.pack_id
        ? `pack.db "${meta.pack_id}"`
        : 'database'
  if (meta.source === 'qdc')
    return {
      detail: `QF-derived ${kind} built from the QDC API (meta.source = 'qdc'): development only, never distributed (BRIEF §4, FACT §2.1)`,
      qul: false,
    }
  if (meta.source)
    return {
      detail: `SQLite ${kind} (meta.source = '${meta.source}')`,
      qul: kind === 'core.db' && meta.source === 'qul',
    }
  return { detail: `SQLite ${kind}${info.meta ? '' : ' (no meta table)'}`, qul: false }
}

// ---------------------------------------------------------------------------------------------------------------------
// Archives: zip (incl. ZIP64), tar (ustar, GNU long names, pax paths), gzip and xz.

/**
 * @typedef {{ name: string, isDir: boolean, method: number, encrypted: boolean, compressedSize: number,
 *   size: number, localHeader: number }} ZipEntry
 */

class ArchiveFormatError extends Error {}

/** The xz stream magic. */
export const XZ_MAGIC = /** @type {const} */ ([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])

/**
 * Decompresses an xz stream with the `xz` tool (Node has no xz decoder): a deb's data.tar.xz (scripts/deb-xz.mjs).
 * @param {Buffer} input @param {number} [limit] the most bytes it may decompress to
 * @returns {Buffer}
 * @throws {Error} when xz is not installed, the stream is corrupt, or it decompresses beyond `limit`
 */
export function unxz(input, limit = MAX_ENTRY_BYTES) {
  const run = spawnSync('xz', ['--decompress', '--stdout'], { input, maxBuffer: Math.max(1, limit) })
  const code = /** @type {NodeJS.ErrnoException | undefined} */ (run.error)?.code
  if (code === 'ENOENT') throw new ArchiveFormatError('cannot be decompressed: xz is not installed')
  if (code === 'ENOBUFS') throw new ArchiveFormatError('decompresses beyond the inspection limit')
  if (run.error || run.status !== 0)
    throw new ArchiveFormatError(
      `cannot be decompressed (${run.error ? message(run.error) : String(run.stderr).trim() || `xz exit ${run.status}`})`,
    )
  return run.stdout
}

/**
 * Lists the central directory of a zip archive.
 * @param {ByteSource} src @returns {ZipEntry[]}
 */
export function listZip(src) {
  const tailLength = Math.min(src.size, 22 + 0xffff)
  const tail = src.read(src.size - tailLength, tailLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ArchiveFormatError('no end-of-central-directory record')
  let disk = tail.readUInt16LE(eocd + 4)
  let count = tail.readUInt16LE(eocd + 10)
  let cdSize = tail.readUInt32LE(eocd + 12)
  let cdOffset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locatorAt = src.size - tailLength + eocd - 20
    const locator = src.read(locatorAt, 20)
    if (locator.length < 20 || locator.readUInt32LE(0) !== 0x07064b50)
      throw new ArchiveFormatError('ZIP64 locator missing')
    const record = src.read(Number(locator.readBigUInt64LE(8)), 56)
    if (record.length < 56 || record.readUInt32LE(0) !== 0x06064b50)
      throw new ArchiveFormatError('ZIP64 end-of-central-directory record missing')
    disk = record.readUInt32LE(16)
    count = Number(record.readBigUInt64LE(32))
    cdSize = Number(record.readBigUInt64LE(40))
    cdOffset = Number(record.readBigUInt64LE(48))
  }
  if (disk !== 0) throw new ArchiveFormatError('multi-volume archive')
  if (cdOffset + cdSize > src.size) throw new ArchiveFormatError('central directory out of bounds')
  if (cdSize > 256 * MIB) throw new ArchiveFormatError('central directory too large')
  const cd = src.read(cdOffset, cdSize)
  /** @type {ZipEntry[]} */
  const entries = []
  let pos = 0
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== 0x02014b50)
      throw new ArchiveFormatError(`central directory entry ${i} is corrupt`)
    const flags = cd.readUInt16LE(pos + 8)
    const method = cd.readUInt16LE(pos + 10)
    let compressedSize = cd.readUInt32LE(pos + 20)
    let size = cd.readUInt32LE(pos + 24)
    const nameLength = cd.readUInt16LE(pos + 28)
    const extraLength = cd.readUInt16LE(pos + 30)
    const commentLength = cd.readUInt16LE(pos + 32)
    let localHeader = cd.readUInt32LE(pos + 42)
    const nameBytes = cd.subarray(pos + 46, pos + 46 + nameLength)
    const name = nameBytes.toString(flags & 0x800 ? 'utf8' : 'latin1')
    const extra = cd.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength)
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra.readUInt16LE(e)
      const len = extra.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let f = e + 4
        const field = () => {
          if (f + 8 > e + 4 + len) throw new ArchiveFormatError(`ZIP64 extra field of ${name} is short`)
          const v = Number(extra.readBigUInt64LE(f))
          f += 8
          return v
        }
        if (size === 0xffffffff) size = field()
        if (compressedSize === 0xffffffff) compressedSize = field()
        if (localHeader === 0xffffffff) localHeader = field()
      }
      e += 4 + len
    }
    entries.push({
      name,
      isDir: name.endsWith('/') || name.endsWith('\\'),
      method,
      encrypted: (flags & 0x1) !== 0,
      compressedSize,
      size,
      localHeader,
    })
    pos += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * The (decompressed) content of a zip entry.
 * @param {ByteSource} src @param {ZipEntry} entry @param {(bytes: number) => number} budget
 * @returns {ByteSource}
 */
function zipEntryData(src, entry, budget) {
  const local = src.read(entry.localHeader, 30)
  if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50)
    throw new ArchiveFormatError('local header missing')
  const dataStart = entry.localHeader + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  if (dataStart + entry.compressedSize > src.size) throw new ArchiveFormatError('entry data out of bounds')
  if (entry.method === 0) return sliceSource(src, dataStart, entry.compressedSize)
  if (entry.method !== 8) throw new ArchiveFormatError(`compression method ${entry.method} is not supported`)
  if (entry.size > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES)
    throw new ArchiveFormatError(`entry of ${formatBytes(entry.size)} is too large to inspect`)
  const out = inflate(() =>
    zlib.inflateRawSync(src.read(dataStart, entry.compressedSize), inflateOptions(budget)),
  )
  if (out.length !== entry.size)
    throw new ArchiveFormatError('entry size does not match the central directory')
  budget(out.length)
  return bufferSource(out)
}

/** @param {(bytes: number) => number} budget */
function inflateOptions(budget) {
  return { maxOutputLength: Math.max(1, Math.min(MAX_ENTRY_BYTES, budget(0))) }
}

/** @param {() => Buffer} run */
function inflate(run) {
  try {
    return run()
  } catch (error) {
    if (
      error instanceof RangeError ||
      /** @type {NodeJS.ErrnoException} */ (error).code === 'ERR_BUFFER_TOO_LARGE'
    )
      throw new ArchiveFormatError('decompresses beyond the inspection limit')
    throw new ArchiveFormatError(`cannot be decompressed (${message(error)})`)
  }
}

/** @param {Buffer} h a 512-byte block */
function isTarHeader(h) {
  if (h.length < 512 || h.readUInt8(0) === 0) return false
  const stored = parseOctal(h.subarray(148, 156))
  if (stored === null) return false
  let sum = 0
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h.readUInt8(i)
  return sum === stored
}

/** @param {Buffer} field @returns {number | null} */
function parseOctal(field) {
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim()
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : null
}

/** @param {Buffer} field @returns {number} size field: octal, or GNU base-256 */
function parseTarSize(field) {
  if (field.readUInt8(0) & 0x80) {
    let value = field.readUInt8(0) & 0x7f
    for (let i = 1; i < field.length; i++) value = value * 256 + field.readUInt8(i)
    return value
  }
  const octal = parseOctal(field)
  if (octal === null) throw new ArchiveFormatError('bad tar size field')
  return octal
}

/** @param {Buffer} buf */
function cString(buf) {
  const end = buf.indexOf(0)
  return buf.subarray(0, end < 0 ? buf.length : end).toString('utf8')
}

/**
 * @typedef {{ name: string, type: 'file' | 'dir' | 'link' | 'other', size: number, dataStart: number }} TarEntry
 */

/**
 * Lists a tar archive (ustar, GNU long names, pax `path`).
 * @param {ByteSource} src @returns {TarEntry[]}
 */
export function listTar(src) {
  /** @type {TarEntry[]} */
  const entries = []
  /** @type {string | null} */
  let longName = null
  /** @type {string | null} */
  let paxPath = null
  for (let offset = 0; offset + 512 <= src.size;) {
    const h = src.read(offset, 512)
    if (h.every((b) => b === 0)) break
    if (!isTarHeader(h)) throw new ArchiveFormatError(`bad tar header at byte ${offset}`)
    const size = parseTarSize(h.subarray(124, 136))
    const typeflag = String.fromCharCode(h.readUInt8(156))
    const dataStart = offset + 512
    if (dataStart + size > src.size) throw new ArchiveFormatError('tar entry out of bounds')
    const ustar = h.toString('latin1', 257, 262) === 'ustar'
    const prefix = ustar ? cString(h.subarray(345, 500)) : ''
    const base = cString(h.subarray(0, 100))
    const name = prefix ? `${prefix}/${base}` : base
    if (typeflag === 'L') {
      longName = cString(src.read(dataStart, Math.min(size, 64 * KIB)))
    } else if (typeflag === 'x') {
      const records = src.read(dataStart, Math.min(size, MIB)).toString('utf8')
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(records)
      if (match?.[1]) paxPath = match[1]
    } else if (typeflag !== 'g') {
      entries.push({
        name: paxPath ?? longName ?? name,
        type:
          typeflag === '0' || typeflag === '\0' || typeflag === '7'
            ? 'file'
            : typeflag === '5'
              ? 'dir'
              : typeflag === '1' || typeflag === '2'
                ? 'link'
                : 'other',
        size,
        dataStart,
      })
      longName = null
      paxPath = null
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

/** @typedef {{ name: string, size: number, dataStart: number }} ArEntry */

/** The global header of a Unix ar archive (a .deb is one). */
export const AR_MAGIC = Buffer.from('!<arch>\n', 'latin1')

/**
 * Lists a Unix ar archive: a .deb holds `debian-binary`, `control.tar.*` and `data.tar.*`. GNU (`//` name table,
 * `/123`) and BSD (`#1/len`) long names are supported; symbol tables are skipped.
 * @param {ByteSource} src @returns {ArEntry[]}
 */
export function listAr(src) {
  if (!src.read(0, AR_MAGIC.length).equals(AR_MAGIC)) throw new ArchiveFormatError('not an ar archive')
  /** @type {ArEntry[]} */
  const entries = []
  /** @type {Buffer | null} */
  let gnuNames = null
  for (let offset = AR_MAGIC.length; offset < src.size;) {
    if (offset + 60 > src.size) throw new ArchiveFormatError(`truncated ar header at byte ${offset}`)
    const h = src.read(offset, 60)
    if (h.toString('latin1', 58, 60) !== '`\n')
      throw new ArchiveFormatError(`bad ar header at byte ${offset}`)
    const raw = h.toString('latin1', 0, 16).trimEnd()
    const sizeText = h.toString('latin1', 48, 58).trim()
    if (!/^\d+$/.test(sizeText)) throw new ArchiveFormatError(`bad ar entry size at byte ${offset}`)
    const size = Number(sizeText)
    let dataStart = offset + 60
    let dataSize = size
    if (dataStart + size > src.size) throw new ArchiveFormatError('ar entry out of bounds')
    let name = ''
    if (raw === '//') gnuNames = src.read(dataStart, Math.min(size, MIB))
    else if (raw === '/' || raw === '/SYM64/' || raw.startsWith('__.SYMDEF')) name = ''
    else if (/^\/\d+$/.test(raw)) {
      if (!gnuNames) throw new ArchiveFormatError('a GNU long ar name without a name table')
      const at = Number(raw.slice(1))
      const end = gnuNames.indexOf('/\n', at)
      name = gnuNames.toString('utf8', at, end < 0 ? gnuNames.length : end)
    } else if (/^#1\/\d+$/.test(raw)) {
      const length = Number(raw.slice(3))
      if (length > size) throw new ArchiveFormatError('a BSD long ar name longer than its entry')
      name = src.read(dataStart, length).toString('utf8').replace(/\0+$/, '')
      dataStart += length
      dataSize -= length
    } else name = raw.endsWith('/') ? raw.slice(0, -1) : raw
    if (name) entries.push({ name, size: dataSize, dataStart })
    offset = offset + 60 + size + (size % 2)
  }
  return entries
}

/** Magic numbers of archive formats the guard cannot open (it refuses them). */
const OTHER_ARCHIVES = /** @type {const} */ ([
  ['7-Zip', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ['RAR', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
  ['bzip2', [0x42, 0x5a, 0x68]], // "BZh" + a block-size digit (checked below)
  ['zstd', [0x28, 0xb5, 0x2f, 0xfd]],
  ['lz4', [0x04, 0x22, 0x4d, 0x18]],
  ['lzip', [0x4c, 0x5a, 0x49, 0x50]],
  ['cabinet', [0x4d, 0x53, 0x43, 0x46]],
])
const OTHER_ARCHIVE_EXT = /\.(7z|rar|bz2|tbz2?|zst|tzst|lz|lz4|lzma|tlz|cab|z|iso|wim)$/

// ---------------------------------------------------------------------------------------------------------------------
// Name and content rules.

const DB_FILE = /\.(db|db3|sqlite|sqlite3)(-(wal|shm|journal))?$/
const FONT_FILE = /\.(ttf|otf|ttc|woff2?|eot)$/
const BUNDLE_FILE =
  /\.(msi|msix|msixbundle|appx|appxbundle|dmg|pkg|deb|rpm|appimage|snap|flatpak|apk|aab|ipa)$|\.(app|appimage)\.tar\.gz$|\.(nsis|msi)\.zip$/
const JSON_FILE = /\.(json|jsonl|ndjson)$/

/** @type {[string, RegExp[]][]} QF-derived JSON shapes: every pattern of a group must match. */
const QDC_RESPONSE_SHAPES = [
  [
    'a QDC verses response',
    [/"verse_key"\s*:/, /"(code_v[12]|text_qpc_hafs|text_imlaei(_simple)?|char_type_name)"\s*:/],
  ],
  ['a QDC chapters response', [/"bismillah_pre"\s*:/, /"revelation_order"\s*:/]],
]
/** @type {[string, RegExp[]][]} */
const FIXTURE_SHAPES = [
  ['mushaf page words (PageData)', [/"ayahId"\s*:/, /"glyph"\s*:/, /"isEnd"\s*:/]],
  ['the fixture manifest', [/"ayahWindows"\s*:/]],
  ['the Quran index (QuranIndex)', [/"surahs"\s*:/, /"juz"\s*:/, /"rub"\s*:/, /"manzil"\s*:/]],
]

/** @param {Buffer} buf @param {readonly number[]} bytes */
function startsWith(buf, bytes) {
  return buf.length >= bytes.length && bytes.every((b, i) => buf.readUInt8(i) === b)
}

/**
 * The executable format of `head` (the first bytes of `src`), or null.
 * @param {Buffer} head @param {ByteSource} src
 */
function executableKind(head, src) {
  if (startsWith(head, [0x4d, 0x5a]) && src.size >= 64) {
    const peOffset = head.length >= 64 ? head.readUInt32LE(0x3c) : -1
    if (peOffset > 0 && src.read(peOffset, 4).equals(Buffer.from('PE\0\0', 'latin1'))) {
      const nsis = src.read(0, Math.min(src.size, 4 * MIB)).includes('NullsoftInst')
      return nsis ? 'an NSIS installer (PE)' : 'a Windows PE binary'
    }
  }
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'an ELF binary'
  const magic = head.length >= 8 ? head.readUInt32BE(0) : 0
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return 'a Mach-O binary'
  if (magic === 0xcafebabe && head.readUInt32BE(4) >= 1 && head.readUInt32BE(4) <= 30)
    return 'a universal Mach-O binary'
  return null
}

/** @param {Buffer} head */
function isFontMagic(head) {
  if (head.length < 12) return false
  const tag = head.toString('latin1', 0, 4)
  if (tag === 'wOFF' || tag === 'wOF2' || tag === 'OTTO' || tag === 'ttcf' || tag === 'true') return true
  if (head.readUInt32BE(0) !== 0x00010000) return false
  const tables = head.readUInt16BE(4)
  return tables >= 4 && tables <= 64 && head.readUInt16BE(6) === 16 * 2 ** Math.floor(Math.log2(tables))
}

// ---------------------------------------------------------------------------------------------------------------------
// The inspector.

class Inspector {
  /** @param {{ cwd: string, rules: Rules, verified: Map<string, number> }} options */
  constructor({ cwd, rules, verified }) {
    this.cwd = cwd
    this.rules = rules
    /** Release rules: SHA-256 → size of the installers scripts/check-bundles.mjs verified. */
    this.verified = verified
    /** @type {Map<string, Reason[]>} */
    this.findings = new Map()
    /** @type {Map<RuleId, string[]>} directory-level path findings, so children don't repeat them */
    this.reportedTrees = new Map()
    this.inspectedFiles = 0
    /** @type {Set<string>} */
    this.seenFiles = new Set()
    /** @type {Set<string>} */
    this.seenDirs = new Set()
    /** @type {string[]} */
    this.notFound = []
    this.decompressed = 0
    /** The display path of the input being inspected. */
    this.currentRoot = ''
  }

  /** Charges `bytes` against the decompression budget and returns what is left. @param {number} bytes */
  budget = (bytes) => {
    this.decompressed += bytes
    return Math.max(0, MAX_TOTAL_DECOMPRESSED - this.decompressed)
  }

  /** @param {string} where @param {RuleId} rule @param {string} detail @param {boolean} [qul] */
  add(where, rule, detail, qul = false) {
    const tree = SUBSUMED_BY[rule]
    if (tree && this.inTree(tree, where)) return
    const reasons = this.findings.get(where) ?? []
    // The first reason per rule says it all.
    if (!reasons.some((r) => r.rule === rule)) reasons.push(qul ? { rule, detail, qul } : { rule, detail })
    this.findings.set(where, reasons)
  }

  /**
   * Whether `reason` (one of `reasons`, the findings of one path) is refused under the active rules.
   * @param {Reason} reason @param {Reason[]} reasons
   */
  refuses(reason, reasons) {
    if (this.rules === 'private') return !RULES[reason.rule].privateAllowed
    if (this.rules === 'release') {
      if (reason.rule === 'sqlite') return reason.qul !== true
      if (reason.rule === 'db-file') return !reasons.some((r) => r.rule === 'sqlite' && r.qul === true)
      return !RULES[reason.rule].releaseAllowed
    }
    return true
  }

  /**
   * Release rules: an installer the guard could not open must be one check-bundles verified (same size and SHA-256).
   * @param {string} where @param {number} fd @param {number} size
   */
  requireVerified(where, fd, size) {
    const reasons = this.findings.get(where) ?? []
    // An installer: a bundle by name (.dmg, .AppImage, …) or an NSIS installer by content. A plain binary (the app's
    // exe, a DLL or a shared library inside an unpacked installer) is code and is allowed as it is.
    const installer = reasons.some(
      (r) => r.rule === 'bundle' || (r.rule === 'executable' && r.detail.startsWith('an NSIS installer')),
    )
    if (!installer) return
    const hash = createHash('sha256')
    const chunk = Buffer.alloc(4 * MIB)
    for (let at = 0; at < size;) {
      const got = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - at), at)
      if (got === 0) break
      hash.update(chunk.subarray(0, got))
      at += got
    }
    const sha256 = hash.digest('hex')
    if (this.verified.get(sha256) === size) return
    this.add(
      where,
      'uninspectable',
      `an installer whose contents this guard cannot open (sha256 ${sha256.slice(0, 12)}…): unpack and verify it ` +
        'with `node scripts/check-bundles.mjs --core qul --manifest <file>`, then pass --verified <file>',
    )
  }

  /** @param {RuleId} rule @param {string} where whether `where` lies in a tree already reported for `rule` */
  inTree(rule, where) {
    const tops = this.reportedTrees.get(rule) ?? []
    return tops.some((top) => where === top || where.startsWith(`${top}/`) || where.startsWith(`${top}!/`))
  }

  /**
   * A path rule that covers a whole tree is reported once, at its top, but never above the input being inspected.
   * @param {string} top @param {RuleId} rule @param {string} detail
   */
  addTree(top, rule, detail) {
    const root = this.currentRoot
    const shown = root && (root === top || root.startsWith(`${top}/`)) ? root : top
    if (this.inTree(rule, shown)) return
    this.reportedTrees.set(rule, [...(this.reportedTrees.get(rule) ?? []), shown])
    this.add(shown, rule, detail)
  }

  /** @param {string} arg a path or glob, relative to cwd */
  inspectArg(arg) {
    if (/[*?[\]{}]/.test(arg)) {
      const matches = fs.globSync(arg, { cwd: this.cwd })
      if (matches.length === 0) this.notFound.push(arg)
      for (const match of [...matches].sort()) this.inspectRoot(path.resolve(this.cwd, match))
      return
    }
    const abs = path.resolve(this.cwd, arg)
    if (!fs.existsSync(abs) && !isSymlink(abs)) {
      this.notFound.push(arg)
      return
    }
    this.inspectRoot(abs)
  }

  /** @param {string} abs */
  inspectRoot(abs) {
    this.currentRoot = this.display(abs)
    this.inspectPath(abs)
  }

  /** @param {string} abs */
  display(abs) {
    const rel = path.relative(this.cwd, abs)
    const shown = rel === '' ? '.' : rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel
    return shown.split(path.sep).join('/')
  }

  /** @param {string} abs */
  inspectPath(abs) {
    const where = this.display(abs)
    const components = where.split('/').filter((c) => c !== '' && c !== '.')
    /** @type {fs.Stats} */
    let stat
    try {
      const link = fs.lstatSync(abs)
      stat = link.isSymbolicLink() ? fs.statSync(abs) : link
    } catch (error) {
      if (isSymlink(abs)) return void this.notFound.push(`${where} (dangling symlink)`)
      return void this.add(where, 'uninspectable', `cannot be read (${message(error)})`)
    }
    // Path rules apply to every name a file or directory is reached by (a symlink can hide a fixtures/ directory behind
    // another name); its content is inspected once.
    if (stat.isDirectory()) {
      this.pathRules(where, components, 'dir')
      let real
      try {
        real = fs.realpathSync(abs)
      } catch (error) {
        return void this.add(where, 'uninspectable', `cannot be read (${message(error)})`)
      }
      if (this.seenDirs.has(real)) return
      this.seenDirs.add(real)
      /** @type {fs.Dirent[]} */
      let children
      try {
        children = fs.readdirSync(abs, { withFileTypes: true })
      } catch (error) {
        return void this.add(where, 'uninspectable', `cannot be listed (${message(error)})`)
      }
      for (const child of children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
        this.inspectPath(path.join(abs, child.name))
      return
    }
    if (!stat.isFile()) return
    this.pathRules(where, components, 'file')
    let real = abs
    try {
      real = fs.realpathSync(abs)
    } catch {
      // keep abs
    }
    if (this.seenFiles.has(real)) return
    this.seenFiles.add(real)
    this.inspectedFiles++
    /** @type {number | undefined} */
    let fd
    try {
      fd = fs.openSync(abs, 'r')
      const opened = this.contentRules(where, components.at(-1) ?? '', fdSource(fd, stat.size), 0)
      if (this.rules === 'release' && !opened) this.requireVerified(where, fd, stat.size)
    } catch (error) {
      this.add(where, 'uninspectable', `cannot be read (${message(error)})`)
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }

  /**
   * Rules on the path alone.
   * @param {string} where @param {string[]} components @param {'file' | 'dir'} kind
   */
  pathRules(where, components, kind) {
    const lower = components.map((c) => c.toLowerCase())
    const name = lower.at(-1) ?? ''
    const fixturesAt = lower.findIndex((c) => c === 'fixtures' || c === 'fixtures-out')
    if (fixturesAt >= 0)
      this.addTree(
        treeTop(where, components, fixturesAt),
        'fixtures',
        'browser-mock fixtures are exported from the qdc core.db (QF-derived, §4.6)',
      )
    for (let i = 0; i + 1 < lower.length; i++) {
      if (lower[i] !== 'data') continue
      if (lower[i + 1] === 'cache')
        this.addTree(
          treeTop(where, components, i + 1),
          'data-cache',
          'raw QF API responses are never uploaded (§4.2)',
        )
      if (lower[i + 1] === 'dev-packs')
        this.addTree(
          treeTop(where, components, i + 1),
          'dev-packs',
          'QCF fonts may not be redistributed as an asset package (§4.8, FACT §2.1)',
        )
    }
    const targetAt = lower.indexOf('target')
    const bundleAt = targetAt >= 0 ? lower.indexOf('bundle', targetAt + 1) : -1
    if (bundleAt >= 0)
      this.addTree(treeTop(where, components, bundleAt), 'bundle', 'a Tauri bundle output directory')
    const appAt = lower.findIndex((c, i) => c.endsWith('.app') && (i < lower.length - 1 || kind === 'dir'))
    if (appAt >= 0) this.addTree(treeTop(where, components, appAt), 'bundle', 'a macOS application bundle')
    if (kind === 'dir') return
    if (DB_FILE.test(name))
      this.add(where, 'db-file', 'database files are never uploaded while the repository is public')
    if (FONT_FILE.test(name)) this.add(where, 'font', 'font binaries are never uploaded (FACT §2.1, D23)')
    if (BUNDLE_FILE.test(name)) this.add(where, 'bundle', 'an installer or application package')
    if (OTHER_ARCHIVE_EXT.test(name))
      this.add(where, 'uninspectable', 'an archive format the guard cannot open, so it is refused')
  }

  /**
   * Rules on the bytes; archives are opened and walked. Returns whether `src` was an archive the guard opened.
   * @param {string} where @param {string} name @param {ByteSource} src @param {number} depth
   * @returns {boolean}
   */
  contentRules(where, name, src, depth) {
    const lowerName = name.toLowerCase()
    const head = src.read(0, 512)
    if (head.subarray(0, 16).equals(SQLITE_MAGIC)) {
      const { detail, qul } = describeSqlite(src)
      this.add(where, 'sqlite', detail, qul)
      return false
    }
    const zip = startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])
    const gzip = startsWith(head, [0x1f, 0x8b])
    const tar = isTarHeader(head)
    const ar = head.subarray(0, AR_MAGIC.length).equals(AR_MAGIC)
    const xz = startsWith(head, XZ_MAGIC)
    if (zip || gzip || tar || ar || xz) {
      if (depth >= MAX_ARCHIVE_DEPTH) {
        this.add(where, 'uninspectable', `archives nested deeper than ${MAX_ARCHIVE_DEPTH} levels`)
        return false
      }
      try {
        if (zip) this.inspectZip(where, src, depth)
        else if (tar) this.inspectTar(where, src, depth)
        else if (ar) this.inspectAr(where, src, depth)
        else this.inspectStream(where, lowerName, src, depth, xz ? 'xz' : 'gzip')
      } catch (error) {
        const kind = zip ? 'zip' : tar ? 'tar' : ar ? 'ar' : xz ? 'xz' : 'gzip'
        this.add(where, 'uninspectable', `${kind} archive ${message(error)}`)
        return false
      }
      return true
    }
    const other = OTHER_ARCHIVES.find(
      ([kind, magic]) =>
        startsWith(head, magic) &&
        (kind !== 'bzip2' || (head.length > 3 && /[1-9]/.test(String.fromCharCode(head.readUInt8(3))))),
    )
    if (other) {
      this.add(where, 'uninspectable', `a ${other[0]} archive cannot be inspected, so it is refused`)
      return false
    }
    const executable = executableKind(head, src)
    if (executable)
      this.add(where, 'executable', `${executable}: application builds and installers are never uploaded`)
    if (isFontMagic(head)) this.add(where, 'font', 'font binaries are never uploaded (FACT §2.1, D23)')
    if (JSON_FILE.test(lowerName)) this.jsonRules(where, src)
    return false
  }

  /** @param {string} where @param {ByteSource} src */
  jsonRules(where, src) {
    const text = src.read(0, Math.min(src.size, MAX_JSON_SCAN)).toString('utf8')
    for (const [what, patterns] of QDC_RESPONSE_SHAPES)
      if (patterns.every((p) => p.test(text))) this.add(where, 'qdc-response', `${what} (QF content)`)
    for (const [what, patterns] of FIXTURE_SHAPES)
      if (patterns.every((p) => p.test(text)))
        this.add(where, 'fixture-data', `${what}, exported from core.db`)
  }

  /** @param {string} where @param {ByteSource} src @param {number} depth */
  inspectZip(where, src, depth) {
    const entries = listZip(src)
    for (const entry of entries) {
      const inner = `${where}!/${entry.name.replace(/\\/g, '/').replace(/\/+$/, '')}`
      const components = entry.name.split(/[\\/]+/).filter(Boolean)
      if (entry.isDir) {
        this.pathRules(inner, components, 'dir')
        continue
      }
      this.inspectedFiles++
      this.pathRules(inner, components, 'file')
      if (entry.encrypted) {
        this.add(inner, 'uninspectable', 'an encrypted zip entry cannot be inspected, so it is refused')
        continue
      }
      try {
        this.contentRules(inner, components.at(-1) ?? '', zipEntryData(src, entry, this.budget), depth + 1)
      } catch (error) {
        this.add(inner, 'uninspectable', `zip entry ${message(error)}`)
      }
    }
  }

  /** @param {string} where @param {ByteSource} src @param {number} depth */
  inspectTar(where, src, depth) {
    for (const entry of listTar(src)) {
      const inner = `${where}!/${entry.name.replace(/\\/g, '/').replace(/\/+$/, '')}`
      const components = entry.name.split(/[\\/]+/).filter(Boolean)
      if (entry.type === 'dir') {
        this.pathRules(inner, components, 'dir')
        continue
      }
      if (entry.type !== 'file') {
        this.pathRules(inner, components, 'file')
        continue
      }
      this.inspectedFiles++
      this.pathRules(inner, components, 'file')
      this.contentRules(
        inner,
        components.at(-1) ?? '',
        sliceSource(src, entry.dataStart, entry.size),
        depth + 1,
      )
    }
  }

  /** @param {string} where @param {ByteSource} src @param {number} depth */
  inspectAr(where, src, depth) {
    for (const entry of listAr(src)) {
      const inner = `${where}!/${entry.name.replace(/\\/g, '/')}`
      const components = entry.name.split(/[\\/]+/).filter(Boolean)
      this.inspectedFiles++
      this.pathRules(inner, components, 'file')
      this.contentRules(
        inner,
        components.at(-1) ?? '',
        sliceSource(src, entry.dataStart, entry.size),
        depth + 1,
      )
    }
  }

  /**
   * A gzip or xz stream: a tar inside is walked, anything else is inspected as one file.
   * @param {string} where @param {string} lowerName @param {ByteSource} src @param {number} depth
   * @param {'gzip' | 'xz'} format
   */
  inspectStream(where, lowerName, src, depth, format) {
    if (src.size > MAX_ENTRY_BYTES)
      throw new ArchiveFormatError(`of ${formatBytes(src.size)} is too large to inspect`)
    const limit = inflateOptions(this.budget)
    const out =
      format === 'xz'
        ? unxz(readAll(src), limit.maxOutputLength)
        : inflate(() => zlib.gunzipSync(readAll(src), limit))
    this.budget(out.length)
    const inner = bufferSource(out)
    if (isTarHeader(out.subarray(0, 512))) return this.inspectTar(where, inner, depth + 1)
    const ext = format === 'xz' ? '.xz' : '.gz'
    const innerName = lowerName.endsWith(ext) ? lowerName.slice(0, -ext.length) : `${lowerName}.content`
    const innerWhere = `${where}!/${innerName}`
    this.inspectedFiles++
    this.pathRules(innerWhere, [innerName], 'file')
    this.contentRules(innerWhere, innerName, inner, depth + 1)
  }

  /** @param {string[]} inputs @returns {Report} */
  report(inputs) {
    /** @type {Finding[]} */
    const forbidden = []
    /** @type {Finding[]} */
    const allowed = []
    for (const [where, reasons] of [...this.findings].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const refused = reasons.some((r) => this.refuses(r, reasons))
      ;(refused ? forbidden : allowed).push({ path: where, reasons })
    }
    return {
      ok: forbidden.length === 0,
      private: this.rules === 'private',
      rules: this.rules,
      inputs,
      inspectedFiles: this.inspectedFiles,
      notFound: this.notFound,
      forbidden,
      allowed,
    }
  }
}

/** The display path of the tree rooted at `components[index]`. @param {string} where @param {string[]} components @param {number} index */
function treeTop(where, components, index) {
  const archive = where.lastIndexOf('!/')
  const prefix = archive >= 0 ? `${where.slice(0, archive)}!/` : ''
  const local = archive >= 0 ? where.slice(archive + 2).split('/') : where.split('/')
  // `components` and `local` name the same path; keep the original spelling (and any absolute prefix).
  const skip = local.length - components.length
  return prefix + local.slice(0, skip + index + 1).join('/')
}

/** @param {string} abs */
function isSymlink(abs) {
  try {
    return fs.lstatSync(abs).isSymbolicLink()
  } catch {
    return false
  }
}

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {number} n */
function formatBytes(n) {
  return n >= MIB ? `${(n / MIB).toFixed(1)} MiB` : n >= KIB ? `${(n / KIB).toFixed(1)} KiB` : `${n} B`
}

// ---------------------------------------------------------------------------------------------------------------------
// Repository visibility (--private).

/**
 * Whether the GitHub event payload says the repository is private.
 * @param {NodeJS.ProcessEnv} env @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function confirmPrivateRepository(env) {
  const eventPath = env.GITHUB_EVENT_PATH
  if (!eventPath)
    return {
      ok: false,
      reason: 'GITHUB_EVENT_PATH is not set, so the repository visibility cannot be confirmed',
    }
  /** @type {any} */
  let event
  try {
    event = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
  } catch (error) {
    return { ok: false, reason: `the event payload ${eventPath} cannot be read (${message(error)})` }
  }
  const repo = event?.repository
  if (repo?.private === true && repo?.visibility !== 'public') return { ok: true }
  return {
    ok: false,
    reason: `the event payload says repository.private = ${JSON.stringify(repo?.private ?? null)}${
      repo?.visibility ? ` (visibility ${repo.visibility})` : ''
    }`,
  }
}

/**
 * Inspects `inputs` (paths or globs relative to `cwd`) under the public rules, the private-repository rules
 * (`privateRepo`) or the release rules (`release`, with the installers check-bundles verified).
 * @param {string[]} inputs
 * @param {{ cwd?: string, privateRepo?: boolean, release?: boolean, verified?: VerifiedInstaller[] }} [options]
 * @returns {Report}
 */
export function inspect(
  inputs,
  { cwd = process.cwd(), privateRepo = false, release = false, verified = [] } = {},
) {
  if (privateRepo && release) throw new Error('the private-repository and release rules are exclusive')
  const inspector = new Inspector({
    cwd,
    rules: release ? 'release' : privateRepo ? 'private' : 'public',
    verified: new Map(verified.map((v) => [v.sha256.toLowerCase(), v.bytes])),
  })
  for (const input of inputs) inspector.inspectArg(input)
  return inspector.report(inputs)
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI.

const USAGE = `Usage: node scripts/check-artifacts.mjs [--private | --release [--verified <file>]] [--json] [--from-env VAR]
                                   [--] <path | glob>...

Refuses QF-derived and distributable content before a CI upload (ARCHITECTURE §13.3): SQLite databases and *.db files,
fixtures/ trees and fixture-shaped JSON, raw QDC responses, data/cache, data/dev-packs, installers and app bundles,
executables, fonts, and any archive it cannot fully inspect. Archives (zip, tar, tar.gz, gz, xz, ar/.deb) are opened
recursively.

  --private        private-repository rules: databases and fixtures are allowed (only when the GitHub event payload
                   says repository.private is true)
  --release        release rules (§13.4, release.yml): installers and executables are allowed, an SQLite database only
                   as a core.db with meta.source = 'qul'; installers the guard cannot open need --verified
  --verified FILE  the qd-bundle-check/1 manifest of \`node scripts/check-bundles.mjs --core qul --manifest FILE\`
  --from-env VAR   also read paths from the environment variable VAR, one per line
  --json           print the report as JSON
  --help

Exit codes: 0 nothing forbidden, 1 something forbidden (or --private refused), 2 bad usage.`

/** The manifest format `scripts/check-bundles.mjs` writes. */
export const BUNDLE_CHECK_FORMAT = 'qd-bundle-check/1'

/**
 * The installers a check-bundles manifest verified for a release: a qul run whose installers passed.
 * @param {string} file @returns {{ ok: true, verified: VerifiedInstaller[] } | { ok: false, reason: string }}
 */
export function readVerified(file) {
  /** @type {any} */
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return { ok: false, reason: `${file} cannot be read (${message(error)})` }
  }
  if (manifest?.format !== BUNDLE_CHECK_FORMAT)
    return { ok: false, reason: `${file} is not a ${BUNDLE_CHECK_FORMAT} manifest` }
  if (manifest.core !== 'qul')
    return {
      ok: false,
      reason: `${file} verified bundles around a ${JSON.stringify(manifest.core)} core.db; a release needs --core qul`,
    }
  /** @type {VerifiedInstaller[]} */
  const verified = []
  for (const entry of Array.isArray(manifest.installers) ? manifest.installers : [])
    if (entry?.ok === true && typeof entry.sha256 === 'string' && Number.isSafeInteger(entry.bytes))
      verified.push({ sha256: entry.sha256, bytes: entry.bytes })
  return { ok: true, verified }
}

/** Escapes a GitHub workflow-command message. @param {string} s */
function escapeData(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/**
 * Runs the CLI; returns the exit code.
 * @param {string[]} argv @param {{ env?: NodeJS.ProcessEnv, cwd?: string, out?: (line: string) => void,
 *   err?: (line: string) => void }} [io]
 */
export function main(
  argv,
  { env = process.env, cwd = process.cwd(), out = console.log, err = console.error } = {},
) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        private: { type: 'boolean', default: false },
        release: { type: 'boolean', default: false },
        verified: { type: 'string' },
        json: { type: 'boolean', default: false },
        'from-env': { type: 'string', multiple: true, default: [] },
        help: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    err(`check-artifacts: ${message(error)}\n\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    out(USAGE)
    return 0
  }
  const inputs = [...positionals]
  for (const name of values['from-env']) {
    const value = env[name]
    if (value === undefined) {
      err(`check-artifacts: --from-env ${name}: the variable is not set`)
      return 2
    }
    inputs.push(
      ...value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    )
  }
  if (inputs.length === 0) {
    err(`check-artifacts: no paths given\n\n${USAGE}`)
    return 2
  }
  const excludes = inputs.filter((p) => p.startsWith('!'))
  if (excludes.length > 0) {
    err(
      `check-artifacts: exclusion patterns are not supported (${excludes.join(', ')}); list exactly the paths to upload`,
    )
    return 2
  }
  const annotate = env.GITHUB_ACTIONS === 'true'
  if (values.private && values.release) {
    err('check-artifacts: --private and --release are exclusive')
    return 2
  }
  if (values.verified !== undefined && !values.release) {
    err('check-artifacts: --verified applies to the release rules only (--release)')
    return 2
  }
  /** @type {VerifiedInstaller[]} */
  let verified = []
  if (values.verified !== undefined) {
    const read = readVerified(path.resolve(cwd, values.verified))
    if (!read.ok) {
      err(`check-artifacts: --verified: ${read.reason}`)
      if (annotate) out(`::error title=check-artifacts::${escapeData(`--verified: ${read.reason}`)}`)
      return 1
    }
    verified = read.verified
  }
  let privateRepo = false
  if (values.private) {
    const visibility = confirmPrivateRepository(env)
    if (!visibility.ok) {
      const text = `--private refused: ${visibility.reason}. Databases and fixtures may be uploaded only from a private repository (§13.3).`
      err(`check-artifacts: ${text}`)
      if (annotate) out(`::error title=check-artifacts::${escapeData(text)}`)
      return 1
    }
    privateRepo = true
  }

  const report = inspect(inputs, { cwd, privateRepo, release: values.release, verified })
  if (values.json) {
    out(JSON.stringify(report, null, 2))
  } else {
    const rules =
      report.rules === 'release'
        ? 'release rules'
        : privateRepo
          ? 'private-repository rules'
          : 'public-repository rules'
    out(`check-artifacts  ${inputs.length} input(s), ${report.inspectedFiles} file(s) inspected (${rules})`)
    for (const missing of report.notFound) out(`  note  nothing matches ${missing}`)
    const show = (/** @type {string} */ label, /** @type {Finding[]} */ list) => {
      for (const finding of list.slice(0, 200)) {
        out(`  ${label}  ${finding.path}`)
        for (const r of finding.reasons) out(`          ${r.rule.padEnd(13)} ${r.detail}`)
      }
      if (list.length > 200) out(`          … ${list.length - 200} more`)
    }
    const release = report.rules === 'release'
    show('FAIL', report.forbidden)
    show(release ? 'ok (release)' : 'ok (private repository)', report.allowed)
    out(
      !report.ok
        ? `check-artifacts FAILED: ${report.forbidden.length} forbidden path(s); nothing may be uploaded (ARCHITECTURE ${release ? '§13.4' : '§13.3'})`
        : release
          ? `check-artifacts passed (release): ${report.allowed.length} installer, executable or qul core.db path(s), nothing QF-derived`
          : report.allowed.length > 0
            ? `check-artifacts passed (private repository): ${report.allowed.length} QF-derived development path(s) allowed, nothing else forbidden`
            : 'check-artifacts passed: nothing QF-derived or distributable would be uploaded',
    )
  }
  if (annotate)
    for (const finding of report.forbidden.slice(0, 50))
      out(
        `::error title=check-artifacts::${escapeData(
          `${finding.path}: ${finding.reasons.map((r) => `${RULES[r.rule].title}: ${r.detail}`).join('; ')}`,
        )}`,
      )
  return report.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
