// @vitest-environment node
/**
 * Аддоны xterm окна — выпуски под установленный xterm 5.5 (раунд fix-6.2, п.3). Выпуски под
 * xterm 6 не объявляют peerDependencies и держатся на внутренностях ядра: `addon-webgl@0.19`
 * ронял терминал на `_store`, pnpm этого не ловит. Страж: каждый `@xterm/addon-*` окна
 * объявляет peer `@xterm/xterm` той же старшей версии, что установлена.
 * Среда node: под jsdom `import.meta.url` не путь к файлу.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

interface Manifest {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

describe('аддоны xterm окна', () => {
  const own = manifest(new URL('../../../package.json', import.meta.url).pathname);
  const addons = Object.keys(own.dependencies ?? {}).filter((name) => name.startsWith('@xterm/addon-'));
  const xtermMajor = manifest(require.resolve('@xterm/xterm/package.json')).version.split('.')[0];

  it('в зависимостях окна есть аддоны', () => {
    expect(addons.length).toBeGreaterThan(0);
  });

  it.each(addons)('%s — peer @xterm/xterm той же старшей версии', (name) => {
    const peer = manifest(require.resolve(`${name}/package.json`)).peerDependencies?.['@xterm/xterm'];
    expect(peer).toMatch(new RegExp(`^\\^${xtermMajor}\\.`));
  });
});
