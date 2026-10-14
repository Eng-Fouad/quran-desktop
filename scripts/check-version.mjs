#!/usr/bin/env node
// @ts-check
// check-version: a release tag names the version every manifest carries.
//
//   node scripts/check-version.mjs v0.1.0
//
// The tag must be `v<semver>` and equal package.json `version`, src-tauri/tauri.conf.json `version` (the installer
// and bundle versions) and the Cargo workspace version (`[workspace.package] version`, the binary's).
//
// Exit codes: 0 they agree, 1 they do not, 2 bad usage.
import console from 'node:console'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/

/**
 * The versions the repository declares.
 * @param {string} root
 * @returns {{ file: string, version: string | null }[]}
 */
export function declaredVersions(root = ROOT) {
  const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(root, rel), 'utf8')
  const cargo = read('Cargo.toml')
  const header = '[workspace.package]'
  const at = cargo.indexOf(header)
  const rest = at < 0 ? '' : cargo.slice(at + header.length)
  const next = rest.search(/^\[/m)
  const workspace = next < 0 ? rest : rest.slice(0, next)
  return [
    { file: 'package.json', version: JSON.parse(read('package.json')).version ?? null },
    {
      file: 'src-tauri/tauri.conf.json',
      version: JSON.parse(read('src-tauri/tauri.conf.json')).version ?? null,
    },
    {
      file: 'Cargo.toml [workspace.package]',
      version: /^version\s*=\s*"([^"]+)"/m.exec(workspace)?.[1] ?? null,
    },
  ]
}

/**
 * @param {string} tag @param {{ file: string, version: string | null }[]} declared
 * @returns {string[]} problems
 */
export function checkTag(tag, declared) {
  const m = /^v(.+)$/.exec(tag)
  if (!m?.[1] || !SEMVER.test(m[1])) return [`the tag ${JSON.stringify(tag)} is not v<semver> (e.g. v0.1.0)`]
  return declared
    .filter((d) => d.version !== m[1])
    .map((d) => `${d.file} declares ${d.version ?? 'no version'}, the tag says ${m[1]}`)
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  const tag = argv[0]
  if (!tag || argv.length > 1) {
    console.error('usage: node scripts/check-version.mjs v<version>')
    return 2
  }
  const problems = checkTag(tag, declaredVersions())
  for (const p of problems) {
    console.error(`check-version: ${p}`)
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error title=Release version::${p}`)
  }
  if (problems.length === 0)
    console.log(`check-version: ${tag} matches package.json, tauri.conf.json and Cargo.toml`)
  return problems.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
