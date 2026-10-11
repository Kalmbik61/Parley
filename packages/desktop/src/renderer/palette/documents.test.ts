/**
 * Тесты 4–5 куска 6.2 (спека 9.1–9.2): документы палитры из хранилищ и их ранжирование.
 */

import { describe, expect, it } from 'vitest';
import type { WorkEntry } from '@parley/core';
import { ACTIONS, type ActionId } from '../../shared/keybindings.js';
import type { WorkLayout } from '../../shared/layout-types.js';
import { workAttention, type WorkAttention } from '../attention/derive.js';
import type { HistoryEntry } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { emptyLayout, openTab } from '../layout/tree.js';
import { workKey } from '../lib/tree-order.js';
import { makeLetter, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { buildDocuments, filesQuery, rankDocuments, SECTION_LIMITS, type PaletteDoc, type PaletteSection } from './documents.js';
import type { PaletteMode } from './store.js';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function keyOf(entry: WorkEntry): string {
  return workKey(entry.projectPath, entry.map.work.id);
}

function terminalTab(sessionId: string) {
  return { kind: 'terminal' as const, id: tabId.terminal(sessionId), sessionId };
}

function layoutWith(...sessionIds: string[]): WorkLayout {
  let layout = emptyLayout();
  for (const id of sessionIds) layout = openTab(layout, terminalTab(id));
  return layout;
}

interface Input {
  works: WorkEntry[];
  layouts?: Record<string, WorkLayout>;
  history?: HistoryEntry[];
  attention?: Record<string, WorkAttention>;
  branches?: Record<string, string | null>;
  mode?: PaletteMode;
  activeWorkKey?: string | null;
  available?: (id: ActionId) => boolean;
  wakePaused?: boolean | null;
  files?: PaletteDoc[] | null;
}

function build(input: Input): PaletteDoc[] {
  const attention =
    input.attention ?? Object.fromEntries(input.works.map((entry) => [keyOf(entry), workAttention(entry, {})]));
  return buildDocuments({
    works: input.works,
    activity: {},
    attention,
    branches: input.branches ?? {},
    order: input.works.map(keyOf),
    layouts: input.layouts ?? {},
    history: input.history ?? [],
    actions: ACTIONS,
    available: input.available ?? (() => true),
    wakePaused: input.wakePaused ?? false,
    providers: [{ id: 'claude', label: 'Claude Code' }],
    mode: input.mode ?? 'default',
    activeWorkKey: input.activeWorkKey ?? null,
    files: input.files === undefined ? null : input.files,
    run: () => {},
  });
}

function titles(docs: PaletteDoc[], section: PaletteSection): string[] {
  return docs.filter((doc) => doc.section === section).map((doc) => doc.title);
}

function doc(id: string, section: PaletteSection, patch: Partial<PaletteDoc> = {}): PaletteDoc {
  return { id, section, title: id, subtitle: '', fields: [], recencyAt: null, order: 0, icon: 'action', run: () => {}, ...patch };
}

// Подписи строк (спека окна 2026-09-29, 1.9 и снимок dark-03): вид строки и работа — «Tab · Платежи»,
// «Room · Платежи», у сессии — работа, слово состояния и провайдер, у работы — проект, число сессий и ветка,
// у действия — «Action». Поле поиска подпись не читает: ранжирование не меняется.
describe('buildDocuments — подписи строк (Organic, 1.9)', () => {
  const w = makeWork('w-01', {
    projectPath: '/tmp/shop',
    title: 'Платежи',
    sessions: [makeSession('s-01', 'план'), makeSession('s-02', 'бэкенд'), makeSession('s-03', 'старая', { lifecycle: 'closed' })],
    rooms: [makeRoom('r-01', 'Возвраты')],
  });
  const layout = openTab(openTab(layoutWith('s-01'), { kind: 'room', id: 'room:r-01', roomId: 'r-01' }), { kind: 'mail', id: 'mail' });
  const docs = build({ works: [w], layouts: { [keyOf(w)]: layout }, branches: { '/tmp/shop': 'main' } });
  const subtitleOf = (id: string): string | undefined => docs.find((doc) => doc.id === id)?.subtitle;

  it('вкладки: терминал и почта — «Tab · работа», комната — «Room · работа»', () => {
    expect(subtitleOf(`tab:${keyOf(w)}\n${tabId.terminal('s-01')}`)).toBe('Tab · Платежи');
    expect(subtitleOf(`tab:${keyOf(w)}\nmail`)).toBe('Tab · Платежи');
    expect(subtitleOf(`tab:${keyOf(w)}\nroom:r-01`)).toBe('Room · Платежи');
  });

  it('комната из секции комнат — «Room · работа»', () => {
    expect(subtitleOf(`room:${keyOf(w)}\nr-01`)).toBe('Room · Платежи');
  });

  it('архивная комната документом «Room» не бывает (архив комнат, 5.3); её уже открытая вкладка остаётся вкладкой', () => {
    const archived = makeWork('w-03', {
      projectPath: '/tmp/arch',
      title: 'Архив',
      sessions: [makeSession('s-01', 'a')],
      rooms: [makeRoom('r-01', 'Открытая'), { ...makeRoom('r-02', 'Старая'), archivedAt: '2026-10-08T12:00:00.000Z' }],
    });
    const tabbed = openTab(layoutWith('s-01'), { kind: 'room', id: 'room:r-02', roomId: 'r-02' });
    const archivedDocs = build({ works: [archived], layouts: { [keyOf(archived)]: tabbed } });
    expect(titles(archivedDocs, 'rooms')).toEqual(['Открытая']);
    expect(archivedDocs.some((doc) => doc.id === `room:${keyOf(archived)}\nr-02`)).toBe(false);
    expect(archivedDocs.some((doc) => doc.id === `tab:${keyOf(archived)}\nroom:r-02`)).toBe(true);
  });

  it('сессия — «работа · слово состояния · провайдер»; работа — «проект · 2 sessions · ветка» (закрытые не в счёт)', () => {
    expect(subtitleOf(`session:${keyOf(w)}\ns-02`)).toBe('Платежи · idle · Claude Code');
    expect(subtitleOf(`work:${keyOf(w)}`)).toBe('shop · 2 sessions · main');
  });

  it('работа без ветки — без хвоста; одна сессия — «1 session»', () => {
    const solo = makeWork('w-02', { projectPath: '/tmp/solo', title: 'Соло', sessions: [makeSession('s-01', 'a')] });
    const soloDocs = build({ works: [solo] });
    expect(soloDocs.find((doc) => doc.id === `work:${keyOf(solo)}`)?.subtitle).toBe('solo · 1 session');
  });

  it('действие — «Action»; строка «New session or room» — среди действий, открывает то же, что ⌘T', () => {
    const action = docs.find((doc) => doc.id === 'action:session.new');
    expect(action?.title).toBe('New session or room');
    expect(action?.subtitle).toBe('Action');
    expect(action?.fields).toContain('room');
  });
});

describe('buildDocuments (тест 5)', () => {
  it('нет архивной работы, закрытой сессии, недоступного действия и служебных палитры, работы и вкладки по номеру', () => {
    const live = makeWork('w-01', {
      projectPath: '/tmp/a',
      title: 'Живая',
      sessions: [makeSession('s-01', 'план'), makeSession('s-02', 'старая', { lifecycle: 'closed' })],
    });
    const archived = makeWork('w-02', { projectPath: '/tmp/b', title: 'Архив', status: 'archived', sessions: [makeSession('s-01', 'архивная')] });
    const docs = build({ works: [live, archived], available: (id) => id !== 'settings.open' });

    expect(titles(docs, 'works')).toEqual(['Живая']);
    expect(titles(docs, 'sessions')).toEqual(['S01 план']);
    const actionIds = docs.filter((d) => d.section === 'actions').map((d) => d.id);
    expect(actionIds).not.toContain('action:settings.open');
    expect(actionIds).not.toContain('action:palette.open');
    expect(actionIds).not.toContain('action:work.goto.2');
    expect(actionIds).not.toContain('action:tab.mruNext');
    expect(actionIds).toContain('action:work.new');
  });

  it('splitRight: нет действий и чужих работ; сессия с открытой вкладкой — только вкладкой', () => {
    const a = makeWork('w-01', { projectPath: '/tmp/a', title: 'A', sessions: [makeSession('s-01', 'один'), makeSession('s-02', 'два')], rooms: [makeRoom('r-01', 'обзор')] });
    const b = makeWork('w-02', { projectPath: '/tmp/b', title: 'B', sessions: [makeSession('s-03', 'чужая')] });
    const docs = build({
      works: [a, b],
      layouts: { [keyOf(a)]: layoutWith('s-01'), [keyOf(b)]: layoutWith('s-03') },
      mode: 'splitRight',
      activeWorkKey: keyOf(a),
    });

    expect(docs.filter((d) => d.section === 'actions')).toEqual([]);
    expect(docs.filter((d) => d.section === 'works')).toEqual([]);
    expect(titles(docs, 'tabs')).toEqual(['S01 один']);
    expect(titles(docs, 'sessions')).toEqual(['S02 два']);
    expect(titles(docs, 'rooms')).toEqual(['обзор']);
  });

  it('open: из действий — только New browser tab (9.2a), выбор зовёт run(browser.newTab); недоступное — нет', () => {
    const a = makeWork('w-01', { projectPath: '/tmp/a', title: 'A' });
    const ran: ActionId[] = [];
    const docs = buildDocuments({
      works: [a],
      activity: {},
      attention: { [keyOf(a)]: workAttention(a, {}) },
      branches: {},
      order: [keyOf(a)],
      layouts: {},
      history: [],
      actions: ACTIONS,
      available: () => true,
      wakePaused: false,
      providers: [],
      mode: 'open',
      activeWorkKey: keyOf(a),
      files: null,
      run: (id) => ran.push(id),
    });
    const actions = docs.filter((d) => d.section === 'actions');
    expect(actions.map((d) => d.title)).toEqual(['New browser tab']);
    actions[0]?.run('default');
    expect(ran).toEqual(['browser.newTab']);
    // Пустой запрос палитры «Открыть…» показывает документ сразу — иначе «+» без набора бесполезен.
    expect(rankDocuments('', docs, NOW).flatMap((s) => s.docs).map((d) => d.title)).toContain('New browser tab');
    expect(build({ works: [a], mode: 'open', available: (id) => id !== 'browser.newTab' }).filter((d) => d.section === 'actions')).toEqual([]);
    // Обычный режим пустым запросом действий по-прежнему не показывает.
    expect(rankDocuments('', build({ works: [a] }), NOW).some((s) => s.section === 'actions')).toBe(false);
  });

  it('свежесть вкладки — самое позднее at её записей истории, без записей — null; работа — lastEventAt внимания, ветка в полях', () => {
    const a = makeWork('w-01', { projectPath: '/tmp/a', title: 'A', sessions: [makeSession('s-01', 'один'), makeSession('s-02', 'два')] });
    const key = keyOf(a);
    const hourAgo = NOW - HOUR;
    const attention: Record<string, WorkAttention> = { [key]: { ...workAttention(a, {}), lastEventAt: '2026-09-27T10:00:00.000Z' } };
    const docs = build({
      works: [a],
      layouts: { [key]: layoutWith('s-01', 's-02') },
      history: [
        { workKey: key, tabId: tabId.terminal('s-01'), at: hourAgo - HOUR },
        { workKey: key, tabId: tabId.terminal('s-01'), at: hourAgo },
        { workKey: '/tmp/other w-09', tabId: tabId.terminal('s-02'), at: NOW },
      ],
      attention,
      branches: { '/tmp/a': 'feature/palette' },
    });

    const tabs = docs.filter((d) => d.section === 'tabs');
    expect(tabs.find((d) => d.title === 'S01 один')?.recencyAt).toBe(hourAgo);
    expect(tabs.find((d) => d.title === 'S02 два')?.recencyAt).toBeNull();
    const work = docs.find((d) => d.section === 'works' && d.title === 'A');
    expect(work?.recencyAt).toBe(Date.parse('2026-09-27T10:00:00.000Z'));
    expect(work?.fields).toContain('feature/palette');
    expect(work?.fields).toContain('/tmp/a');
    expect(work?.fields).toContain('w-01');
  });

  it('«Open mail» — только у работы с письмами', () => {
    const withMail = makeWork('w-01', { projectPath: '/tmp/a', title: 'С почтой', messages: [makeLetter('m-1')] });
    const noMail = makeWork('w-02', { projectPath: '/tmp/b', title: 'Без почты' });
    const mail = build({ works: [withMail, noMail] }).filter((d) => d.title === 'Open mail');
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subtitle).toBe('С почтой');
    expect(mail[0]?.section).toBe('works');
  });

  it('wake.toggle при wakePaused: true — Resume auto-wake, иначе Pause auto-wake', () => {
    const wake = (paused: boolean): string | undefined =>
      build({ works: [], wakePaused: paused }).find((d) => d.id === 'action:wake.toggle')?.title;
    expect(wake(true)).toBe('Resume auto-wake');
    expect(wake(false)).toBe('Pause auto-wake');
  });

  it('точка работы — по уровню внимания: needs-you → blocked, off — без точки', () => {
    const a = makeWork('w-01', { projectPath: '/tmp/a', title: 'A' });
    const b = makeWork('w-02', { projectPath: '/tmp/b', title: 'B' });
    const base = workAttention(a, {});
    const docs = build({
      works: [a, b],
      attention: { [keyOf(a)]: { ...base, level: 'needs-you' }, [keyOf(b)]: { ...base, level: 'off' } },
    });
    expect(docs.find((d) => d.title === 'A')?.state).toBe('blocked');
    expect(docs.find((d) => d.title === 'B')?.state).toBeUndefined();
  });
});

