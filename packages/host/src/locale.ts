import { readFileSync } from 'node:fs';
import { desktopUiPath, SYSTEM_LOCALE_ENV } from '@parley/core/desktop-locale';
import { resolveAppLocale, type AppLocale } from '@parley/core/i18n';

/** The host can deliver synchronously while the window is closed or restarts independently. */
export function hostLocaleReader(home: string): () => AppLocale {
  const file = desktopUiPath(home);
  const systemLocale =
    process.env[SYSTEM_LOCALE_ENV] || new Intl.DateTimeFormat().resolvedOptions().locale;
  return () => {
    try {
      const settings = JSON.parse(readFileSync(file, 'utf8')) as { locale?: unknown } | null;
      return resolveAppLocale(settings?.locale, systemLocale);
    } catch {
      return resolveAppLocale(undefined, systemLocale);
    }
  };
}
