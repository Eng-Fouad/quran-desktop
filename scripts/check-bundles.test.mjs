// @ts-check
// node --test scripts/check-bundles.test.mjs
//
// The pure checks, and the deb path end to end (a deb is read in Node, so a synthetic one exercises everything). The
// NSIS, dmg and AppImage paths need 7-Zip, hdiutil or Linux; CI runs them on the real installers.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import zlib from 'node:zlib'
import {
  binaryArch,
  checkBinaryArch,
  checkBundles,
  checkCore,
  checkDebControl,
  checkDesktopEntry,
  checkInfoPlist,
  checkLinuxTree,
  checkNsisScript,
  expectations,
  findPortable,
  pngSize,
} from './check-bundles.mjs'

/** @type {typeof import('node:sqlite') | null} */
let sqlite = null
try {
  sqlite = await import('node:sqlite')
} catch {
  sqlite = null
}
const needsSqlite = sqlite ? {} : { skip: 'node:sqlite is not available in this Node version' }

const work = fs.mkdtempSync(path.join(tmpdir(), 'qd-check-bundles-'))
after(() => fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
let counter = 0
const fresh = () => {
  const dir = path.join(work, `case-${++counter}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const expect = expectations()

/** A core.db-shaped SQLite file (> 1 MiB when `big`). @param {string} source @param {boolean} [big] */
function coreDb(source, big = true) {
  if (!sqlite) throw new Error('node:sqlite unavailable')
  const file = path.join(fresh(), 'core.db')
  const db = new sqlite.DatabaseSync(file)
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID')
  for (const t of ['mushaf', 'ayah', 'word']) db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, x TEXT)`)
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('source', source)
  if (big) {
    const insert = db.prepare('INSERT INTO word (x) VALUES (?)')
    db.exec('BEGIN')
    for (let i = 0; i < 3000; i++) insert.run(`${i}`.padEnd(500, 'x'))
    db.exec('COMMIT')
  }
  db.close()
  return fs.readFileSync(file)
}

/** @param {Record<string, string | Buffer>} files */
function tar(files) {
  /** @type {Buffer[]} */
  const blocks = []
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const h = Buffer.alloc(512)
    h.write(name, 0, 'utf8')
    h.write('0000644\0', 100, 'latin1')
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
    h.write('00000000000\0', 136, 'latin1')
    h.write('        ', 148, 'latin1')
    h.write('0', 156, 'latin1')
    h.write('ustar\0', 257, 'latin1')
    h.write('00', 263, 'latin1')
    let sum = 0
    for (const b of h) sum += b
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

/** @param {string} control @param {Record<string, string | Buffer>} data */
function deb(control, data) {
  /** @param {string} name @param {Buffer} body */
  const member = (name, body) => {
    const h = Buffer.alloc(60, 0x20)
    h.write(`${name}/`, 0, 'latin1')
    h.write(String(body.length), 48, 'latin1')
    h.write('`\n', 58, 'latin1')
    return Buffer.concat([h, body, Buffer.alloc(body.length % 2, 0x0a)])
  }
  return Buffer.concat([
    Buffer.from('!<arch>\n', 'latin1'),
    member('debian-binary', Buffer.from('2.0\n')),
    member('control.tar.gz', zlib.gzipSync(tar({ './control': control }))),
    member('data.tar.gz', zlib.gzipSync(tar(data))),
  ])
}

const CONTROL = `Package: quran
Version: ${expect.version}
Architecture: amd64
Installed-Size: 26000
Maintainer: Quran for Desktop contributors
Priority: optional
Depends: libasound2 | libasound2t64, libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0
Description: Quran reader with recitation
`
const DESKTOP = `[Desktop Entry]
Categories=Education;
Comment=Quran reader with recitation
Exec=quran-desktop
StartupWMClass=quran-desktop
Icon=quran-desktop
Name=Quran
Terminal=false
Type=Application
`

/** The first 64 bytes of a little-endian 64-bit ELF for `machine` (62 x86-64, 183 AArch64). @param {number} machine */
function elf(machine) {
  const head = Buffer.alloc(64)
  head.write('\x7fELF', 0, 'latin1')
  head[4] = 2 // ELFCLASS64
  head[5] = 1 // little-endian
  head.writeUInt16LE(machine, 18)
  return head
}

/** A minimal PE: the DOS stub's e_lfanew, then `PE\0\0` and the machine. @param {number} machine */
function pe(machine) {
  const head = Buffer.alloc(0x100)
  head.write('MZ', 0, 'latin1')
  head.writeUInt32LE(0x80, 0x3c)
  head.write('PE\0\0', 0x80, 'latin1')
  head.writeUInt16LE(machine, 0x84)
  return head
}

/** The installed tree of a correct deb. @param {Buffer} core @param {Buffer} [binary] */
function debTree(core, binary = elf(62)) {
  /** @type {Record<string, string | Buffer>} */
  const files = {
    'usr/bin/quran-desktop': binary,
    'usr/lib/Quran/data/core.db': core,
    'usr/lib/Quran/data/catalog.json': '{"packs":[]}',
    'usr/share/applications/Quran.desktop': DESKTOP,
  }
  for (const icon of expect.linuxIcons)
    files[
      `usr/share/icons/hicolor/${icon.width}x${icon.height}${icon.retina ? '@2' : ''}/apps/quran-desktop.png`
    ] = 'png'
  return files
}

describe('expectations', () => {
  it('reads the identity and the Linux icons from the tauri config', () => {
    assert.equal(expect.productName, 'Quran')
    assert.equal(expect.binary, 'quran-desktop')
    assert.equal(expect.identifier, 'com.quran.labs.desktop')
    assert.equal(expect.macMinimum, '13.3')
    assert.equal(expect.installMode, 'currentUser')
    assert.equal(expect.webviewInstallMode, 'downloadBootstrapper')
    assert.equal(expect.installerIcon, 'icons/windows/icon.ico')
    assert.equal(expect.uninstallerIcon, 'icons/windows/icon.ico')
    assert.ok(expect.debDepends.includes('libasound2 | libasound2t64'))
    // tray-32 first (the window icon), one per size (LEAD 16/18): 16, 24, 32, 64, 128, 256 (@2x) and 512.
    const sizes = expect.linuxIcons.map((i) => `${i.width}${i.retina ? '@2' : ''}`).sort()
    assert.deepEqual(new Set(sizes).size, sizes.length, `no size twice: ${sizes.join(', ')}`)
    assert.ok(sizes.includes('16') && sizes.includes('32') && sizes.includes('512'), sizes.join(', '))
    assert.throws(() => pngSize(Buffer.from('not a png at all, really')), /not a PNG/)
  })
})

describe('checks', () => {
  it('core.db: the placeholder in CI bundles, a qul build in releases', needsSqlite, () => {
    assert.deepEqual(checkCore(Buffer.alloc(0), 'placeholder'), [])
    assert.match(checkCore(Buffer.alloc(5), 'placeholder')[0] ?? '', /0-byte placeholder/)
    assert.match(checkCore(Buffer.alloc(0), 'qul')[0] ?? '', /placeholder or a failed build/)
    assert.deepEqual(checkCore(coreDb('qul'), 'qul'), [])
    assert.match(checkCore(coreDb('qdc'), 'qul')[0] ?? '', /meta\.source = "qdc", not 'qul'/)
    assert.match(checkCore(Buffer.alloc(2 * 1024 * 1024, 1), 'qul')[0] ?? '', /not a readable SQLite/)
  })

  it('the desktop entry names the app, its binary and its icon (MPRIS DesktopEntry, §2.4)', () => {
    assert.deepEqual(checkDesktopEntry(DESKTOP, expect), [])
    const wrong = DESKTOP.replace('Name=Quran', 'Name=Quran Desktop').replace(
      'Categories=Education;',
      'Categories=Utility;',
    )
    assert.deepEqual(checkDesktopEntry(wrong, expect), [
      'desktop entry Name="Quran Desktop", expected Quran',
      'desktop entry Categories=Utility; lacks Education',
    ])
  })

  it('deb Depends carries the tray library, the webview and ALSA', () => {
    assert.deepEqual(checkDebControl(CONTROL, expect), [])
    const old = CONTROL.replace('libayatana-appindicator3-1', 'libappindicator3-1')
    assert.deepEqual(checkDebControl(old, expect), [], 'the legacy appindicator is accepted too')
    const missing = CONTROL.replace(', libayatana-appindicator3-1', '').replace(
      'libasound2 | libasound2t64, ',
      '',
    )
    const problems = checkDebControl(missing, expect)
    assert.equal(problems.length, 2, problems.join('\n'))
    assert.match(problems[0] ?? '', /Depends lacks an appindicator library/)
    assert.match(problems[1] ?? '', /Depends lacks libasound2 \| libasound2t64/)
    assert.match(checkDebControl(CONTROL.replace('amd64', 'arm64'), expect)[0] ?? '', /Architecture arm64/)
    // An arm64 build: the same Depends, Architecture arm64.
    assert.deepEqual(checkDebControl(CONTROL.replace('amd64', 'arm64'), expect, 'arm64'), [])
    assert.match(checkDebControl(CONTROL, expect, 'arm64')[0] ?? '', /Architecture amd64, expected arm64/)
  })

  it('reads the architecture of a PE or ELF binary', () => {
    assert.equal(binaryArch(pe(0x8664)), 'x64')
    assert.equal(binaryArch(pe(0xaa64)), 'arm64')
    assert.equal(binaryArch(pe(0x14c)), 'PE machine 0x14c')
    assert.equal(binaryArch(elf(62)), 'x64')
    assert.equal(binaryArch(elf(183)), 'arm64')
    assert.equal(binaryArch(Buffer.from('#!/bin/sh\n')), 'neither a PE nor an ELF binary')
    assert.deepEqual(checkBinaryArch(pe(0xaa64), 'arm64', 'quran-desktop.exe'), [])
    assert.deepEqual(checkBinaryArch(pe(0x8664), 'arm64', 'quran-desktop.exe'), [
      'quran-desktop.exe is built for x64, expected arm64',
    ])
  })

  it('the Linux tree has the binary, the resources, the desktop entry and every icon', () => {
    const files = new Set(Object.keys(debTree(Buffer.alloc(0))))
    assert.deepEqual(checkLinuxTree(files, expect), [])
    files.delete('usr/share/applications/Quran.desktop')
    assert.deepEqual(checkLinuxTree(files, expect), ['missing usr/share/applications/Quran.desktop'])
    const appimage = new Set([...files, 'usr/share/applications/Quran.desktop'])
    assert.match(
      checkLinuxTree(appimage, expect, { appimage: true })[0] ?? '',
      /bundles no libayatana-appindicator3/,
    )
    appimage.add('usr/lib/libayatana-appindicator3.so.1')
    assert.deepEqual(checkLinuxTree(appimage, expect, { appimage: true }), [])
    // An arm64 AppImage keeps the library under its multiarch directory.
    appimage.delete('usr/lib/libayatana-appindicator3.so.1')
    appimage.add('usr/lib/aarch64-linux-gnu/libayatana-appindicator3.so.1')
    assert.deepEqual(checkLinuxTree(appimage, expect, { appimage: true }), [])
  })

  it("reads tauri's NSIS script", () => {
    const script = `!define PRODUCTNAME "Quran"
!define VERSION "${expect.version}"
!define INSTALLMODE "currentUser"
!define MAINBINARYNAME "quran-desktop"
!define BUNDLEID "com.quran.labs.desktop"
!define INSTALLWEBVIEW2MODE "downloadBootstrapper"
!define INSTALLERICON "C:\\repo\\src-tauri\\icons\\windows\\icon.ico"
!define UNINSTALLERICON "C:\\repo\\src-tauri\\icons\\windows\\icon.ico"
  File "\${MAINBINARYSRCPATH}"
    File /a "/oname=data\\catalog.json" "C:\\repo\\src-tauri\\resources\\catalog.json"
    File /a "/oname=data\\core.db" "C:\\repo\\src-tauri\\resources\\core.db"
`
    const ok = checkNsisScript(script, expect)
    assert.deepEqual(ok.problems, [])
    assert.deepEqual(ok.files, [
      { name: 'data/catalog.json', source: 'C:\\repo\\src-tauri\\resources\\catalog.json' },
      { name: 'data/core.db', source: 'C:\\repo\\src-tauri\\resources\\core.db' },
    ])
    const preview = checkNsisScript(
      script.replace('"com.quran.labs.desktop"', '"com.quran.labs.desktop.preview"'),
      expect,
    )
    assert.deepEqual(preview.problems, [
      'NSIS BUNDLEID is "com.quran.labs.desktop.preview", expected "com.quran.labs.desktop"',
    ])
    // Without `installerIcon` tauri writes an empty define and the setup exe shows NSIS's generic icon.
    const generic = checkNsisScript(
      script.replace(/^!define INSTALLERICON ".*"$/m, '!define INSTALLERICON ""'),
      expect,
    )
    assert.deepEqual(generic.problems, [
      'NSIS INSTALLERICON is "", expected the app icon icons/windows/icon.ico',
    ])
  })

  it('Info.plist', () => {
    const plist = {
      CFBundleIdentifier: 'com.quran.labs.desktop',
      CFBundleExecutable: 'quran-desktop',
      CFBundleName: 'Quran',
      CFBundleShortVersionString: expect.version,
      LSMinimumSystemVersion: '13.3',
    }
    assert.deepEqual(checkInfoPlist(plist, expect), [])
    assert.deepEqual(checkInfoPlist({ ...plist, LSMinimumSystemVersion: '10.13' }, expect), [
      'Info.plist LSMinimumSystemVersion is "10.13", expected "13.3"',
    ])
  })
})

describe('a deb end to end', () => {
  it('passes a correct placeholder deb and reports what is wrong with a bad one', () => {
    const bundle = path.join(fresh(), 'bundle')
    const file = path.join(bundle, 'deb', `Quran_${expect.version}_amd64.deb`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, deb(CONTROL, debTree(Buffer.alloc(0))))
    const [ok] = checkBundles({
      bundleDirs: [bundle],
      core: 'placeholder',
      universal: false,
      expect,
      arch: 'x64',
    })
    assert.equal(ok?.kind, 'deb')
    assert.deepEqual(ok?.problems, [])
    assert.equal(ok?.ok, true)
    assert.match(ok?.sha256 ?? '', /^[0-9a-f]{64}$/)

    const tree = debTree(Buffer.alloc(0))
    delete tree['usr/lib/Quran/data/catalog.json']
    tree['usr/share/applications/Quran.desktop'] = DESKTOP.replace('Icon=quran-desktop', 'Icon=quran')
    tree['usr/lib/Quran/fixtures/p1.json'] = '{"ayahId":1,"glyph":"x","isEnd":false}'
    fs.writeFileSync(file, deb(CONTROL.replace(', libgtk-3-0', ''), tree))
    const [bad] = checkBundles({
      bundleDirs: [bundle],
      core: 'placeholder',
      universal: false,
      expect,
      arch: 'x64',
    })
    const text = bad?.problems.join('\n') ?? ''
    assert.equal(bad?.ok, false)
    assert.match(text, /Depends lacks libgtk-3-0/)
    assert.match(text, /missing usr\/lib\/Quran\/data\/catalog\.json/)
    assert.match(text, /desktop entry Icon="quran", expected quran-desktop/)
    assert.match(text, /fixtures/)
  })

  it('a release deb needs the qul core.db', needsSqlite, () => {
    const bundle = path.join(fresh(), 'bundle')
    const file = path.join(bundle, 'deb', `Quran_${expect.version}_amd64.deb`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, deb(CONTROL, debTree(coreDb('qul'))))
    const opts = /** @type {const} */ ({ core: 'qul', universal: false, expect, arch: 'x64' })
    assert.equal(checkBundles({ bundleDirs: [bundle], ...opts })[0]?.ok, true)
    fs.writeFileSync(file, deb(CONTROL, debTree(coreDb('qdc'))))
    const [qdc] = checkBundles({ bundleDirs: [bundle], ...opts })
    assert.equal(qdc?.ok, false)
    assert.match(qdc?.problems.join('\n') ?? '', /meta\.source = "qdc"/)
  })

  it('an arm64 deb passes as arm64, and a binary of the other architecture fails', () => {
    const bundle = path.join(fresh(), 'bundle')
    const file = path.join(bundle, 'deb', `Quran_${expect.version}_arm64.deb`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const control = CONTROL.replace('amd64', 'arm64')
    fs.writeFileSync(file, deb(control, debTree(Buffer.alloc(0), elf(183))))
    const opts = /** @type {const} */ ({ core: 'placeholder', universal: false, expect, arch: 'arm64' })
    const [ok] = checkBundles({ bundleDirs: [bundle], ...opts })
    assert.deepEqual(ok?.problems, [])
    fs.writeFileSync(file, deb(control, debTree(Buffer.alloc(0), elf(62))))
    const [bad] = checkBundles({ bundleDirs: [bundle], ...opts })
    assert.deepEqual(bad?.problems, ['usr/bin/quran-desktop is built for x64, expected arm64'])
  })
})

describe('portable zips', () => {
  it('finds the newest zip under bundle/portable', () => {
    const bundle = path.join(fresh(), 'bundle')
    assert.equal(findPortable([bundle]), undefined)
    const dir = path.join(bundle, 'portable')
    fs.mkdirSync(dir, { recursive: true })
    const older = path.join(dir, 'Quran_0.0.9_x64_portable.zip')
    const newer = path.join(dir, `Quran_${expect.version}_x64_portable.zip`)
    fs.writeFileSync(older, 'zip')
    fs.writeFileSync(newer, 'zip')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a zip')
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(older, past, past)
    assert.equal(findPortable([bundle]), newer)
  })
})