describe('rankDocuments (тест 4)', () => {
  it('при равных очках свежее выше, при равной свежести — меньший order', () => {
    const docs = [
      doc('old', 'sessions', { title: 'plan', recencyAt: NOW - 3 * 24 * HOUR, order: 0 }),
      doc('fresh', 'sessions', { title: 'plan', recencyAt: NOW - 10 * 60 * 1000, order: 5 }),
      doc('second', 'sessions', { title: 'plan', recencyAt: null, order: 2 }),
      doc('first', 'sessions', { title: 'plan', recencyAt: null, order: 1 }),
    ];
    const [section] = rankDocuments('plan', docs, NOW);
    expect(section?.docs.map((d) => d.id)).toEqual(['fresh', 'old', 'first', 'second']);
  });

  it('секция с лучшим документом первая; лимит секции и more верны', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => doc(`s${i}`, 'sessions', { title: `review ${i}`, order: i }));
    const best = doc('room', 'rooms', { title: 'review' });
    const ranked = rankDocuments('review', [...sessions, best], NOW);
    expect(ranked.map((s) => s.section)).toEqual(['rooms', 'sessions']);
    const sessionSection = ranked[1];
    expect(sessionSection?.docs).toHaveLength(SECTION_LIMITS.sessions);
    expect(sessionSection?.more).toBe(10 - SECTION_LIMITS.sessions);
    expect(rankDocuments('review', sessions, NOW, new Set(['sessions']))[0]?.docs).toHaveLength(10);
  });

  it('токен не совпал — документа нет; нет совпадений — пустой список', () => {
    expect(rankDocuments('xyz', [doc('a', 'works', { title: 'plan' })], NOW)).toEqual([]);
  });

  it('пустой запрос — шесть последних вкладок и четыре последние работы, хотя лимит вкладок — 5', () => {
    const tabs = Array.from({ length: 8 }, (_, i) => doc(`t${i}`, 'tabs', { recencyAt: NOW - i * 1000 }));
    const unvisitedTab = doc('t-none', 'tabs', { recencyAt: null });
    const works = Array.from({ length: 6 }, (_, i) => doc(`w${i}`, 'works', { visitedAt: NOW - i * 1000 }));
    const sessions = [doc('s', 'sessions')];
    const ranked = rankDocuments('  ', [unvisitedTab, ...tabs, ...works, ...sessions], NOW);
    expect(ranked.map((s) => s.section)).toEqual(['tabs', 'works']);
    expect(ranked[0]?.docs.map((d) => d.id)).toEqual(['t0', 't1', 't2', 't3', 't4', 't5']);
    expect(ranked[1]?.docs.map((d) => d.id)).toEqual(['w0', 'w1', 'w2', 'w3']);
  });

  it('пустой запрос палитры одной работы (режимы разделения) — все её секции по свежести и порядку', () => {
    const ranked = rankDocuments('', [doc('t', 'tabs'), doc('s2', 'sessions', { order: 2 }), doc('s1', 'sessions', { order: 1 })], NOW);
    expect(ranked.map((s) => s.section)).toEqual(['tabs', 'sessions']);
    expect(ranked[1]?.docs.map((d) => d.id)).toEqual(['s1', 's2']);
  });
});

