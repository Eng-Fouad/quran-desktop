<!--
  ThemePreview (onboarding theme cards). A decorative thumbnail of page 1 in a given theme: the
  page (`MushafPage interactive={false}`, hafs, from core.db through `mushaf_get_pages`) rising from the theme's app
  surface. With two themes (Match system) the second covers the end half along a diagonal, so the card shows the
  light and dark variants at once.

  Each layer re-themes its subtree with the theme's own token declarations (`themeStyle`), so the preview always
  matches the token sheet. Inert and hidden from assistive technology: the card around it carries the name.
-->
<script lang="ts">
  import MushafPage from '$components/mushaf/MushafPage.svelte'
  import type { ResolvedTheme } from '$lib/contracts/stores'
  import type { PageData } from '$lib/ipc/bindings'
  import { themeStyle } from './themeTokens'

  interface Props {
    /** Page 1 in the hafs style, or null while it loads (the themed surface shows alone). */
    page: PageData | null
    /** One theme, or the light and dark variants of Match system. */
    themes: readonly ResolvedTheme[]
    /** Quran font size of the thumbnail page (CSS px). */
    qfs?: number
  }

  let { page, themes, qfs = 4 }: Props = $props()
</script>

<div class="preview" aria-hidden="true" inert style:--tp-qfs="{qfs}px">
  {#each themes as theme, i (theme)}
    <div class={['layer', { second: i > 0 }]} data-theme-preview={theme} style={themeStyle(theme)}>
      {#if page}
        <div class="sheet">
          <MushafPage data={page} {qfs} side="right" interactive={false} />
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .preview {
    position: relative;
    overflow: hidden;
    block-size: 100%;
    inline-size: 100%;
    isolation: isolate;
  }

  .layer {
    position: absolute;
    inset: 0;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-block-start: calc(var(--tp-qfs) * 2.6);
    background-color: var(--surface-app);
    color: var(--text);
  }

  /* Match system: the dark variant over the end side, cut on a diagonal. */
  .second {
    clip-path: polygon(64% 0, 100% 0, 100% 100%, 36% 100%);
  }

  :global([dir='rtl']) .second {
    clip-path: polygon(0 0, 36% 0, 64% 100%, 0 100%);
  }

  .sheet {
    flex: none;
    pointer-events: none;
  }

  @media (forced-colors: active) {
    .second {
      clip-path: none;
      display: none;
    }
  }
</style>
