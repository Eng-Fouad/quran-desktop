<!-- Test fixture (WP11a): translation mode in a canvas-sized box (the shell's `main.canvas` gives it its size). -->
<script lang="ts">
  import TranslationView from '../TranslationView.svelte'

  interface Props {
    width?: number
    height?: number
  }

  let { width = 1100, height = 760 }: Props = $props()
</script>

<main class="host" id="qd-main" data-test-host style:inline-size="{width}px" style:block-size="{height}px">
  <TranslationView />
</main>

<style>
  .host {
    position: relative;
    display: block;
    overflow: hidden;
    background-color: var(--surface-app);
    color: var(--text);
  }
</style>
