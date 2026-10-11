<!--
  Test fixture (WP7b): every resting primitive on one sheet, for the visual review of themes, accents and RTL
  (`gallery.browser.test.ts`). Not part of the app; nothing outside `src/components/ui/**/*.test.ts` imports it.
-->
<script lang="ts">
  import BookOpen from '@lucide/svelte/icons/book-open'
  import Bookmark from '@lucide/svelte/icons/bookmark'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import Copy from '@lucide/svelte/icons/copy'
  import Download from '@lucide/svelte/icons/download'
  import LayoutGrid from '@lucide/svelte/icons/layout-grid'
  import List from '@lucide/svelte/icons/list'
  import Play from '@lucide/svelte/icons/play'
  import Repeat from '@lucide/svelte/icons/repeat'
  import Settings from '@lucide/svelte/icons/settings'
  import {
    Badge,
    Button,
    Card,
    EmptyState,
    Field,
    IconButton,
    Kbd,
    Progress,
    ScrollArea,
    SearchInput,
    Segmented,
    Select,
    Skeleton,
    Slider,
    Switch,
    Tabs,
    TextInput,
  } from '../index'

  interface Props {
    arabic?: boolean
  }

  let { arabic = false }: Props = $props()

  const t = (en: string, ar: string) => (arabic ? ar : en)
  const digits = (n: number, fraction = 0) =>
    new Intl.NumberFormat(arabic ? 'ar-u-nu-arab' : 'en-US', { maximumFractionDigits: fraction }).format(n)

  let scope = $state('quran')
  let view = $state('grid')
  let tab = $state('translation')
  let follow = $state(true)
  let offline = $state(false)
  let speed = $state(125)
  let ink = $state(88)
  let query = $state('الرحمن')
  let note = $state('')
  let reciter = $state('afasy')
  let translation = $state('')

  const reciters = [
    { value: 'afasy', label: 'Mishary Alafasy', hint: 'مشاري العفاسي', hintLang: 'ar' },
    { value: 'husary', label: 'Mahmoud Khalil Al-Husary', hint: 'محمود خليل الحصري', hintLang: 'ar' },
    { value: 'minshawi', label: 'Mohamed Siddiq Al-Minshawi', hint: 'محمد صديق المنشاوي', hintLang: 'ar' },
  ]
  const translations = [
    { value: 'sahih', label: 'Saheeh International', hint: '0.5 MB', group: 'English' },
    { value: 'hilali', label: 'Hilali & Khan', hint: '0.7 MB', group: 'English' },
    { value: 'muyassar', label: 'التفسير الميسر', hint: '1.2 MB', group: 'العربية' },
  ]
</script>

