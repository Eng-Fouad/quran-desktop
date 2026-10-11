import type { Dict } from '$lib/contracts/i18n'

/** `palette` messages, Arabic (§11.1). Owner: WP10c. Same keys as `../en/palette.ts`; plurals define all six categories. */
export const palette = {
  title: 'لوحة الأوامر',
  description: 'انتقل إلى موضع أو سورة، أو نفّذ أمرًا، أو غيّر إعدادًا، أو اختر قارئًا.',
  placeholder: 'انتقل إلى {ref} أو سورة مثل {surah} أو اكتب أمرًا…',
  placeholderScope: {
    commands: 'ابحث في الأوامر والإعدادات…',
    surahs: 'اسم السورة أو رقمها…',
    reciters: 'ابحث عن قارئ…',
  },
  inputLabel: 'ابحث في اللوحة',
  listLabel: 'النتائج',
  groups: {
    goto: 'انتقال',
    surahs: 'السور',
    commands: 'الأوامر',
    settings: 'الإعدادات',
    reciters: 'القرّاء',
    recent: 'الأخيرة',
    search: 'البحث',
  },
  scope: {
    menuLabel: 'البحث في',
    chipLabel: 'البحث في: {scope}',
    all: 'الكل',
    commands: 'الأوامر',
    surahs: 'السور',
    reciters: 'القرّاء',
  },
  empty: {
    title: 'لا نتائج.',
    try: 'جرّب',
  },
  pageShort: 'ص {page}',
  juzShort: 'ج {juz}',
  hints: {
    choose: 'للاختيار',
    open: 'للفتح',
    close: 'للإغلاق',
    scopes: 'البادئة',
    commands: 'الأوامر',
    surahs: 'السور',
    reciters: 'القرّاء',
  },
  status: {
    zero: 'لا نتائج',
    one: 'نتيجة واحدة',
    two: 'نتيجتان',
    few: '{count} نتائج',
    many: '{count} نتيجة',
    other: '{count} نتيجة',
  },
  statusNone: 'لا نتائج',
  recent: {
    continue: 'المتابعة من علامة القراءة',
    read: 'قراءة',
    listen: 'استماع',
    memorize: 'حفظ',
  },
  search: {
    item: 'البحث في القرآن عن «{query}»',
  },
  reciters: {
    current: 'الحالي',
    downloaded: {
      zero: 'لا سور منزّلة',
      one: 'سورة واحدة منزّلة',
      two: 'سورتان منزّلتان',
      few: '{count} سور منزّلة',
      many: '{count} سورة منزّلة',
      other: '{count} سورة منزّلة',
    },
    wordTiming: 'تظليل الكلمات',
    chosen: 'القارئ: {name}',
  },
  settings: {
    current: 'الحالي',
    choice: '{setting}: {value}',
    toggled: '{setting}: {state}',
    values: {
      theme: {
        system: 'مطابقة النظام',
        paper: 'ورقي',
        sepia: 'بني فاتح',
        night: 'ليلي',
        black: 'أسود',
        high_contrast: 'تباين عالٍ',
      },
      accent: {
        teal: 'أزرق مخضر',
        emerald: 'زمردي',
        blue: 'أزرق',
        indigo: 'نيلي',
        rose: 'وردي',
        amber: 'كهرماني',
      },
      readingMode: {
        mushaf: 'المصحف',
        translation: 'الترجمة',
      },
      pageMode: {
        auto: 'تلقائي',
        single: 'صفحة واحدة',
        spread: 'صفحتان متقابلتان',
      },
      mushafStyle: {
        hafs: 'حفص (مدمج)',
        qcf_v2: 'مجمع الملك فهد، الإصدار الثاني (طبعة ١٤٢١هـ)',
        qcf_v1: 'مجمع الملك فهد، الإصدار الأول (طبعة ١٤٠٥هـ)',
        qcf_v4: 'التجويد الملوّن (الإصدار الرابع)',
      },
      uiLanguage: {
        en: 'English',
        ar: 'العربية',
      },
    },
  },
  commands: {
    about: 'حول تطبيق قرآن',
  },
} satisfies Dict['palette']
