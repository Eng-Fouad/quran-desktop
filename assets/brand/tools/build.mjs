// @ts-check
/**
 * Brand asset pipeline (ARCHITECTURE §9.9, LEAD.md item 16): every icon, derived from the owner-approved source raster
 * assets/brand/source/ic_upcoming_app_icon.webp by the parameters in tools/design.mjs.
 *
 *   node assets/brand/tools/build.mjs                  write everything (needs the installed Microsoft Edge)
 *   node assets/brand/tools/build.mjs --check          rebuild into a temp dir and compare with the committed files
 *   node assets/brand/tools/build.mjs --check --tolerance 2   … allowing a per-channel Δ of 2 in compared pixels
 *   node assets/brand/tools/build.mjs --review         also write artifacts/brand/review.png (sign-off sheet)
 *
 * Steps: Edge decodes the WebP exactly (raster.mjs); everything else is plain JavaScript (pixels.mjs, design.mjs), so the
 * pixels do not depend on the browser build; PNGs are encoded by formats.mjs (pngjs, zlib level 9).
 *
 * Outputs (repo-relative):
 *   assets/brand/icon.png                       the master: the source's pixels as PNG; input of `pnpm tauri icon`
 *   src-tauri/icons/*                           that command's output (Linux PNGs, Appx, iOS, Android, base ico/icns)
 *   src-tauri/icons/windows/icon.ico            Windows: tuned 16/20/24/32/40/48/64 + the master at 256, full-bleed
 *   src-tauri/icons/macos/icon.icns             macOS: Apple grid (824 px body), tuned 16/32/64, the master above
 *   src-tauri/icons/tray/*.png                  tray: colour 16/20/24/32 (+ tray.png = 32), template 18/36
 *   src-tauri/icons/media/artwork.png           media-session artwork, 512 px, opaque
 *   src/assets/app-icon.svg                     About/onboarding: SVG wrapper around the 256 px master raster
 *   src/assets/app-icon-small.svg               title bar: SVG wrapper around the tuned 32 px raster
 *   src/assets/app-mark.svg                     single colour: currentColor through the silhouette (128 px) as a mask
 *   src/assets/star8.svg                        EmptyState decoration: copy of assets/brand/svg/star8.svg (geometric)
 *
 * `--check` compares PNG pixels (also inside ICO, ICNS and the SVG wrappers; the wrappers' text exactly otherwise),
 * and the `tauri icon` set byte for byte (icon.icns entry by entry: tauri-cli writes its entries in a random order).
 */
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  ARTWORK,
  MACOS,
  MARK,
  SMALL,
  SOURCE,
  TEMPLATE,
  analyse,
  artwork,
  macosCanvas,
  macosIcon,
  masterIcon,
  silhouette,
  tunedIcon,
} from './design.mjs'
import {
  compareRgba,
  decodePng,
  encodeIco,
  encodeIcns,
  encodePng,
  readIcns,
  readIcnsEntries,
  readIco,
} from './formats.mjs'
import { maskToRgba8, toRgba8 } from './pixels.mjs'
import { Rasteriser } from './raster.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TAURI_CLI = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')

/**
 * Windows ICO sizes: tuned up to 64 px (16–32: the taskbar, tray and small icons; 40–64: the same slots at 125–200 %
 * scaling, where the master's thin bevelled strokes read poorly), the master at 256 (Explorer's large views).
 */
const WINDOWS_TUNED = /** @type {const} */ ([16, 20, 24, 32, 40, 48, 64])
const WINDOWS_MASTER = /** @type {const} */ ([256])
/** Tray icons: one per notification-area DPI step (16 at 100 %, 20 at 125 %, 24 at 150 %, 32 at 200 %). */
const TRAY = /** @type {const} */ ([16, 20, 24, 32])
const MACOS_TUNED = /** @type {const} */ ([16, 32, 64])
const MACOS_MASTER = /** @type {const} */ ([128, 256, 512, 1024])
/** Directories inside src-tauri/icons that this script owns beyond the `tauri icon` set. */
const OWN_DIRS = ['windows', 'macos', 'tray', 'media']
/** Product name (LEAD.md item 16) for the SVG <title>s. */
const TITLE = 'Quran'

