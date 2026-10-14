<!--
  Test double of `RenditionStack` for `MushafPage.swap.browser.test.ts`: mounts the renditions listed in the
  module-level `stack` as GlyphLayers, the way `RenditionStack` stacks a fallback and a QCF rendition, fits the top one
  and reports its word boxes through `onmeasure`. The test drives the swap by editing `stack`.
-->
<script module lang="ts">
  import type { RenditionKind, WordBox } from '$lib/contracts/components'

  export interface DoubleRendition {
    key: number
    kind: RenditionKind
    family: string
  }

  export const stack: {
    renditions: DoubleRendition[]
    elements: Record<number, HTMLElement | null>
    measured: WordBox[][]
  } = $state({ renditions: [], elements: {}, measured: [] })
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import type { RenditionStackProps } from '$lib/contracts/components'
  import { fitLines } from '$lib/mushaf/geometry'
  import { measure } from '$lib/mushaf/layout'
  import GlyphLayer from './GlyphLayer.svelte'

  let { data, qfs, onmeasure }: RenditionStackProps = $props()

  $effect(() => {
    void qfs
    void data
    const top = stack.renditions.at(-1)
    const el = top ? stack.elements[top.key] : null
    const block = el?.closest<HTMLElement>('.mp-block')
    if (!el || !block) return
    untrack(() => {
      fitLines(el)
      const boxes = measure(el, block)
      stack.measured.push(boxes)
      onmeasure?.(boxes)
    })
  })
</script>

{#each stack.renditions as r (r.key)}
  <GlyphLayer
    bind:element={stack.elements[r.key]}
    {data}
    rendition={r.kind}
    family={r.family}
    glyphScale={1}
    centerGap={0.3}
  />
{/each}
