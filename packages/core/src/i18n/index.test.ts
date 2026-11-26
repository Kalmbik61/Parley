import { describe, expect, it } from 'vitest';
import { createI18n, isLocalePreference, LOCALE_PREFERENCES, localeCatalog, resolveAppLocale } from './index.js';

describe('Parley locale', () => {
  it('offers only explicit interface languages with their native labels', () => {
    expect(LOCALE_PREFERENCES).toEqual(['en', 'ru']);
    expect(isLocalePreference('system')).toBe(false);
    expect(LOCALE_PREFERENCES.every(isLocalePreference)).toBe(true);
    expect(localeCatalog.en['settings.language.en']).toBe('English');
    expect(localeCatalog.en['settings.language.ru']).toBe('Русский');
    expect(localeCatalog.en).not.toHaveProperty('settings.language.system');
    expect(localeCatalog.ru).not.toHaveProperty('settings.language.system');
  });

  it.each([
    ['system', 'ru-RU', 'ru'],
    ['system', 'en-GB', 'en'],
    ['system', 'de-DE', 'en'],
    ['ru', 'de-DE', 'ru'],
    ['en', 'ru-RU', 'en'],
    [undefined, 'ru-RU', 'ru'],
    ['invalid', 'de-DE', 'en'],
    ['invalid', 'ru-RU', 'en'],
  ])('resolves %s with system locale %s as %s', (preference, systemLocale, expected) => {
    expect(resolveAppLocale(preference, systemLocale)).toBe(expected);
  });

  it('formats dates, numbers and relative time with the selected locale', () => {
    const date = new Date('2026-11-24T12:00:00Z');
    const dateOptions = { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' } as const;
    const en = createI18n('en');
    const ru = createI18n('ru');
    expect(en.formatDate(date, dateOptions)).toBe('November 24, 2026');
    expect(ru.formatDate(date, dateOptions)).toBe('24 ноября 2026 г.');
    expect(en.formatNumber(1234.5)).toBe('1,234.5');
    expect(ru.formatNumber(1234.5)).toBe('1\u00a0234,5');
    expect(en.formatRelativeTime(-2, 'day')).toBe('2 days ago');
    expect(ru.formatRelativeTime(-2, 'day')).toBe('2 дня назад');
  });

  it('uses cardinal plural rules, including fractional counts', () => {
    const counts = [0, 1, 2, 5, 11, 21, 22, 25, 1.5];
    expect(counts.map(createI18n('en').pluralCategory)).toEqual([
      'other', 'one', 'other', 'other', 'other', 'other', 'other', 'other', 'other',
    ]);
    expect(counts.map(createI18n('ru').pluralCategory)).toEqual([
      'many', 'one', 'few', 'many', 'many', 'one', 'few', 'many', 'other',
    ]);
  });

  it('keeps catalog keys and named parameters in sync and preserves the inserted name', () => {
    const names = (template: string) => [...new Set(template.match(/\{\w+\}/g))].sort();
    expect(Object.keys(localeCatalog.ru).sort()).toEqual(Object.keys(localeCatalog.en).sort());
    for (const key of Object.keys(localeCatalog.en) as Array<keyof typeof localeCatalog.en>) {
      expect(names(localeCatalog.ru[key]), key).toEqual(names(localeCatalog.en[key]));
    }
    const name = 'Fix {count} $&';
    const workspace = 'Research «Бета»';
    expect(createI18n('en').t('pilot.sessionFinished', { workspace, name })).toBe(`${workspace} · ${name} — finished`);
    expect(createI18n('ru').t('pilot.sessionFinished', { workspace, name })).toBe(`${workspace} · ${name} — завершено`);
  });
});
