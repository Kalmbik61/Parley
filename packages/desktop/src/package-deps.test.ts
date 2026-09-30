/**
 * Страж состава `dependencies` окна (fix-7.5): electron-builder кладёт в `app.asar` всё дерево
 * `dependencies`, а рендерер Vite собирает целиком — его библиотеки в asar лежали бы вторым,
 * мёртвым разом (так `app.asar` вырос за этап 7 на 50 МБ). Поэтому в `dependencies` — ровно
 * пакеты, которые main, preload и общий с ними `shared/` берут во время работы (они остаются
 * внешними у `externalizeDepsPlugin`); библиотеки рендерера и сборочные — в `devDependencies`.
 *
 * `import type` не считается: типы в сборку не попадают. `require.resolve` — считается: так main
 * в dev находит точку входа `@parley/host`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(srcRoot, '..', 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(ts|js)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

/** Имя пакета спецификатора: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function runtimePackages(): Set<string> {
  const found = new Set<string>();
  const pattern = /(?:^|\n)\s*import\s+(?!type\s)[^'"]*?from\s+'([^'.][^']*)'|(?:import|require|require\.resolve)\(\s*'([^'.][^']*)'/g;
  for (const file of ['main', 'preload', 'shared'].flatMap((dir) => sources(path.join(srcRoot, dir)))) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined || specifier.startsWith('node:') || builtinModules.includes(specifier)) continue;
      found.add(packageOf(specifier));
    }
  }
  // Electron даёт сам процесс: electron-builder требует его в devDependencies.
  found.delete('electron');
  return found;
}

describe('dependencies окна (fix-7.5)', () => {
  it('ровно пакеты, которые main, preload и shared берут во время работы', () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([...runtimePackages()].sort());
  });
});
