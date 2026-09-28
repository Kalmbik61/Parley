/**
 * Кусок 8.3, тест 4: вкладка диффа на Monaco заменила прежнюю панель — ни `react-diff-view`, ни
 * `gitdiff-parser`, ни `components/changes` в исходниках окна и в его `package.json` не осталось.
 * Этот файл сам себя не сканирует: искомые имена в нём есть.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(import.meta.url);
/** `packages/desktop` — этот файл лежит в `src/renderer/review`. */
const desktopRoot = path.resolve(path.dirname(here), '../../..');
const NEEDLES = ['react-diff-view', 'gitdiff-parser', 'components/changes'];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx|css|html)$/.test(entry.name) && full !== here) out.push(full);
  }
  return out;
}

describe('прежняя панель диффа удалена (тест 4)', () => {
  it('поиск react-diff-view, gitdiff-parser и components/changes по исходникам и package.json пуст', () => {
    const files = [...sources(path.join(desktopRoot, 'src')), path.join(desktopRoot, 'package.json')];
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return NEEDLES.filter((needle) => text.includes(needle)).map((needle) => `${path.relative(desktopRoot, file)}: ${needle}`);
    });
    expect(found).toEqual([]);
  });
});
