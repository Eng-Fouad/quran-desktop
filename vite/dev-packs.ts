/**
 * The dev-packs plugin (§4.8, §5.17; WP8b): serves the locally fetched QCF page fonts and decor fonts
 * (`cargo xtask fetch-dev-packs` → `data/dev-packs/`, gitignored, never committed or uploaded) at `/__packs/*` while
 * `vite --mode mock` runs, so QCF rendering, the D13 cross-fade, the V4 palettes, the COLR probe and decor headers work
 * in a normal browser before the real app exists. `vite.config.ts` loads it only in mock mode.
 *
 * - Routes mirror the app's `quran://` allow-list (§6.2): `mushaf/{v1,v2,v4}/p{1..604}.woff2` and the decor files.
 *   Anything else under `/__packs/` is a 404 (never the SPA fallback), so a missing font fails loudly.
 * - `GET /__packs/index.json` lists what is on disk with each file's size and a short sha256 (`sha8`). The mock's
 *   `fonts.ts` handler reads it to answer `mushaf_ensure_page_fonts` / `decor_ensure` like Rust does (`?v=<sha8>` URLs).
 * - Responses carry the exact content type, an ETag (304 on revalidation) and `Access-Control-Allow-Origin: *`, like the
 *   protocol handler; query strings (`?v=`) are ignored.
 * - `QD_PACKS_DIR` overrides the directory (absolute, or relative to the Vite root).
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

/** URL prefix the mock and `fontBytes` use (§5.16, §5.17). */
export const PACKS_PREFIX = '/__packs'
const PAGES = 604

/** The decor files of the `decor` pack and the optional Nastaliq face (§6.2), with their content types. */
const DECOR_FILES: Readonly<Record<string, string>> = {
  'qcf-surah-header.woff2': 'font/woff2',
  'quran-common.ttf': 'font/ttf',
  'sura-names.woff2': 'font/woff2',
  'noto-nastaliq-urdu.woff2': 'font/woff2',
}

const MUSHAF_ROUTE = /^\/mushaf\/(v[124])\/p([1-9][0-9]{0,2})\.woff2$/
const DECOR_ROUTE = /^\/decor\/([a-z0-9-]+\.(?:woff2|ttf))$/

export interface DevPackFile {
  bytes: number
  /** The first 8 hex digits of the file's sha256 (the `?v=` cache buster). */
  sha8: string
}

/** `GET /__packs/index.json`. */
export interface DevPackIndex {
  version: 1
  mushaf: Record<'v1' | 'v2' | 'v4', Record<string, DevPackFile>>
  decor: Record<string, DevPackFile>
}

interface Route {
  file: string
  type: string
}

/** Maps a request path (without the prefix and query) to a file of the packs directory, or `null` (404). */
export function routeOf(path: string, root: string): Route | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  const mushaf = MUSHAF_ROUTE.exec(decoded)
  if (mushaf) {
    const [, variant = '', page = ''] = mushaf
    if (Number(page) > PAGES) return null
    return { file: join(root, 'mushaf', variant, `p${page}.woff2`), type: 'font/woff2' }
  }
  const decor = DECOR_ROUTE.exec(decoded)
  const name = decor?.[1]
  const type = name ? DECOR_FILES[name] : undefined
  if (name && type) return { file: join(root, 'decor', name), type }
  return null
}

/** Size, mtime and short hash of one file; hashes are reused while size and mtime are unchanged. */
const hashCache = new Map<string, { size: number; mtimeMs: number; sha8: string }>()

