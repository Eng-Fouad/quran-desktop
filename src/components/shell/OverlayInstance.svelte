<!--
  OverlayInstance: one keyed overlay instance of `OverlayHost`. It tells the overlay component rendered
  inside which `ui.overlays` entry it belongs to (`overlay.ts`), so the component's Dialog is open only while that
  entry is the top overlay.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { OverlayEntry } from '$lib/contracts/overlays'
  import { setOverlayEntry } from './overlay'

  interface Props {
    entry: OverlayEntry
    children: Snippet
  }

  let { entry, children }: Props = $props()

  // One instance per entry: OverlayHost keys it on the entry, so the entry never changes for this instance.
  // svelte-ignore state_referenced_locally
  setOverlayEntry(entry)
</script>

<div class="overlay-slot" data-overlay={entry.kind}>
  {@render children()}
</div>

<style>
  .overlay-slot {
    display: contents;
  }
</style>
