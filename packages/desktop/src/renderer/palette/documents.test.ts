/**
 * Тесты 4–5 куска 6.2 (спека 9.1–9.2): документы палитры из хранилищ и их ранжирование.
 */

import { describe, expect, it } from 'vitest';
import type { WorkEntry } from '@harnas/core';
import { ACTIONS, type ActionId } from '../../shared/keybindings.js';
import type { WorkLayout } from '../../shared/layout-types.js';
import { workAttention, type WorkAttention } from '../attention/derive.js';
import type { HistoryEntry } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { emptyLayout, openTab } from '../layout/tree.js';
import { workKey } from '../lib/tree-order.js';
import { makeLetter, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { buildDocuments, rankDocuments, SECTION_LIMITS, type PaletteDoc, type PaletteSection } from './documents.js';
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
    run: () => {},
  });
}

function titles(docs: PaletteDoc[], section: PaletteSection): string[] {
  return docs.filter((doc) => doc.section === section).map((doc) => doc.title);
}

function doc(id: string, section: PaletteSection, patch: Partial<PaletteDoc> = {}): PaletteDoc {
  return { id, section, title: id, subtitle: '', fields: [], recencyAt: null, order: 0, icon: 'action', run: () => {}, ...patch };
}

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
