import { readFileSync } from 'node:fs';
import { desktopUiPath, SYSTEM_LOCALE_ENV } from '../i18n/desktop-locale.js';
import { resolveAppLocale, type AppLocale } from '../i18n/index.js';
import { parleyHome } from './store.js';

/** Export strings are fixed while capturing an intent, before asynchronous IO or retries. */
export function exportLocale(): AppLocale {
  const systemLocale =
    process.env[SYSTEM_LOCALE_ENV] || new Intl.DateTimeFormat().resolvedOptions().locale;
  try {
    const settings = JSON.parse(readFileSync(desktopUiPath(parleyHome()), 'utf8')) as {
      locale?: unknown;
    } | null;
    return resolveAppLocale(settings?.locale, systemLocale);
  } catch {
    return resolveAppLocale(undefined, systemLocale);
  }
}
