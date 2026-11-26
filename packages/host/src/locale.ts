import { readFileSync } from 'node:fs';
import { desktopUiPath, localeFromDesktopSettings, SYSTEM_LOCALE_ENV } from '@parley/core/desktop-locale';
import type { AppLocale } from '@parley/core/i18n';

/** The host can deliver synchronously while the window is closed or restarts independently. */
export function hostLocaleReader(home: string): () => AppLocale {
  const file = desktopUiPath(home);
  const systemLocale =
    process.env[SYSTEM_LOCALE_ENV] || new Intl.DateTimeFormat().resolvedOptions().locale;
  return () => {
    try {
      return localeFromDesktopSettings(JSON.parse(readFileSync(file, 'utf8')), systemLocale);
    } catch {
      return 'en';
    }
  };
}
