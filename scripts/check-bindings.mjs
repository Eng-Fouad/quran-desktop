// Bindings drift check (§5.15) that does not depend on git history: regenerates src/lib/ipc/bindings.ts through the
// `export_bindings` test and fails when the regenerated file differs from the one on disk (the original is restored,
// so a failing check never leaves a modified working tree behind).
//
//   pnpm bindings:check
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'src', 'lib', 'ipc', 'bindings.ts')

if (!existsSync(FILE)) {
  console.error('bindings:check: src/lib/ipc/bindings.ts is missing — run `pnpm bindings`')
  process.exit(1)
}
const before = readFileSync(FILE, 'utf8')
const run = spawnSync('cargo', ['test', '-p', 'quran-desktop', '--lib', 'export_bindings', '--quiet'], {
  cwd: ROOT,
  stdio: 'inherit',
})
if (run.status !== 0) {
  console.error('bindings:check: `cargo test export_bindings` failed')
  process.exit(run.status ?? 1)
}
const after = readFileSync(FILE, 'utf8')
if (after !== before) {
  writeFileSync(FILE, before)
  console.error(
    'bindings:check: src/lib/ipc/bindings.ts is out of date with the Rust contract.\n' +
      '                Run `pnpm bindings` and commit the regenerated file.',
  )
  process.exit(1)
}
console.log('bindings:check: bindings.ts is up to date')
