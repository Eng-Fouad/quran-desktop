<!--
  FatalScreen: shown instead of the shell when bootstrap failed (`app.fatal`).

  - Debug build without core.db (`app_bootstrap` → `NotFound("core.db missing …")`): "Core data missing (dev build)"
    with the command that builds it.
  - A browser preview of a production build (no IPC): "Run Quran in Tauri".
  - Anything else: "Quran couldn't start" with the localised `errors.<kind>` message.
  The developer message is never shown raw: it sits in a Details disclosure, with Copy details. Try again reloads the
  webview; Quit exits through `app_quit` (only with a backend). The root carries `data-qd-fatal` (the QA harness's
  marker). Takes no props: it reads stores.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import Copy from '@lucide/svelte/icons/copy'
  import appIcon from '../../assets/app-icon.svg'
  import { Button } from '$components/ui'
  import { app, i18n } from '$lib/stores'
  import { hasIpc } from '$lib/stores/app.svelte'
  import { splitAround } from '$lib/util/format'

  const CORE_COMMAND = 'pnpm core:qdc'
  const TAURI_COMMAND = 'pnpm app:dev'

  const reason = $derived(app.fatalReason ?? 'error')
  const title = $derived(
    reason === 'core_missing'
      ? i18n.t('shell.fatal.coreMissingTitle')
      : reason === 'no_backend'
        ? i18n.t('shell.fatal.browserTitle')
        : i18n.t('shell.fatal.genericTitle'),
  )
  /** The body around its `{command}` placeholder (rendered as code), or the error kind's message. */
  const body = $derived.by(() => {
    if (reason === 'core_missing') {
      return { parts: splitAround(i18n.t('shell.fatal.coreMissingBody'), 'command'), command: CORE_COMMAND }
    }
    if (reason === 'no_backend') {
      return { parts: splitAround(i18n.t('shell.fatal.browserBody'), 'command'), command: TAURI_COMMAND }
    }
    return { parts: null, command: '' }
  })
  const message = $derived(i18n.t(`errors.${app.fatalKind ?? 'internal'}`))
  const details = $derived(`${app.fatalKind ?? 'internal'}: ${app.fatal ?? ''}`)
  const backend = hasIpc()

  let copied = $state(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  async function copyDetails(): Promise<void> {
    const info = app.info
    const text = [
      details,
      `${info.name} ${info.version || '?'} · ${info.platform} ${info.arch} · ${info.osVersion || '?'}`,
      `webview ${info.webviewVersion}`,
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      copied = true
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => (copied = false), 2_000)
    } catch (e) {
      console.warn('[qd] could not copy the details', e)
    }
  }
</script>

<main class="fatal" data-qd-fatal={app.fatalKind ?? 'internal'} data-reason={reason}>
  <div class="card">
    <img class="icon" src={appIcon} width="56" height="56" alt="" draggable="false" />
    <h1 class="title">{title}</h1>
    {#if body.parts}
      <p class="body">{body.parts[0]}<code class="command">{body.command}</code>{body.parts[1]}</p>
    {:else}
      <p class="body">{message}</p>
    {/if}

    {#if app.fatal && reason !== 'no_backend'}
      <details class="details">
        <summary>{i18n.t('common.details')}</summary>
        <pre class="message" dir="ltr">{details}</pre>
      </details>
    {/if}

    <div class="actions">
      {#if backend}
        <Button variant="primary" onclick={() => location.reload()}>{i18n.t('shell.fatal.tryAgain')}</Button>
        <Button variant="secondary" onclick={() => app.quit()}>{i18n.t('shell.fatal.quit')}</Button>
      {/if}
      {#if reason !== 'no_backend'}
        <Button variant="ghost" onclick={copyDetails}>
          {#snippet icon()}
            {#if copied}<Check size={16} strokeWidth={2} />{:else}<Copy size={16} strokeWidth={1.75} />{/if}
          {/snippet}
          {copied ? i18n.t('common.copied') : i18n.t('shell.fatal.copyDetails')}
        </Button>
      {/if}
    </div>
  </div>
</main>

<style>
  .fatal {
    display: grid;
    place-items: center;
    min-block-size: 100vh;
    padding: var(--space-8) var(--space-4);
    background-color: var(--surface-app);
    color: var(--text);
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    inline-size: min(520px, 100%);
    padding: var(--space-10) var(--space-8) var(--space-8);
    border-radius: var(--radius-lg);
    background-color: var(--surface-raised);
    box-shadow: var(--shadow-2);
    text-align: center;
  }

  .icon {
    margin-block-end: var(--space-2);
    border-radius: 12px;
    -webkit-user-drag: none;
  }

  .title {
    font-size: var(--text-xl);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
  }

  .body {
    max-inline-size: 42ch;
    color: var(--text-muted);
    font-size: var(--text-md);
    line-height: var(--leading-ui);
  }

  .command {
    padding-block: 1px;
    padding-inline: var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    background-color: var(--surface-sunken);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 0.92em;
    unicode-bidi: isolate;
    direction: ltr;
  }

  .details {
    inline-size: 100%;
    margin-block-start: var(--space-2);
    text-align: start;
  }

  .details summary {
    inline-size: fit-content;
    margin-inline: auto;
    padding-block: var(--space-1);
    padding-inline: var(--space-2);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .details summary:hover {
    color: var(--text);
  }

  .message {
    margin-block: var(--space-2) 0;
    padding: var(--space-3);
    overflow: auto;
    max-block-size: 160px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background-color: var(--surface-sunken);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    /* The element is dir="ltr": developer text always reads left to right. */
    text-align: start;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2);
    margin-block-start: var(--space-4);
  }
</style>
