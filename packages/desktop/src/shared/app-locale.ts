import { createI18n, isAppLocale, type AppLocale } from '@parley/core/i18n';

// Both preload bridges make the selected locale available before renderer modules run.
const { parley } = globalThis as { parley?: { locale?: () => AppLocale } };
const locale = parley?.locale?.();
export let appI18n = createI18n(isAppLocale(locale) ? locale : 'en');

export function setAppLocale(locale: AppLocale): void {
  appI18n = createI18n(locale);
}

export function displayLocale(): 'en-US' | 'ru-RU' {
  return appI18n.locale === 'ru' ? 'ru-RU' : 'en-US';
}

export function displayCalendarDay(iso: string): string {
  const day = iso.slice(0, 10);
  if (appI18n.locale === 'en' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString(displayLocale(), { dateStyle: 'medium', timeZone: 'UTC' });
}