<div class="gallery" lang={arabic ? 'ar' : 'en'} dir={arabic ? 'rtl' : 'ltr'}>
  <section class="col">
    <h3>{t('Buttons', 'الأزرار')}</h3>
    <div class="row">
      <Button variant="primary">{t('Download', 'تنزيل')}</Button>
      <Button>{t('Cancel', 'إلغاء')}</Button>
      <Button variant="ghost">{t('Skip', 'تخطٍّ')}</Button>
      <Button variant="danger">{t('Delete', 'حذف')}</Button>
      <Button variant="link">{t('Undo', 'تراجع')}</Button>
    </div>
    <div class="row">
      <Button variant="primary" size="sm">
        {#snippet icon()}<Play />{/snippet}
        {t('Play', 'تشغيل')}
      </Button>
      <Button size="sm">
        {#snippet icon()}<Copy />{/snippet}
        {t('Copy', 'نسخ')}
      </Button>
      <Button variant="primary" size="lg">
        {t('Start reading', 'ابدأ القراءة')}
        {#snippet iconEnd()}<ChevronRight class="icon-dir" />{/snippet}
      </Button>
    </div>
    <div class="row">
      <Button variant="primary" loading>{t('Download', 'تنزيل')}</Button>
      <Button loading>{t('Saving', 'حفظ')}</Button>
      <Button disabled>{t('Disabled', 'معطّل')}</Button>
      <Button variant="primary" disabled>{t('Install', 'تثبيت')}</Button>
    </div>
    <div class="row">
      <IconButton label={t('Bookmark', 'علامة')} icon={Bookmark} />
      <IconButton label={t('Repeat', 'تكرار')} icon={Repeat} pressed />
      <IconButton label={t('Settings', 'الإعدادات')} icon={Settings} variant="secondary" />
      <IconButton label={t('Play', 'تشغيل')} icon={Play} variant="primary" />
      <IconButton label={t('Next', 'التالي')} icon={ChevronRight} mirror size="sm" />
      <IconButton label={t('Download', 'تنزيل')} icon={Download} size="lg" />
    </div>

    <h3>{t('Choices', 'الاختيارات')}</h3>
    <div class="row">
      <Segmented
        label={t('Scope', 'النطاق')}
        bind:value={scope}
        options={[
          { value: 'quran', label: t('Quran', 'القرآن') },
          { value: 'translation', label: t('Translation', 'الترجمة') },
          { value: 'notes', label: t('Notes', 'الملاحظات') },
        ]}
      />
      <Segmented
        label={t('View', 'العرض')}
        size="sm"
        bind:value={view}
        options={[
          { value: 'list', label: t('List', 'قائمة'), icon: List, iconOnly: true },
          { value: 'grid', label: t('Grid', 'شبكة'), icon: LayoutGrid, iconOnly: true },
        ]}
      />
    </div>
    <Switch
      label={t('Follow the recitation', 'متابعة التلاوة')}
      description={t('Turn pages with the reciter', 'تقليب الصفحات مع القارئ')}
      bind:checked={follow}
    />
    <Switch label={t('Work offline', 'العمل دون اتصال')} bind:checked={offline} />
    <Tabs
      label={t('Side pane', 'اللوحة الجانبية')}
      bind:value={tab}
      fill
      tabs={[
        { value: 'translation', label: t('Translation', 'الترجمة') },
        { value: 'tafsir', label: t('Tafsir', 'التفسير') },
        { value: 'notes', label: t('Notes', 'الملاحظات'), badge: 3 },
        { value: 'words', label: t('Words', 'الكلمات') },
      ]}
    >
      {#snippet panel(value)}
        <p class="panel">{value}</p>
      {/snippet}
    </Tabs>

    <h3>{t('Sliders', 'المنزلقات')}</h3>
    <Slider
      label={t('Speed', 'السرعة')}
      bind:value={speed}
      min={50}
      max={200}
      step={5}
      ticks={[75, 100, 125, 150, 200]}
      format={(v) => `${digits(v / 100, 2)}×`}
    />
    <Slider
      label={t('Ink brightness', 'سطوع الحبر')}
      bind:value={ink}
      min={65}
      max={100}
      format={(v) => `${digits(v)}%`}
    />
  </section>

  <section class="col">
    <h3>{t('Fields', 'الحقول')}</h3>
    <SearchInput bind:value={query} />
    <SearchInput value="" shortcut="Ctrl+F" placeholder={t('Search the Quran', 'ابحث في القرآن')} />
    <Field
      label={t('Note title', 'عنوان الملاحظة')}
      hint={t('Shown in the notes list', 'يظهر في قائمة الملاحظات')}
    >
      {#snippet children(c)}
        <TextInput id={c.id} aria-describedby={c.describedBy} bind:value={note} placeholder="…" />
      {/snippet}
    </Field>
    <Field label={t('Collection', 'المجموعة')} error={t('A name is required', 'الاسم مطلوب')} required>
      {#snippet children(c)}
        <TextInput id={c.id} aria-describedby={c.describedBy} invalid={c.invalid} value="" />
      {/snippet}
    </Field>
    <Field label={t('Reciter', 'القارئ')}>
      {#snippet children(c)}
        <Select id={c.id} items={reciters} bind:value={reciter} fullWidth />
      {/snippet}
    </Field>
    <div class="row">
      <Select
        label={t('Translation', 'الترجمة')}
        items={translations}
        bind:value={translation}
        placeholder={t('Choose a translation', 'اختر ترجمة')}
        size="sm"
      />
      <Select label={t('Reciter', 'القارئ')} items={reciters} value="husary" searchable size="sm" />
    </div>

    <h3>{t('Status', 'الحالة')}</h3>
    <div class="row">
      <Badge>{t('Queued', 'في الانتظار')}</Badge>
      <Badge tone="accent">{t('Word timing', 'توقيت الكلمات')}</Badge>
      <Badge tone="success">{t('Installed', 'مثبّت')}</Badge>
      <Badge tone="warning">{t('Update', 'تحديث')}</Badge>
      <Badge tone="danger">{t('Failed', 'فشل')}</Badge>
      <Badge size="sm">2/3</Badge>
    </div>
    <div class="row">
      <Kbd chord="Ctrl+K" />
      <Kbd chord="Ctrl+Shift+C" />
      <Kbd chord="⌘⇧K" />
      <Kbd keys={['Space']} />
      <Kbd chord="Shift+B" size="sm" />
    </div>
    <div class="stack">
      <Progress value={42} label={t('Downloading', 'جارٍ التنزيل')} />
      <Progress indeterminate label={t('Preparing', 'جارٍ التحضير')} />
      <Progress value={100} tone="success" label={t('Done', 'تم')} />
    </div>
    <div class="row">
      <Progress variant="ring" value={30} label="30%" />
      <Progress variant="ring" size={24} value={75} label="75%" />
      <Progress variant="ring" size={24} indeterminate label={t('Buffering', 'تخزين مؤقت')} />
    </div>
    <div class="stack skeletons">
      <Skeleton w="70%" />
      <Skeleton w="92%" />
      <Skeleton w="54%" />
      <Skeleton w={48} h={48} radius="full" />
    </div>
  </section>

  <section class="col">
    <h3>{t('Surfaces', 'الأسطح')}</h3>
    <Card>
      <p class="card-title">{t('Continue reading', 'متابعة القراءة')}</p>
      <p class="card-body">{t('Al-Kahf · p 297 · 3 days ago', 'الكهف · ص ٢٩٧ · قبل ٣ أيام')}</p>
    </Card>
    <div class="row cards">
      <Card interactive selected padding="sm" label={t('Paper', 'ورقي')}>
        <span class="swatch paper"></span>
        {t('Paper', 'ورقي')}
      </Card>
      <Card interactive padding="sm" label={t('Night', 'ليلي')}>
        <span class="swatch night"></span>
        {t('Night', 'ليلي')}
      </Card>
    </div>
    <div class="empty-box">
      <EmptyState
        title={t('No bookmarks yet', 'لا توجد علامات بعد')}
        body={t('Press B on any ayah to bookmark it.', 'اضغط B على أي آية لوضع علامة عليها.')}
        kbd="B"
        compact
      >
        {#snippet action()}
          <Button size="sm">
            {#snippet icon()}<BookOpen />{/snippet}
            {t('Open the index', 'افتح الفهرس')}
          </Button>
        {/snippet}
      </EmptyState>
    </div>
    <div class="scroll-box">
      <ScrollArea type="always">
        <ol class="lines">
          {#each { length: 24 } as _, i (i)}
            <li>{t('Row', 'صف')} {i + 1}</li>
          {/each}
        </ol>
      </ScrollArea>
    </div>
  </section>
</div>

<style>
  .gallery {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-6);
    padding: var(--space-6);
    background-color: var(--surface-app);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: var(--text-md);
  }

  .col {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-inline-size: 0;
    padding: var(--space-4);
    border-radius: var(--radius-lg);
    background-color: var(--surface-page);
  }

  h3 {
    margin-block-start: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-title);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .skeletons {
    gap: var(--space-2);
  }

  .panel {
    padding-block: var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .card-title {
    font-weight: var(--weight-title);
  }

  .card-body {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .cards > :global(*) {
    flex: 1 1 0;
  }

  .swatch {
    display: block;
    block-size: 40px;
    margin-block-end: var(--space-2);
    border-radius: var(--radius-sm);
  }

  .paper {
    background-color: #fdf8ec;
    box-shadow: inset 0 0 0 1px var(--border);
  }

  .night {
    background-color: #1a1c1f;
  }

  .empty-box {
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-md);
  }

  .scroll-box {
    block-size: 120px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .scroll-box :global(.scroll-area) {
    block-size: 100%;
  }

  .lines {
    margin: 0;
    padding-block: var(--space-2);
    padding-inline: var(--space-4);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
</style>
