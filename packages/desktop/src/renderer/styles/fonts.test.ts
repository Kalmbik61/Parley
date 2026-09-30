/**
 * Шрифты Organic (кусок 1 плана «Organic», спека окна 2026-09-29, раздел 4 «Типографика»):
 * Figtree (variable) в тексте, Caprasimo в заголовках и кнопках, оба лежат в `renderer/assets/fonts/`
 * вместе с лицензиями OFL 1.1. Окно не ходит в сеть — из Google Fonts ничего не грузится, а Geist
 * ушёл целиком, вместе с лицензией.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseThemeInline, parseTokens, rawValue } from '../test-utils/css-tokens.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.resolve(dirname, '..');
const fontsDir = path.join(rendererDir, 'assets', 'fonts');
const baseCss = readFileSync(path.join(dirname, 'base.css'), 'utf8');
const tokensCss = readFileSync(path.join(dirname, 'tokens.css'), 'utf8');
const tokens = parseTokens(tokensCss);

/** Правила `@font-face` из base.css: семейство → тело правила. */
function fontFaces(css: string): Map<string, string> {
  const faces = new Map<string, string>();
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = match[1] as string;
    const family = /font-family:\s*'([^']+)'/.exec(body)?.[1];
    if (family !== undefined) faces.set(family, body);
  }
  return faces;
}

describe('файлы шрифтов', () => {
  it('в assets/fonts — Figtree и Caprasimo с лицензиями, и ничего больше', () => {
    expect(readdirSync(fontsDir).sort()).toEqual(['Caprasimo-OFL.txt', 'Caprasimo.ttf', 'Figtree-OFL.txt', 'Figtree-Variable.ttf']);
  });

  it('это настоящие TrueType-файлы, а лицензии — SIL OFL 1.1 с правообладателем', () => {
    for (const name of ['Caprasimo.ttf', 'Figtree-Variable.ttf']) {
      const head = readFileSync(path.join(fontsDir, name)).subarray(0, 4);
      // 0x00010000 — TrueType; `true` — старый макинтошевский TrueType.
      expect([0x00010000, 0x74727565], name).toContain(head.readUInt32BE(0));
      expect(statSync(path.join(fontsDir, name)).size, name).toBeGreaterThan(10_000);
    }
    const figtree = readFileSync(path.join(fontsDir, 'Figtree-OFL.txt'), 'utf8');
    const caprasimo = readFileSync(path.join(fontsDir, 'Caprasimo-OFL.txt'), 'utf8');
    expect(figtree).toMatch(/^Copyright 2022 The Figtree Project Authors/);
    expect(caprasimo).toMatch(/^Copyright 2023 The Caprasimo Project Authors/);
    for (const license of [figtree, caprasimo]) expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });
});

describe('@font-face в base.css', () => {
  const faces = fontFaces(baseCss);

  it('Figtree — variable, веса 400–700, файл из assets/fonts', () => {
    const body = faces.get('Figtree');
    expect(body).toMatch(/font-weight:\s*400 700;/);
    expect(body).toContain("url('../assets/fonts/Figtree-Variable.ttf')");
    expect(existsSync(path.join(fontsDir, 'Figtree-Variable.ttf'))).toBe(true);
  });

  it('Caprasimo — один вес 400, файл из assets/fonts', () => {
    const body = faces.get('Caprasimo');
    expect(body).toMatch(/font-weight:\s*400;/);
    expect(body).toContain("url('../assets/fonts/Caprasimo.ttf')");
  });

  it('других семейств нет, из сети ничего не тянется', () => {
    expect([...faces.keys()].sort()).toEqual(['Caprasimo', 'Figtree']);
    expect(baseCss).not.toMatch(/https?:|googleapis|@import\s+url/i);
  });

  it('база окна — 13px/1.4 (спека 4), без интерлиньяжа Geist', () => {
    const body = /(?:^|\n)body\s*\{([^}]*)\}/.exec(baseCss)?.[1];
    expect(body).toMatch(/font-size:\s*13px;/);
    expect(body).toMatch(/line-height:\s*1\.4;/);
    expect(body).not.toMatch(/letter-spacing/);
  });

  it('::selection — accent 30 % (спека 4)', () => {
    expect(baseCss).toMatch(/::selection\s*\{\s*background:\s*color-mix\(in srgb,\s*var\(--color-accent\)\s*30%,\s*transparent\);\s*\}/);
  });

  it('фокус — обводка 2px --ring со смещением 2px, в слое base: утилиты (outline-none) её перекрывают', () => {
    const layer = /@layer base\s*\{([\s\S]*?)\n\}/.exec(baseCss)?.[1];
    expect(layer).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--ring\);\s*outline-offset:\s*2px;\s*\}/);
  });
});

describe('семейства в tokens.css', () => {
  it('текст — Figtree, заголовки и кнопки — Caprasimo, оба с запасным системным шрифтом (кириллицы в них нет)', () => {
    expect(rawValue(tokens, 'light', '--app-font-family')).toMatch(/^'Figtree', -apple-system, /);
    expect(rawValue(tokens, 'light', '--font-sans')).toBe('var(--app-font-family)');
    expect(parseThemeInline(tokensCss).get('--font-heading')).toMatch(/^'Caprasimo', -apple-system, .*sans-serif$/);
  });

  it('моноширинный — как в спеке: SF Mono, SFMono-Regular, ui-monospace, Menlo, monospace', () => {
    expect(rawValue(tokens, 'light', '--font-mono')).toBe("'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace");
  });
});

describe('Geist убран целиком', () => {
  it('ни в стилях, ни в коде рендерера, ни в файлах шрифтов не осталось ни следа', () => {
    const found: string[] = [];
    const stack = [rendererDir];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/geist/i.test(entry.name)) found.push(`${path.relative(rendererDir, full)} (имя файла)`);
        else if (/\.(css|tsx?|html)$/.test(entry.name) && entry.name !== 'fonts.test.ts' && /geist/i.test(readFileSync(full, 'utf8'))) {
          found.push(path.relative(rendererDir, full));
        }
      }
    }
    expect(found).toEqual([]);
  });
});
