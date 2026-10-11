// @ts-check
// Screenshot checks (§12.6; WP13a): blank-image detection and local baselines compared with pixelmatch (threshold 0.1,
// at most 0.5 % differing pixels). Baselines live in the gitignored `tests/e2e/baselines/<mode>/` and are written only
// by `--update-baselines`; Mushaf images are never committed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

export const PIXEL_THRESHOLD = 0.1
export const MAX_DIFF_RATIO = 0.005

/**
 * Whether every pixel of a PNG has the same colour (a webview that rendered nothing).
 * @param {Buffer} png
 * @returns {{ blank: boolean, color: string }}
 */
export function blankness(png) {
  const { data } = PNG.sync.read(png)
  const r = data[0] ?? 0
  const g = data[1] ?? 0
  const b = data[2] ?? 0
  const a = data[3] ?? 0
  const color = `rgba(${r}, ${g}, ${b}, ${a})`
  for (let i = 4; i < data.length; i += 4) {
    if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b || data[i + 3] !== a)
      return { blank: false, color }
  }
  return { blank: true, color }
}

/** @typedef {'new' | 'same' | 'changed' | 'size' | 'updated'} BaselineStatus */
/**
 * @typedef {object} BaselineResult
 * @property {string} shot        the image file name (`S19.png`)
 * @property {BaselineStatus} status
 * @property {number | null} diffRatio  differing pixels / all pixels
 * @property {string | null} baseline   the baseline file
 * @property {string | null} diff       the diff image (red pixels differ), written for `changed`
 */

/**
 * Compares a screenshot with its baseline, or stores it as the new baseline with `update`.
 * @param {string} file       the screenshot
 * @param {string} baselineDir
 * @param {string} diffDir
 * @param {{ update?: boolean, threshold?: number, maxRatio?: number }} [options]
 * @returns {BaselineResult}
 */
export function compareBaseline(file, baselineDir, diffDir, options = {}) {
  const shot = basename(file)
  const baseline = join(baselineDir, shot)
  if (options.update) {
    mkdirSync(baselineDir, { recursive: true })
    copyFileSync(file, baseline)
    return { shot, status: 'updated', diffRatio: null, baseline, diff: null }
  }
  if (!existsSync(baseline)) return { shot, status: 'new', diffRatio: null, baseline: null, diff: null }

  const current = PNG.sync.read(readFileSync(file))
  const expected = PNG.sync.read(readFileSync(baseline))
  if (current.width !== expected.width || current.height !== expected.height)
    return { shot, status: 'size', diffRatio: 1, baseline, diff: null }

  const { width, height } = current
  const output = new PNG({ width, height })
  const differing = pixelmatch(expected.data, current.data, output.data, width, height, {
    threshold: options.threshold ?? PIXEL_THRESHOLD,
  })
  const diffRatio = differing / (width * height)
  if (diffRatio <= (options.maxRatio ?? MAX_DIFF_RATIO))
    return { shot, status: 'same', diffRatio, baseline, diff: null }
  const diff = join(diffDir, shot)
  mkdirSync(dirname(diff), { recursive: true })
  writeFileSync(diff, PNG.sync.write(output))
  return { shot, status: 'changed', diffRatio, baseline, diff }
}
