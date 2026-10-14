// @ts-check
// Helpers for e2e scenarios: `import { check, equal, mushaf } from '../lib/index.mjs'`.
export { check, equal, includes, ScenarioAssertionError, ScenarioPending, waitUntil } from './assert.mjs'
export { createQdClient, HOOK_MISSING, waitForBoot } from './qd.mjs'
export {
  DEFAULT_WINDOW,
  discover,
  loadScenario,
  parseOnly,
  RegistryError,
  resolveMeta,
  runsIn,
  select,
} from './registry.mjs'

/** DOM selectors of the Mushaf renderer. */
export const mushaf = {
  /** @param {number} n */
  page: (n) => `section.mp[data-page="${n}"]`,
  /** Word spans of a page (`.w`, end markers included). @param {number} n */
  words: (n) => `section.mp[data-page="${n}"] .mp-glyphs .w`,
  /** @param {number} wordId */
  word: (wordId) => `.mp-glyphs .w[data-w="${wordId}"]`,
}
