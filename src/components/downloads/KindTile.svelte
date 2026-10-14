<!--
  KindTile: the leading tile of a pack, its kind's icon on a tint of the kind colour (the colours of the disk-usage
  bar's segments, `DiskUsageBar`). `PackRow` draws it at 36 px, the rail's Downloads flyout at 32 px. Decorative: the
  row names the pack.
-->
<script lang="ts">
  import AudioLines from '@lucide/svelte/icons/audio-lines'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import BookText from '@lucide/svelte/icons/book-text'
  import Languages from '@lucide/svelte/icons/languages'
  import Shapes from '@lucide/svelte/icons/shapes'
  import WholeWord from '@lucide/svelte/icons/whole-word'
  import type { LucideIcon } from '@lucide/svelte'
  import type { PackKind } from '$lib/ipc/bindings'

  interface Props {
    kind: PackKind
    /** Tile size in px (the icon is half of it). */
    size?: 32 | 36
  }

  let { kind, size = 36 }: Props = $props()

  const ICONS: Record<PackKind, LucideIcon> = {
    mushaf_fonts: BookOpen,
    decor: Shapes,
    translation: Languages,
    tafsir: BookText,
    recitation: AudioLines,
    wbw: WholeWord,
  }

  const Icon = $derived(ICONS[kind])
</script>

<span class="tile k-{kind}" style:--_size="{size}px" aria-hidden="true">
  <Icon size={size / 2} strokeWidth={1.75} />
</span>

<style>
  /* Kind colours, as in the disk-usage bar (DiskUsageBar). */
  .tile {
    --_k: var(--text-muted);
    display: inline-grid;
    flex: none;
    place-items: center;
    inline-size: var(--_size);
    block-size: var(--_size);
    border-radius: var(--radius-md);
    background-color: color-mix(in srgb, var(--_k) 13%, var(--surface-raised));
    color: color-mix(in srgb, var(--_k) 88%, var(--text));
  }

  .k-mushaf_fonts {
    --_k: var(--frame-gold);
  }

  .k-decor {
    --_k: color-mix(in srgb, var(--frame-gold) 80%, var(--text));
  }

  .k-translation {
    --_k: color-mix(in srgb, var(--user-hl-blue-solid) 78%, var(--text));
  }

  .k-tafsir {
    --_k: color-mix(in srgb, var(--user-hl-purple-solid) 78%, var(--text));
  }

  .k-recitation {
    --_k: var(--accent);
  }

  .k-wbw {
    --_k: color-mix(in srgb, var(--user-hl-yellow-solid) 82%, var(--text));
  }

  @media (forced-colors: active) {
    .tile {
      border: 1px solid CanvasText;
    }
  }
</style>
