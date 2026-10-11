/**
 * FontFace registry (§8.5): creates, loads and evicts the page and decor faces, by URL or by bytes (D30), with an LRU
 * of 24 faces per QCF style. Owner: WP8b. The `fonts` store drives it; nothing else touches `document.fonts` for page
 * fonts.
 *
 * - `url` transport: `new FontFace(family, 'url("…") format("woff2")', { display: 'block' })`, a CORS-mode load from
 *   `quran://` (`http://quran.localhost` on Windows).
 * - `bytes` transport: `new FontFace(family, arrayBuffer, { display: 'block' })` from the raw `font_bytes` response, which
 *   needs no CORS (§5.16).
 * - Each face is added to `document.fonts` before `load()`, so `document.fonts.status` reports the load (QA's `waitIdle`
 *   waits on it). A face that fails to load is removed again, and loading the same family later starts afresh.
 * - Groups: a page face belongs to its style's group (`qcf-v2` for `qcf-v2-p262`) and takes part in that group's LRU;
 *   decor faces form no group and are never evicted. The store gives the groups of styles the reader has left a budget
 *   of 0 (`evictFaces`), so only the faces still on screen stay in `document.fonts`.
 */

/** Where a face's data comes from: a `quran://` URL, or raw bytes from `fontBytes`. */
export type FaceSource = { url: string } | { bytes: ArrayBuffer }

/** At most this many faces per QCF style stay loaded (§8.5). */
export const FACES_PER_STYLE = 24

/** `display: block`: a face is never shown in a fallback font while it loads (the renditions wait for it anyway). */
const DESCRIPTORS: FontFaceDescriptors = { display: 'block' }

interface Entry {
  family: string
  /** The face once it has loaded. */
  face: FontFace | null
  /** The face in `document.fonts`: from the moment it is added, before its load settles. */
  added: FontFace | null
  loading: Promise<FontFace | null> | null
  /** Monotonic use stamp: the load, then every display (`touchFace`). */
  used: number
}

const entries = new Map<string, Entry>()
let clock = 0
const faceSetListeners = new Set<() => void>()

/**
 * Calls `listener` whenever a face joins `document.fonts`, finishes loading there, or leaves it, until the returned
 * function is called. Chromium drops words it shaped before such a change, so the shaping warm-up does them again
 * (warmup.ts).
 */
export function onFaceSetChange(listener: () => void): () => void {
  faceSetListeners.add(listener)
  return () => faceSetListeners.delete(listener)
}

function faceSetChanged(): void {
  for (const listener of [...faceSetListeners]) listener()
}

/** The LRU group of a family: `qcf-v2` for `qcf-v2-p262`; `null` for decor and anything else (never evicted). */
export function faceGroup(family: string): string | null {
  const m = /^(qcf-v[124])-p\d+$/.exec(family)
  return m?.[1] ?? null
}

/** A CSS `url("…")` with the quote, backslash and line breaks escaped. */
export function cssUrl(url: string): string {
  return `url("${url.replace(/["\\\n\r\f]/g, (c) => `\\${c.codePointAt(0)?.toString(16) ?? ''} `)}")`
}

/** The `format()` hint of a font URL or relative path, from its extension (query and fragment ignored). */
export function fontFormat(urlOrRel: string): 'woff2' | 'woff' | 'truetype' | 'opentype' {
  const path = urlOrRel.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  if (path.endsWith('.ttf')) return 'truetype'
  if (path.endsWith('.otf')) return 'opentype'
  if (path.endsWith('.woff')) return 'woff'
  return 'woff2'
}

function fontSet(): FontFaceSet | null {
  return typeof document !== 'undefined' && document.fonts ? document.fonts : null
}

function create(family: string, source: FaceSource): FontFace {
  if ('url' in source) {
    return new FontFace(family, `${cssUrl(source.url)} format("${fontFormat(source.url)}")`, DESCRIPTORS)
  }
  return new FontFace(family, source.bytes, DESCRIPTORS)
}

/**
 * Loads the face of `family` from `source`, or returns the face already loaded (or loading) for it. Resolves `null`
 * when the face could not be created or decoded (a 404, a CORS rejection, a corrupt file); the caller marks the font
 * failed and may retry, which starts a fresh load.
 */
export function loadFace(family: string, source: FaceSource): Promise<FontFace | null> {
  const known = entries.get(family)
  if (known?.face) {
    known.used = ++clock
    return Promise.resolve(known.face)
  }
  if (known?.loading) return known.loading
  const entry: Entry = { family, face: null, added: null, loading: null, used: ++clock }
  entries.set(family, entry)
  entry.loading = (async () => {
    let face: FontFace | null = null
    try {
      face = create(family, source)
      fontSet()?.add(face)
      entry.added = face
      faceSetChanged()
      await face.load()
      if (entries.get(family) !== entry) {
        // Evicted or cleared while loading: this face is no longer wanted.
        fontSet()?.delete(face)
        faceSetChanged()
        return null
      }
      entry.face = face
      faceSetChanged()
      return face
    } catch (e) {
      if (face) {
        fontSet()?.delete(face)
        faceSetChanged()
      }
      if (entries.get(family) === entry) entries.delete(family)
      console.warn(`[fonts] ${family} could not be loaded`, e)
      return null
    } finally {
      entry.loading = null
    }
  })()
  return entry.loading
}

/** Whether `family` is loaded and usable now. */
export function hasFace(family: string): boolean {
  return entries.get(family)?.face != null
}

/** Marks a family as just displayed (LRU). */
export function touchFace(family: string): void {
  const entry = entries.get(family)
  if (entry) entry.used = ++clock
}

/** The loaded families, optionally of one LRU group (`qcf-v4`), least recently used first. */
export function loadedFamilies(group?: string): string[] {
  return [...entries.values()]
    .filter((e) => e.face && (group === undefined || faceGroup(e.family) === group))
    .sort((a, b) => a.used - b.used)
    .map((e) => e.family)
}

/** Unloads one face (`document.fonts.delete`), a face still loading included (its load then resolves `null`). */
export function deleteFace(family: string): boolean {
  const entry = entries.get(family)
  if (!entry) return false
  entries.delete(family)
  const face = entry.face ?? entry.added
  if (face) {
    fontSet()?.delete(face)
    faceSetChanged()
  }
  return true
}

/**
 * Removes faces beyond each group's budget, least recently used first, never one in `keep` (the faces on screen and
 * their neighbours). `budget` is one number for every group, or a function of the group (`qcf-v4` → 0 unloads every
 * V4 face that is not kept). Returns the evicted families.
 */
export function evictFaces(
  keep: ReadonlySet<string>,
  budget: number | ((group: string) => number) = FACES_PER_STYLE,
): string[] {
  const groups = new Map<string, Entry[]>()
  for (const entry of entries.values()) {
    const group = faceGroup(entry.family)
    if (!group || !entry.face) continue
    const list = groups.get(group)
    if (list) list.push(entry)
    else groups.set(group, [entry])
  }
  const evicted: string[] = []
  for (const [group, list] of groups) {
    const limit = typeof budget === 'function' ? budget(group) : budget
    let excess = list.length - Math.max(0, limit)
    if (excess <= 0) continue
    list.sort((a, b) => a.used - b.used)
    for (const entry of list) {
      if (excess <= 0) break
      if (keep.has(entry.family)) continue
      deleteFace(entry.family)
      evicted.push(entry.family)
      excess--
    }
  }
  return evicted
}

/** Unloads every face this registry added (store reset, tests). */
export function clearFaces(): void {
  for (const family of [...entries.keys()]) deleteFace(family)
}
