/**
 * The rows of the study pane's "add" cards (no translation, no tafsir chosen, no word-by-word pack). Pure over the
 * catalogue (`translations.packMeta`, which folds running jobs in), so the ranking is testable.
 *
 * Ranking: the UI language first, then the OS language, then English, then the catalogue's recommendation; packs that
 * can be used at once come before ones that must be downloaded. Selected translations that are missing come first of
 * all (they are what the reader asked for).
 */
import type { PackKind } from '$lib/ipc/bindings'
import type { PackMeta } from '$lib/stores/translations.svelte'

/** What a row's button does. `show`: an installed translation not selected yet; `use`: make this pack the one shown. */
export type PickAction = 'use' | 'show' | 'install' | 'downloading' | 'failed'

export interface PickRow {
  meta: PackMeta
  action: PickAction
}

export interface RankContext {
  uiLanguage: string
  osLanguage: string
}

/** How well a pack's language suits the reader. */
export function languageScore(meta: PackMeta, ctx: RankContext): number {
  return (
    (meta.language === ctx.uiLanguage ? 8 : 0) +
    (meta.language === ctx.osLanguage ? 4 : 0) +
    (meta.language === 'en' ? 2 : 0) +
    (meta.recommended ? 1 : 0)
  )
}

/** The button of a pack: installed or fetched on demand → `use`; else by its download state. */
export function actionOf(meta: PackMeta): PickAction {
  if (meta.onDemand || meta.availability === 'installed' || meta.availability === 'unknown') return 'use'
  if (meta.availability === 'downloading') return 'downloading'
  if (meta.availability === 'failed') return 'failed'
  return 'install'
}

/** Best first: usable now, then by language score, then catalogue order. */
export function rank(metas: readonly PackMeta[], ctx: RankContext): PackMeta[] {
  return metas
    .map((meta, i) => ({ meta, i }))
    .sort((a, b) => {
      const ready = Number(actionOf(b.meta) === 'use') - Number(actionOf(a.meta) === 'use')
      return ready || languageScore(b.meta, ctx) - languageScore(a.meta, ctx) || a.i - b.i
    })
    .map(({ meta }) => meta)
}

/**
 * Tafsir or word-by-word packs to offer (`limit` rows): every pack of the kind, best first. A tafsir the reader can
 * use at once (installed, or fetched as you read) says "Use"; a whole pack not on disk says "Install".
 */
export function packRows(
  kind: Extract<PackKind, 'tafsir' | 'wbw'>,
  catalogue: readonly PackMeta[],
  ctx: RankContext,
  limit: number,
): PickRow[] {
  const ofKind = catalogue.filter((m) => m.kind === kind)
  return rank(ofKind, ctx)
    .slice(0, limit)
    .map((meta) => ({ meta, action: actionOf(meta) }))
}

/**
 * Translations to offer (three for the UI language): the selected ones that are missing (with their download
 * state), then installed ones not selected ("Show"), then the catalogue's best matches ("Install").
 */
export function translationRows(
  missing: readonly PackMeta[],
  catalogue: readonly PackMeta[],
  selected: readonly string[],
  ctx: RankContext,
  limit = 3,
): PickRow[] {
  const out: PickRow[] = missing.map((meta) => {
    const action = actionOf(meta)
    return { meta, action: action === 'use' ? 'show' : action }
  })
  const add = (row: PickRow) => {
    if (out.length < Math.max(limit, missing.length) && !out.some((r) => r.meta.id === row.meta.id))
      out.push(row)
  }
  const others = catalogue.filter((m) => m.kind === 'translation' && !selected.includes(m.id))
  for (const meta of rank(others, ctx)) {
    add({ meta, action: meta.availability === 'installed' ? 'show' : actionOf(meta) })
  }
  return out
}
