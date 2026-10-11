import { svelte } from '@sveltejs/vite-plugin-svelte'
import { existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { createLogger, defineConfig, runnerImport, type PluginOption, type UserConfig } from 'vite'
import { woff2Only } from './vite/woff2-only.ts'

/** Import aliases (§7.1). Mirrored in tsconfig.app.json `paths`; vitest.config.ts reuses this object. */
export const alias = {
  $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
  $components: fileURLToPath(new URL('./src/components', import.meta.url)),
  $styles: fileURLToPath(new URL('./src/styles', import.meta.url)),
}

const host = process.env.TAURI_DEV_HOST

/**
 * The dev-packs plugin (`vite/dev-packs.ts`, WP8b) serves `data/dev-packs` at `/__packs/*` in `--mode mock` (§4.8, §5.17).
 * It is imported at runtime, and only when the file exists, so this config works before WP8b lands.
 * Contract for WP8b: the module exports `devPacks(): PluginOption` (a named export; a default export is also accepted).
 */
async function loadDevPacks(): Promise<PluginOption> {
  const file = fileURLToPath(new URL('./vite/dev-packs.ts', import.meta.url))
  if (!existsSync(file)) return null
  const logger = createLogger()
  try {
    type DevPacksModule = { devPacks?: () => PluginOption; default?: () => PluginOption }
    const { module } = await runnerImport<DevPacksModule>(file)
    const factory = module.devPacks ?? module.default
    if (typeof factory === 'function') return factory()
    logger.warn('[qd] vite/dev-packs.ts does not export devPacks(): /__packs/* is not served')
  } catch (error) {
    logger.warn(`[qd] vite/dev-packs.ts failed to load, /__packs/* is not served:\n${String(error)}`)
  }
  return null
}

// Tauri expects a fixed dev port and must not watch the Rust sources (FACT_SHEET §1).
// `vite --mode mock` (`pnpm dev:web`) runs the UI in a normal browser against the IPC mock. `__MOCK_IPC__` is a
// compile-time constant (D29), so production builds tree-shake the mock, synthetic generator and fixtures away.
export default defineConfig(async ({ mode }): Promise<UserConfig> => {
  const mock = mode === 'mock'
  return {
    // woff2Only: production builds ship WOFF2 sources only (§13.6 installer budget; vite/woff2-only.ts).
    plugins: [svelte(), mock ? await loadDevPacks() : null, woff2Only()],
    resolve: { alias },
    define: {
      __MOCK_IPC__: JSON.stringify(mock),
    },
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
      watch: {
        ignored: [
          '**/src-tauri/**',
          '**/crates/**',
          '**/xtask/**',
          '**/target/**',
          '**/data/**',
          '**/artifacts/**',
        ],
      },
    },
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
    build: {
      // Keep Vite 8's default 'baseline-widely-available' target (chrome111 / edge111 / safari16.4), FACT_SHEET C11.
      sourcemap: !!process.env.TAURI_ENV_DEBUG,
      minify: process.env.TAURI_ENV_DEBUG ? false : 'oxc',
    },
  }
})
