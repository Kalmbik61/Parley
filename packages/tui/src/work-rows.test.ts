import type { WorkEntry, WorkMap, WorkSession } from '@harnas/core';
import { describe, expect, it } from 'vitest';
import { glyphs } from './glyphs.js';
import { buildRows, layoutRows, rowLines, workKey, workTail, type WorkRow } from './work-rows.js';

const g = glyphs({});

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'план',
    task: 'составить план',
    parent: null,
    contextFrom: [],
    status: 'active',
    history: [],
    startedAt: '2026-09-02T09:12:00.000Z',
    endedAt: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    ...over,
  };
}

function entry(
  projectPath: string,
  id: string,
  over: Partial<WorkMap['work']> = {},
  sessions: WorkSession[] = [],
  messages: WorkMap['messages'] = [],
): WorkEntry {
  return {
    projectPath,
    map: {
      schemaVersion: 1,
      work: {
        id,
        title: id,
        goal: '',
        status: 'active',
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
        ...over,
      },
      sessions,
      messages,
    },
  };
}

const labels = (rows: WorkRow[]): string[] =>
  rows.map((row) => (row.kind === 'work' ? row.work.title : `  ${row.session.label}`));

describe('buildRows', () => {
  it('проекты идут по свежести самой свежей работы (6.5)', () => {
    const rows = buildRows([
      entry('/dev/site', 'w-0002', { title: 'Лендинг', updatedAt: '2026-09-01T10:00:00.000Z' }),
      entry('/dev/shop', 'w-0001', { title: 'Авторизация', updatedAt: '2026-09-02T10:00:00.000Z' }),
    ]);

    expect(labels(rows)).toEqual(['Авторизация', 'Лендинг']);
    expect(rows[0]?.startsProject).toBe(true);
    expect(rows[0]?.projectPath).toBe('/dev/shop');
    expect(rows[1]?.startsProject).toBe(true);
  });

  it('в проекте active выше done, внутри — по свежести', () => {
    const rows = buildRows([
      entry('/dev/shop', 'w-0001', {
        title: 'Готовая',
        status: 'done',
        updatedAt: '2026-09-03T10:00:00.000Z',
      }),
      entry('/dev/shop', 'w-0002', { title: 'Старая', updatedAt: '2026-09-01T10:00:00.000Z' }),
      entry('/dev/shop', 'w-0003', { title: 'Свежая', updatedAt: '2026-09-02T10:00:00.000Z' }),
    ]);

    expect(labels(rows)).toEqual(['Свежая', 'Старая', 'Готовая']);
    // Заголовок проекта рисуется один раз — перед первой работой.
    expect(rows.map((row) => row.startsProject)).toEqual([true, false, false]);
  });

  it('archived не показываются совсем', () => {
    const rows = buildRows([
      entry('/dev/shop', 'w-0001', { title: 'Живая' }),
      entry('/dev/shop', 'w-0002', { title: 'Сданная в архив', status: 'archived' }),
    ]);
    expect(labels(rows)).toEqual(['Живая']);
  });

  it('сессии идут деревом: дети под родителем с отступом', () => {
    const rows = buildRows([
      entry('/dev/shop', 'w-0001', {}, [
        session({ id: 's-01', label: 'план' }),
        session({ id: 's-02', label: 'бэкенд' }),
        session({ id: 's-03', label: 'ревью', parent: 's-02' }),
      ]),
    ]);

    expect(labels(rows)).toEqual(['w-0001', '  план', '  бэкенд', '  ревью']);
    expect(rows[3]?.kind === 'session' && rows[3].depth).toBe(1);
    expect(rows[1]?.kind === 'session' && rows[1].depth).toBe(0);
  });

  it('done работы при старте свёрнуты, active — развёрнуты', () => {
    const sessions = [session({ id: 's-01', label: 'план' })];
    const rows = buildRows([
      entry('/dev/shop', 'w-0001', { title: 'Живая' }, sessions),
      entry('/dev/shop', 'w-0002', { title: 'Релиз', status: 'done' }, sessions),
    ]);

    expect(labels(rows)).toEqual(['Живая', '  план', 'Релиз']);
    expect(rows[2]?.kind === 'work' && rows[2].total).toBe(1);
  });

  it('свёртка переопределяется явно — в обе стороны', () => {
    const sessions = [session({ id: 's-01', label: 'план' })];
    const entries = [
      entry('/dev/shop', 'w-0001', { title: 'Живая' }, sessions),
      entry('/dev/shop', 'w-0002', { title: 'Релиз', status: 'done' }, sessions),
    ];
    const expanded = new Map([
      [workKey('/dev/shop', 'w-0001'), false],
      [workKey('/dev/shop', 'w-0002'), true],
    ]);

    expect(labels(buildRows(entries, { expanded }))).toEqual(['Живая', 'Релиз', '  план']);
  });

  it('пустая работа объясняет, что делать', () => {
    const rows = buildRows([entry('/dev/shop', 'w-0001', { title: 'Платежи' })]);
    expect(rows[0]?.kind === 'work' && rows[0].note).toBe('сессий нет · n — новая');
  });

  it('фильтр прячет сессии, но не работы, и помечает опустевшие', () => {
    const rows = buildRows(
      [
        entry('/dev/shop', 'w-0001', {}, [
          session({ id: 's-01', label: 'план', provider: 'claude' }),
          session({ id: 's-02', label: 'бэкенд', provider: 'codex' }),
        ]),
        entry('/dev/shop', 'w-0002', { title: 'Платежи' }, [
          session({ id: 's-01', label: 'план', provider: 'claude' }),
        ]),
      ],
      { filter: 'codex' },
    );

    expect(labels(rows)).toEqual(['w-0001', '  бэкенд', 'Платежи']);
    expect(rows[2]?.kind === 'work' && rows[2].note).toBe('фильтр: Cx');
    // Счётчики описывают работу целиком, а не то, что осталось после фильтра.
    expect(rows[0]?.kind === 'work' && rows[0].counters.statuses.active).toBe(2);
  });

  it('непрочитанные сообщения считаются работе и адресату', () => {
    const rows = buildRows([
      entry(
        '/dev/shop',
        'w-0001',
        {},
        [session({ id: 's-01', label: 'план' }), session({ id: 's-02', label: 'бэкенд' })],
        [
          {
            id: 'm-01',
            from: 's-01',
            to: 's-02',
            at: '2026-09-02T09:41:00.000Z',
            text: 'жду',
            readAt: null,
          },
          {
            id: 'm-02',
            from: 's-02',
            to: 's-01',
            at: '2026-09-02T09:42:00.000Z',
            text: 'ок',
            readAt: '2026-09-02T09:43:00.000Z',
          },
        ],
      ),
    ]);

    expect(rows[0]?.kind === 'work' && rows[0].counters.unread).toBe(1);
    expect(rows[1]?.kind === 'session' && rows[1].unread).toBe(0);
    expect(rows[2]?.kind === 'session' && rows[2].unread).toBe(1);
  });

  it('живые метрики приходят снаружи — карта их не хранит, пока сессия жива', () => {
    const rows = buildRows(
      [entry('/dev/shop', 'w-0001', {}, [session({ id: 's-01', providerSessionId: 'uuid-1' })])],
      {
        live: (item) =>
          item.providerSessionId === 'uuid-1'
            ? {
                durationMs: 32 * 60_000,
                tokens: { input: 1_200, output: 845, cacheRead: 0, cacheWrite: 0 },
                model: 'claude-opus-5',
              }
            : { durationMs: null, tokens: null, model: null },
      },
    );

    expect(rows[1]?.kind === 'session' && rows[1].live.durationMs).toBe(32 * 60_000);
    expect(rows[1]?.kind === 'session' && rows[1].live.model).toBe('claude-opus-5');
  });

  it('метрики из карты важнее живых: завершённая сессия их уже зафиксировала', () => {
    const done = session({
      id: 's-01',
      status: 'done',
      metrics: {
        durationMs: 8 * 60_000,
        tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        toolCalls: {},
      },
    });
    const rows = buildRows([entry('/dev/shop', 'w-0001', {}, [done])], {
      live: () => ({ durationMs: 999, tokens: null, model: 'claude-opus-5' }),
    });

    expect(rows[1]?.kind === 'session' && rows[1].live.durationMs).toBe(8 * 60_000);
    expect(rows[1]?.kind === 'session' && rows[1].live.tokens?.input).toBe(10);
    // Модель в карте не хранится — она всегда из логов провайдера.
    expect(rows[1]?.kind === 'session' && rows[1].live.model).toBe('claude-opus-5');
  });
});

