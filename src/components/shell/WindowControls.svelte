<!--
  WindowControls: the Windows caption buttons of the custom title bar (`decorations: false`).
  Rendered by `TitleBar` on Windows only.

  - Three 46×40 buttons: minimise, maximise / restore (follows the window's state through `onResized`), close (which
    goes through `CloseRequested`, so close-to-tray applies). Close hover is the Windows red #c42b1c with a
    white glyph; the others hover with `--surface-hover`.
  - Glyphs are Segoe Fluent Icons (Windows 11) or Segoe MDL2 Assets (Windows 10) code points, detected once; without
    either font (the browser mock elsewhere) they are drawn as 10 px SVG.
  - Snap Layouts: the maximise button carries `data-qd-snap`; on Windows 11 Rust lays a native hit-test
    target over it, so the flyout appears and pointer events never reach the button. Rust reports the target's pointer
    state with the `qd:caption-button` window event (`hover` / `pressed` / `none`), shown here like `:hover` and
    `:active`. Keyboard and screen readers still use the button itself.
  - Like native caption buttons they are not tab stops (Alt+Space and Win+arrows remain); they keep their labels.
  - The group follows the inline end, so the Arabic UI mirrors it to the left with close at the outer edge, as a
    mirrored Windows window does.
  Props: `inactive` dims the glyphs while the window is in the background.
-->
<script lang="ts">
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { onMount } from 'svelte'
  import { Tooltip } from '$components/ui'
  import { i18n } from '$lib/stores'
  import { CAPTION_GLYPHS, captionGlyphFont } from '$lib/util/platform'

  interface Props {
    /** The window is not the foreground window (glyphs dimmed, like native captions). */
    inactive?: boolean
  }

  let { inactive = false }: Props = $props()

  const font = captionGlyphFont()
  let maximized = $state(false)
  /** The native Snap Layouts target's pointer state over the maximise button. */
  let nativeState = $state<'hover' | 'pressed' | undefined>()

  function onCaptionButton(e: Event): void {
    const detail = (e as CustomEvent<{ button?: string; state?: string } | null>).detail
    if (detail?.button !== 'maximize') return
    nativeState = detail.state === 'hover' || detail.state === 'pressed' ? detail.state : undefined
  }

  onMount(() => {
    const win = getCurrentWindow()
    let disposed = false
    let unlisten: (() => void) | undefined
    const sync = () =>
      win.isMaximized().then(
        (m) => {
          if (!disposed) maximized = m
        },
        () => {},
      )
    void sync()
    win
      .onResized(() => void sync())
      .then(
        (fn) => {
          if (disposed) fn()
          else unlisten = fn
        },
        (e: unknown) => console.warn('[qd] window resize events are unavailable', e),
      )
    window.addEventListener('qd:caption-button', onCaptionButton)
    return () => {
      disposed = true
      unlisten?.()
      window.removeEventListener('qd:caption-button', onCaptionButton)
    }
  })

  function run(action: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>): void {
    action(getCurrentWindow()).catch((e: unknown) => console.warn('[qd] window control failed', e))
  }

  const maximizeLabel = $derived(maximized ? i18n.t('shell.window.restore') : i18n.t('shell.window.maximize'))
</script>

{#snippet glyph(kind: keyof typeof CAPTION_GLYPHS)}
  {#if font}
    <span class="glyph" style:font-family={`"${font}"`} aria-hidden="true">{CAPTION_GLYPHS[kind]}</span>
  {:else}
    <svg class="glyph-svg" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      {#if kind === 'minimize'}
        <path d="M0 5.5h10" />
      {:else if kind === 'maximize'}
        <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
      {:else if kind === 'restore'}
        <path d="M2.5 2.5V2a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 9.5 2v4a1.5 1.5 0 0 1-1.5 1.5h-.5" />
        <rect x="0.5" y="2.5" width="7" height="7" rx="1.5" />
      {:else}
        <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
      {/if}
    </svg>
  {/if}
{/snippet}

<div class="controls" class:inactive>
  <Tooltip content={i18n.t('shell.window.minimize')} side="bottom">
    {#snippet children({ props })}
      <button
        {...props}
        type="button"
        class="control"
        tabindex="-1"
        aria-label={i18n.t('shell.window.minimize')}
        onclick={() => run((w) => w.minimize())}
      >
        {@render glyph('minimize')}
      </button>
    {/snippet}
  </Tooltip>
  <Tooltip content={maximizeLabel} side="bottom">
    {#snippet children({ props })}
      <button
        {...props}
        type="button"
        class="control"
        tabindex="-1"
        data-qd-snap
        data-native-state={nativeState}
        aria-label={maximizeLabel}
        onclick={() => run((w) => w.toggleMaximize())}
      >
        {@render glyph(maximized ? 'restore' : 'maximize')}
      </button>
    {/snippet}
  </Tooltip>
  <Tooltip content={i18n.t('shell.window.close')} side="bottom" align="end">
    {#snippet children({ props })}
      <button
        {...props}
        type="button"
        class="control close"
        tabindex="-1"
        aria-label={i18n.t('shell.window.close')}
        onclick={() => run((w) => w.close())}
      >
        {@render glyph('close')}
      </button>
    {/snippet}
  </Tooltip>
</div>

<style>
  .controls {
    /* Windows 11 caption colours (system constants, not theme tokens). */
    --_close-bg: #c42b1c;
    --_close-bg-pressed: color-mix(in srgb, #c42b1c 90%, transparent);
    --_close-fg: #ffffff;

    display: flex;
    flex: none;
    align-self: stretch;
  }

  .control {
    display: grid;
    place-items: center;
    inline-size: 46px;
    block-size: 40px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background-color: transparent;
    color: var(--text);
    cursor: default;
    transition:
      background-color var(--dur-fast) var(--ease-standard),
      color var(--dur-fast) var(--ease-standard);
  }

  .inactive .control {
    color: var(--text-faint);
  }

  .control:hover,
  .control[data-native-state='hover'] {
    background-color: var(--surface-hover);
    color: var(--text);
  }

  .control:active,
  .control[data-native-state='pressed'] {
    background-color: color-mix(in srgb, var(--text) 6%, transparent);
  }

  .close:hover,
  .close:active {
    background-color: var(--_close-bg);
    color: var(--_close-fg);
  }

  .close:active {
    background-color: var(--_close-bg-pressed);
  }

  .glyph {
    font-size: 10px;
    line-height: 1;
    font-weight: 400;
    /* Hinted icon glyphs: never synthesised. */
    font-synthesis: none;
  }

  .glyph-svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    shape-rendering: geometricPrecision;
  }

  @media (forced-colors: active) {
    .close:hover {
      background-color: Highlight;
      color: HighlightText;
    }
  }
</style>
