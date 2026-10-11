<!--
  OverlayHost (§7.4, §7.5): renders the top-most overlay of `ui.overlays` with exactly its `OverlayProps[kind]`, so
  the compiler checks every overlay component against the §7.9 contract. Owner: WP7c. Takes no props.

  - Each overlay component renders its own bits-ui `Dialog` (focus trap, Escape, outside click) with `open={isOpen()}`
    (`overlayOpen(kind)`, `overlay.ts`) and `onOpenChange={(o) => !o && ui.close(kind)}`.
  - When the stack empties, the last overlay stays mounted for its exit transition (its entry is no longer the top, so
    its Dialog animates out and restores focus), then unmounts. A new top overlay (every `ui.open` makes a new entry)
    replaces the shown one at once with a fresh instance, so its Dialog opens with its own initial focus.
  - Each instance knows its own entry (`OverlayInstance`), so a closing instance never opens again when an overlay of
    the same kind is pushed inside its exit window; bits-ui then releases the body lock it took (WP9b's report).
-->
<script lang="ts">
  import ConfirmDialog from '$components/dialogs/ConfirmDialog.svelte'
  import GoToDialog from '$components/dialogs/GoToDialog.svelte'
  import NoteEditorDialog from '$components/dialogs/NoteEditorDialog.svelte'
  import SelfTestDialog from '$components/dialogs/SelfTestDialog.svelte'
  import ShortcutSheet from '$components/dialogs/ShortcutSheet.svelte'
  import OnboardingDialog from '$components/onboarding/OnboardingDialog.svelte'
  import CommandPalette from '$components/palette/CommandPalette.svelte'
  import type { OverlayEntry } from '$lib/contracts/overlays'
  import { settings, ui } from '$lib/stores'
  import OverlayInstance from './OverlayInstance.svelte'

  /** Slightly longer than the Dialog exit (`--dur-normal`, 200 ms), so its `transitionend` always lands first. */
  const EXIT_MS = 260

  let shown = $state.raw<OverlayEntry | null>(ui.topOverlay)
  let timer: ReturnType<typeof setTimeout> | undefined

  $effect(() => {
    const top = ui.topOverlay
    clearTimeout(timer)
    if (top !== null) {
      shown = top
      return
    }
    if (shown === null) return
    const delay = settings.reducedMotion ? 0 : EXIT_MS
    timer = setTimeout(() => (shown = null), delay)
    return () => clearTimeout(timer)
  })
</script>

{#if shown}
  {#key shown}
    <OverlayInstance entry={shown}>
      {#if shown.kind === 'palette'}
        <CommandPalette {...shown.props} />
      {:else if shown.kind === 'goto'}
        <GoToDialog {...shown.props} />
      {:else if shown.kind === 'shortcuts'}
        <ShortcutSheet />
      {:else if shown.kind === 'onboarding'}
        <OnboardingDialog />
      {:else if shown.kind === 'confirm'}
        <ConfirmDialog {...shown.props} />
      {:else if shown.kind === 'note-editor'}
        <NoteEditorDialog {...shown.props} />
      {:else if shown.kind === 'self-test'}
        <SelfTestDialog {...shown.props} />
      {/if}
    </OverlayInstance>
  {/key}
{/if}
