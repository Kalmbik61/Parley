import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveAppLocale, type AppLocale } from './locale.js';

/** The desktop supplies its preferred system language to each detached host it starts. */
export const SYSTEM_LOCALE_ENV = 'PARLEY_SYSTEM_LOCALE';

export function desktopUiPath(home: string): string {
  return path.join(home, 'desktop', 'ui.json');
}

/** Read at delivery time so a detached host can observe preferences without an open window. */
export async function readDesktopAppLocale(
  home: string,
  systemLocale = process.env[SYSTEM_LOCALE_ENV] || new Intl.DateTimeFormat().resolvedOptions().locale,
): Promise<AppLocale> {
  try {
    const settings = JSON.parse(await readFile(desktopUiPath(home), 'utf8')) as { locale?: unknown } | null;
    return resolveAppLocale(settings?.locale, systemLocale);
  } catch {
    return resolveAppLocale(undefined, systemLocale);
  }
}
