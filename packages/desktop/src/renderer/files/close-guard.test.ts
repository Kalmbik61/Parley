/**
 * Тест 5 куска 7.3a: вопрос о несохранённых буферах при закрытии вкладок — ответы применяются
 * после всех; и вопрос при закрытии окна (тест 11, сторона рендерера).
 */

import { describe, expect, it, vi } from 'vitest';
import { answerWindowClose, createCloseGuard } from './close-guard.js';

const W = '/p w-1';
const A = 'file:p:a.ts';
const B = 'file:p:b.ts';

function guardWith(answers: Record<string, 'save' | 'discard' | 'cancel'>, saveOk: Record<string, boolean> = {}) {
  const asked: string[] = [];
  const saved: string[] = [];
  const guard = createCloseGuard({
    isDirty: (_workKey, tabId) => tabId in answers,
    ask: async (_workKey, tabId) => {
      asked.push(tabId);
      return answers[tabId] ?? 'cancel';
    },
    save: async (_workKey, tabId) => {
      saved.push(tabId);
      return saveOk[tabId] ?? true;
    },
  });
  return { guard, asked, saved };
}

describe('createCloseGuard (тест 5)', () => {
  it('discard на A, cancel на B → false, записей нет', async () => {
    const { guard, asked, saved } = guardWith({ [A]: 'discard', [B]: 'cancel' });
    expect(await guard(W, [A, B])).toBe(false);
    expect(asked).toEqual([A, B]);
    expect(saved).toEqual([]);
  });

  it('save на A с конфликтом → false', async () => {
    const { guard, saved } = guardWith({ [A]: 'save' }, { [A]: false });
    expect(await guard(W, [A])).toBe(false);
    expect(saved).toEqual([A]);
  });

  it('save на A, discard на B → true, одна запись A — после ответа на B', async () => {
    const order: string[] = [];
    const guard = createCloseGuard({
      isDirty: () => true,
      ask: async (_w, tabId) => {
        order.push(`ask ${tabId}`);
        return tabId === A ? 'save' : 'discard';
      },
      save: async (_w, tabId) => {
        order.push(`save ${tabId}`);
        return true;
      },
    });
    expect(await guard(W, [A, B])).toBe(true);
    expect(order).toEqual([`ask ${A}`, `ask ${B}`, `save ${A}`]);
  });

  it('чистые вкладки и не-файлы не спрашиваются; пусто — true', async () => {
    const { guard, asked } = guardWith({});
    expect(await guard(W, ['terminal:s-01', A])).toBe(true);
    expect(asked).toEqual([]);
    const isDirty = vi.fn(() => true);
    const guard2 = createCloseGuard({ isDirty, ask: async () => 'discard', save: async () => true });
    expect(await guard2(W, ['terminal:s-01', 'mail'])).toBe(true);
    expect(isDirty).not.toHaveBeenCalled();
  });
});

describe('answerWindowClose (тест 11, рендерер)', () => {
  const dirty = [
    { workKey: W, tabId: A, name: 'a.ts' },
    { workKey: W, tabId: B, name: 'b.ts' },
  ];

  it('грязных нет — close без вопроса', async () => {
    const ask = vi.fn();
    expect(await answerWindowClose({ dirty: () => [], ask, save: async () => true, toast: vi.fn() })).toBe('close');
    expect(ask).not.toHaveBeenCalled();
  });

  it('вопрос по всем грязным; Cancel — cancel; Don\'t save — close без записи', async () => {
    const save = vi.fn(async () => true);
    const ask = vi.fn(async () => 'cancel' as const);
    expect(await answerWindowClose({ dirty: () => dirty, ask, save, toast: vi.fn() })).toBe('cancel');
    expect(ask).toHaveBeenCalledWith(['a.ts', 'b.ts']);
    expect(await answerWindowClose({ dirty: () => dirty, ask: async () => 'discard', save, toast: vi.fn() })).toBe('close');
    expect(save).not.toHaveBeenCalled();
  });

  it('Save all: все записи удались — close; ошибка записи — cancel и тост', async () => {
    const save = vi.fn(async () => true);
    expect(await answerWindowClose({ dirty: () => dirty, ask: async () => 'save', save, toast: vi.fn() })).toBe('close');
    expect(save).toHaveBeenCalledTimes(2);
    const toast = vi.fn();
    const failing = vi.fn(async (_w: string, tabId: string) => tabId !== A);
    expect(await answerWindowClose({ dirty: () => dirty, ask: async () => 'save', save: failing, toast })).toBe('cancel');
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
