<!--
  KeyBadge: a verse's number in a 28 px rosette at the inline start of its row (the Index's star), with
  the reference beside it ("1:2", bidi-isolated, UI digits). `active` fills the star with the accent (the playing or
  selected verse). The rosette is decorative; the reference text carries the accessible name.
-->
<script lang="ts">
  import Rosette from '$components/index/Rosette.svelte'
  import { i18n } from '$lib/stores'

  interface Props {
    surah: number
    ayah: number
    /** Id of the reference text, so the verse can be labelled by it. */
    id?: string
    active?: boolean
  }

  let { surah, ayah, id, active = false }: Props = $props()
</script>

<span class="key">
  <Rosette n={ayah} size={28} {active} />
  <span class="ref tabular-nums" {id}>{i18n.ref(surah, ayah)}</span>
</span>

<style>
  .key {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-inline-size: 0;
  }

  .ref {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
    line-height: 1;
    white-space: nowrap;
  }
</style>