async function describe(file: string): Promise<DevPackFile | null> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return null
    const cached = hashCache.get(file)
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return { bytes: info.size, sha8: cached.sha8 }
    }
    const sha8 = createHash('sha256')
      .update(await readFile(file))
      .digest('hex')
      .slice(0, 8)
    hashCache.set(file, { size: info.size, mtimeMs: info.mtimeMs, sha8 })
    return { bytes: info.size, sha8 }
  } catch {
    return null
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/** Scans the packs directory into the index the mock reads. Missing directories simply list nothing. */
export async function scanPacks(root: string): Promise<DevPackIndex> {
  const index: DevPackIndex = { version: 1, mushaf: { v1: {}, v2: {}, v4: {} }, decor: {} }
  for (const variant of ['v1', 'v2', 'v4'] as const) {
    const dir = join(root, 'mushaf', variant)
    const entries = await Promise.all(
      (await listDir(dir)).map(async (name) => {
        const page = /^p([1-9][0-9]{0,2})\.woff2$/.exec(name)?.[1]
        if (!page || Number(page) > PAGES) return null
        const file = await describe(join(dir, name))
        return file ? ([page, file] as const) : null
      }),
    )
    for (const entry of entries) if (entry) index.mushaf[variant][entry[0]] = entry[1]
  }
  for (const name of Object.keys(DECOR_FILES)) {
    const file = await describe(join(root, 'decor', name))
    if (file) index.decor[name] = file
  }
  return index
}

function etagOf(info: { size: number; mtimeMs: number }): string {
  return `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.statusCode = status
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.end(body)
}

async function serve(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    send(res, 405, 'method not allowed')
    return
  }
  // Connect strips the mount prefix; the query (`?v=<sha8>`) only busts caches.
  const path = (req.url ?? '/').split('?', 1)[0] ?? '/'
  if (path === '/index.json') {
    send(res, 200, JSON.stringify(await scanPacks(root)), 'application/json; charset=utf-8')
    return
  }
  const route = routeOf(path, root)
  if (!route) {
    send(res, 404, `not a pack route: ${path}`)
    return
  }
  let info
  try {
    info = await stat(route.file)
  } catch {
    send(res, 404, `not on disk: ${relative(root, route.file)} (run pnpm dev-packs)`)
    return
  }
  if (!info.isFile()) {
    send(res, 404, `not a file: ${path}`)
    return
  }
  const etag = etagOf(info)
  res.setHeader('ETag', etag)
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', route.type)
  res.setHeader('Content-Length', String(info.size))
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(route.file)
  stream.on('error', (e) => {
    if (!res.headersSent) send(res, 500, String(e))
    else res.destroy(e)
  })
  stream.pipe(res)
}

/** The packs directory: `QD_PACKS_DIR` (absolute, or relative to the Vite root), else `<root>/data/dev-packs`. */
export function packsDir(viteRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.QD_PACKS_DIR?.trim()
  if (override) return isAbsolute(override) ? override : resolve(viteRoot, override)
  return resolve(viteRoot, 'data', 'dev-packs')
}

/** The plugin (`vite --mode mock` only, see `vite.config.ts`). */
export function devPacks(): Plugin {
  let root = resolve('data', 'dev-packs')
  let config: ResolvedConfig | null = null
  return {
    name: 'qd-dev-packs',
    apply: 'serve',
    configResolved(resolved) {
      config = resolved
      root = packsDir(resolved.root)
    },
    async configureServer(server) {
      const index = await scanPacks(root)
      const counts = (['v1', 'v2', 'v4'] as const).map((v) => `${v} ${Object.keys(index.mushaf[v]).length}`)
      const decor = Object.keys(index.decor).length
      const where = relative(config?.root ?? process.cwd(), root) || root
      const empty = counts.every((c) => c.endsWith(' 0')) && decor === 0
      const logger = server.config.logger
      if (empty)
        logger.info(
          `[qd] dev packs: ${where} is empty; QCF styles show the Hafs fallback (run pnpm dev-packs)`,
        )
      else logger.info(`[qd] dev packs: ${PACKS_PREFIX}/* ← ${where} (${counts.join(', ')}, decor ${decor})`)
      server.middlewares.use(PACKS_PREFIX, (req, res, next) => {
        serve(req, res, root).catch((e: unknown) => {
          if (res.headersSent) next(e)
          else send(res, 500, String(e))
        })
      })
    },
  }
}

export default devPacks