const { values: args } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    review: { type: 'boolean', default: false },
    tolerance: { type: 'string', default: '0' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})
if (args.help) {
  console.log('usage: node assets/brand/tools/build.mjs [--check [--tolerance N]] [--review]')
  process.exit(0)
}
const tolerance = Number(args.tolerance)
if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) {
  console.error('build: --tolerance must be an integer 0–255')
  process.exit(2)
}

const png = (/** @type {import('./pixels.mjs').Layer} */ l) => encodePng(toRgba8(l))
const dataUri = (/** @type {Buffer} */ p) => `data:image/png;base64,${p.toString('base64')}`

/**
 * An SVG document that shows one PNG at its exact pixel size (Vite imports it as a URL; CSP allows data: images).
 * @param {Buffer} raster
 * @param {string} comment
 */
function wrapperSvg(raster, comment) {
  const { width: w, height: h } = decodePng(raster)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n` +
    `  <!-- ${comment} -->\n` +
    `  <title>${TITLE}</title>\n` +
    `  <image width="${w}" height="${h}" href="${dataUri(raster)}"/>\n` +
    `</svg>\n`
  )
}

/**
 * The single-colour mark: a rectangle in currentColor, masked by the silhouette (white + alpha, so the default
 * luminance mask equals the alpha). As an <img> or a CSS mask it is black/opaque where the glyph is; inline, it follows
 * the text colour.
 * @param {Buffer} whiteSilhouette
 */
function markSvg(whiteSilhouette) {
  const { width: w, height: h } = decodePng(whiteSilhouette)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n` +
    `  <!-- Single-colour app mark: the قرآن silhouette (${w} px raster) masks a currentColor rectangle. ` +
    `Inline it to follow the text colour, or tint it as a CSS mask over any background (assets/brand/README.md). ` +
    `Generated by assets/brand/tools/build.mjs from assets/brand/source (GPL-3.0, Quran.com / quran_android contributors). -->\n` +
    `  <title>${TITLE}</title>\n` +
    `  <mask id="qd-mark" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">\n` +
    `    <image width="${w}" height="${h}" href="${dataUri(whiteSilhouette)}"/>\n` +
    `  </mask>\n` +
    `  <rect width="${w}" height="${h}" fill="currentColor" mask="url(#qd-mark)"/>\n` +
    `</svg>\n`
  )
}

/** Read and verify the source artwork. */
function readSource() {
  const bytes = readFileSync(join(ROOT, SOURCE.file))
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== SOURCE.sha256)
    throw new Error(
      `${SOURCE.file}: sha256 ${sha}, expected ${SOURCE.sha256} (the approved source, unmodified)`,
    )
  return bytes
}

/**
 * Build every output into `out` (a root that mirrors the repo layout).
 * @param {string} out
 * @param {Rasteriser} raster
 * @param {{ tauriInput: string }} opts the PNG fed to `tauri icon` (the committed one when checking)
 */
