<!--
  AyahHeader: the study pane's 56 px header.

  - The ayah's number in the Index rosette (filled with the accent while it is being recited), the heading
    "Al-Baqarah 2:255" (a range reads "Al-Baqarah 2:255–257"), and a meta line: the surah's Arabic name in Naskh (the
    English UI only: the Arabic UI's heading is already Arabic), its juz and its page in the current layout.
  - Tools: previous / next ayah (`.icon-dir` chevrons), the pin toggle (`sidePane.follow = pinned`) and, when docked,
    hide (`Mod+I`). A sheet has its own close button.
  - The meta line gives way to a chip: "Follow recitation" while a selection or the pin holds the pane during a
    recitation (it clears the hold); "Show 2:256" while the pane is pinned and the reader selected another ayah (it
    moves the pin there).
-->
<script lang="ts">
  import AudioLines from '@lucide/svelte/icons/audio-lines'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Pin from '@lucide/svelte/icons/pin'
  import PanelRightClose from '@lucide/svelte/icons/panel-right-close'
  import { tick } from 'svelte'
  import Rosette from '$components/index/Rosette.svelte'
  import { IconButton } from '$components/ui'
  import { i18n, quran, reader, shortcuts, ui } from '$lib/stores'
  import { pane, spanHas, type Subject } from './pane.svelte'

  interface Props {
    subject: Subject
  }

  let { subject }: Props = $props()

  const first = $derived(quran.ayahRef(subject.from))
  const last = $derived(quran.ayahRef(subject.to))
  const surah = $derived(quran.surah(first.surah))
  const ref = $derived(
    subject.to > subject.from
      ? i18n.ref(first.surah, first.ayah, last.ayah, last.surah)
      : i18n.ref(first.surah, first.ayah),
  )
  const name = $derived(quran.surahName(first.surah))
  const page = $derived(quran.pageOfAyah(reader.layout, subject.from))
  const juz = $derived(quran.juzOf(subject.from))
  const reciting = $derived(spanHas(subject, pane.recited))
  const chip = $derived(pane.chip)
  const sep = $derived(i18n.t('sidepane.sep'))
  const hideKey = $derived.by(() => {
    const def = shortcuts.defs.find((d) => d.id === 'view.sidePane')
    return def ? shortcuts.format(def) : undefined
  })

  const chipRef = $derived.by(() => {
    if (chip === null) return ''
    const from = quran.ayahRef(chip.kind === 'follow' ? chip.ayahId : chip.span.from)
    if (chip.kind === 'follow' || chip.span.to === chip.span.from) return i18n.ref(from.surah, from.ayah)
    const to = quran.ayahRef(chip.span.to)
    return i18n.ref(from.surah, from.ayah, to.ayah, to.surah)
  })

  /** The chevrons: move, then announce the new heading (focus stays on the button). */
  async function step(delta: 1 | -1): Promise<void> {
    pane.step(delta)
    await tick()
    ui.announce(i18n.t('sidepane.header.title', { surah: name, ref }))
  }

  function onChip(): void {
    if (chip === null) return
    if (chip.kind === 'follow') pane.followRecitation()
    else pane.pinTo(chip.span)
  }
</script>

