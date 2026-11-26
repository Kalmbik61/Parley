import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { hostLocaleReader } from './locale.js';

afterEach(() => vi.unstubAllEnvs());

it('defaults new profiles to English and reads legacy and explicit choices without rewriting them', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'parley-host-locale-'));
  vi.stubEnv('PARLEY_SYSTEM_LOCALE', 'ru-RU');
  const readLocale = hostLocaleReader(home);
  const file = path.join(home, 'desktop', 'ui.json');
  try {
    expect(readLocale()).toBe('en');
    await mkdir(path.dirname(file), { recursive: true });
    for (const [settings, expected] of [
      [{ version: 1 }, 'ru'],
      [{ version: 1, locale: 'system' }, 'ru'],
      [{ version: 1, locale: 'en' }, 'en'],
      [{ version: 1, locale: 'ru' }, 'ru'],
    ] as const) {
      const raw = JSON.stringify(settings);
      await writeFile(file, raw, 'utf8');
      expect(readLocale()).toBe(expected);
      expect(await readFile(file, 'utf8')).toBe(raw);
    }
    vi.stubEnv('PARLEY_SYSTEM_LOCALE', 'de-DE');
    await writeFile(file, '{"locale":"system"}', 'utf8');
    expect(hostLocaleReader(home)()).toBe('en');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
