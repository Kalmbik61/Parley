import { describe, expect, it } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { dailyBudget, localDay } from './budget.js';

const add = (db: ReturnType<typeof openMemoryDb>, id: string, day: string, estimate: number, final: number | null) =>
  db.prepare("INSERT INTO voice_usage (voice_session_id, day, state, seconds_estimate, seconds_final) VALUES (?, ?, 'closed', ?, ?)").run(id, day, estimate, final);

describe('dailyBudget', () => {
  const at = new Date(2026, 10, 4, 12, 0, 0);

  it('пустая таблица: весь лимит свободен', () => {
    expect(dailyBudget(openMemoryDb(), 30, at)).toEqual({ limitSeconds: 1800, usedSeconds: 0, remainingSeconds: 1800 });
  });

  it('seconds_final приоритетнее оценки; NULL считается по оценке', () => {
    const db = openMemoryDb();
    add(db, 'a', '2026-11-04', 999, 100);
    add(db, 'b', '2026-11-04', 50, null);
    expect(dailyBudget(db, 30, at)).toMatchObject({ usedSeconds: 150, remainingSeconds: 1650 });
  });

  it('ровно на лимите остаток 0, сверх лимита не уходит в минус', () => {
    const db = openMemoryDb();
    add(db, 'a', '2026-11-04', 0, 1800);
    expect(dailyBudget(db, 30, at).remainingSeconds).toBe(0);
    add(db, 'b', '2026-11-04', 0, 60);
    expect(dailyBudget(db, 30, at).remainingSeconds).toBe(0);
  });

  it('считает только локальные сутки момента at', () => {
    const db = openMemoryDb();
    add(db, 'a', '2026-11-03', 0, 1800);
    expect(dailyBudget(db, 30, at).usedSeconds).toBe(0);
    expect(dailyBudget(db, 30, new Date(2026, 10, 3, 0, 0, 1)).usedSeconds).toBe(1800);
    expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