async function build(out, raster, opts) {
  /** @type {Map<string, Buffer | string>} */
  const files = new Map()
  const decoded = await raster.decode(readSource(), SOURCE.mime)
  if (decoded.method !== 'webgl')
    console.warn(`build: decoded with ${decoded.method}; semi-transparent edge pixels may differ by rounding`)
  const masterPng = encodePng(decoded)
  files.set('assets/brand/icon.png', masterPng)
  const a = analyse(decoded)

  // Windows: one ICO with exact-size entries; Windows picks the entry for each DPI instead of resampling.
  /** @type {Map<number, Buffer>} */
  const tuned = new Map()
  for (const size of WINDOWS_TUNED) tuned.set(size, png(tunedIcon(a, size, SMALL[size])))
  /** @type {Map<number, Buffer>} */
  const large = new Map()
  for (const size of WINDOWS_MASTER) large.set(size, png(masterIcon(a, size)))
  files.set(
    'src-tauri/icons/windows/icon.ico',
    encodeIco([...tuned, ...large].map(([size, p]) => ({ size, png: p }))),
  )

  // macOS: the Apple grid; 16, 32 and 64 px tuned on it.
  const canvas = macosCanvas(a)
  /** @type {Map<number, Buffer>} */
  const mac = new Map()
  for (const size of MACOS_TUNED) {
    const spec = MACOS.small[size]
    mac.set(size, png(tunedIcon(a, size, spec, spec.inset)))
  }
  for (const size of MACOS_MASTER) mac.set(size, png(macosIcon(canvas, size)))
  files.set('src-tauri/icons/macos/icon.icns', encodeIcns(mac))

  // Tray: the tuned colour icons per Windows DPI step; tray.png (Linux) = 32; black templates for macOS.
  for (const size of TRAY)
    files.set(`src-tauri/icons/tray/tray-${size}.png`, /** @type {Buffer} */ (tuned.get(size)))
  files.set('src-tauri/icons/tray/tray.png', /** @type {Buffer} */ (tuned.get(32)))
  for (const [size, name] of /** @type {const} */ ([
    [18, 'tray-template.png'],
    [36, 'tray-template@2x.png'],
  ]))
    files.set(`src-tauri/icons/tray/${name}`, encodePng(maskToRgba8(silhouette(a, size, TEMPLATE[size]))))

  files.set('src-tauri/icons/media/artwork.png', png(artwork(a)))
  if (ARTWORK.size !== 512) throw new Error('artwork must stay 512 px (consumers)')

  // UI (src/assets): SVG wrappers, so the components' imports stay as they are.
  files.set(
    'src/assets/app-icon.svg',
    wrapperSvg(
      /** @type {Buffer} */ (large.get(256)),
      'App icon (About, onboarding, fatal screen): the 256 px master raster. Generated by assets/brand/tools/build.mjs from assets/brand/source (GPL-3.0, Quran.com / quran_android contributors).',
    ),
  )
  files.set(
    'src/assets/app-icon-small.svg',
    wrapperSvg(
      /** @type {Buffer} */ (tuned.get(32)),
      'App icon for 16–32 px (title bar): the tuned 32 px raster. Generated by assets/brand/tools/build.mjs from assets/brand/source (GPL-3.0, Quran.com / quran_android contributors).',
    ),
  )
  files.set(
    'src/assets/app-mark.svg',
    markSvg(encodePng(maskToRgba8(silhouette(a, MARK.size, MARK.spec), [255, 255, 255]))),
  )
  files.set('src/assets/star8.svg', readFileSync(join(ROOT, 'assets/brand/svg/star8.svg'), 'utf8'))

  for (const [path, data] of files) {
    const target = join(out, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
  }

  // `pnpm tauri icon assets/brand/icon.png` (the acceptance command), run on the given input.
  const input = opts.tauriInput === 'built' ? join(out, 'assets/brand/icon.png') : opts.tauriInput
  const tauriOut = join(out, 'src-tauri', 'icons')
  const run = spawnSync(process.execPath, [TAURI_CLI, 'icon', input, '-o', tauriOut], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`tauri icon failed (${run.status}):\n${run.stdout}\n${run.stderr}`)
  return files
}

/** Repo-relative paths of every file below `dir` (forward slashes). */
function listFiles(/** @type {string} */ dir, /** @type {string} */ base = dir) {
  /** @type {string[]} */
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base))
    else out.push(relative(base, p).split(sep).join('/'))
  }
  return out.sort()
}

/** The PNG data: URIs of an SVG, and its text with them replaced by a placeholder. */
function splitSvg(/** @type {string} */ svg) {
  /** @type {Buffer[]} */
  const pngs = []
  const text = svg.replace(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g, (_, b64) => {
    pngs.push(Buffer.from(b64, 'base64'))
    return 'data:image/png;base64,…'
  })
  return { text, pngs }
}

/**
 * Compare a fresh build in `fresh` with the repository.
 * @returns {string[]} problems
 */
