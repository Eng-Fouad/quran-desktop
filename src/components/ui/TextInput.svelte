<!--
  TextInput (§9.5, §11.3): a single-line input. 32 px (sm 28, lg 40), radius-sm, `--surface-sunken` fill plus a 1 px
  `--border-input` border, the focus ring, `dir="auto"` so Arabic typed in the English UI (and Latin in the Arabic UI)
  runs in its natural direction; while empty it takes the UI direction, so the placeholder sits at the reading start
  (an empty `dir="auto"` field resolves to LTR, which put the Arabic placeholder on the left). `leading` / `trailing` snippets add icons or buttons inside the box. `invalid` marks
  the border (pair it with `Field`'s `error`). Other attributes go to the `<input>`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLInputAttributes } from 'svelte/elements'
  import { i18n } from '$lib/stores/i18n.svelte'
  import type { ControlSize } from './types'

  interface Props extends Omit<HTMLInputAttributes, 'size' | 'value'> {
    value?: string
    size?: ControlSize
    invalid?: boolean
    leading?: Snippet
    trailing?: Snippet
    fullWidth?: boolean
    ref?: HTMLInputElement | null
  }

  let {
    value = $bindable(''),
    size = 'md',
    invalid = false,
    leading,
    trailing,
    fullWidth = true,
    ref = $bindable(null),
    type = 'text',
    dir = 'auto',
    disabled,
    class: className,
    ...rest
  }: Props = $props()

  const inputDir = $derived(dir === 'auto' && (value ?? '') === '' ? i18n.dir : dir)
</script>

<span class={['box', `s-${size}`, { full: fullWidth, invalid, disabled }, className]}>
  {#if leading}<span class="adorn lead">{@render leading()}</span>{/if}
  <input
    {...rest}
    bind:this={ref}
    bind:value
    {type}
    dir={inputDir}
    {disabled}
    class="input"
    aria-invalid={invalid || rest['aria-invalid'] || undefined}
  />
  {#if trailing}<span class="adorn trail">{@render trailing()}</span>{/if}
</span>

<style>
  .box {
    --_h: 32px;
    position: relative;
    display: inline-flex;
    align-items: center;
    min-inline-size: 0;
    block-size: var(--_h);
    border: 1px solid var(--border-input);
    border-radius: var(--radius-sm);
    background-color: var(--surface-sunken);
    color: var(--text);
    transition: border-color var(--dur-fast) var(--ease-standard);
  }

  .s-sm {
    --_h: 28px;
  }

  .s-lg {
    --_h: 40px;
  }

  .full {
    display: flex;
    inline-size: 100%;
  }

  .box:hover:not(.disabled, :focus-within) {
    border-color: var(--text-muted);
  }

  .box:focus-within {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .invalid,
  .invalid:hover {
    border-color: var(--danger);
  }

  .disabled {
    opacity: 0.5;
  }

  .input {
    flex: 1 1 auto;
    min-inline-size: 0;
    /* Stretched by the flex row, not `block-size: 100%`: Blink resets a fixed- or percent-height input's line box to
       `normal`, which for IBM Plex Sans Arabic is shorter than its dots (the field drew «ابحث فى» for «ابحث في»). */
    align-self: stretch;
    padding-block: 0;
    padding-inline: var(--space-3);
    border: 0;
    background: none;
    color: inherit;
    font-family: inherit;
    font-size: var(--text-md);
    text-align: start;
    outline: none;
    unicode-bidi: plaintext;
  }

  .s-sm .input {
    font-size: var(--text-sm);
  }

  .s-lg .input {
    font-size: var(--text-lg);
  }

  .input:disabled {
    cursor: default;
  }

  .input::-webkit-search-cancel-button,
  .input::-webkit-search-decoration {
    appearance: none;
  }

  .adorn {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-muted);
  }

  .lead {
    padding-inline-start: var(--space-2);
  }

  .lead + .input {
    padding-inline-start: var(--space-2);
  }

  .trail {
    padding-inline-end: var(--space-1);
  }

  .input:has(+ .trail) {
    padding-inline-end: var(--space-1);
  }

  @media (forced-colors: active) {
    .box {
      border-color: CanvasText;
    }
  }
</style>
