import type { Dict } from '$lib/contracts/i18n'

/** `fonts` messages, Arabic (§11.1). Owner: WP8b. Same keys as `../en/fonts.ts`; plurals define all six categories. */
export const fonts = {
  dot: {
    offline: 'دون اتصال — تُعرض الصفحة بخط حفص',
    failed: 'تعذّر تنزيل خط هذه الصفحة',
    failedAction: 'تعذّر تنزيل خط هذه الصفحة. أعِد المحاولة',
    retrying: 'جارٍ تنزيل خط هذه الصفحة…',
    retry: 'إعادة المحاولة',
  },
} satisfies Dict['fonts']
