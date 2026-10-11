<!--
  Test fixture (WP7b): the §10.3 ayah menu rows in a dropdown `Menu` (opened from a button) or a programmatic
  `ContextMenu` (opened at a point, like `ui.contextMenu`). Every command reports through `onAction(id)`.
-->
<script lang="ts">
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import Copy from '@lucide/svelte/icons/copy'
  import Play from '@lucide/svelte/icons/play'
  import { Button, ContextMenu, Menu, type MenuEntry, type Point } from '../index'

  interface Props {
    mode?: 'menu' | 'context'
    onAction: (id: string) => void
    /** Context mode: where to open (null = closed). */
    at?: Point | null
    onClose?: () => void
  }

  let { mode = 'menu', onAction, at = null, onClose }: Props = $props()

  let follow = $state(false)
  let color = $state('yellow')

  const items: MenuEntry[] = $derived([
    { id: 'play', label: 'Play from here', icon: Play, kbd: 'Ctrl+Click', onSelect: () => onAction('play') },
    {
      type: 'submenu',
      id: 'repeat',
      label: 'Repeat',
      items: [
        { id: 'repeat-3', label: 'This ayah ×3', onSelect: () => onAction('repeat-3') },
        { id: 'repeat-5', label: 'This ayah ×5', onSelect: () => onAction('repeat-5') },
      ],
    },
    { type: 'separator' },
    { id: 'bookmark', label: 'Bookmark', icon: Bookmark, kbd: 'B', onSelect: () => onAction('bookmark') },
    {
      type: 'radio',
      id: 'highlight',
      label: 'Highlight',
      value: color,
      onValueChange: (v) => {
        color = v
        onAction(`highlight-${v}`)
      },
      options: [
        { value: 'yellow', label: 'Yellow', swatch: 'var(--user-hl-yellow-solid)' },
        { value: 'green', label: 'Green', swatch: 'var(--user-hl-green-solid)' },
      ],
    },
    {
      type: 'checkbox',
      id: 'follow',
      label: 'Follow recitation',
      checked: follow,
      onCheckedChange: (v) => {
        follow = v
        onAction(`follow-${v}`)
      },
    },
    { id: 'copy', label: 'Copy', icon: Copy, kbd: 'C', onSelect: () => onAction('copy') },
    { id: 'disabled', label: 'Can not do this', disabled: true, onSelect: () => onAction('disabled') },
  ])
</script>

<button type="button" id="before">Before</button>

{#if mode === 'menu'}
  <Menu {items} label="Ayah actions">
    {#snippet trigger({ props })}
      <Button {...props} id="trigger">Actions</Button>
    {/snippet}
  </Menu>
{:else}
  <ContextMenu {items} {at} {onClose} label="Ayah 2:255" />
{/if}
