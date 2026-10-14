/**
 * Mock handlers: app and window commands. `app_bootstrap` reads every state slice (plus the fixture or synthetic
 * index) to assemble `Bootstrap`; it never writes them.
 *
 * Behaviour mirrors the real commands (`commands/app.rs`) on the platform the browser reports:
 * - `window_set_chrome` answers `unsupported` for a translucent effect, like Windows 10 or Linux: a browser page has no
 *   backdrop material behind it, so the shell keeps its chrome opaque. `?mockMica` simulates Windows 11, where the
 *   effect applies (the root then turns transparent over the browser's own background).
 * - `system_open_external` accepts `https://` and `mailto:` only.
 *
 * Development switches in the page URL, for states that are otherwise hard to reach in a browser:
 * - `?mockNotice=user_db_recovered` (or `content_db_recovered`): bootstrap reports that startup notice (shown as a
 *   banner).
 * - `?mockFatal=core` fails `app_bootstrap` like a debug build without core.db; `?mockFatal=<kind>` with any other
 *   `AppError` kind fails it with that kind (the fatal screen).
 */
import type {
  AppError,
  AppInfo,
  Bootstrap,
  PackInfo,
  PackSummary,
  Platform,
  StartupNotice,
} from '../../bindings'
import { fixtures } from '../fixtures'
import { type Handlers, handle, MockError } from '../result'
import { state } from '../state'
import { mockOnline } from './settings'

const APP_ERROR_KINDS: readonly AppError['kind'][] = [
  'not_found',
  'invalid_argument',
  'database',
  'io',
  'network',
  'offline',
  'integrity',
  'cancelled',
  'conflict',
  'audio',
  'unsupported',
  'internal',
]

/** The real debug build's message when core.db is missing or a placeholder (`UNAVAILABLE_MESSAGE`). */
export const CORE_MISSING_MESSAGE = 'core.db missing — run pnpm core:qdc'

const DATA_DIR = 'C:/mock/com.quran.labs.desktop'

function params(): URLSearchParams {
  return new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
}

/**
 * The host's platform, so browser tests follow the OS they run on. `navigator.platform` first ("MacIntel", "Win32",
 * "Linux x86_64"): Playwright's WebKit sends a Mac user agent on every OS, so on Linux CI the user agent alone would run
 * the macOS app (Meta shortcuts, the glass chrome) on WebKitGTK. jsdom reports no platform: its user agent decides.
 */
function platform(): Platform {
  const host = navigator.platform
  if (host) {
    if (/^Mac/i.test(host)) return 'macos'
    if (/^Win/i.test(host)) return 'windows'
    if (/Linux|X11|CrOS/i.test(host)) return 'linux'
  }
  const ua = navigator.userAgent
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos'
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux'
  return 'windows'
}

function webviewVersion(): string {
  const m = /(Edg|Chrome|Version)\/([\d.]+)/.exec(navigator.userAgent)
  return m ? `${m[1]} ${m[2]}` : 'unknown'
}

async function appInfo(): Promise<AppInfo> {
  const manifest = await fixtures.manifest()
  return {
    name: 'Quran',
    version: '0.1.0',
    identifier: 'com.quran.labs.desktop',
    platform: platform(),
    arch: 'x86_64',
    osVersion: 'browser mock',
    osLocale: navigator.language || null,
    webviewVersion: webviewVersion(),
    dataDir: DATA_DIR,
    logDir: `${DATA_DIR}/logs`,
    // The dev-packs plugin serves data/dev-packs here in --mode mock.
    protocolBase: '/__packs/',
    fontTransport: 'url',
    debug: true,
    // `?qdtest` installs window.__QD_TEST__ in the mock too.
    testMode: params().has('qdtest'),
    core: {
      schemaVersion: 1,
      normalizerVersion: 1,
      source: manifest?.source ?? 'synthetic',
      builtAt: manifest?.builtAt ?? '',
    },
  }
}

function summary(p: PackInfo): PackSummary {
  return { id: p.id, kind: p.kind, title: p.title, language: p.language, state: p.state }
}

/** Startup notices requested with `?mockNotice=` (the real ones come from `build_state`). */
function notices(): StartupNotice[] {
  const out: StartupNotice[] = []
  for (const kind of params().getAll('mockNotice')) {
    if (kind === 'user_db_recovered') {
      out.push({
        type: 'user_db_recovered',
        data: { quarantinedFile: `${DATA_DIR}/user.db.corrupt-1760083200000` },
      })
    } else if (kind === 'content_db_recovered') {
      out.push({ type: 'content_db_recovered' })
    }
  }
  return out
}

/** A bootstrap failure requested with `?mockFatal=` (`core`, or an `AppError` kind). */
function fatal(): MockError | null {
  const kind = params().get('mockFatal')
  if (kind === null) return null
  if (kind === 'core' || kind === '') return new MockError('not_found', CORE_MISSING_MESSAGE)
  const known = APP_ERROR_KINDS.find((k) => k === kind)
  return new MockError(known ?? 'internal', `simulated bootstrap failure (?mockFatal=${kind})`)
}

export const appHandlers: Handlers<
  | 'appBootstrap'
  | 'windowReady'
  | 'windowSetChrome'
  | 'windowSetCaption'
  | 'appQuit'
  | 'systemOpenExternal'
  | 'systemRevealDataDir'
> = {
  appBootstrap: handle(async (): Promise<Bootstrap> => {
    const failure = fatal()
    if (failure) throw failure
    const settings = state.settings.value
    const user = state.user.value
    // Copies, like real IPC: the UI must not be able to mutate the mock's state by reference.
    const rest = structuredClone({
      settings,
      firstRun: state.firstRun,
      positions: user.positions,
      readingBookmark: user.readingBookmark,
      packs: state.packs.value.list.map(summary),
      reciters: state.audio.value.reciters,
      decor: state.fonts.value.decor,
      audio: state.audio.value.snapshot,
      online: mockOnline(settings),
      notices: notices(),
    })
    // The index is large and immutable: shared, not copied (stores keep it in $state.raw).
    return { app: await appInfo(), index: await fixtures.index(), ...rest }
  }),
  windowReady: handle(() => null),
  // A browser page has no native caption buttons (the Snap Layouts target exists on Windows 11 only).
  windowSetCaption: handle((visible: boolean) => {
    if (typeof visible !== 'boolean') throw new MockError('invalid_argument', 'visible must be a boolean')
    return null
  }),
  windowSetChrome: handle(({ effect }) => {
    if (effect !== 'off' && !params().has('mockMica')) {
      throw new MockError(
        'unsupported',
        'a browser page has no window backdrop (load ?mockMica to simulate one)',
      )
    }
    return null
  }),
  appQuit: handle(() => {
    console.info('[mock IPC] app_quit: the real app exits here')
    return null
  }),
  systemOpenExternal: handle((url: string) => {
    if (!/^(https:\/\/|mailto:)/i.test(url))
      throw new MockError('invalid_argument', `only https:// and mailto: URLs open: ${url}`)
    console.info(`[mock IPC] system_open_external ${url}`)
    return null
  }),
  systemRevealDataDir: handle(() => {
    console.info(`[mock IPC] system_reveal_data_dir: the real app opens ${DATA_DIR} in the file manager`)
    return null
  }),
}
