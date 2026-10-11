/**
 * Links and bundled notices of the About screen (§9.7). Owner: WP12c.
 *
 * - Links open in the system browser through `system_open_external` (https only, §5.13); the webview never navigates.
 * - Bundled notices (the KFGQPC Hafs licence, the app's own GPL) are plain text loaded on demand (a served file, or
 *   for the app's licence a lazily loaded chunk) and rendered as text, never as HTML.
 */
import { NOTICE_PATHS, hostOf, type AttributionNotice } from '$lib/about/attributions'
import { api, call } from '$lib/ipc'
import { ui } from '$lib/stores'

/** Opens an https URL in the default browser; failures become a toast. */
export function openExternal(url: string): void {
  call(api.systemOpenExternal(url)).catch((e: unknown) => ui.toastError(e))
}

/** The click handler of an external `<a href>`: opens it outside the webview (also for modified clicks). */
export function onExternalClick(e: MouseEvent, url: string): void {
  e.preventDefault()
  openExternal(url)
}

/** "quranenc.com/en/browse/english_saheeh" → "quranenc.com": the label of a link. */
export function siteLabel(url: string): string {
  return hostOf(url) ?? url
}

const notices = new Map<AttributionNotice, Promise<string>>()

/** A served notice (`NOTICE_PATHS`). */
async function fetchNotice(notice: keyof typeof NOTICE_PATHS): Promise<string> {
  const url = new URL(NOTICE_PATHS[notice], new URL(import.meta.env.BASE_URL, location.href)).href
  const res = await fetch(url)
  const type = res.headers.get('content-type') ?? ''
  // A missing static file comes back as index.html in the dev server and the webview: never show that.
  if (!res.ok || type.includes('text/html')) throw new Error(`notice ${notice}: HTTP ${res.status} ${type}`)
  return res.text()
}

/**
 * The app's own licence: the repository's `LICENSE` (GNU GPL v3, unmodified), bundled as a separate chunk that loads
 * on demand. Not a served file: Tauri types an extensionless asset as HTML, and a copy under `public/` could drift.
 */
async function appLicence(): Promise<string> {
  return (await import('../../../LICENSE?raw')).default
}

/** The text of a bundled notice (cached; a failed load is retried next time). */
export function loadNotice(notice: AttributionNotice): Promise<string> {
  const cached = notices.get(notice)
  if (cached) return cached
  const load = (notice === 'app-licence' ? appLicence() : fetchNotice(notice)).then((text) => text.trim())
  notices.set(notice, load)
  load.catch(() => notices.delete(notice))
  return load
}
