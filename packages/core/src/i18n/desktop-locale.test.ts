import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { desktopUiPath, readDesktopAppLocale } from './desktop-locale.js';

it('reads the saved interface language with no desktop process and observes subsequent writes', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'parley-locale-'));
  try {
    const file = desktopUiPath(home);
    await expect(readDesktopAppLocale(home, 'ru-RU')).resolves.toBe('ru');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"version":1,"locale":"en"}', 'utf8');
    await expect(readDesktopAppLocale(home, 'ru-RU')).resolves.toBe('en');
    await writeFile(file, '{"version":1,"locale":"ru"}', 'utf8');
    await expect(readDesktopAppLocale(home, 'de-DE')).resolves.toBe('ru');
    await writeFile(file, '{"version":1}', 'utf8');
    await expect(readDesktopAppLocale(home, 'de-DE')).resolves.toBe('en');
    await writeFile(file, '{', 'utf8');
    await expect(readDesktopAppLocale(home, 'ru-RU')).resolves.toBe('ru');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
