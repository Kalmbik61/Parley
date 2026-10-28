import { describe, expect, it } from 'vitest';
import type { WorkEntry, WorkMap } from '@parley/core';
import { findText, soundKey } from './find.js';
import type { OverviewSource } from './overview.js';

function session(id: string, label: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    label,
    provider: 'claude',
    task: `task of ${label}`,
    summary: null,
    lifecycle: 'active',
    ...extra,
  };
}
function entry(
  projectPath: string,
  workId: string,
  title: string,
  overrides: Partial<WorkMap> = {},
): WorkEntry {
  return {
    projectPath,
    map: {
      schemaVersion: 2,
      work: { id: workId, title, goal: '', status: 'active' },
      sessions: [session('s-03', 'S03 Ruslan'), session('s-05', 'S05 Vera')],
      messages: [],
      rooms: [
        {
          id: 'r-1',
          title: 'Auth',
          creator: 's-03',
          members: ['s-03', 's-05'],
          createdAt: '',
          lead: 's-03',
          proposal: null,
        },
      ],
      ...overrides,
    } as unknown as WorkMap,
  };
}
function source(entries: WorkEntry[]): OverviewSource {
  return { entries, live: () => undefined, roomTail: () => [] };
}

// «Site» — первая работа: в ней сессия с task про auth стоит в targetsOf раньше, чем комната «Auth» второй работы.
const site = entry('/u/site', 'w-1', 'Site', {
  sessions: [session('s-01', 'S01 Mark', { task: 'auth refactor' })],
  rooms: [],
} as unknown as Partial<WorkMap>);
// «Billing» в проекте scanum: S03 с ролью Reviewer, S05 с task про Safari, S09 закрыта; комната «Auth».
const billing = entry('/u/scanum', 'w-2', 'Billing', {
  sessions: [
    session('s-03', 'S03 Ruslan', { role: { source: 'builtin', name: 'Reviewer' } }),
    session('s-05', 'S05 Vera', { task: 'fix Safari login' }),
    session('s-09', 'S09 Old', { lifecycle: 'closed' }),
  ],
} as unknown as Partial<WorkMap>);
const src = source([site, billing]);

// 25 сессий с task «task of …» в одной работе.
const manySrc = source([
  entry('/u/many', 'w-9', 'Many', {
    sessions: Array.from({ length: 25 }, (_, i) =>
      session(`s-${String(i + 1).padStart(2, '0')}`, `S${String(i + 1).padStart(2, '0')} Agent`),
    ),
    rooms: [],
  } as unknown as Partial<WorkMap>),
]);

describe('soundKey', () => {
  it('«Сканум» и scanum звучат одинаково', () => {
    expect(soundKey('Сканум')).toBe('skanum');
    expect(soundKey('scanum')).toBe('skanum');
    expect(soundKey('Парлей')).toBe(soundKey('Parley'));
    expect(soundKey('my-harnas')).toBe('miharnas');
  });
  it('ё как е, твёрдый и мягкий знаки пропадают, двойные буквы — одна', () => {
    expect(soundKey('Ёлка')).toBe(soundKey('елка'));
    expect(soundKey('объём')).toBe('obem');
    expect(soundKey('Wallet')).toBe('valet');
  });
  it('ph — f, x — ks, q — k, остальные знаки отбрасываются', () => {
    expect(soundKey('phone')).toBe('fone');
    expect(soundKey('Max')).toBe('maks');
    expect(soundKey('queue')).toBe('kueue');
    expect(soundKey('--  ')).toBe('');
  });
});

describe('findText', () => {
  it('по имени проекта — работа', () => {
    expect(findText(src, 'scanum', { includeClosed: false })).toMatch(
      /^Work "Billing" \[work:[^\]]+\] \(project scanum\)$/m,
    );
  });
  it('«Сканум» находит проект scanum по звучанию', () => {
    expect(findText(src, 'Сканум', { includeClosed: false })).toContain('(project scanum)');
  });
  it('по роли и по задаче — сессия, с пометкой совпавшего поля', () => {
    expect(findText(src, 'reviewer', { includeClosed: false })).toMatch(
      /Session S03 Ruslan .* · role Reviewer/,
    );
    expect(findText(src, 'safari', { includeClosed: false })).toMatch(
      /Session S05 Vera .* — matched task: fix Safari login/,
    );
  });
  it('совпало summary — пометка matched summary, первые 120 знаков', () => {
    const long = `payments ${'x'.repeat(200)}`;
    const withSummary = source([
      entry('/u/p', 'w-1', 'P', {
        sessions: [session('s-03', 'S03 Ruslan', { task: '', summary: long })],
        rooms: [],
      } as unknown as Partial<WorkMap>),
    ]);
    const text = findText(withSummary, 'payments', { includeClosed: false });
    expect(text).toContain(` — matched summary: ${long.slice(0, 120)}`);
    expect(text).not.toContain(long.slice(0, 121));
  });
  it('закрытые — только с include_closed и с пометкой', () => {
    expect(findText(src, 'S09', { includeClosed: false })).toBe('Nothing found for "S09".');
    expect(findText(src, 'S09', { includeClosed: true })).toMatch(
      /^Session S09 Old \[[^\]]+\] claude · closed · /m,
    );
  });
  it('точное имя — первым', () => {
    // Сессия S01 с task «auth refactor» стоит в targetsOf раньше комнаты «Auth», но точное имя идёт первым.
    const lines = findText(src, 'auth', { includeClosed: false }).split('\n');
    expect(lines[0]).toMatch(/^Room "Auth"/);
    expect(
      lines.some((line) => /^Session S01 Mark .* — matched task: auth refactor$/.test(line)),
    ).toBe(true);
  });
  it('точное имя папки проекта у работы — тоже точное совпадение', () => {
    const lines = findText(src, 'scanum', { includeClosed: false }).split('\n');
    expect(lines[0]).toMatch(/^Work "Billing"/);
  });
  it('прямые совпадения есть — второй проход по звучанию не нужен', () => {
    // «scanum» совпадает прямо с проектом; «Сканум» в полях нет, но и не нужен.
    const text = findText(src, 'scanum', { includeClosed: false });
    expect(text.split('\n')).toHaveLength(1);
  });
  it('ничего не нашлось — Nothing found, даже по звучанию', () => {
    expect(findText(src, 'zzzqqq', { includeClosed: false })).toBe('Nothing found for "zzzqqq".');
  });
  it('запрос из одних знаков препинания не находит всё подряд по звучанию', () => {
    expect(findText(src, '---', { includeClosed: false })).toBe('Nothing found for "---".');
  });
  it('архивная работа — только с include_closed, с пометкой archived', () => {
    const archived = entry('/u/old', 'w-3', 'Legacy', {
      work: { id: 'w-3', title: 'Legacy', goal: '', status: 'archived' },
    } as Partial<WorkMap>);
    const withArchive = source([billing, archived]);
    expect(findText(withArchive, 'legacy', { includeClosed: false })).toBe(
      'Nothing found for "legacy".',
    );
    expect(findText(withArchive, 'legacy', { includeClosed: true })).toMatch(
      /^Work "Legacy" \[work:[^\]]+\] \(project old\) · archived$/m,
    );
  });
  it('больше 20 — 20 строк и хвост', () => {
    const lines = findText(manySrc, 'task', { includeClosed: false }).split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[20]).toMatch(/^…and \d+ more; say more precisely\.$/);
    expect(lines[20]).toBe('…and 5 more; say more precisely.');
  });
});
