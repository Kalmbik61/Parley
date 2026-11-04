/**
 * Подпуть `@parley/core/voice-live` берут renderer острова и телефон: ни `node:*`, ни встроенных модулей Node, ни
 * сторонних пакетов, ни корневого индекса core. Разрешены только соседние файлы модуля и чистый нормализатор
 * `../assistant/text.js` (он сам без импортов — это проверяется здесь же).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ALLOWED = /^(\.\/[\w-]+\.js|\.\.\/assistant\/text\.js)$/;
const SPECIFIER = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

describe('voice-live: без Node и корневого индекса', () => {
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => path.join(dir, name));

  it('в модуле есть файлы', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files.map((file) => [path.basename(file), file] as const))('%s импортирует только разрешённое', (_name, file) => {
    for (const specifier of specifiers(file)) expect(specifier, `${path.basename(file)} → ${specifier}`).toMatch(ALLOWED);
  });

  it('нормализатор текста сам ничего не импортирует', () => {
    expect(specifiers(path.join(dir, '..', 'assistant', 'text.ts'))).toEqual([]);
  });

  it('подпуть объявлен в package.json и не ссылается на корневой индекс', () => {
    const pkg = JSON.parse(readFileSync(path.join(dir, '..', '..', 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports['./voice-live']).toBe('./dist/voice-live/index.js');
    expect(pkg.exports['./voice-live']).not.toBe(pkg.exports['.']);
  });
});
