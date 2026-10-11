<!--
  HideStylePicker (§9.7, §8.16): how hidden words look during memorisation, as two cards with a sample line of 1:2 whose
  last words are hidden the way the option hides them: blurred (the line keeps its shape) or blank (only each word's
  space shows). A radio group. The samples use the reader's own values (`src/styles/mushaf/memo.css`): a blur of 0.16 of
  the font size at 55 % opacity, and a `--text-faint` rule across the lower part of each blank word.
-->
<script lang="ts">
  import type { MemoHideStyle } from '$lib/ipc/bindings'
  import { i18n, settings } from '$lib/stores'
  import { save } from '../model'
  import { radioGroup } from './radio'

  interface Props {
    labelledBy: string
    describedBy?: string
  }

  let { labelledBy, describedBy }: Props = $props()

  const STYLES: readonly MemoHideStyle[] = ['blur', 'blank']
  /** 1:2 in the Hafs script; the first word stays visible. */
  const WORDS = ['ٱلْحَمْدُ', 'لِلَّهِ', 'رَبِّ', 'ٱلْعَٰلَمِينَ'] as const

  const value = $derived(settings.value.memoHideStyle)

  function choose(next: string): void {
    if (next !== value) void save('memoHideStyle', next as MemoHideStyle)
  }
</script>

<div
  class="hide-styles"
  role="radiogroup"
  aria-labelledby={labelledBy}
  aria-describedby={describedBy}
  use:radioGroup={choose}
>
  {#each STYLES as style (style)}
    {@const checked = value === style}
    <button
      type="button"
      class={['option', { checked }]}
      role="radio"
      aria-checked={checked}
      tabindex={checked ? 0 : -1}
      data-value={style}
      onclick={() => choose(style)}
    >
      <span class="sample quran-text" lang="ar" dir="rtl" aria-hidden="true">
        {#each WORDS as word, i (i)}
          <span class={['w', { hid: i > 0, [style]: i > 0 }]}>{word}</span>
        {/each}
      </span>
      <span class="name">{i18n.t(`settings.options.memoHideStyle.${style}`)}</span>
      <span class="hint">{i18n.t(`settings.options.memoHideStyleHint.${style}`)}</span>
    </button>
  {/each}
</div>

<style>
  .hide-styles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
    gap: var(--space-3);
  }

  .option {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background-color: var(--surface-raised);
    color: var(--text);
    font-family: inherit;
    text-align: start;
    cursor: pointer;
    transition:
      border-color var(--dur-fast) var(--ease-standard),
      box-shadow var(--dur-fast) var(--ease-standard);
  }

  .option:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-1);
  }

  .option.checked {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .sample {
    display: flex;
    justify-content: center;
    gap: 0.28em;
    margin-block-end: var(--space-2);
    padding-block: var(--space-2);
    padding-inline: var(--space-3);
    border-radius: var(--radius-sm);
    background-color: var(--surface-page);
    color: var(--ink);
    font-family: var(--font-quran);
    font-size: 24px;
    line-height: 1.9;
    white-space: nowrap;
  }

  /* As memo.css: blur(0.16·qfs) at 55 % opacity. */
  .hid.blur {
    filter: blur(0.16em);
    opacity: 0.55;
  }

  /* As memo.css's #qd-memo-blank filter: an 80 %-wide rule at 70 % of the word's height, --text-faint at 70 %. */
  .hid.blank {
    background-image: linear-gradient(
      color-mix(in srgb, var(--text-faint) 70%, transparent),
      color-mix(in srgb, var(--text-faint) 70%, transparent)
    );
    background-position: 50% 72.5%;
    background-repeat: no-repeat;
    background-size: 80% max(1px, 3.5%);
    color: transparent;
  }

  .name {
    padding-inline: var(--space-1);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
  }

  .checked .name {
    color: var(--accent-text);
  }

  .hint {
    padding-inline: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-ui);
  }

  @media (forced-colors: active) {
    .option.checked {
      outline: 2px solid Highlight;
    }

    .hid.blank {
      background-color: GrayText;
    }
  }
</style>
