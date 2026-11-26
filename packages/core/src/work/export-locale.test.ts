import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { exportLocale } from './export-locale.js';

afterEach(() => vi.unstubAllEnvs());

it('defaults new profiles to English and interprets legacy preferences without migrating on export', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'parley-export-locale-'));
  vi.stubEnv('PARLEY_HOME', home);
  vi.stubEnv('PARLEY_SYSTEM_LOCALE', 'ru-RU');
  const file = path.join(home, 'desktop', 'ui.json');
  try {
    expect(exportLocale()).toBe('en');
    await mkdir(path.dirname(file), { recursive: true });
    for (const [settings, expected] of [
      [{ version: 1 }, 'ru'],
      [{ version: 1, locale: 'system' }, 'ru'],
      [{ version: 1, locale: 'en' }, 'en'],
      [{ version: 1, locale: 'ru' }, 'ru'],
    ] as const) {
      const raw = JSON.stringify(settings);
      await writeFile(file, raw, 'utf8');
      expect(exportLocale()).toBe(expected);
      expect(await readFile(file, 'utf8')).toBe(raw);
    }
    vi.stubEnv('PARLEY_SYSTEM_LOCALE', 'de-DE');
    await writeFile(file, '{"locale":"system"}', 'utf8');
    expect(exportLocale()).toBe('en');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