function compare(/** @type {string} */ fresh, /** @type {Map<string, Buffer | string>} */ files) {
  /** @type {string[]} */
  const problems = []
  const read = (/** @type {string} */ root, /** @type {string} */ p) => {
    try {
      return readFileSync(join(root, p))
    } catch {
      return undefined
    }
  }
  const pixels = (
    /** @type {string} */ label,
    /** @type {import('./formats.mjs').Rgba} */ a,
    /** @type {import('./formats.mjs').Rgba} */ b,
  ) => {
    const r = compareRgba(a, b, tolerance)
    if (!r.equal) problems.push(`${label}: ${r.reason}`)
  }

  // 1. Script-owned outputs.
  for (const path of files.keys()) {
    const want = read(fresh, path)
    const have = read(ROOT, path)
    if (!want) throw new Error(`fresh build is missing ${path}`)
    if (!have) {
      problems.push(`${path}: missing`)
      continue
    }
    if (have.equals(want)) continue
    if (path.endsWith('.svg')) {
      const a = splitSvg(have.toString('utf8'))
      const b = splitSvg(want.toString('utf8'))
      if (a.text !== b.text || a.pngs.length !== b.pngs.length)
        problems.push(`${path}: differs from the build`)
      else
        a.pngs.forEach((p, i) =>
          pixels(`${path} image ${i}`, decodePng(p), decodePng(/** @type {Buffer} */ (b.pngs[i]))),
        )
    } else if (path.endsWith('.png')) pixels(path, decodePng(have), decodePng(want))
    else if (path.endsWith('.ico')) {
      const a = readIco(have)
      const b = readIco(want)
      if (a.map((e) => `${e.size}/${e.format}`).join() !== b.map((e) => `${e.size}/${e.format}`).join())
        problems.push(
          `${path}: entries ${a.map((e) => e.size).join(',')} vs ${b.map((e) => e.size).join(',')}`,
        )
      else a.forEach((e, i) => b[i] && pixels(`${path} ${e.size}px`, e.image, b[i].image))
    } else if (path.endsWith('.icns')) {
      const a = readIcns(have)
      const b = readIcns(want)
      if ([...a.keys()].sort().join() !== [...b.keys()].sort().join())
        problems.push(`${path}: entry types differ`)
      else for (const [type, img] of a) pixels(`${path} ${type}`, img, /** @type {any} */ (b.get(type)))
    } else problems.push(`${path}: differs`)
  }

  // 2. The `tauri icon` set: byte-identical, except icon.icns whose entry order is random (compare entry by entry).
  const tauriFresh = listFiles(join(fresh, 'src-tauri', 'icons')).filter(
    (p) => !OWN_DIRS.includes(p.split('/')[0] ?? ''),
  )
  const tauriHave = listFiles(join(ROOT, 'src-tauri', 'icons')).filter(
    (p) => !OWN_DIRS.includes(p.split('/')[0] ?? ''),
  )
  for (const p of tauriHave)
    if (!tauriFresh.includes(p)) problems.push(`src-tauri/icons/${p}: not produced by tauri icon`)
  for (const p of tauriFresh) {
    const want = read(join(fresh, 'src-tauri', 'icons'), p)
    const have = read(join(ROOT, 'src-tauri', 'icons'), p)
    if (!want) continue
    if (!have) {
      problems.push(`src-tauri/icons/${p}: missing (run the build)`)
      continue
    }
    if (have.equals(want)) continue
    if (p.endsWith('.icns')) {
      const a = readIcnsEntries(have)
      const b = readIcnsEntries(want)
      const same = a.size === b.size && [...a].every(([t, d]) => b.get(t)?.equals(d))
      if (!same) problems.push(`src-tauri/icons/${p}: entries differ`)
    } else problems.push(`src-tauri/icons/${p}: differs from \`tauri icon assets/brand/icon.png\``)
  }

  // 3. Files this script used to write and no longer does (own dirs only).
  for (const dir of OWN_DIRS) {
    const base = join(ROOT, 'src-tauri', 'icons', dir)
    if (!existsSync(base)) continue
    for (const n of listFiles(base))
      if (!files.has(`src-tauri/icons/${dir}/${n}`))
        problems.push(`src-tauri/icons/${dir}/${n}: stale (not built)`)
  }
  return problems
}

