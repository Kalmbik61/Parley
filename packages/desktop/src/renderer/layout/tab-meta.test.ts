/**
 * Тесты 6 и 7 куска 2.4: заголовки всех шести видов вкладок (спека 5.3) и
 * обрезка заголовка по кодовым точкам (план, «Числа»: 40).
 */

import { describe, expect, it } from 'vitest';
import type { Room, WorkEntry, WorkSession } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { FileRootSpec, TabSpec } from '../../shared/layout-types.js';
import { bufferKey } from '../files/buffer.js';
import { EMPTY_EXTRAS, fileTabHint, fileTabTitles, tabMeta, truncateTitle, type TabMetaExtras } from './tab-meta.js';

function session(id: string, label: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
    worktree: null,
  };
}

function room(id: string, title: string): Room {
  return { id, title, creator: 'human', members: [], createdAt: '2026-01-01T00:00:00.000Z' };
}

function entry(sessions: WorkSession[], rooms: Room[] = []): WorkEntry {
  return {
    projectPath: '/tmp/p',
    map: {
      schemaVersion: 2,
      rooms,
      work: { id: 'w', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions,
      messages: [],
    },
  };
}

describe('tabMeta — тест 6', () => {
  const e = entry([session('s-02', 'исполнитель')], [room('r-01', 'общая')]);

  it('terminal: ярлык сессии, значок terminal, сессия для точки состояния', () => {
    const meta = tabMeta({ kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' }, e);
    expect(meta.title).toBe('S02 исполнитель');
    expect(meta.icon).toBe('terminal');
    expect(meta.session?.id).toBe('s-02');
    expect(meta.unread).toBe(false);
    expect(meta.dirty).toBe(false);
    expect(meta.favicon).toBeNull();
  });

  // Раунд исправлений 1 куска 3.3: метка-страж core `NEW_LABEL` — по-русски, окно
  // показывает английскую.
  it('terminal: метка новой сессии из core — английская', () => {
    const meta = tabMeta({ kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01' }, entry([session('s-01', 'новая сессия')]));
    expect(meta.title).toBe('S01 New session');
  });

  it('terminal без сессии в карте — тег без ярлыка, session: null', () => {
    const meta = tabMeta({ kind: 'terminal', id: 'terminal:s-09', sessionId: 's-09' }, e);
    expect(meta.title).toBe('S09');
    expect(meta.session).toBeNull();
  });

  it('mail: «Mail», значок mail', () => {
    const meta = tabMeta({ kind: 'mail', id: 'mail' }, e);
    expect(meta.title).toBe('Mail');
    expect(meta.icon).toBe('mail');
  });

  it('room: название комнаты, значок room', () => {
    const meta = tabMeta({ kind: 'room', id: 'room:r-01', roomId: 'r-01' }, e);
    expect(meta.title).toBe('общая');
    expect(meta.icon).toBe('room');
  });

  it('room без комнаты в карте — запасной заголовок', () => {
    const meta = tabMeta({ kind: 'room', id: 'room:r-09', roomId: 'r-09' }, e);
    expect(meta.title).toBe('Room');
  });

  it('diff без коммита: «Changes S02»', () => {
    const meta = tabMeta({ kind: 'diff', id: 'diff:s-02', sessionId: 's-02', commit: null }, e);
    expect(meta.title).toBe('Changes S02');
    expect(meta.icon).toBe('diff');
  });

  it('diff с коммитом: «Changes S02 · <7 символов hash>»', () => {
    const meta = tabMeta(
      { kind: 'diff', id: 'diff:s-02:abcdef1234', sessionId: 's-02', commit: 'abcdef1234567' },
      e,
    );
    expect(meta.title).toBe('Changes S02 · abcdef1');
  });

  it('file: имя файла из пути', () => {
    const meta = tabMeta({ kind: 'file', id: 'file:p:src/index.ts', root: { kind: 'project' }, path: 'src/index.ts' }, e);
    expect(meta.title).toBe('index.ts');
    expect(meta.icon).toBe('file');
  });

  it('browser: адрес — заголовка страницы ещё нет (этап 9)', () => {
    const meta = tabMeta({ kind: 'browser', id: 'browser:abc123', url: 'https://example.com' }, e);
    expect(meta.title).toBe('https://example.com');
    expect(meta.icon).toBe('browser');
  });

  it('entry: null — все виды не падают', () => {
    expect(tabMeta({ kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' }, null).title).toBe('S02');
    expect(tabMeta({ kind: 'room', id: 'room:r-01', roomId: 'r-01' }, null).title).toBe('Room');
  });
});

describe('truncateTitle — тест 7', () => {
  it('короче предела — не трогает', () => {
    expect(truncateTitle('S02 исполнитель', 40)).toBe('S02 исполнитель');
  });

  it('50 эмодзи, предел 40 — 40 эмодзи и «…», без одиночных суррогатов', () => {
    const result = truncateTitle('🙂'.repeat(50), 40);
    const codePoints = Array.from(result);
    expect(codePoints).toHaveLength(41);
    expect(codePoints.slice(0, 40).every((ch) => ch === '🙂')).toBe(true);
    expect(codePoints[40]).toBe('…');
    // Ни один суррогат не остался в одиночестве: строка целиком — валидные code points.
    expect(result).toBe('🙂'.repeat(40) + '…');
  });
});

// Тест 10 куска 4.2: отметки вкладки терминала из внимания (спека 7.3).
describe('tabMeta — extras.attention (тест 10 куска 4.2)', () => {
  const e = entry([session('s-02', 'исполнитель')]);
  const tab = { kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02' } as const;
  const key = refKey({ projectPath: '/tmp/p', workId: 'w', sessionId: 's-02' });
  const extras = (attention: TabMetaExtras['attention']): TabMetaExtras => ({ ...EMPTY_EXTRAS, attention });

  it('needs-you → unread и needsYou', () => {
    const meta = tabMeta(tab, e, extras({ [key]: 'needs-you' }));
    expect(meta.unread).toBe(true);
    expect(meta.needsYou).toBe(true);
  });

  it('unseen → unread, но не needsYou', () => {
    const meta = tabMeta(tab, e, extras({ [key]: 'unseen' }));
    expect(meta.unread).toBe(true);
    expect(meta.needsYou).toBe(false);
  });

  it('working → ни того, ни другого; без extras — оба ложны, как в этапе 2', () => {
    expect(tabMeta(tab, e, extras({ [key]: 'working' }))).toMatchObject({ unread: false, needsYou: false });
    expect(tabMeta(tab, e)).toMatchObject({ unread: false, needsYou: false });
  });

  it('вкладка почты extras не трогают', () => {
    expect(tabMeta({ kind: 'mail', id: 'mail' }, e, extras({ [key]: 'needs-you' }))).toMatchObject({ unread: false, needsYou: false });
  });
});

// Тест 9 куска 7.3a: точка «не сохранён» по bufferKey и заголовки файлов строки.
describe('tabMeta — dirty вкладки file (тест 9 куска 7.3a)', () => {
  const tab = { kind: 'file', id: 'file:p:src/a.ts', root: { kind: 'project' }, path: 'src/a.ts' } as const;
  const workA = entry([]);
  const workB: WorkEntry = { ...workA, map: { ...workA.map, work: { ...workA.map.work, id: 'w-b' } } };

  it('грязный буфер работы A — точка на её вкладке, на такой же вкладке работы B того же проекта — нет', () => {
    const extras: TabMetaExtras = { ...EMPTY_EXTRAS, dirtyTabIds: new Set([bufferKey('/tmp/p w', tab.id)]) };
    expect(tabMeta(tab, workA, extras).dirty).toBe(true);
    expect(tabMeta(tab, workB, extras).dirty).toBe(false);
    expect(tabMeta(tab, workA).dirty).toBe(false);
  });
});

describe('fileTabTitles (тест 9 куска 7.3a)', () => {
  const fileTab = (path: string, root: FileRootSpec = { kind: 'project' }): TabSpec => ({ kind: 'file', id: `file:${path}`, root, path });

  it('src/index.ts и docs/index.ts — с папкой; одиночный a.ts — имя; не-файлы не входят', () => {
    const titles = fileTabTitles([fileTab('src/index.ts'), fileTab('docs/index.ts'), fileTab('lib/a.ts'), { kind: 'mail', id: 'mail' }]);
    expect(titles.get('file:src/index.ts')).toBe('src/index.ts');
    expect(titles.get('file:docs/index.ts')).toBe('docs/index.ts');
    expect(titles.get('file:lib/a.ts')).toBe('a.ts');
    expect(titles.has('mail')).toBe(false);
  });

  it('файл в корне рядом с тёзкой в папке — имя без папки; глубокий путь — только ближняя папка', () => {
    const titles = fileTabTitles([fileTab('index.ts'), fileTab('a/b/c/index.ts')]);
    expect(titles.get('file:index.ts')).toBe('index.ts');
    expect(titles.get('file:a/b/c/index.ts')).toBe('c/index.ts');
  });

  // Раунд fix-live, D5: одинаковый путь из разных корней различает метка корня, а не папка.
  const S01: FileRootSpec = { kind: 'worktree', sessionId: 's-01' };
  const S02: FileRootSpec = { kind: 'worktree', sessionId: 's-02' };
  const rootTab = (path: string, root: FileRootSpec): TabSpec => ({
    kind: 'file',
    id: `file:${root.kind === 'project' ? 'p' : `w:${root.sessionId}`}:${path}`,
    root,
    path,
  });

  it('один путь из двух worktree — имя и метка сессии: app.ts · S01 и app.ts · S02', () => {
    const titles = fileTabTitles([rootTab('src/app.ts', S01), rootTab('src/app.ts', S02)]);
    expect(titles.get('file:w:s-01:src/app.ts')).toBe('app.ts · S01');
    expect(titles.get('file:w:s-02:src/app.ts')).toBe('app.ts · S02');
  });

  it('один путь из папки проекта и worktree — метка папки проекта: Project', () => {
    const titles = fileTabTitles([rootTab('src/app.ts', { kind: 'project' }), rootTab('src/app.ts', S02)]);
    expect(titles.get('file:p:src/app.ts')).toBe('app.ts · Project');
    expect(titles.get('file:w:s-02:src/app.ts')).toBe('app.ts · S02');
  });

  it('одно имя в двух папках одного корня — только папка, метки корня нет', () => {
    const titles = fileTabTitles([rootTab('src/index.ts', S01), rootTab('docs/index.ts', S01)]);
    expect(titles.get('file:w:s-01:src/index.ts')).toBe('src/index.ts');
    expect(titles.get('file:w:s-01:docs/index.ts')).toBe('docs/index.ts');
  });

  it('всё вместе: папка у тёзок в разных папках, метка — только у пути, открытого из двух корней', () => {
    const titles = fileTabTitles([rootTab('src/app.ts', S01), rootTab('src/app.ts', S02), rootTab('lib/app.ts', S01), rootTab('b.ts', S02)]);
    expect(titles.get('file:w:s-01:src/app.ts')).toBe('src/app.ts · S01');
    expect(titles.get('file:w:s-02:src/app.ts')).toBe('src/app.ts · S02');
    expect(titles.get('file:w:s-01:lib/app.ts')).toBe('lib/app.ts');
    expect(titles.get('file:w:s-02:b.ts')).toBe('b.ts');
  });

  it('длинное имя обрезается, метка корня остаётся видна', () => {
    const long = `${'x'.repeat(60)}.ts`;
    const titles = fileTabTitles([rootTab(long, S01), rootTab(long, S02)]);
    const title = titles.get(`file:w:s-02:${long}`) ?? '';
    expect(title.endsWith('… · S02')).toBe(true);
    expect(Array.from(title).length).toBeLessThanOrEqual(41);
  });
});

describe('fileTabHint (раунд fix-live, D5)', () => {
  it('подсказка файловой вкладки — всегда путь и метка корня', () => {
    expect(fileTabHint({ kind: 'file', id: 'f', root: { kind: 'worktree', sessionId: 's-02' }, path: 'src/app.ts' })).toBe('src/app.ts · S02');
    expect(fileTabHint({ kind: 'file', id: 'f', root: { kind: 'project' }, path: 'src/app.ts' })).toBe('src/app.ts · Project');
  });
});

describe('tabMeta — вкладка браузера (тест 11 куска 9.2a)', () => {
  const tab: TabSpec = { kind: 'browser', id: 'browser:abc123', url: 'http://localhost:5173/' };
  const extras = (title: string | null, favicon: string | null): TabMetaExtras => ({
    ...EMPTY_EXTRAS,
    browser: { [tab.id]: { title, favicon } },
  });

  it('заголовок страницы и favicon из extras.browser', () => {
    const meta = tabMeta(tab, null, extras('Dev server', 'data:image/png;base64,AA=='));
    expect(meta.title).toBe('Dev server');
    expect(meta.favicon).toBe('data:image/png;base64,AA==');
    expect(meta.icon).toBe('browser');
  });

  it('без заголовка (и с пустым) — адрес; без адреса — New tab; длинный заголовок обрезан', () => {
    expect(tabMeta(tab, null).title).toBe('http://localhost:5173/');
    expect(tabMeta(tab, null, extras('', null)).title).toBe('http://localhost:5173/');
    expect(tabMeta({ ...tab, url: '' }, null).title).toBe('New tab');
    expect(tabMeta(tab, null, extras('x'.repeat(100), null)).title).toBe(`${'x'.repeat(40)}…`);
    expect(tabMeta(tab, null).favicon).toBeNull();
  });
});
