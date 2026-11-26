import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAppLocale, type AppLocale } from './locale.js';

/** The desktop supplies its preferred system language to each detached host it starts. */
export const SYSTEM_LOCALE_ENV = 'PARLEY_SYSTEM_LOCALE';

export function desktopUiPath(home: string): string {
  return path.join(home, 'desktop', 'ui.json');
}

export function localeFromDesktopSettings(settings: unknown, systemLocale: string): AppLocale {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'en';
  return resolveAppLocale('locale' in settings ? settings.locale : undefined, systemLocale);
}

/** Read at delivery time so a detached host can observe preferences without an open window. */
export async function readDesktopAppLocale(
  home: string,
  systemLocale = process.env[SYSTEM_LOCALE_ENV] || new Intl.DateTimeFormat().resolvedOptions().locale,
): Promise<AppLocale> {
  try {
    return localeFromDesktopSettings(JSON.parse(await readFile(desktopUiPath(home), 'utf8')), systemLocale);
  } catch {
    return 'en';
  }
}
