import { createTranslator, defineCatalog, type Translator } from './catalog.js';
import type { AppLocale } from './locale.js';

export { createTranslator, defineCatalog } from './catalog.js';
export type { Translator } from './catalog.js';
export { isAppLocale, isLocalePreference, LOCALE_PREFERENCES, resolveAppLocale } from './locale.js';
export type { AppLocale, LocalePreference } from './locale.js';

export const localeCatalog = defineCatalog(
  {
    'settings.language': 'Interface language',
    'settings.language.en': 'English',
    'settings.language.ru': 'Русский',
    'settings.language.restart': 'Restart Parley to apply language changes.',
    'settings.language.error': 'Could not save the interface language.',
    'pilot.sessionFinished': '{workspace} · {name} — finished',
  },
  {
    'settings.language': 'Язык интерфейса',
    'settings.language.en': 'English',
    'settings.language.ru': 'Русский',
    'settings.language.restart': 'Перезапустите Parley, чтобы изменить язык интерфейса.',
    'settings.language.error': 'Не удалось сохранить язык интерфейса.',
    'pilot.sessionFinished': '{workspace} · {name} — завершено',
  },
);

export interface I18n {
  locale: AppLocale;
  t: Translator<typeof localeCatalog.en>;
  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string;
  pluralCategory(value: number): Intl.LDMLPluralRule;
}

export function createI18n(locale: AppLocale): I18n {
  const pluralRules = new Intl.PluralRules(locale);
  return {
    locale,
    t: createTranslator(locale, localeCatalog),
    formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(value),
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value),
    formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions) =>
      new Intl.RelativeTimeFormat(locale, options).format(value, unit),
    pluralCategory: (value: number) => pluralRules.select(value),
  };
}
