export const LOCALE_PREFERENCES = ['system', 'en', 'ru'] as const;
export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];
export type AppLocale = Exclude<LocalePreference, 'system'>;

export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'en' || value === 'ru';
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || isAppLocale(value);
}

export function resolveAppLocale(preference: unknown, systemLocale: string): AppLocale {
  if (isAppLocale(preference)) return preference;
  const primary = systemLocale.split(/[-_]/)[0]?.toLowerCase();
  return isAppLocale(primary) ? primary : 'en';
}
