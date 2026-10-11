import type { Dict } from '$lib/contracts/i18n'

/** `content` messages, Arabic (§11.1). Owner: WP11a. Same keys as `../en/content.ts`; plurals define all six categories. */
export const content = {
  sep: '، ',
  view: {
    label: 'الآيات مع الترجمة',
    loading: 'جارٍ تحميل الآيات…',
  },
  surah: {
    heading: 'سورة {name}، رقم {number}',
    pageShort: 'ص {page}',
    basmala: 'البسملة',
  },
  verse: {
    bookmarked: 'عليها علامة مرجعية',
    noted: 'عليها ملاحظة',
    highlighted: 'مظلّلة باللون {color}',
    playing: 'تُتلى الآن',
    loadError: 'تعذّر تحميل هذه الآية',
    translationError: 'تعذّر تحميل الترجمة',
  },
  actions: {
    label: 'إجراءات الآية {ref}',
    play: 'التلاوة من هنا',
    bookmark: 'إضافة علامة مرجعية',
    unbookmark: 'إزالة العلامة المرجعية',
    highlight: 'تظليل',
    note: 'إضافة ملاحظة',
    editNote: 'تعديل الملاحظة',
    copy: 'نسخ',
    study: 'التفسير ومعاني الكلمات',
    more: 'إجراءات أخرى',
    copied: 'نُسخت الآية {ref}',
  },
  highlight: {
    label: 'لون التظليل',
    yellow: 'الأصفر',
    green: 'الأخضر',
    blue: 'الأزرق',
    red: 'الأحمر',
    purple: 'البنفسجي',
    remove: 'إزالة التظليل',
  },
  footnote: {
    marker: 'الحاشية {marker}',
    title: 'الحاشية {marker}',
    note: 'تعليق المترجم',
    notes: 'الحواشي',
    missing: 'لم ترد هذه الحاشية في الترجمة.',
  },
  empty: {
    title: 'أضف ترجمة',
    body: 'اقرأ معنى كل آية بجانب النص العربي.',
    offline: 'تُنزَّل الترجمات عند الاتصال بالإنترنت',
    listLabel: 'ترجمات يمكن إضافتها',
    meta: '{language}، {size}',
    use: 'عرض',
    installed: 'مثبّتة',
    downloading: 'جارٍ التنزيل… {percent}',
    failed: 'تعذّر التنزيل',
    more: 'مزيد من الترجمات',
    mushaf: 'العودة إلى المصحف',
  },
  notice: {
    missing: 'لم تُنزَّل ترجمة {name}',
    downloading: 'جارٍ تنزيل {name}، {percent}',
    broken: 'تعذّر فتح ترجمة {name}',
    hide: 'إخفاء',
  },
  follow: {
    back: 'العودة إلى موضع التلاوة',
  },
} satisfies Dict['content']
