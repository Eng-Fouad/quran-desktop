<!--
  LiveRegion: the polite live region behind `ui.announce(text)`: "Page 262" on page change, "Al-Baqarah 2:255,
  page 42" after a jump, "Reciting 2:255" when `announceRecitation` is on. Repeating the same text announces it again
  (`ui.announce` clears and re-sets it). Takes no props.
-->
<script lang="ts">
  import { ui } from '$lib/stores'
</script>

<div class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-qd-live>{ui.announcement}</div>