/** Sign-off sheet: every output at real size and magnified, on light and dark surfaces, plus in-context mocks. */
async function review(
  /** @type {Rasteriser} */ raster,
  /** @type {Map<string, Buffer | string>} */ files,
  /** @type {string} */ root,
) {
  const get = (/** @type {string} */ p) => {
    const data = files.get(p)
    if (data === undefined) throw new Error(`review: no ${p}`)
    return Buffer.from(data)
  }
  const uri = (/** @type {string} */ p) =>
    `data:${p.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${get(p).toString('base64')}`
  const pngUri = (/** @type {import('./formats.mjs').Rgba} */ img) =>
    `data:image/png;base64,${encodePng(img).toString('base64')}`
  const winIco = readIco(get('src-tauri/icons/windows/icon.ico'))
  const ico = Object.fromEntries(winIco.map((e) => [e.size, pngUri(e.image)]))
  const mac = readIcns(get('src-tauri/icons/macos/icon.icns'))
  const macUri = (/** @type {string} */ t) => {
    const img = mac.get(t)
    return img ? pngUri(img) : ''
  }
  const linux32 = `data:image/png;base64,${readFileSync(join(root, 'src-tauri/icons/32x32.png')).toString('base64')}`
  // [theme, --surface-app, --frame-gold, --text] from src/styles/tokens.css (WP7a).
  const themes = [
    ['paper', '#f3efe6', '#ac8a55', '#24211c'],
    ['sepia', '#e9dcc3', '#9c7638', '#3a2f22'],
    ['night', '#111315', '#8f7444', '#e3ded2'],
    ['black', '#000000', '#6e5a36', '#d6d1c5'],
    ['high contrast', '#ffffff', '#000000', '#000000'],
    ['high contrast dark', '#000000', '#ffffff', '#ffffff'],
  ]
  const icoSizes = WINDOWS_TUNED
  const strip = (/** @type {string} */ bg, /** @type {string} */ fg) =>
    `<div class="strip" style="background:${bg};color:${fg}">` +
    icoSizes.map((s) => `<img src="${ico[s]}" width="${s}" height="${s}">`).join('') +
    `<span class="gap"></span>` +
    TRAY.map((s) => `<img class="px" src="${ico[s]}" width="${s * 8}" height="${s * 8}">`).join('') +
    `</div>`
  const mark = uri('src/assets/app-mark.svg')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font:13px "Segoe UI",system-ui;background:#d9d9d9;color:#222}
    h2{font-size:14px;margin:18px 16px 6px}
    .row{display:flex;gap:16px;align-items:center;padding:12px 16px;flex-wrap:wrap}
    .strip{display:flex;gap:14px;align-items:center;padding:12px 16px}
    .gap{width:24px}.px{image-rendering:pixelated}
    .tb{display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;font-weight:600;font-size:13px}
    .menubar{display:flex;align-items:center;justify-content:flex-end;gap:14px;height:24px;padding:0 12px}
    .es{display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px;width:150px}
    .about{display:flex;align-items:center;gap:12px;padding:14px 18px;white-space:nowrap}
    .about strong{display:block;font-size:16px;font-weight:600}.about span{font-size:12px;opacity:.7}
    .star{width:48px;height:48px;-webkit-mask:url(${uri('src/assets/star8.svg')}) center/contain no-repeat;mask:url(${uri('src/assets/star8.svg')}) center/contain no-repeat}
    .mark{width:32px;height:32px;-webkit-mask:url(${mark}) center/contain no-repeat;mask:url(${mark}) center/contain no-repeat}
    .tray{display:flex;align-items:center;gap:10px;height:40px;padding:0 12px}
  </style></head><body>
  <h2>Master (icon.png at 384 px) · macOS icns ic09 on the Apple grid · media artwork · templates on light and dark menu bars</h2>
  <div class="row">
    <img src="${uri('assets/brand/icon.png')}" width="384" height="384">
    <div style="background:linear-gradient(#5b7fa6,#a3b8cf);padding:12px"><img src="${macUri('ic09')}" width="256" height="256"></div>
    <img src="${uri('src-tauri/icons/media/artwork.png')}" width="200" height="200">
    <div>
      <div class="menubar" style="background:#ececec"><img src="${uri('src-tauri/icons/tray/tray-template@2x.png')}" width="18" height="18"><img src="${uri('src-tauri/icons/tray/tray-template.png')}" width="18" height="18"><span>9:41</span></div>
      <div class="menubar" style="background:#2b2b2b;color:#fff"><img style="filter:invert(1)" src="${uri('src-tauri/icons/tray/tray-template@2x.png')}" width="18" height="18"><img style="filter:invert(1)" src="${uri('src-tauri/icons/tray/tray-template.png')}" width="18" height="18"><span>9:41</span></div>
      <div class="row"><img class="px" src="${uri('src-tauri/icons/tray/tray-template.png')}" width="144" height="144"><img class="px" src="${uri('src-tauri/icons/tray/tray-template@2x.png')}" width="144" height="144"></div>
    </div>
  </div>
  <h2>Windows ICO entries 16 / 20 / 24 / 32 / 40 / 48 / 64 at real size, then the tuned 16–32 magnified ×8 — light and dark taskbars</h2>
  ${strip('#f3f3f3', '#000')}${strip('#202020', '#fff')}
  <h2>Tray (tray-16…32 at real size) on Windows light/dark and Linux panels · macOS tuned is32 / il32 / ic11 / ic12 and ×8 · Linux 32x32.png (tauri icon)</h2>
  <div class="row">
    ${[
      ['#f3f3f3', '#000'],
      ['#202020', '#fff'],
      ['#3d3846', '#fff'],
    ]
      .map(
        ([bg, fg]) =>
          `<div class="tray" style="background:${bg};color:${fg}">${TRAY.map((s) => `<img src="${uri(`src-tauri/icons/tray/tray-${s}.png`)}" width="${s}" height="${s}">`).join('')}<span>12:00</span></div>`,
      )
      .join('')}
    ${['is32', 'il32', 'ic11', 'ic12'].map((t) => `<img src="${macUri(t)}">`).join('')}
    <img class="px" src="${macUri('is32')}" width="128" height="128"><img class="px" src="${macUri('il32')}" width="256" height="256">
    <img src="${linux32}" width="32" height="32"><img class="px" src="${linux32}" width="256" height="256">
  </div>
  <h2>Title bar (app-icon-small.svg at 18 css px) · About header (app-icon.svg at 64 css px) · app-mark.svg as a CSS mask in each theme's gold and text colour · EmptyState star8</h2>
  <div class="row">${themes.map(([name, bg, , fg]) => `<div class="tb" style="background:${bg};color:${fg}"><img src="${uri('src/assets/app-icon-small.svg')}" width="18" height="18">Quran <span style="font-weight:400;opacity:.7">${name}</span></div>`).join('')}</div>
  <div class="row">${themes.map(([name, bg, , fg]) => `<div class="about" style="background:${bg};color:${fg}"><img src="${uri('src/assets/app-icon.svg')}" width="64" height="64"><div><strong>Quran for Desktop</strong><span>${name}</span></div></div>`).join('')}</div>
  <div class="row">${themes.map(([name, bg, gold, fg]) => `<div class="es" style="background:${bg};color:${fg}"><div style="display:flex;gap:10px"><div class="mark" style="background:${gold}"></div><div class="mark" style="background:${fg}"></div><img src="${mark}" width="32" height="32"><div class="star" style="background:${gold}"></div></div><span style="opacity:.75">${name}</span></div>`).join('')}</div>
  </body></html>`
  const shot = await raster.screenshotHtml(html, { width: 1520, height: 900 })
  const target = join(ROOT, 'artifacts', 'brand', 'review.png')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, shot)
  console.log(`build: review sheet → ${relative(ROOT, target)}`)
}

async function main() {
  const raster = new Rasteriser()
  try {
    if (!args.check) {
      const files = await build(ROOT, raster, { tauriInput: 'built' })
      console.log(`build: wrote ${files.size} files and the \`tauri icon\` set in src-tauri/icons`)
      if (args.review) await review(raster, files, ROOT)
      return 0
    }
    const tmp = mkdtempSync(join(tmpdir(), 'qd-brand-'))
    try {
      const files = await build(tmp, raster, { tauriInput: join(ROOT, 'assets', 'brand', 'icon.png') })
      const problems = compare(tmp, files)
      if (args.review) await review(raster, files, tmp)
      if (problems.length) {
        console.error(`build --check: ${problems.length} difference(s):`)
        for (const p of problems) console.error(`  - ${p}`)
        return 1
      }
      console.log(
        `build --check: ok — ${files.size} outputs and the \`tauri icon assets/brand/icon.png\` set match` +
          (tolerance ? ` (tolerance ${tolerance})` : ' exactly'),
      )
      return 0
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } finally {
    await raster.close()
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`build: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    process.exit(1)
  },
)
