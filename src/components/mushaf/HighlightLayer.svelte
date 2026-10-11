<!--
  HighlightLayer (§8.7, D12). Owner: WP8d. The `.mp-hl` layer behind a page's glyphs: every highlight state of the
  page, drawn as shapes computed from the rendition's measured word boxes (`boxes`, fed by RenditionStack through
  MushafPage). Glyph colours never change; at most one fill sits under any word (`planHighlights`, layout.ts).

  Layers, bottom to top (styles in `src/styles/mushaf/highlights.css`):
    1 user highlights (UserMarks)      ayah pills in the user's colour; under a state fill they become a bar
    2 search hit (reader.searchHit)    word pills + underline, pulsing twice on arrival
    3 selection (reader.selection)     ayah pills: 6 % fill + accent ring
    4 hover (reader.hover)             ayah pills, neutral tint, 120 ms fade (when `hoverHighlight`)
    5 audio ayah (player)              ayah pills, 150 ms cross-fade (the basmala segment: WP8c's BasmalaLine)
    6 audio word (player.activeWord)   one opaque pill gliding on the compositor (when `wordHighlight`)
    7 reading cursor                   a 2 px focus ring while DOM focus is on its roving item (A11yLayer)
  plus the arrival flash after a jump (`reader.flash`), drawn like the audio ayah and fading out.

  The glide is transform-only on one element inside a `contain: strict` layer: the same line glides, a new line or
  page jumps, reduced motion is always instant (§8.7). A word change writes the pill's box once and plays a Web
  Animation of its transform from the box it showed (glide.ts): the compositor runs the glide, so a recitation writes
  nothing per frame. Nothing here reads layout, except the pill's own transform when a word arrives mid-glide.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { fade } from 'svelte/transition'
  import type { HighlightLayerProps, WordBox } from '$lib/contracts/components'
  import { api, call, events } from '$lib/ipc'
  import type { UserMarks } from '$lib/ipc/bindings'
  import { LH, TB_W } from '$lib/mushaf/geometry'
  import {
    boxMoved,
    boxTransform,
    flipFrom,
    flipTo,
    type GlideBox,
    GLIDE_MS,
    glideEasing,
    shownBox,
  } from '$lib/mushaf/glide'
  import {
    boxOf,
    type FillKind,
    HL_OUTSET,
    type HighlightShape,
    planHighlights,
    wordPill,
  } from '$lib/mushaf/layout'
  import { library, player, reader, settings } from '$lib/stores'
  import { listenEvent } from '$lib/stores/app.svelte'

  let { data, qfs, boxes }: HighlightLayerProps = $props()

  const lh = $derived(qfs * LH)
  const blockW = $derived(qfs * TB_W)
  /** Rects are relative to `.mp-block`; the layer starts `HL_OUTSET` qfs to its left. */
  const offset = $derived(HL_OUTSET * qfs)

  // --- user marks of this page ------------------------------------------------------------------------------------

  /** The marks of the page they were loaded for (another page never shows them, even for a frame). */
  let marks = $state.raw<{ page: number; marks: UserMarks } | null>(null)
  /** Bumped by `user-data-changed` for highlights, so the page's marks are fetched again. */
  let marksVersion = $state(0)

  $effect(() =>
    listenEvent(events.userDataChanged, (e) => {
      if (e.kinds.includes('highlights')) marksVersion += 1
    }),
  )

  /**
   * The page's marks from the library store's cache (`marksFor`, WP11c), shared with `MarginMarks`; a store that keeps
   * no cache (it resolves null) leaves the command to answer directly.
   */
  async function loadMarks(layout: typeof data.layout, page: number, from: number, to: number) {
    const stored = await library.marksFor(layout, [page], from, to)
    return stored ?? (await call(api.userMarks(layout, from, to, [page])))
  }

  $effect(() => {
    const { layout, page } = data
    const { firstAyahId, lastAyahId } = data.info
    // Local library changes (optimistic, before the event) replace the highlight list; never depend on
    // `library.marks` itself, which `marksFor` may rewrite as it caches.
    void library.highlights
    void marksVersion
    let cancelled = false
    untrack(() => loadMarks(layout, page, firstAyahId, lastAyahId)).then(
      (m) => {
        if (!cancelled) marks = { page, marks: m }
      },
      (e: unknown) => console.debug('[qd] the page marks could not be loaded', e),
    )
    return () => {
      cancelled = true
    }
  })

  // --- states -------------------------------------------------------------------------------------------------------

  const hoverAyahId = $derived(settings.value.hoverHighlight ? (reader.hover?.ayahId ?? null) : null)
  const audioAyahId = $derived(player.isActive ? player.currentAyahId : null)

  /** The arrival flash after a jump, until `reader.flash.until`. */
  let flashAyahId = $state<number | null>(null)
  let flashMs = $state(0)
  $effect(() => {
    const flash = reader.flash
    const left = flash ? flash.until - Date.now() : 0
    if (!flash || left <= 0) {
      flashAyahId = null
      return
    }
    flashAyahId = flash.ayahId
    flashMs = left
    const timer = setTimeout(() => (flashAyahId = null), left)
    return () => clearTimeout(timer)
  })

  /** The roving item that has DOM focus (keyboard focus only): layer 7 rings its ayah. */
  let focusedAyahId = $state<number | null>(null)
  $effect(() => {
    const update = () => {
      const el = document.activeElement
      const li = el instanceof HTMLElement ? el.closest<HTMLElement>('.mp-a11y li[data-ayah]') : null
      const id = li && li.matches(':focus-visible') ? Number(li.dataset.ayah) : Number.NaN
      focusedAyahId = Number.isInteger(id) ? id : null
    }
    // On focusout the next element is not focused yet: look again once the focus has moved.
    const later = () => queueMicrotask(update)
    update()
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', later)
    return () => {
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', later)
    }
  })

  const plan = $derived(
    planHighlights(
      boxes,
      {
        user: marks?.page === data.page ? marks.marks.highlights : [],
        search: reader.searchHit,
        selection: reader.selection,
        hoverAyahId,
        audioAyahId,
        flashAyahId,
        cursorAyahId: focusedAyahId,
      },
      { qfs, lh, blockW },
    ),
  )

  /** Fade durations (§8.7): hover 120 ms, the audio ayah's 150 ms cross-fade; everything else is instant. */
  const FADE_MS: Partial<Record<FillKind, number>> = { hover: 120, audio: 150 }
  const fadeMs = (kind: HighlightShape['kind']): number =>
    settings.reducedMotion ? 0 : (FADE_MS[kind as FillKind] ?? 0)

  const classes = (s: HighlightShape) => ['hl', `hl-${s.kind}`, s.color && `hl-${s.color}`]

  // --- the audio word glide (§8.7 layer 6) ------------------------------------------------------------------------

  const activeWord = $derived(settings.value.wordHighlight && player.isActive ? player.activeWord : null)
  const wordBox: WordBox | undefined = $derived(activeWord ? boxOf(boxes, activeWord.wordId) : undefined)

  /** The pill, while a word is highlighted. Its box is written here, not by the template (one write per word). */
  let pill = $state<HTMLDivElement | null>(null)
  /** The box the pill is laid out at (layer px), and the line and box set it was measured in: a new line, page or
   * re-measure jumps instead of gliding. */
  let laid: GlideBox | null = null
  let glideLine = -1
  let glideBoxes: readonly WordBox[] | null = null
  let glide: Animation | null = null

  $effect(() => {
    const el = pill
    const box = wordBox
    const all = boxes
    const size = qfs
    const height = lh
    const dx = offset
    untrack(() => {
      if (!el || !box) {
        glide?.cancel()
        glide = null
        laid = null
        glideLine = -1
        return
      }
      const p = wordPill(box, size, height)
      const to: GlideBox = { x: p.x + dx, y: p.y, w: p.w, h: p.h }
      const glides =
        laid !== null &&
        box.line === glideLine &&
        all === glideBoxes &&
        !settings.reducedMotion &&
        typeof el.animate === 'function'
      // Mid-glide, the new glide starts where the pill is now.
      const from = glides && laid ? shownBox(el, laid, glide?.playState === 'running') : null
      glide?.cancel()
      glide = null
      el.style.transform = boxTransform(to)
      el.style.width = `${to.w}px`
      el.style.height = `${to.h}px`
      el.style.borderRadius = `${p.r}px`
      if (from && boxMoved(from, to)) {
        glide = el.animate([{ transform: flipFrom(from, to) }, { transform: flipTo(to) }], {
          duration: GLIDE_MS,
          easing: glideEasing(),
        })
      }
      laid = to
      glideLine = box.line
      glideBoxes = all
    })
  })
</script>

<div class="mp-hl" aria-hidden="true" data-page={data.page}>
  {#each plan.fills as s (s.key)}
    <div
      class={classes(s)}
      data-pulse={s.kind === 'search' ? '' : undefined}
      style:translate={`${s.x + offset}px ${s.y}px`}
      style:width={`${s.w}px`}
      style:height={`${s.h}px`}
      style:border-radius={`${s.r}px`}
      style:--hl-flash-ms={s.kind === 'flash' ? `${Math.round(flashMs)}ms` : undefined}
      transition:fade={{ duration: fadeMs(s.kind) }}
    ></div>
  {/each}
  {#if wordBox}
    <div bind:this={pill} class="hl hl-word" data-playing={player.isPlaying ? '' : undefined}></div>
  {/if}
  {#each plan.rings as s (s.key)}
    <div
      class={classes(s)}
      style:translate={`${s.x + offset}px ${s.y}px`}
      style:width={`${s.w}px`}
      style:height={`${s.h}px`}
      style:border-radius={`${s.r}px`}
    ></div>
  {/each}
  {#each plan.bars as s (s.key)}
    <div
      class={classes(s)}
      data-pulse={s.kind === 'search-bar' ? '' : undefined}
      style:translate={`${s.x + offset}px ${s.y}px`}
      style:width={`${s.w}px`}
      style:height={`${s.h}px`}
      style:border-radius={`${s.r}px`}
    ></div>
  {/each}
</div>
