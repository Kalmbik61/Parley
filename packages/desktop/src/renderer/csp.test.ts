/**
 * Куски 7.3b (тест 10) и 7.5 (тест 8): CSP окна (`index.html`) — строка спеки 15.2 целиком, вместе с
 * `blob:` в `img-src` для картинок превью. Любое ослабление CSP сначала меняет спеку.
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

describe('CSP окна (7.3b тест 10, 7.5 тест 8)', () => {
  it('index.html — строка спеки 15.2 целиком', () => {
    const html = read('./index.html');
    const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
    expect(meta).not.toBeNull();
    const spec = read('../../../../docs/specs/2026-09-26-desktop-orca-ui-design.md');
    const section = spec.slice(spec.indexOf('### 15.2'), spec.indexOf('## 16.'));
    const line = /`(default-src[^`]+)`/.exec(section.replace(/\n\s*/g, ' '));
    expect(line).not.toBeNull();
    const expected = directives(line?.[1] ?? '');
    expect(directives(meta?.[1] ?? '')).toEqual(expected);
    // И как строка, в том же порядке: сверка глазами со спекой — один к одному.
    const squeeze = (text: string): string => text.replace(/\s+/g, ' ').trim();
    expect(squeeze(meta?.[1] ?? '')).toBe(squeeze(line?.[1] ?? ''));
    expect(expected['worker-src']).toBe("'self'");
    expect(expected['img-src']).toBe("'self' data: blob:");
    // Без WebAssembly: pdf.js идёт с `useWasm: false` (`PdfPreview.tsx`).
    expect(expected['script-src']).toBe("'self'");
  });
});
