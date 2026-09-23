/**
 * Комната на месте панели агента: рамка, заголовок с числом писем, пометки и
 * строки ленты (дизайн комнаты 2026-09-23, раздел 5; приёмка плана, кусок 3).
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { pinUnicodeGlyphs } from '../../test/glyphs-env.js';
import { glyphs } from '../glyphs.js';
import type { RoomLine, RoomView } from '../room-view.js';
import { Room, roomMarks } from './room.js';

pinUnicodeGlyphs();

const g = glyphs();

const view = (lines: readonly RoomLine[] = [], patch: Partial<RoomView> = {}): RoomView => ({
  title: 'комната · 5 писем',
  unread: 0,
  lines,
  below: 0,
  total: lines.length,
  ...patch,
});

describe('roomMarks (5.1)', () => {
  it('вида нет — пометок нет', () => {
    expect(roomMarks(null, g)).toBe('');
  });

  it('непрочитанного и хвоста нет — пустая строка', () => {
    expect(roomMarks(view(), g)).toBe('');
  });

  it('только непрочитанные', () => {
    expect(roomMarks(view([], { unread: 3 }), g)).toBe('▤3');
  });

  it('непрочитанные и хвост ленты вместе', () => {
    expect(roomMarks(view([], { unread: 3, below: 12 }), g)).toBe('▤3 ↓12');
  });
});

describe('Room рамка (5.1)', () => {
  const sample = (): RoomView =>
    view(
      [
        { text: 'S01 (Claude) · S02 (Codex)', tone: 'muted' },
        { text: '16:23  S01 (Claude) → S02 (Codex) · вопрос', tone: 'head', mark: 'unseen' },
        { text: 'вопрос без ответа', tone: 'body' },
      ],
      { unread: 3, below: 12 },
    );

  const frameOf = (props: { view: RoomView | null; width: number; height: number }): string[] =>
    (render(<Room {...props} />).lastFrame() ?? '').split('\n');

  it('верхняя грань несёт «комната · N писем» слева и пометки справа', () => {
    const rows = frameOf({ view: sample(), width: 30, height: 8 });
    const top = rows[0] ?? '';
    expect(top).toHaveLength(32); // width + 2 — боковые грани.
    expect(top.startsWith('╭─ комната · 5 писем ')).toBe(true);
    expect(top).toContain('▤3 ↓12');
    expect(top.endsWith('─╮')).toBe(true);
  });

  it('нижняя грань замыкает комнату', () => {
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
    expect(rows.some((row) => row.includes('S01 (Claude) · S02 (Codex)'))).toBe(true);
    expect(rows.some((row) => row.includes('вопрос без ответа'))).toBe(true);
  });

  it('непрочитанное письмо помечено глифом перед строкой', () => {
    const rows = frameOf({ view: sample(), width: 30, height: 8 });
    expect(rows.some((row) => row.includes('▤ 16:23'))).toBe(true);
  });

  it('высота — height содержимого плюс две строки рамки (как у панели)', () => {
    const rows = frameOf({ view: sample(), width: 30, height: 8 });
    expect(rows).toHaveLength(10);
  });

  it('работа не выбрана — рамка на месте, заголовок «комната» без пометок', () => {
    const rows = frameOf({ view: null, width: 30, height: 8 });
    expect(rows[0]?.startsWith('╭')).toBe(true);
    expect(rows[0]).toContain('комната');
    expect(rows[0]).not.toMatch(/[▤↓]/);
    expect(rows.at(-1)).toBe(`╰${'─'.repeat(30)}╯`);
  });

  it('заголовок письма длиннее ширины режется, а не переносится', () => {
    const long = 'x'.repeat(80);
    const rows = frameOf({
      view: view([{ text: long, tone: 'head' }]),
      width: 20,
      height: 6,
    });
    const row = rows.find((line) => line.includes('x'));
    expect(row).toBeDefined();
    expect(row).toHaveLength(22);
    expect(row).not.toContain(g.ellipsis);
  });
});

describe('Room: строка тела не шире width — инвариант по набору ширин панели', () => {
  it('каждая строка ленты, включая пустой заполнитель, ровно width + 2', () => {
    for (const width of [10, 18, 26, 40, 60, 92, 120]) {
      const rows = (
        render(
          <Room
            view={view([
              { text: 'участники'.repeat(20), tone: 'muted' },
              { text: 'тело письма '.repeat(30), tone: 'body' },
              { text: '', tone: 'muted', rule: true },
            ])}
            width={width}
            height={10}
          />,
        ).lastFrame() ?? ''
      ).split('\n');
      for (const row of rows) expect(row).toHaveLength(width + 2);
    }
  });
});

describe('высота комнаты: height содержимого плюс две строки рамки (как у панели)', () => {
  const rows = (node: Parameters<typeof render>[0]): number =>
    (render(node).lastFrame() ?? '').split('\n').length;

  it('комната занимает ровно height + 2 при любой высоте, включая вырожденную', () => {
    for (const height of [0, 1, 2, 3, 6, 12]) {
      expect(rows(<Room view={null} width={30} height={height} />)).toBe(height + 2);
    }
  });

  it('лента длиннее отведённого не растягивает комнату', () => {
    const lines: RoomLine[] = Array.from({ length: 50 }, (_, at) => ({
      text: `письмо ${at}`,
      tone: 'body',
    }));
    for (const height of [4, 8, 20]) {
      expect(rows(<Room view={view(lines)} width={30} height={height} />)).toBe(height + 2);
    }
  });
});
