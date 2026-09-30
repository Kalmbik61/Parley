/**
 * Толщина линий значков (кусок 1 плана «Organic», спека окна 2026-09-29, раздел 4 «Иконки»):
 * `strokeWidth` 2.75 у всех значков lucide. Вместо правки каждого места — одно правило CSS для
 * `svg.lucide` в `base.css`: lucide-react ставит на `<svg>` класс `lucide`, а атрибут `stroke-width`
 * (у него 2 по умолчанию, а проп `strokeWidth` кладётся в тот же атрибут) — презентационный, и любое
 * правило автора его перекрывает. Живую проверку (что computed style — 2.75) делает
 * `e2e/theme.spec.ts`: в jsdom стили не считаются.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { MessageCircleQuestion, Search, X } from 'lucide-react';
import { describe, expect, it } from 'vitest';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const baseCss = readFileSync(path.join(dirname, 'base.css'), 'utf8');

describe('lucide: толщина линий 2.75 одним правилом CSS', () => {
  it('lucide-react этой версии ставит на <svg> класс `lucide` — за него цепляется правило', () => {
    const { container } = render(
      <>
        <Search />
        <X />
        <MessageCircleQuestion strokeWidth={1} />
      </>,
    );
    const icons = [...container.querySelectorAll('svg')];
    expect(icons).toHaveLength(3);
    for (const icon of icons) expect(icon.classList.contains('lucide'), icon.outerHTML).toBe(true);
  });

  it('base.css: `svg.lucide { stroke-width: 2.75 }` — в слое base, чтобы утилиты stroke-* могли его перекрыть', () => {
    const layer = /@layer base\s*\{([\s\S]*?)\n\}/g;
    const rules = [...baseCss.matchAll(layer)].map((match) => match[1] as string).join('\n');
    expect(rules).toMatch(/svg\.lucide\s*\{\s*stroke-width:\s*2\.75;\s*\}/);
  });

  it('никто не задаёт толщину значкам поодиночке: правило всё равно перекрыло бы проп, а он вводил бы в заблуждение', () => {
    const found: string[] = [];
    const stack = [path.resolve(dirname, '..')];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name) && /strokeWidth|absoluteStrokeWidth/.test(readFileSync(full, 'utf8'))) {
          found.push(path.relative(dirname, full));
        }
      }
    }
    expect(found).toEqual([]);
  });
});