describe('секция files (кусок 7.4, спека 9.1, 10.2)', () => {
  const fileDoc = (path: string): PaletteDoc => ({
    id: `file:${path}`,
    section: 'files',
    title: path.slice(path.lastIndexOf('/') + 1),
    subtitle: path,
    fields: [path],
    recencyAt: null,
    order: 0,
    icon: 'file',
    titleWeight: 2,
    run: () => {},
  });
  const works = [makeWork('w-01', { sessions: [makeSession('s-01', 'plan')] })];

  it('filesQuery: режим files — запрос как есть; default с / — запрос без /; иначе null', () => {
    expect(filesQuery('files', 'main')).toBe('main');
    expect(filesQuery('files', '')).toBe('');
    expect(filesQuery('default', '/main')).toBe('main');
    expect(filesQuery('default', '/')).toBe('');
    expect(filesQuery('default', 'main')).toBeNull();
    expect(filesQuery('splitRight', '/main')).toBeNull();
  });

  it('режим files — только документы файлов, других секций нет; files: null — пусто', () => {
    const files = [fileDoc('src/main.ts')];
    expect(build({ works, mode: 'files', files })).toEqual(files);
    expect(build({ works, mode: 'files', files: null })).toEqual([]);
  });

  it('обычный режим документов файлов не берёт', () => {
    const docs = build({ works, files: [fileDoc('src/main.ts')] });
    expect(docs.some((doc) => doc.section === 'files')).toBe(false);
  });
});

describe('вкладка файла — путь для значка (спека значков 3.3)', () => {
  it('filePath — полный путь вкладки, даже когда название обрезано; у прочих документов его нет (фокус ревью 5)', () => {
    const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Файлы', sessions: [makeSession('s-01', 'main')] });
    const path = `src/${'very-long-file-name-'.repeat(12)}index.json`;
    const fileTab = { kind: 'file' as const, id: tabId.file({ kind: 'project' }, path), root: { kind: 'project' as const }, path };
    const docs = build({ works: [w], layouts: { [keyOf(w)]: openTab(layoutWith('s-01'), fileTab) } });
    const doc = docs.find((candidate) => candidate.id === `tab:${keyOf(w)}\n${fileTab.id}`);
    expect(doc?.icon).toBe('file');
    expect(doc?.title).not.toBe(path.slice(path.lastIndexOf('/') + 1));
    expect(doc?.filePath).toBe(path);
    expect(docs.filter((candidate) => candidate.icon !== 'file').every((candidate) => candidate.filePath === undefined)).toBe(true);
  });
});