<header class="ayah-header" data-source={subject.source}>
  <span class="badge" title={reciting ? i18n.t('sidepane.header.reciting') : undefined}>
    <Rosette n={first.ayah} size={36} active={reciting} />
  </span>
  <div class="heading">
    <h2 class="title" id="qd-pane-title">
      <span class="name">{name}</span>
      <span class="ref tabular-nums">{ref}</span>
    </h2>
    {#if chip !== null}
      <button
        type="button"
        class="chip"
        data-chip={chip.kind}
        title={chip.kind === 'follow'
          ? i18n.t('sidepane.header.followRecitationAt', { ref: chipRef })
          : i18n.t('sidepane.header.showSelectionHint')}
        aria-label={chip.kind === 'follow'
          ? i18n.t('sidepane.header.followRecitationAt', { ref: chipRef })
          : undefined}
        onclick={onChip}
      >
        {#if chip.kind === 'follow'}
          <AudioLines size={14} strokeWidth={2} aria-hidden="true" />
          <span>{i18n.t('sidepane.header.followRecitation')}</span>
        {:else}
          <Pin size={13} strokeWidth={2} aria-hidden="true" />
          <span>{i18n.t('sidepane.header.showSelection', { ref: chipRef })}</span>
        {/if}
      </button>
    {:else}
      <p class="meta">
        {#if i18n.locale !== 'ar' && surah}
          <span class="arabic-name" lang="ar" dir="rtl">{surah.nameAr}</span><span class="sep">{sep}</span>
        {/if}
        <span>{i18n.t('common.juzNumber', { juz })}</span><span class="sep">{sep}</span><span
          >{i18n.t('common.pageNumber', { page })}</span
        >
      </p>
    {/if}
  </div>
  <div class="tools">
    <IconButton
      label={i18n.t('sidepane.header.previous')}
      icon={ChevronLeft}
      mirror
      size="sm"
      tooltipSide="bottom"
      disabled={pane.stepTarget(-1) === null}
      onclick={() => void step(-1)}
    />
    <IconButton
      label={i18n.t('sidepane.header.next')}
      icon={ChevronRight}
      mirror
      size="sm"
      tooltipSide="bottom"
      disabled={pane.stepTarget(1) === null}
      onclick={() => void step(1)}
    />
    <!-- A toggle keeps one name; its state is aria-pressed, and the tooltip says what a click does. -->
    <IconButton
      label={i18n.t('sidepane.header.pin')}
      tooltip={i18n.t(pane.pinned ? 'sidepane.header.unpin' : 'sidepane.header.pin')}
      icon={Pin}
      size="sm"
      tooltipSide="bottom"
      pressed={pane.pinned}
      class="pin"
      onclick={() => pane.togglePin()}
    />
    {#if ui.paneDocked}
      <IconButton
        label={i18n.t('sidepane.header.close')}
        icon={PanelRightClose}
        mirror
        size="sm"
        tooltipSide="bottom"
        shortcut={hideKey}
        onclick={() => ui.closeSidePane()}
      />
    {/if}
  </div>
</header>

<style>
  .ayah-header {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-3);
    block-size: 56px;
    padding-inline: var(--space-4) var(--space-2);
  }

  .badge {
    display: inline-grid;
    flex: none;
    place-items: center;
  }

  .heading {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    min-inline-size: 0;
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: 0.4em;
    min-inline-size: 0;
    margin: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text);
    font-size: var(--text-md);
    font-weight: var(--weight-title);
    line-height: var(--leading-title);
    white-space: nowrap;
  }

  .name {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
  }

  .ref {
    flex: none;
    color: var(--text-muted);
    font-weight: var(--weight-label);
  }

  .meta {
    display: flex;
    align-items: baseline;
    min-inline-size: 0;
    margin: 0;
    overflow-x: clip;
    overflow-y: visible;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 18px;
    white-space: nowrap;
  }

  .arabic-name {
    font-family: var(--font-naskh);
    font-size: 14px;
    line-height: 18px;
  }

  .sep {
    white-space: pre;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 5px;
    max-inline-size: 100%;
    block-size: 20px;
    padding-inline: var(--space-2) 9px;
    border: 0;
    border-radius: var(--radius-full);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-family: inherit;
    font-size: var(--text-2xs);
    font-weight: var(--weight-title);
    line-height: 20px;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease-standard);
  }

  .chip > span {
    min-inline-size: 0;
    overflow-x: clip;
    overflow-y: visible;
    text-overflow: ellipsis;
  }

  .chip:hover {
    background-color: color-mix(in srgb, var(--accent) 20%, transparent);
  }

  .chip:focus-visible {
    outline: var(--focus-ring-w) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .tools {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-0_5);
  }

  /* The pin leans like a pushpin when it is off and stands upright when it holds the pane. */
  .tools :global(.pin svg) {
    rotate: 30deg;
    transition: rotate var(--dur-quick) var(--ease-standard);
  }

  .tools :global(.pin[aria-pressed='true'] svg) {
    rotate: 0deg;
  }

  @media (forced-colors: active) {
    .chip {
      border: 1px solid LinkText;
      color: LinkText;
    }
  }
</style>
