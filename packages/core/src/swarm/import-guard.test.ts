/**
 * Подпуть `@parley/core/swarm` берут renderer острова и телефон: ни `node:*`, ни встроенных модулей Node, ни
 * сторонних пакетов, ни корневого индекса core, ни DOM. Разрешены только соседние файлы модуля и типы
 * `@parley/protocol` (строго `import type`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SIBLING = /^\.\/[\w-]+\.js$/;
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const DOM = /\b(document|window|HTMLCanvasElement|CanvasRenderingContext2D|requestAnimationFrame)\b/;

function specifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

/** Код без комментариев: слова про canvas в пояснениях не считаются. */
function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('swarm: без Node, DOM и корневого индекса', () => {
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => path.join(dir, name));

  it('в модуле есть файлы', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(files.map((file) => [path.basename(file), file] as const))('%s импортирует только разрешённое', (_name, file) => {
    for (const specifier of specifiers(file)) {
      if (specifier === '@parley/protocol') {
        expect(readFileSync(file, 'utf8'), `${path.basename(file)}: протокол только как тип`).toMatch(/import type [^;]*from '@parley\/protocol'/);
      } else {
        expect(specifier, `${path.basename(file)} → ${specifier}`).toMatch(SIBLING);
      }
    }
  });

  it.each(files.map((file) => [path.basename(file), file] as const))('%s не знает о DOM', (_name, file) => {
    expect(code(file)).not.toMatch(DOM);
  });

  it('подпуть объявлен в package.json и не ссылается на корневой индекс', () => {
    const pkg = JSON.parse(readFileSync(path.join(dir, '..', '..', 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports['./swarm']).toBe('./dist/swarm/index.js');
    expect(pkg.exports['./swarm']).not.toBe(pkg.exports['.']);
  });
});
