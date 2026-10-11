<!--
  CopyPreview: what copying 112:1 produces with the current copy settings (`quran_copy_text`, the command the reader's
  Copy uses), updated as the settings change. Each line takes its own direction (Arabic text, a Latin reference, a
  translation), and Arabic lines are set in the Quran font.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { Skeleton } from '$components/ui'
  import { api, call } from '$lib/ipc'
  import type { CopyOptions } from '$lib/ipc/bindings'
  import { i18n, quran, settings } from '$lib/stores'

  interface Props {
    labelledBy?: string
  }

  let { labelledBy }: Props = $props()

  /** Al-Ikhlas 112:1, short enough for one line. */
  const ayahId = $derived(quran.ayahId(112, 1))
  const options: CopyOptions = $derived({ ...settings.value.copy })

  let text = $state<string | null>(null)
  let failed = $state(false)
  /** Only the newest request's answer is shown. */
  let seq = 0

  $effect(() => {
    const id = ayahId
    const opts = options
    const mine = ++seq
    untrack(() => {
      call(api.quranCopyText(id, id, opts)).then(
        (t) => {
          if (mine !== seq) return
          text = t
          failed = false
        },
        (e: unknown) => {
          if (mine !== seq) return
          failed = true
          console.warn('[qd] settings: copy preview', e)
        },
      )
    })
  })

  const ARABIC = /\p{Script=Arabic}/u
  const lines = $derived((text ?? '').split('\n').filter((l) => l.trim() !== ''))
</script>

<figure class="copy-preview" aria-labelledby={labelledBy}>
  <figcaption class="caption">{i18n.t('settings.translations.copyPreview')}</figcaption>
  <div class="paper" data-copy-preview>
    {#if failed}
      <p class="error">{i18n.t('settings.translations.copyPreviewError')}</p>
    {:else if text === null}
      <Skeleton h={16} w="70%" />
    {:else}
      {#each lines as line, i (i)}
        <p class={['line', { arabic: i === 0 && ARABIC.test(line) }]} dir="auto">{line}</p>
      {/each}
    {/if}
  </div>
</figure>

<style>
  .copy-preview {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
  }

  .caption {
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-label);
  }

  .paper {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-block: var(--space-3);
    padding-inline: var(--space-4);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-md);
    background-color: var(--surface-sunken);
    user-select: text;
  }

  .line {
    margin: 0;
    color: var(--text);
    font-size: var(--text-md);
    line-height: var(--leading-reading);
    unicode-bidi: plaintext;
    overflow-wrap: anywhere;
  }

  .line.arabic {
    font-family: var(--font-quran), var(--font-naskh);
    font-size: 22px;
    line-height: 1.9;
  }

  .error {
    margin: 0;
    color: var(--warning-text);
    font-size: var(--text-sm);
  }
</style>
