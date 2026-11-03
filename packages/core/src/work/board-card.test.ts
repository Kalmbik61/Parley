import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { backlogState, boardReturnMessage, parseTaken } from './board-card.js';

describe('backlogState', () => {
  it('различает четыре состояния', () => {
    expect(backlogState({ checked: false })).toBe('backlog');
    expect(backlogState({ checked: false, taken: 'w-01/s-02' })).toBe('in-progress');
    expect(backlogState({ checked: false, taken: 'w-01/s-02' }, { review: '2026-11-01T10:00:00.000Z' })).toBe('review');
    expect(backlogState({ checked: true, taken: 'w-01/s-02' }, { review: '2026-11-01T10:00:00.000Z' })).toBe('done');
  });
});

describe('boardReturnMessage', () => {
  it('даёт точный текст и обрезает заметку по краям', () => {
    expect(boardReturnMessage({ id: 'b-1', title: 'Fix it' }, '  add tests \n'))
      .toBe('Board card b-1 is back from review: Fix it\n\nadd tests\n\nWhen it is done, call report with status done and backlog ["b-1"].');
  });
});

describe('parseTaken', () => {
  it('разбирает сессию и комнату', () => {
    expect(parseTaken('w-01/s-02')).toEqual({ workId: 'w-01', kind: 'session', targetId: 's-02' });
    expect(parseTaken('w-3/r-10')).toEqual({ workId: 'w-3', kind: 'room', targetId: 'r-10' });
  });

  it('мусор даёт null', () => {
    for (const junk of ['', 'w-01', 'x/y', 'w-01/s-02/x', 'w-01/q-02']) expect(parseTaken(junk)).toBeNull();
  });
});

describe('board-card.ts', () => {
  it('не импортирует значений', () => {
    const source = readFileSync(new URL('./board-card.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter(line => /^\s*import\b/.test(line));
    for (const line of imports) expect(line.startsWith('import type')).toBe(true);
  });
});
