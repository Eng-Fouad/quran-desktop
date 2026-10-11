import type { Dict } from '$lib/contracts/i18n'

/** `search` messages, Arabic (§11.1). Owner: WP10b. Same keys as `../en/search.ts`; plurals define all six categories. */
export const search = {
  field: {
    quran: 'ابحث في القرآن',
    translation: 'ابحث في الترجمة',
    notes: 'ابحث في ملاحظاتك',
  },
  scope: {
    label: 'البحث في',
    quran: 'القرآن',
    translation: 'الترجمة',
    notes: 'الملاحظات',
    pack: 'الترجمة التي يُبحث فيها',
  },
  mode: {
    label: 'المطابقة',
    smart: 'ذكي',
    exact: 'حروف مطابقة',
    substring: 'يحتوي',
    smartHint: 'يتجاهل الحركات واختلاف الرسم، ويُكمل الكلمة الأخيرة، ويصحّح الأخطاء الصغيرة',
    exactHint: 'كلمات كاملة، والهمزة والتاء المربوطة كما كُتبتا',
    substringHint: 'الحروف في أي موضع، ولو امتدت عبر الكلمات',
  },
  filter: {
    label: 'تضييق البحث',
    everywhere: 'كل السور',
    surahs: 'السور',
    juz: 'الأجزاء',
    juzItem: 'الجزء {juz}',
    both: '{surah}{sep}{juz}',
    none: 'لا سورة ولا جزء يطابق',
    clear: 'البحث في كل السور',
    onlyThis: 'في {name} فقط',
  },
  summary: {
    results: {
      zero: 'لا نتائج',
      one: 'نتيجة واحدة',
      two: 'نتيجتان',
      few: '{count} نتائج',
      many: '{count} نتيجة',
      other: '{count} نتيجة',
    },
    inSurahs: {
      zero: 'في {count} سورة',
      one: 'في سورة واحدة',
      two: 'في سورتين',
      few: 'في {count} سور',
      many: 'في {count} سورة',
      other: 'في {count} سورة',
    },
    searching: 'جارٍ البحث…',
  },
  typo: {
    showing: 'تُعرض نتائج {terms}',
    noExact: 'لا مطابقة تامة لـ{query}',
  },
  truncated: {
    showing: 'تُعرض {shown} من {total}',
    filter: 'تصفية حسب السورة',
  },
  empty: {
    title: 'ابحث في القرآن',
    body: 'بالعربية مع الحركات أو دونها، أو بكلمة من ترجمة، أو بمرجع مثل {ref}.',
    recent: 'عمليات البحث الأخيرة',
    clearRecent: 'مسح',
    examples: 'جرّب',
    reference: 'مرجع',
    again: 'إعادة البحث عن {query} في {scope}',
  },
  none: {
    title: 'لا نتائج لـ«{query}»',
    bodyQuran: 'جرّب الوضع الذكي أو رسمًا آخر للكلمة، أو ابحث في الترجمات.',
    bodyTranslation: 'جرّب كلمة أخرى أو الوضع الذكي، أو ابحث في نص القرآن.',
    bodyNotes: 'جرّب كلمة أخرى أو الوضع الذكي، أو ابحث في نص القرآن.',
    bodyQuranSmart: 'جرّب رسمًا آخر للكلمة، أو ابحث في الترجمات.',
    bodyTranslationSmart: 'جرّب كلمة أخرى، أو ابحث في نص القرآن.',
    bodyNotesSmart: 'جرّب كلمة أخرى، أو ابحث في نص القرآن.',
    trySmart: 'استخدام الوضع الذكي',
    translations: 'البحث في الترجمات',
    quran: 'البحث في نص القرآن',
    everywhere: 'البحث في كل السور',
  },
  noPack: {
    title: 'ابحث في ترجمة',
    body: 'ثبّت ترجمة لتبحث في نصها.',
    offline: 'تُنزَّل الترجمات عند الاتصال بالإنترنت.',
    listLabel: 'ترجمات للتثبيت',
    downloading: 'جارٍ التنزيل',
    more: 'مزيد من الترجمات',
  },
  failed: {
    title: 'تعذّر البحث',
  },
  jump: {
    goTo: 'الانتقال إلى {target}',
  },
  complete: {
    label: 'إكمال الكلمة',
    chip: '{term}، {ayahs}',
  },
  results: {
    label: 'نتائج البحث',
  },
  group: {
    label: '{name}، {results}',
  },
  hit: {
    page: 'ص {page}',
    label: '{ref}، صفحة {page}',
    note: 'ملاحظة',
    more: {
      zero: '+{count} في هذه الآية',
      one: '+{count} أخرى في هذه الآية',
      two: '+{count} أخريان في هذه الآية',
      few: '+{count} أخرى في هذه الآية',
      many: '+{count} أخرى في هذه الآية',
      other: '+{count} أخرى في هذه الآية',
    },
    moreShort: '+{count}',
  },
  menu: {
    label: 'النتيجة {ref}',
    openPane: 'فتح في اللوحة الجانبية',
    bookmark: 'إضافة علامة',
    unbookmark: 'إزالة العلامة',
  },
  announce: {
    hit: 'النتيجة {n} من {total}: {ref}',
  },
} satisfies Dict['search']
