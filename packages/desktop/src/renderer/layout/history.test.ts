/**
 * Тесты 7 и 8 куска 2.2 плана каркаса (история и MRU) — чистые функции,
 * настоящих часов не трогают: `at` в тестах — просто счётчик, а не `Date.now()`.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_HISTORY, pushHistory, removeMru, stepHistory, touchMru, type History, type HistoryEntry } from './history.js';

function entry(workKey: string, tabId: string | null, at: number): HistoryEntry {
  return { workKey, tabId, at };
}

describe('pushHistory (тест 7)', () => {
  it('добавляет запись и двигает index на неё', () => {
    const h1 = pushHistory(EMPTY_HISTORY, entry('a', 't1', 1));
    expect(h1.entries).toEqual([entry('a', 't1', 1)]);
    expect(h1.index).toBe(0);
  });

  it('подряд одинаковые (workKey и tabId) не пишутся — та же ссылка', () => {
    const h1 = pushHistory(EMPTY_HISTORY, entry('a', 't1', 1));
    const h2 = pushHistory(h1, entry('a', 't1', 2));
    expect(h2).toBe(h1);
  });

  it('60 записей подряд без повторов → предел 50', () => {
    let history: History = EMPTY_HISTORY;
    for (let i = 0; i < 60; i += 1) {
      history = pushHistory(history, entry('a', `t${i}`, i));
    }
    expect(history.entries).toHaveLength(50);
    // Держатся последние 50 — с t10 по t59.
    expect(history.entries[0]).toEqual(entry('a', 't10', 10));
    expect(history.entries.at(-1)).toEqual(entry('a', 't59', 59));
    expect(history.index).toBe(49);
  });

  it('запись после шага назад обрезает «вперёд»', () => {
    let history: History = EMPTY_HISTORY;
    history = pushHistory(history, entry('a', 't1', 1));
    history = pushHistory(history, entry('a', 't2', 2));
    const back = stepHistory(history, -1, () => true);
    expect(back?.entry).toEqual(entry('a', 't1', 1));
    history = back!.history;

    history = pushHistory(history, entry('a', 't3', 3));
    expect(history.entries).toEqual([entry('a', 't1', 1), entry('a', 't3', 3)]);
    expect(history.index).toBe(1);
  });
});

describe('stepHistory (тест 7)', () => {
  it('stepHistory(-1) после двух записей возвращает первую', () => {
    let history: History = EMPTY_HISTORY;
    history = pushHistory(history, entry('a', 't1', 1));
    history = pushHistory(history, entry('a', 't2', 2));

    const result = stepHistory(history, -1, () => true);
    expect(result?.entry).toEqual(entry('a', 't1', 1));
    expect(result?.history.index).toBe(0);
  });

  it('мёртвая запись пропускается', () => {
    let history: History = EMPTY_HISTORY;
    history = pushHistory(history, entry('a', 't1', 1));
    history = pushHistory(history, entry('b', 't2', 2));
    history = pushHistory(history, entry('c', 't3', 3));

    // 'b' мертва (например, работа удалена) — шаг назад из 'c' должен попасть на 'a'.
    const result = stepHistory(history, -1, (e) => e.workKey !== 'b');
    expect(result?.entry).toEqual(entry('a', 't1', 1));
  });

  it('шагать некуда — null', () => {
    const history = pushHistory(EMPTY_HISTORY, entry('a', 't1', 1));
    expect(stepHistory(history, -1, () => true)).toBeNull();
    expect(stepHistory(history, 1, () => true)).toBeNull();
    expect(stepHistory(EMPTY_HISTORY, -1, () => true)).toBeNull();
  });
});

describe('mru (тест 8)', () => {
  it('25 касаний одной работы → предел 20, свежие первыми', () => {
    let mru = touchMru({}, 'a', 't0');
    for (let i = 1; i < 25; i += 1) mru = touchMru(mru, 'a', `t${i}`);

    expect(mru.a).toHaveLength(20);
    expect(mru.a?.[0]).toBe('t24');
    expect(mru.a).not.toContain('t0');
    expect(mru.a).not.toContain('t4');
  });

  it('повторное касание переносит вкладку в начало без дублей', () => {
    let mru = touchMru({}, 'a', 't1');
    mru = touchMru(mru, 'a', 't2');
    mru = touchMru(mru, 'a', 't1');

    expect(mru.a).toEqual(['t1', 't2']);
  });

  it('removeMru убирает вкладку; нет такой — та же ссылка', () => {
    const mru = touchMru(touchMru({}, 'a', 't1'), 'a', 't2');
    const removed = removeMru(mru, 'a', 't1');
    expect(removed.a).toEqual(['t2']);

    expect(removeMru(mru, 'a', 'not-there')).toBe(mru);
    expect(removeMru(mru, 'other-work', 't1')).toBe(mru);
  });
});