describe('workTail', () => {
  it('агрегат статусов и непрочитанных', () => {
    expect(workTail({ statuses: { active: 2, pending: 1 }, unread: 1 }, g, 20)).toBe('●2 ◌1 ▤1');
    expect(workTail({ statuses: { done: 4 }, unread: 0 }, g, 20)).toBe('✓4');
  });

  it('работа без сессий — прочерк', () => {
    expect(workTail({ statuses: {}, unread: 0 }, g, 20)).toBe('—');
  });

  it('на узкой ширине сжимается до ▤N, а без сообщений — до ●N (6.4)', () => {
    const counters = { statuses: { active: 2, pending: 1, done: 3 }, unread: 1 };
    expect(workTail(counters, g, 8)).toBe('●2 ◌1 ▤1');
    expect(workTail(counters, g, 5)).toBe('●2 ▤1');
    expect(workTail(counters, g, 2)).toBe('▤1');
    expect(workTail({ statuses: { active: 2, done: 3 }, unread: 0 }, g, 2)).toBe('●2');
  });
});

describe('rowLines и layoutRows', () => {
  const many = (count: number): WorkRow[] =>
    buildRows([
      entry(
        '/dev/shop',
        'w-0001',
        {},
        Array.from({ length: count }, (_, at) => session({ id: `s-${at}`, label: `шаг ${at}` })),
      ),
    ]);

  it('ряд сессии — две строки, работа — одна', () => {
    const rows = many(1);
    expect(rowLines(rows[0]!)).toBe(2); // работа + заголовок проекта над ней
    expect(rowLines(rows[1]!)).toBe(2);
  });

  it('пустая работа занимает строку заметки', () => {
    const rows = buildRows([entry('/dev/shop', 'w-0001')]);
    expect(rowLines(rows[0]!)).toBe(3);
  });

  it('окно считается в строках и не рвёт ряд', () => {
    const rows = many(20);
    const layout = layoutRows(rows, 10, 9);
    const shown = rows.slice(layout.start, layout.end);
    const lines =
      shown.reduce((sum, row) => sum + rowLines(row), 0) +
      (layout.above > 0 ? 1 : 0) +
      (layout.below > 0 ? 1 : 0) +
      (layout.stickyWork === null ? 0 : 1) +
      (layout.stickyProject === null ? 0 : 1);

    expect(lines).toBeLessThanOrEqual(9);
    expect(layout.start).toBeLessThanOrEqual(10);
    expect(layout.end).toBeGreaterThan(10);
  });

  it('заголовки работы и проекта липнут, когда окно начинается с середины', () => {
    const rows = many(20);
    const layout = layoutRows(rows, 15, 9);
    expect(layout.above).toBeGreaterThan(0);
    expect(layout.stickyWork).toBe(0);
    expect(layout.stickyProject).toBe('/dev/shop');
  });

  it('липкий заголовок работы не считается скрытым рядом (6.6)', () => {
    const rows = many(20);
    const layout = layoutRows(rows, 15, 9);
    // Ряд работы нарисован над окном: «… N выше» считает только спрятанные сессии.
    expect(layout.stickyWork).toBe(0);
    expect(layout.above).toBe(layout.start - 1);
  });

  it('начало списка липких заголовков не требует', () => {
    const layout = layoutRows(many(20), 0, 9);
    expect(layout.start).toBe(0);
    expect(layout.above).toBe(0);
    expect(layout.stickyWork).toBeNull();
    expect(layout.stickyProject).toBeNull();
    expect(layout.below).toBeGreaterThan(0);
  });

  it('короткий список показывается целиком', () => {
    const rows = many(1);
    expect(layoutRows(rows, 0, 20)).toMatchObject({
      start: 0,
      end: rows.length,
      above: 0,
      below: 0,
    });
  });

  it('пустой список и нулевая высота', () => {
    expect(layoutRows([], 0, 10)).toMatchObject({ start: 0, end: 0 });
    expect(layoutRows(many(3), 0, 0)).toMatchObject({ start: 0, end: 0 });
  });
});
