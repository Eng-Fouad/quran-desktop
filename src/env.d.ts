/// <reference types="svelte" />
/// <reference types="vite/client" />

/**
 * Compile-time switch for the browser IPC mock: `true` under `vite --mode mock` (`pnpm dev:web`) and in vitest,
 * `false` in every Tauri build, so Rollup drops the mock, the synthetic generator and the fixtures from `dist/`.
 */
declare const __MOCK_IPC__: boolean

/** Build-time variables exposed through `envPrefix` (vite.config.ts). The `TAURI_ENV_*` set exists only under the tauri CLI. */
interface ImportMetaEnv {
  readonly TAURI_ENV_DEBUG?: string
  readonly TAURI_ENV_PLATFORM?: string
  readonly TAURI_ENV_PLATFORM_VERSION?: string
  readonly TAURI_ENV_FAMILY?: string
  readonly TAURI_ENV_ARCH?: string
  readonly TAURI_ENV_TARGET_TRIPLE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
