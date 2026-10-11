/**
 * Text matching for `Combobox` (and searchable `Select`) lists (§9.5): case-, accent- and diacritic-insensitive,
 * with the light Arabic folding users expect when typing a name (alef forms, alef maqsura, ta marbuta, tatweel and
 * harakat do not matter). Every whitespace-separated query token must occur in the label, hint or a keyword; items
 * whose label starts with the query come first, otherwise the list order is kept.
 */
import type { SelectItem } from './types'

const ARABIC_FOLD: Readonly<Record<string, string>> = {
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ى: 'ي',
  ة: 'ه',
  ؤ: 'و',
  ئ: 'ي',
}

/** Lower-cased, without combining marks (Latin accents, Arabic harakat), tatweel or Arabic letter variants. */
export function foldForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\p{M}\u0640]/gu, '')
    .replace(/[أإآٱىةؤئ]/gu, (ch) => ARABIC_FOLD[ch] ?? ch)
    .toLocaleLowerCase('en')
    .trim()
}

/** The items matching `query` (all of them for a blank query), prefix matches of the label first. */
export function filterItems<T extends SelectItem>(items: readonly T[], query: string): T[] {
  const tokens = foldForMatch(query).split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return [...items]
  const head: T[] = []
  const rest: T[] = []
  for (const item of items) {
    const label = foldForMatch(item.label)
    const haystack = [label, foldForMatch(item.hint ?? ''), ...(item.keywords ?? []).map(foldForMatch)].join(
      '\n',
    )
    if (!tokens.every((t) => haystack.includes(t))) continue
    if (label.startsWith(tokens.join(' '))) head.push(item)
    else rest.push(item)
  }
  return [...head, ...rest]
}

/** Items grouped by `group` in first-appearance order (ungrouped items form a group with an empty heading). */
export function groupItems<T extends SelectItem>(items: readonly T[]): { heading: string; items: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = item.group ?? ''
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }
  return [...groups].map(([heading, list]) => ({ heading, items: list }))
}
