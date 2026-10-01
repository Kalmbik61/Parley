/**
 * Страж синхронности гида агента с окном (fix-guide, п. 5). Гид `read_guide` (core/work/guide.ts)
 * цитирует блоки, которые окно шлёт в терминал агента, — чтобы агент узнал их в своём вводе. Шаблоны
 * этих блоков живут здесь, в `S`; поменяет окно шаблон — тест упадёт и напомнит поправить гид.
 *
 * Лежит в `main/`: он импортирует `@parley/core` как значение, а так core берёт только процесс
 * main — рендерер из core получает лишь типы.
 */

import { GUIDE } from '@parley/core';
import { describe, expect, it } from 'vitest';
import { S } from '../shared/strings.js';

/** Те же ветка, база и сессия, что в примерах гида. */
const BRANCH = 'parley/w-0003/s-02';
const BASE = 'master';

describe('гид агента цитирует блоки окна дословно', () => {
  it('заметки к диффу — S.notes', () => {
    expect(GUIDE).toContain(S.notes.header('S02', BRANCH));
    // Без ветки заголовок кончается двоеточием сразу после сессии — общее начало то же.
    expect(S.notes.header('S02', null)).toBe('Review notes for S02:');
    expect(GUIDE).toContain(S.notes.file('src/a.ts'));
    expect(GUIDE).toContain(S.notes.line(7));
    expect(GUIDE).toContain(S.notes.lines(10, 14));
    expect(GUIDE).toContain(S.notes.sideOriginal);
    expect(GUIDE).toContain(S.notes.note('ещё текст'));
  });

  it('элемент страницы Design Mode — S.designBlock', () => {
    expect(GUIDE).toContain(S.designBlock.header('http://localhost:5173/settings'));
    expect(GUIDE).toContain(S.designBlock.dataNote);
    expect(GUIDE).toContain(S.designBlock.selector('main > section.settings > button.save'));
    expect(GUIDE).toContain(S.designBlock.text('Save'));
    expect(GUIDE).toContain(S.designBlock.styles(''));
    expect(GUIDE).toContain(S.designBlock.html);
    expect(GUIDE).toContain(S.designBlock.screenshot(''));
    expect(GUIDE).toContain(S.designBlock.truncated);
  });

  it('просьба разрешить конфликт — S.changes.askAgentIntro и askAgentInstruction', () => {
    expect(GUIDE).toContain(S.changes.askAgentIntro(BRANCH, BASE));
    expect(GUIDE).toContain(S.changes.askAgentInstruction(BASE));
  });
});
