/**
 * Reading and saving settings by row path: `showPageFrame`, or `sidePane.widthPx` for a nested field. Saving
 * goes through the settings store's optimistic `update`, which persists the whole value and reverts on error;
 * a nested field is saved with its parent object whole (the store merges top-level keys only).
 *
 * Also the formatters for values shown beside sliders and steppers, in the UI language and digits.
 */
import { defaultSettings } from '$lib/contracts/settings'
import type { Settings } from '$lib/ipc/bindings'
import { i18n } from '$lib/stores/i18n.svelte'
import { settings } from '$lib/stores/settings.svelte'
import type { SettingPath, SettingUnit } from './meta'

type NestedKey = 'sidePane' | 'sidebar' | 'copy'

/** The value type of a row path. */
export type PathValue<P extends SettingPath> = P extends `${infer A}.${infer B}`
  ? A extends NestedKey
    ? B extends keyof Settings[A]
      ? Settings[A][B]
      : never
    : never
  : P extends keyof Settings
    ? Settings[P]
    : never

function split(path: string): [string, string | undefined] {
  const dot = path.indexOf('.')
  return dot < 0 ? [path, undefined] : [path.slice(0, dot), path.slice(dot + 1)]
}

/** The value at `path` in `source`. */
export function readPath<P extends SettingPath>(source: Settings, path: P): PathValue<P> {
  const [parent, child] = split(path)
  const top = (source as unknown as Record<string, unknown>)[parent]
  if (child === undefined) return top as PathValue<P>
  return (top as Record<string, unknown>)[child] as PathValue<P>
}

/** The `settings.update` patch that sets `path` to `value` (a nested field takes its parent object whole). */
export function patchFor<P extends SettingPath>(
  source: Settings,
  path: P,
  value: PathValue<P>,
): Partial<Settings> {
  const [parent, child] = split(path)
  if (child === undefined) return { [parent]: value } as Partial<Settings>
  const current = (source as unknown as Record<string, Record<string, unknown>>)[parent]
  return { [parent]: { ...current, [child]: value } } as Partial<Settings>
}

/** The current value of a row. */
export function current<P extends SettingPath>(path: P): PathValue<P> {
  return readPath(settings.value, path)
}

/** The default value of a row (`Settings::default()`). */
export function defaultOf<P extends SettingPath>(path: P): PathValue<P> {
  return readPath(defaultSettings(), path)
}

/** Saves one row (optimistic; resolves `false` when the write failed and was reverted). */
export function save<P extends SettingPath>(path: P, value: PathValue<P>): Promise<boolean> {
  return settings.update(patchFor(settings.value, path, value))
}

/** A value with its unit, in the UI language: "150%" («١٥٠٪»), "300 px", "1.25×", "2 GB", "3 times". */
export function formatValue(unit: SettingUnit | undefined, value: number): string {
  switch (unit) {
    case 'pct':
      return new Intl.NumberFormat(i18n.intlLocale, { style: 'percent', maximumFractionDigits: 0 }).format(
        value / 100,
      )
    case 'px':
      return i18n.t('settings.units.px', { value })
    case 'speed':
      return i18n.t('settings.units.speed', { value: value / 100 })
    case 'mib':
      return i18n.bytes(value * 1024)
    case 'count':
      return value === 0 ? i18n.t('settings.units.infinite') : i18n.num(value)
    default:
      return i18n.num(value)
  }
}

/** A pause in seconds, from milliseconds: "1.5 s". */
export function formatSeconds(ms: number): string {
  return i18n.t('settings.units.seconds', { value: Math.round(ms / 100) / 10 })
}

/** A pause as a share of the ayah's length, from a percentage: "×1.5". */
export function formatShare(pct: number): string {
  return i18n.t('settings.units.multiplier', { value: pct / 100 })
}

/** A repeat count for screen readers and the stepper's long form: "Once", "3 times", "Until you stop". */
export function formatTimes(count: number): string {
  return count === 0 ? i18n.t('settings.units.infiniteLong') : i18n.tp('settings.units.times', count)
}
