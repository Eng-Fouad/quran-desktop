// @ts-check
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import svelte from 'eslint-plugin-svelte'
import globals from 'globals'
import path from 'node:path'
import ts from 'typescript-eslint'
import svelteConfig from './svelte.config.js'

/** The only file allowed to render raw HTML (§7.6). */
const SAFE_HTML_FILE = 'src/components/ui/SafeHtml.svelte'

/** An eslint-disable directive (any form) that names the raw-HTML rule or this guard rule. */
const DISABLE_DIRECTIVE = /^\s*eslint-disable(?:-next-line|-line)?\b/
const GUARDED_RULES = /svelte\/no-at-html-tags|qd\/no-html-escape-hatch/

/**
 * Local rules. `qd/no-html-escape-hatch` keeps `svelte/no-at-html-tags` enforceable: only SafeHtml.svelte may carry
 * `<!-- eslint-disable-next-line svelte/no-at-html-tags -->`; anywhere else the directive itself is an error.
 * @type {import('eslint').ESLint.Plugin}
 */
const qd = {
  meta: { name: 'qd' },
  rules: {
    'no-html-escape-hatch': {
      meta: {
        type: 'problem',
        docs: { description: `Only ${SAFE_HTML_FILE} may disable svelte/no-at-html-tags (§7.6)` },
        schema: [],
        messages: {
          directive: `Raw HTML is rendered only through ${SAFE_HTML_FILE} (§7.6). Use <SafeHtml html={...} /> instead of disabling svelte/no-at-html-tags.`,
        },
      },
      create(context) {
        // Relative to this config file (the repo root), whatever directory ESLint was started from.
        const relative = path
          .relative(import.meta.dirname, context.filename)
          .split(path.sep)
          .join('/')
        if (relative === SAFE_HTML_FILE) return {}
        /** @type {Set<string>} */
        const seen = new Set()
        /** @param {{ value: string, loc?: import('estree').SourceLocation | null, range?: [number, number] }} comment */
        const check = (comment) => {
          if (!comment.loc || !DISABLE_DIRECTIVE.test(comment.value) || !GUARDED_RULES.test(comment.value))
            return
          const key = `${comment.loc.start.line}:${comment.loc.start.column}`
          if (seen.has(key)) return
          seen.add(key)
          context.report({ loc: comment.loc, messageId: 'directive' })
        }
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) check(comment)
          },
          /** @param {any} node svelte-eslint-parser `SvelteHTMLComment` (template `<!-- … -->`) */
          SvelteHTMLComment(node) {
            check(node)
          },
        }
      },
    },
  },
}

const INVOKE_MESSAGE =
  'Call commands through `call(api.x(...))` from $lib/ipc; only src/lib/ipc may use invoke (§5.16).'
const BINDINGS_MESSAGE =
  'Import `api`, `events` and `call` from $lib/ipc; only type imports may come from bindings.ts (§5.16).'

/** IPC boundary (§5.16): code outside src/lib/ipc reaches Rust only through `$lib/ipc` (`api`, `events`, `call`, `fontBytes`). */
const ipcPaths = [
  { name: '@tauri-apps/api/core', importNames: ['invoke'], message: INVOKE_MESSAGE },
  { name: '@tauri-apps/api', importNames: ['core'], message: INVOKE_MESSAGE },
]
const bindingsPattern = {
  regex: '(^|/)ipc/bindings(\\.(ts|js))?$',
  allowTypeImports: true,
  message: BINDINGS_MESSAGE,
}
/** D29: the mock is reachable only through `initIpc()` behind `__MOCK_IPC__`; tests may import it directly. */
const mockPatterns = [
  {
    regex: '(^|/)ipc/mock(/|$)',
    message: 'The IPC mock is loaded only by $lib/ipc behind __MOCK_IPC__ (D29).',
  },
  {
    regex: '^@tauri-apps/api/mocks$',
    message: 'Tauri mocks belong in src/lib/ipc/mock/** and tests only (D29).',
  },
]

export default defineConfig(
  globalIgnores([
    'dist/',
    'target/',
    'artifacts/',
    'src-tauri/',
    'crates/',
    'xtask/',
    'data/',
    'docs/',
    'tests/e2e/baselines/',
    'src/lib/ipc/bindings.ts',
    'src/lib/ipc/mock/fixtures/',
  ]),
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
  // Application code runs in the webview.
  {
    files: ['src/**'],
    languageOptions: { globals: { ...globals.browser, __MOCK_IPC__: 'readonly' } },
  },
  // Tooling runs in Node. QA drivers and e2e scenarios also pass callbacks to page.evaluate (browser globals).
  {
    files: ['*.{js,mjs,cjs,ts}', 'scripts/**', 'vite/**'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['scripts/qa/**', 'tests/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    plugins: { qd },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'svelte/no-at-html-tags': 'error',
      'qd/no-html-escape-hatch': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,js,svelte}'],
    ignores: ['src/lib/ipc/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { paths: ipcPaths, patterns: [bindingsPattern, ...mockPatterns] },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts'],
    ignores: ['src/lib/ipc/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: ipcPaths, patterns: [bindingsPattern] }],
    },
  },
)
