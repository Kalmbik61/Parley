export const LOCALE_PREFERENCES = ['en', 'ru'] as const;
export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];
export type AppLocale = LocalePreference;

export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'en' || value === 'ru';
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return isAppLocale(value);
}

export function resolveAppLocale(preference: unknown, systemLocale: string): AppLocale {
  // Legacy profiles still follow the OS until desktop startup stores an explicit choice.
  if (isAppLocale(preference)) return preference;
  if (preference !== undefined && preference !== 'system') return 'en';
  const primary = systemLocale.split(/[-_]/)[0]?.toLowerCase();
  return isAppLocale(primary) ? primary : 'en';
}
