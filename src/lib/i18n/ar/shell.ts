import type { Dict } from '$lib/contracts/i18n'

/** `shell` messages, Arabic. Same keys as `../en/shell.ts`; plurals define all six categories. */
export const shell = {
  skipToText: 'تخطَّ إلى نص القرآن',
  landmarks: {
    sections: 'الأقسام',
    player: 'مشغّل التلاوة',
    sidePane: 'لوحة الدراسة',
    toasts: 'الإشعارات',
  },
  tabs: {
    index: 'الفهرس',
    search: 'البحث',
    bookmarks: 'العلامات',
    highlights: 'التظليلات',
    notes: 'الملاحظات',
    history: 'السجل',
    memorize: 'الحفظ',
  },
  views: {
    reader: 'القراءة',
    downloads: 'التنزيلات',
    settings: 'الإعدادات',
    about: 'حول التطبيق',
  },
  rail: {
    downloadsActive: {
      zero: 'لا تنزيلات جارية',
      one: 'تنزيل واحد جارٍ',
      two: 'تنزيلان جاريان',
      few: '{count} تنزيلات جارية',
      many: '{count} تنزيلًا جاريًا',
      other: '{count} تنزيل جارٍ',
    },
    downloadsWaiting: {
      zero: 'لا تنزيلات بانتظار الاتصال',
      one: 'تنزيل واحد بانتظار الاتصال',
      two: 'تنزيلان بانتظار الاتصال',
      few: '{count} تنزيلات بانتظار الاتصال',
      many: '{count} تنزيلًا بانتظار الاتصال',
      other: '{count} تنزيل بانتظار الاتصال',
    },
    downloadsFailed: {
      zero: 'لم يتعذّر أي تنزيل',
      one: 'تعذّر تنزيل واحد',
      two: 'تعذّر تنزيلان',
      few: 'تعذّرت {count} تنزيلات',
      many: 'تعذّر {count} تنزيلًا',
      other: 'تعذّر {count} تنزيل',
    },
  },
  titleBar: {
    search: 'ابحث أو انتقل إلى…',
    location: 'الموضع',
    pages: 'ص {from}–{to}',
    goTo: 'انتقال إلى…',
    backToReading: 'العودة إلى القراءة',
  },
  window: {
    minimize: 'تصغير',
    maximize: 'تكبير',
    restore: 'استعادة الحجم',
    close: 'إغلاق',
  },
  sidebar: {
    hide: 'إخفاء الشريط الجانبي',
    resize: 'تغيير عرض الشريط الجانبي',
  },
  sidePane: {
    resize: 'تغيير عرض لوحة الدراسة',
  },
  offline: {
    badge: 'غير متصل',
    networkOff: 'وضع عدم الاتصال',
    unreachable: 'لا يوجد اتصال بالإنترنت. كل ما نزّلته يعمل كما هو.',
    disallowed: 'استخدام الشبكة متوقف. تنتظر التنزيلات والبث حتى تسمح بها من الإعدادات.',
  },
  zen: {
    hint: 'وضع التركيز · اضغط {key} للخروج',
  },
  banner: {
    userDbRecovered: 'تعذّر فتح مكتبتك، واحتُفظ بنسخة منها.',
    keptAs: 'حُفظت باسم {file}',
    restore: 'الاستعادة من نسخة احتياطية…',
    showFiles: 'إظهار الملفات…',
  },
  fatal: {
    coreMissingTitle: 'بيانات القرآن الأساسية مفقودة (نسخة التطوير)',
    coreMissingBody: 'أنشئ قاعدة بيانات القرآن بالأمر {command} ثم شغّل التطبيق من جديد.',
    browserTitle: 'شغّل تطبيق قرآن داخل Tauri',
    browserBody: 'هذه معاينة لنسخة الإنتاج في المتصفح، ولا خادم خلفها. شغّل التطبيق بالأمر {command}.',
    genericTitle: 'تعذّر بدء تطبيق قرآن',
    tryAgain: 'إعادة المحاولة',
    quit: 'إنهاء',
    copyDetails: 'نسخ التفاصيل',
  },
  shortcutSheet: {
    description: 'تعمل الاختصارات في كل مكان إلا أثناء الكتابة في حقل.',
    filter: 'تصفية الاختصارات',
    noMatches: 'لا يوجد اختصار يطابق «{query}».',
    footer: 'اضغط {key} في أي وقت لفتح هذه القائمة.',
  },
  shortcutTable: {
    action: 'الإجراء',
    keys: 'المفاتيح',
    empty: 'لا توجد اختصارات في هذه المجموعة بعد.',
  },
} satisfies Dict['shell']
