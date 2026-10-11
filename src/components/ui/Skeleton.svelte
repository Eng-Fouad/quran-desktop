<!--
  Skeleton (§9.5, §9.8): a placeholder block on `--surface-sunken` with a 1.2 s shimmer that runs along the inline
  direction; static under reduced motion. Decorative (`aria-hidden`): announce loading on the region instead
  (`aria-busy`). Never used on the Mushaf, whose paper and frame paint at once (§9.8).
-->
<script lang="ts">
  interface Props {
    /** Width: a number (px) or any CSS length (`60%`). Default: the full width. */
    w?: number | string
    /** Height: a number (px) or any CSS length. Default: one line of text. */
    h?: number | string
    /** Corner radius: a radius token name (`sm`, `md`, `full`, …) or a CSS length. */
    radius?: 'xs' | 'sm' | 'md' | 'lg' | 'full' | (string & {})
    class?: string
  }

  let { w, h, radius = 'xs', class: className }: Props = $props()

  const TOKENS = new Set(['xs', 'sm', 'md', 'lg', 'xl', 'full'])
  const length = (v: number | string | undefined) => (typeof v === 'number' ? `${v}px` : v)
  const corner = $derived(TOKENS.has(radius) ? `var(--radius-${radius})` : radius)
</script>

<span
  class={['skeleton', className]}
  style:inline-size={length(w)}
  style:block-size={length(h)}
  style:border-radius={corner}
  aria-hidden="true"
></span>

<style>
  .skeleton {
    /* A tint of the text colour rather than --surface-sunken itself: sunken is darker than the page in night and
       equal to it in black, where a sunken block would vanish. */
    --_fill: color-mix(in srgb, var(--text) 8%, transparent);
    --_shine: color-mix(in srgb, var(--surface-raised) 75%, transparent);
    display: block;
    inline-size: 100%;
    block-size: 1em;
    background-color: var(--_fill);
    background-image: linear-gradient(90deg, transparent 0%, var(--_shine) 50%, transparent 100%);
    background-repeat: no-repeat;
    background-size: 40% 100%;
    animation: shimmer 1.2s var(--ease-standard) infinite;
  }

  /* Dark themes: the raised surface is darker than the tinted block, so the shine is a lighter tint instead. */
  :global(:root:is([data-theme='night'], [data-theme='black'], [data-hc='dark'])) .skeleton {
    --_shine: color-mix(in srgb, var(--text) 9%, transparent);
  }

  /* The shine runs along the inline direction. */
  :global([dir='rtl']) .skeleton {
    animation-name: shimmer-rtl;
  }

  @keyframes shimmer {
    from {
      background-position: -70% 0;
    }

    to {
      background-position: 170% 0;
    }
  }

  @keyframes shimmer-rtl {
    from {
      background-position: 170% 0;
    }

    to {
      background-position: -70% 0;
    }
  }

  /* Static under reduced motion: no moving highlight at all (base.css would only shorten it to one frame). */
  :global(:root[data-motion='reduce']) .skeleton {
    animation: none;
    background-image: none;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(:root:not([data-motion='full'])) .skeleton {
      animation: none;
      background-image: none;
    }
  }
</style>
