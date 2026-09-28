/**
 * Кусок 7.3b, тест 10: CSP окна (`index.html`) совпадает со строкой спеки 15.2 — кроме `blob:` в
 * `img-src`: его добавит превью картинок (7.5). Любое ослабление CSP сначала меняет спеку.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** Директивы по имени: порядок и лишние пробелы не важны. */
function directives(csp: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name !== undefined && name !== '') result[name] = values.join(' ');
  }
  return result;
}

describe('CSP окна (тест 10)', () => {
  it('index.html — строка спеки 15.2 без blob: в img-src', () => {
    const html = read('./index.html');
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
    expect(meta).not.toBeNull();
    const spec = read('../../../../docs/specs/2026-09-26-desktop-orca-ui-design.md');
    const section = spec.slice(spec.indexOf('### 15.2'), spec.indexOf('## 16.'));
    const line = /`(default-src[^`]+)`/.exec(section.replace(/\n\s*/g, ' '));
    expect(line).not.toBeNull();
    const expected = directives(line?.[1] ?? '');
    expected['img-src'] = (expected['img-src'] ?? '').replace(/\s*blob:/, '');
    expect(directives(meta?.[1] ?? '')).toEqual(expected);
    expect(expected['worker-src']).toBe("'self'");
  });
});
