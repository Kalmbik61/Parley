/**
 * Заголовок колонки треда (спецификация 2026-09-08, 6.2–6.3): ярлык слева,
 * непрочитанные и хвост ленты справа.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { glyphs } from '../glyphs.js';
import type { ThreadView } from '../thread-view.js';
import { Thread, threadHead, threadMarks } from './thread.js';

pinUnicodeGlyphs();

const g = glyphs();

const view = (patch: Partial<ThreadView> = {}): ThreadView => ({
  title: 'тред · план',
  owner: 's-01',
  unread: 0,
  lines: [],
  below: 0,
  total: 0,
  ...patch,
});

describe('threadHead (6.2, 6.3)', () => {
  it('сессии нет — одно слово: колонка не врёт про чужой тред', () => {
    expect(threadHead(null, 30, g)).toBe('тред');
  });

  it('пометок нет — один ярлык без выравнивания вправо', () => {
    expect(threadHead(view(), 30, g)).toBe('тред · план');
  });

  it('непрочитанные и хвост ленты стоят у правого края', () => {
    const head = threadHead(view({ unread: 3, below: 12 }), 30, g);
    expect(head).toHaveLength(30);
    expect(head.startsWith('тред · план')).toBe(true);
    expect(head.endsWith('▤3 ↓12')).toBe(true);
  });

  it('длинный ярлык уступает пометкам, а не выдавливает их', () => {
    const head = threadHead(view({ title: 'тред · очень длинный ярлык', unread: 9 }), 20, g);
    expect(head).toHaveLength(20);
    expect(head).toContain('…');
    expect(head.endsWith('▤9')).toBe(true);
  });
});

// Пометки вынесены из `threadHead` отдельной функцией: ей же теперь считает
// правое поле верхней грани дока (план рамок, находка сверки: рамка треда).
describe('threadMarks (6.2, 6.3)', () => {
  it('сессии нет — пометок нет', () => {
    expect(threadMarks(null, g)).toBe('');
  });

  it('непрочитанного и хвоста нет — пустая строка', () => {
    expect(threadMarks(view(), g)).toBe('');
  });

  it('только непрочитанные', () => {
    expect(threadMarks(view({ unread: 3 }), g)).toBe('▤3');
  });

  it('непрочитанные и хвост ленты вместе', () => {
    expect(threadMarks(view({ unread: 3, below: 12 }), g)).toBe('▤3 ↓12');
  });
});

/**
 * Тред в рамке (план рамок, находка сверки: рамка треда): верхняя грань несёт
 * заголовок и пометки, боковые — у каждой строки ленты, нижняя замыкает
 * колонку. Приём и бюджет — те же, что у блоков сайдбара (`frameLine`).
 */
describe('Thread рамка (план рамок, находка сверки: рамка треда)', () => {
  const sample = (): ThreadView =>
    view({
      unread: 3,
      below: 12,
      lines: [{ text: 'первое письмо' }, { text: 'второе письмо' }],
    });

  const frameOf = (props: { view: ThreadView | null; width: number; height: number }): string[] =>
    (render(<Thread {...props} />).lastFrame() ?? '').split('\n');

  it('верхняя грань несёт ярлык слева и пометки справа', () => {
    const rows = frameOf({ view: sample(), width: 30, height: 8 });
    const top = rows[0] ?? '';
    expect(top).toHaveLength(32); // width + 2 — правая грань добавилась (задача 3).
    expect(top.startsWith('╭─ тред · план ')).toBe(true);
    expect(top).toContain('▤3 ↓12');
    expect(top.endsWith('─╮')).toBe(true);
  });

  it('нижняя грань замыкает колонку', () => {
    const rows = frameOf({ view: sample(), width: 30, height: 8 });
    expect(rows.at(-1)).toBe(`╰${'─'.repeat(30)}╯`);
  });

  it('строки ленты идут между боковыми гранями шириной ровно тела', () => {
    const rows = frameOf({ view: sample(), width: 30, height: 8 });
    for (const row of rows.slice(1, -1)) {
      expect(row.startsWith('│')).toBe(true);
      expect(row.endsWith('│')).toBe(true);
      expect(row).toHaveLength(32);
    }
    expect(rows.some((row) => row.includes('первое письмо'))).toBe(true);
    expect(rows.some((row) => row.includes('второе письмо'))).toBe(true);
  });

  it('высота колонки остаётся ровно height строк — рамка забирает две, не одну', () => {
    const rows = frameOf({ view: sample(), width: 30, height: 8 });
    expect(rows).toHaveLength(8);
  });

  it('сессия не выбрана — рамка на месте, ярлык «тред» без пометок', () => {
    const rows = frameOf({ view: null, width: 30, height: 8 });
    expect(rows[0]?.startsWith('╭')).toBe(true);
    expect(rows[0]).toContain('тред');
    expect(rows[0]).not.toMatch(/[▤↓]/);
    expect(rows.at(-1)).toBe(`╰${'─'.repeat(30)}╯`);
  });
});

describe('высота колонки треда (план рамок, находка сверки)', () => {
  const rows = (node: Parameters<typeof render>[0]): number =>
    (render(node).lastFrame() ?? '').split('\n').length;

  // Грани встают в результат безусловно, а строки ленты приходят снаружи:
  // без обрезки тред перерастал отведённое и сдвигал раскладку.
  it('колонка занимает ровно height при любой высоте, включая вырожденную', () => {
    for (const height of [0, 1, 2, 3, 6, 12]) {
      expect(rows(<Thread view={null} width={30} height={height} />)).toBe(Math.max(1, height));
    }
  });

  it('лента длиннее отведённого не растягивает колонку', () => {
    const lines = Array.from({ length: 50 }, (_, at) => ({ text: `письмо ${at}` }));
    for (const height of [4, 8, 20]) {
      expect(rows(<Thread view={view({ lines })} width={30} height={height} />)).toBe(height);
    }
  });
});
