<!--
  Test fixture (WP7b): one floating or modal primitive shown open over a small page, for the visual review
  (`gallery.browser.test.ts`). Not part of the app.
-->
<script lang="ts">
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import Copy from '@lucide/svelte/icons/copy'
  import NotebookPen from '@lucide/svelte/icons/notebook-pen'
  import Play from '@lucide/svelte/icons/play'
  import Repeat from '@lucide/svelte/icons/repeat'
  import Search from '@lucide/svelte/icons/search'
  import { untrack } from 'svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import {
    Button,
    ContextMenu,
    Dialog,
    IconButton,
    Menu,
    Popover,
    Select,
    Sheet,
    Slider,
    Toaster,
    Tooltip,
    type MenuEntry,
  } from '../index'

  type Layer =
    'menu' | 'context' | 'select' | 'combobox' | 'dialog' | 'sheet' | 'popover' | 'tooltip' | 'toast'

  interface Props {
    show: Layer
    arabic?: boolean
  }

  let { show, arabic = false }: Props = $props()

  const t = (en: string, ar: string) => (arabic ? ar : en)

  // These fixtures open once, as rendered: the test toggles `show` by remounting.
  // svelte-ignore state_referenced_locally
  let open = $state(show !== 'toast')
  let speed = $state(125)
  let value = $state('afasy')
  let highlight = $state('yellow')
  let follow = $state(true)

  const reciters = [
    { value: 'afasy', label: 'Mishary Alafasy', hint: 'مشاري العفاسي', hintLang: 'ar' },
    { value: 'husary', label: 'Mahmoud Khalil Al-Husary', hint: 'محمود خليل الحصري', hintLang: 'ar' },
    { value: 'minshawi', label: 'Mohamed Siddiq Al-Minshawi', hint: 'محمد صديق المنشاوي', hintLang: 'ar' },
    { value: 'sudais', label: 'Abdurrahman As-Sudais', hint: 'عبد الرحمن السديس', hintLang: 'ar' },
  ]

  const items: MenuEntry[] = $derived([
    {
      id: 'play',
      label: t('Play from here', 'التشغيل من هنا'),
      icon: Play,
      kbd: 'Ctrl+Click',
      onSelect: () => {},
    },
    {
      type: 'submenu',
      id: 'repeat',
      label: t('Repeat', 'تكرار'),
      icon: Repeat,
      items: [
        { id: 'r3', label: t('This ayah ×3', 'هذه الآية ×٣'), onSelect: () => {} },
        { id: 'r5', label: t('This ayah ×5', 'هذه الآية ×٥'), onSelect: () => {} },
      ],
    },
    { type: 'separator' },
    { id: 'bookmark', label: t('Bookmark', 'إضافة علامة'), icon: Bookmark, kbd: 'B', onSelect: () => {} },
    {
      type: 'radio',
      id: 'highlight',
      label: t('Highlight', 'تظليل'),
      value: highlight,
      onValueChange: (v) => (highlight = v),
      options: [
        { value: 'yellow', label: t('Yellow', 'أصفر'), swatch: 'var(--user-hl-yellow-solid)', kbd: '1' },
        { value: 'green', label: t('Green', 'أخضر'), swatch: 'var(--user-hl-green-solid)', kbd: '2' },
        { value: 'blue', label: t('Blue', 'أزرق'), swatch: 'var(--user-hl-blue-solid)', kbd: '3' },
      ],
    },
    { id: 'note', label: t('Add note…', 'إضافة ملاحظة…'), icon: NotebookPen, kbd: 'N', onSelect: () => {} },
    { type: 'separator' },
    {
      type: 'checkbox',
      id: 'follow',
      label: t('Follow recitation', 'متابعة التلاوة'),
      checked: follow,
      onCheckedChange: (v) => (follow = v),
    },
    { id: 'copy', label: t('Copy', 'نسخ'), icon: Copy, kbd: 'C', onSelect: () => {} },
    {
      id: 'remove',
      label: t('Remove highlight', 'إزالة التظليل'),
      danger: true,
      kbd: '0',
      onSelect: () => {},
    },
  ])

  $effect(() => {
    if (show !== 'toast') return
    // `ui.toast` reads the toast list it appends to: untracked, so this runs once.
    untrack(() => showToasts())
  })

  function showToasts(): void {
    ui.toast({
      message: t('Highlighted 2:255 yellow', 'ظُلّلت ٢:٢٥٥ بالأصفر'),
      action: { label: t('Undo', 'تراجع'), run: () => {} },
    })
    ui.toast({
      message: t('Downloaded Al-Kahf', 'تم تنزيل الكهف'),
      description: t('Mishary Alafasy · 12.4 MB', 'مشاري العفاسي · ١٢٫٤ م.ب'),
      tone: 'success',
    })
  }
