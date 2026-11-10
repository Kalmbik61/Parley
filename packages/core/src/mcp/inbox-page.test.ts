import { describe, expect, it } from 'vitest';
import { INBOX_MAX_BYTES } from '../work/context-budget.js';
import { mcpResultBytes } from '../work/context-pages.js';
import type { Message } from '../work/types.js';
import { inboxPage } from './inbox-page.js';

const letter = (id: string, text: string): Message => ({
  id,
  roomId: null,
  from: 's-02',
  to: ['s-01'],
  at: '2026-11-10T10:00:00.000Z',
  text,
  kind: 'note',
  readBy: {},
});
const view = (message: Message): { id: string; text: string } => ({ id: message.id, text: message.text });
const many = (count: number, text: string): Message[] => Array.from({ length: count }, (_, index) => letter(`m-${index + 1}`, text));

describe('inboxPage', () => {
  it('пустой ящик — прежняя форма: extras равен notice, без remaining', () => {
    expect(inboxPage([], view, {})).toEqual({ messages: [], ids: [], extras: {} });
    const notice = { openAssignments: 2, hint: 'Reading does not complete assignments; call plan_tasks.' };
    expect(inboxPage([], view, notice).extras).toEqual(notice);
  });

  it('120 коротких писем: 50 старейших по порядку', () => {
    const letters = many(120, 'x');
    const page = inboxPage(letters, view, {});
    expect(page.ids).toEqual(letters.slice(0, 50).map((item) => item.id));
    expect(page.messages.map((item) => item.id)).toEqual(page.ids);
    expect(page.extras).toEqual({ remaining: 70, hint: '70 more unread: call check_inbox again.' });
  });

  it('потолок — инвариант по набору текстов, длин и числа писем', () => {
    for (const char of ['a', 'ж', '"', '\\', '\n', '😀']) {
      for (const length of [100, 4096, 40_000]) {
        for (const count of [1, 60]) {
          const letters = many(count, char.repeat(length));
          const { messages, ids, extras } = inboxPage(letters, view, {});
          const label = `${JSON.stringify(char)} x ${length} x ${count}`;
          expect(mcpResultBytes({ state: 'message', messages, ...extras }), label).toBeLessThanOrEqual(INBOX_MAX_BYTES);
          expect(messages.length, label).toBeGreaterThanOrEqual(1);
          expect(messages.length, label).toBeLessThanOrEqual(50);
          expect(ids, label).toEqual(letters.slice(0, ids.length).map((item) => item.id));
          const left = count - ids.length;
          expect(extras.remaining, label).toBe(left > 0 ? left : undefined);
        }
      }
      const huge = inboxPage([letter('m-1', char.repeat(200_000))], view, {});
      expect(mcpResultBytes({ state: 'message', messages: huge.messages, ...huge.extras }), JSON.stringify(char)).toBeLessThanOrEqual(INBOX_MAX_BYTES);
      expect(huge.ids).toEqual(['m-1']);
    }
  });

  it('огромное письмо отдаётся первым и урезанным', () => {
    const page = inboxPage([letter('m-1', 'a'.repeat(200_000))], view, {});
    const [only] = page.messages as { text: string; textBytes?: number }[];
    expect(page.ids).toEqual(['m-1']);
    expect(only?.text.endsWith('bytes in full]')).toBe(true);
    expect(only?.textBytes).toBe(200_000);
    expect(page.extras.hint).toContain('Message m-1 is cut');
    expect(page.extras.remaining).toBeUndefined();
  });

  it('подсказка заданий не теряется', () => {
    const page = inboxPage(many(120, 'x'), view, { openAssignments: 1, hint: 'Reading does not complete assignments; call plan_tasks.' });
    expect(page.extras.openAssignments).toBe(1);
    expect(page.extras.hint).toBe('70 more unread: call check_inbox again. Reading does not complete assignments; call plan_tasks.');
  });
});
