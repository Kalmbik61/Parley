import { readFileSync } from 'node:fs';
import { desktopUiPath, localeFromDesktopSettings, SYSTEM_LOCALE_ENV } from '../i18n/desktop-locale.js';
import type { AppLocale } from '../i18n/index.js';
import { parleyHome } from './store.js';

/** Export strings are fixed while capturing an intent, before asynchronous IO or retries. */
export function exportLocale(): AppLocale {
  const systemLocale =
    process.env[SYSTEM_LOCALE_ENV] || new Intl.DateTimeFormat().resolvedOptions().locale;
  try {
    return localeFromDesktopSettings(JSON.parse(readFileSync(desktopUiPath(parleyHome()), 'utf8')), systemLocale);
  } catch {
    return 'en';
  }
}