</script>

<div class="page" lang={arabic ? 'ar' : 'en'} dir={arabic ? 'rtl' : 'ltr'}>
  <p class="text">
    {t(
      'Allah — there is no deity except Him, the Ever-Living, the Sustainer of existence. Neither drowsiness overtakes Him nor sleep.',
      'اللَّهُ لا إله إلا هو الحي القيوم، لا تأخذه سنة ولا نوم، له ما في السماوات وما في الأرض.',
    )}
  </p>

  <div class="anchor">
    {#if show === 'menu'}
      <Menu {items} bind:open>
        {#snippet trigger({ props })}
          <Button {...props}>{t('Actions', 'الإجراءات')}</Button>
        {/snippet}
      </Menu>
    {:else if show === 'context'}
      <ContextMenu
        {items}
        at={open ? { x: arabic ? 760 : 220, y: 150 } : null}
        onClose={() => (open = false)}
        label="2:255"
      />
    {:else if show === 'select'}
      <Select items={reciters} bind:value bind:open label={t('Reciter', 'القارئ')} />
    {:else if show === 'combobox'}
      <Select
        items={reciters}
        bind:value
        bind:open
        searchable
        label={t('Reciter', 'القارئ')}
        emptyText={t('No matches', 'لا نتائج')}
      />
    {:else if show === 'popover'}
      <Popover bind:open arrow label={t('Speed', 'السرعة')} width={280}>
        {#snippet trigger({ props })}
          <Button {...props} size="sm">1.25×</Button>
        {/snippet}
        <div class="speed">
          <p class="speed-title">{t('Playback speed', 'سرعة التشغيل')}</p>
          <Slider
            label={t('Speed', 'السرعة')}
            bind:value={speed}
            min={50}
            max={200}
            step={5}
            ticks={[75, 100, 125, 150, 200]}
            format={(v) => `${v / 100}×`}
          />
          <p class="speed-note">{t('Pitch is preserved.', 'تبقى طبقة الصوت كما هي.')}</p>
        </div>
      </Popover>
    {:else if show === 'tooltip'}
      <Tooltip content={t('Search', 'بحث')} kbd="Ctrl+K" bind:open side="bottom">
        {#snippet children({ props })}
          <button {...props} class="plain" aria-label={t('Search', 'بحث')}><Search size={20} /></button>
        {/snippet}
      </Tooltip>
      <IconButton label={t('Bookmark', 'علامة')} icon={Bookmark} />
    {:else if show === 'dialog'}
      <Dialog
        bind:open
        title={t('Delete this note?', 'حذف هذه الملاحظة؟')}
        description={t('It moves to the trash for 30 days.', 'تنتقل إلى المهملات لمدة ٣٠ يومًا.')}
        size="sm"
      >
        <p class="body">
          {t(
            'Notes on 2:255 — “Ayat al-Kursi” — will no longer show in the margin.',
            'لن تظهر ملاحظات ٢:٢٥٥ في الهامش بعد الآن.',
          )}
        </p>
        {#snippet footer()}
          <Button onclick={() => (open = false)}>{t('Cancel', 'إلغاء')}</Button>
          <Button variant="danger" onclick={() => (open = false)}>{t('Delete', 'حذف')}</Button>
        {/snippet}
      </Dialog>
    {:else if show === 'sheet'}
      <Sheet bind:open title={t('Al-Baqarah 2:255', 'البقرة ٢:٢٥٥')} width={380}>
        <p class="body">
          {t(
            'Allah — there is no deity except Him, the Ever-Living, the Sustainer of [all] existence.',
            'اللَّهُ لا إله إلا هو الحي القيوم.',
          )}
        </p>
        {#snippet footer()}
          <Button variant="primary" size="sm">{t('Open in reader', 'افتح في القارئ')}</Button>
        {/snippet}
      </Sheet>
    {/if}
  </div>
  {#if show === 'toast'}
    <Toaster label={t('Notifications', 'الإشعارات')} offset={24} />
  {/if}
</div>

<style>
  .page {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    block-size: 560px;
    padding: var(--space-6);
    background-color: var(--surface-app);
    color: var(--text);
    font-family: var(--font-ui);
  }

  .text {
    max-inline-size: 60ch;
    color: var(--text-muted);
    line-height: var(--leading-reading);
  }

  .anchor {
    display: flex;
    gap: var(--space-2);
  }

  .plain {
    display: grid;
    place-items: center;
    inline-size: 32px;
    block-size: 32px;
    border: 1px solid var(--border-input);
    border-radius: var(--radius-sm);
    background: var(--surface-raised);
    color: var(--text);
  }

  .speed {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .speed-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-title);
  }

  .speed-note {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .body {
    color: var(--text);
    line-height: var(--leading-ui);
  }
</style>
