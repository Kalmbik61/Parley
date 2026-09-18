/**
 * Заголовок колонки треда (спецификация 2026-09-08, 6.2–6.3): ярлык слева,
 * непрочитанные и хвост ленты справа.
 */

import { describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { glyphs } from '../glyphs.js';
import type { ThreadView } from '../thread-view.js';
import { threadHead } from './thread.js';

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
