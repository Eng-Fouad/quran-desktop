import { svelte } from '@sveltejs/vite-plugin-svelte'
import { svelteTesting } from '@testing-library/svelte/vite'
import { playwright } from '@vitest/browser-playwright'
import type { BrowserInstanceOption } from 'vitest/node'
import { configDefaults, defineConfig } from 'vitest/config'
import { alias } from './vite.config.ts'

/**
 * Browser project (§12.5). CI installs Playwright's chromium and webkit (`pnpm exec playwright install`) and runs both.
 * Locally no browser is ever downloaded: on Windows chromium launches the installed Microsoft Edge (channel `msedge`).
 *   QD_BROWSERS=chromium,webkit     instances to run (default: CI → chromium,webkit; local → chromium)
 *   QD_BROWSER_CHANNEL=msedge       chromium channel (default: CI → Playwright's chromium; Windows → msedge;
 *                                   other OSes → Playwright's chromium); `bundled` forces Playwright's chromium
 */
const ci = !!process.env.CI
const BROWSERS = ['chromium', 'firefox', 'webkit'] as const
type BrowserName = (typeof BROWSERS)[number]
const isBrowserName = (name: string): name is BrowserName => (BROWSERS as readonly string[]).includes(name)
const browsers = (process.env.QD_BROWSERS ?? (ci ? 'chromium,webkit' : 'chromium'))
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean)
  .map((b) => {
    if (!isBrowserName(b))
      throw new Error(`QD_BROWSERS: unknown browser "${b}" (expected ${BROWSERS.join(', ')})`)
    return b
  })
const channelEnv = process.env.QD_BROWSER_CHANNEL
const channel =
  channelEnv === 'bundled'
    ? undefined
    : (channelEnv ?? (!ci && process.platform === 'win32' ? 'msedge' : undefined))

const instances: BrowserInstanceOption[] = browsers.map((browser) =>
  browser === 'chromium' && channel
    ? { browser, provider: playwright({ launchOptions: { channel } }) }
    : { browser },
)

export default defineConfig({
  plugins: [svelte()],
  resolve: { alias },
  // Tests always run against the IPC mock (D29).
  define: { __MOCK_IPC__: 'true' },
  test: {
    // Attachments, including the browser project's failure screenshots, stay out of the tree like every other test
    // output (Mushaf images are never committed, §12.6). vitest's default is .vitest/attachments in the repo root.
    attachmentsDir: 'artifacts/vitest-browser',
    projects: [
      {
        extends: true,
        // Resolves Svelte's browser build under jsdom and cleans up rendered components after each test.
        plugins: [svelteTesting()],
        test: {
          name: 'unit',
          environment: 'jsdom',
          // vite/**: the build plugins' own tests (vite/woff2-only.test.ts).
          include: ['src/**/*.test.ts', 'vite/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'src/**/*.browser.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances,
            viewport: { width: 1280, height: 800 },
            // Failure screenshots stay out of src/ (Mushaf images are never committed, §12.6).
            screenshotDirectory: 'artifacts/vitest-browser',
          },
        },
      },
    ],
  },
})
