/**
 * Тесты 2, 3, 9–13 куска 4.3: когда окно шлёт уведомление macOS, с каким текстом, тегом и
 * целью. Настоящих уведомлений здесь нет — `notify` подставной или журнал подставного моста.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, SessionActivity, WorkEntry, WorkSession } from '@harnas/core';
import { refKey, type HostNotice, type SessionRef } from '@harnas/protocol';
import type { AppNote, FocusTarget } from '../../shared/bridge.js';
import { DEFAULT_UI, type UiFile } from '../../shared/ui-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { createAttentionNotifier, wireAttentionNotifications } from './notify.js';

function session(id: string, label: string, overrides: Partial<WorkSession> = {}): WorkSession {
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
    ...overrides,
  };
}

function letter(id: string, overrides: Partial<Message> = {}): Message {
  return { id, roomId: null, from: 's-01', to: ['human'], at: '2026-01-01T00:00:00.000Z', text: 'hello', kind: 'note', readBy: {}, ...overrides };
}

function entry(title: string, sessions: WorkSession[], messages: Message[] = []): WorkEntry {
  return {
    projectPath: '/tmp/p',
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id: 'w-01', title, goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions,
      messages,
    },
  };
}

function live(activity: SessionActivity['activity']): SessionActivity {
  return { activity, subagents: 0, turnEndedAt: null, lastEventAt: null, source: 'hooks', exited: false, hooksMissing: false };
}

const ref2: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-02' };
const ref3: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-03' };

interface Harness {
  notes: AppNote[];
  prefs: UiFile['notifications'];
  visible: Set<string>;
  entries: WorkEntry[];
  notifier: ReturnType<typeof createAttentionNotifier>;
}

function harness(entries: WorkEntry[]): Harness {
  const h: Harness = {
    notes: [],
    prefs: { ...DEFAULT_UI.notifications },
    visible: new Set(),
    entries,
    notifier: null as unknown as ReturnType<typeof createAttentionNotifier>,
  };
  h.notifier = createAttentionNotifier({
    notify: (note) => h.notes.push(note),
    prefs: () => h.prefs,
    isTargetVisible: (target: FocusTarget) => h.visible.has(JSON.stringify(target)),
    entries: () => h.entries,
  });
  return h;
}

const redesign = (): WorkEntry =>
  entry('Redesign', [
    session('s-02', 'executor', { task: 'Fix the login form\nand the tests', summary: 'Login fixed\nall green' }),
    session('s-03', 'backend'),
  ]);

describe('createAttentionNotifier.onActivity (тест 2 куска 4.3)', () => {
  it('первое значение сессии — база: blocked первым — уведомления нет', () => {
    const h = harness([redesign()]);
    h.notifier.onActivity(ref2, live('blocked'));
    expect(h.notes).toEqual([]);
  });

  it('после базы working → blocked при невидимой цели — одно уведомление с заголовком и первой строкой задачи', () => {
    const h = harness([redesign()]);
    h.notifier.onActivity(ref2, live('working'));
    h.notifier.onActivity(ref2, live('blocked'));
    expect(h.notes).toEqual([
      {
        title: 'Redesign · S02 executor — needs you',
        body: 'Fix the login form',
        tag: `session:${refKey(ref2)}`,
        target: { kind: 'session', ref: ref2 },
        silent: false,
      },
    ]);
  });

  it('working → unseen — «finished», тело — первая строка summary', () => {
    const h = harness([redesign()]);
    h.notifier.onActivity(ref2, live('working'));
    h.notifier.onActivity(ref2, live('unseen'));
    expect(h.notes).toMatchObject([{ title: 'Redesign · S02 executor — finished', body: 'Login fixed' }]);
  });

  it('unseen без summary — тело пустое', () => {
    const h = harness([redesign()]);
    h.notifier.onActivity(ref3, live('working'));
    h.notifier.onActivity(ref3, live('unseen'));
    expect(h.notes).toMatchObject([{ title: 'Redesign · S03 backend — finished', body: '' }]);
  });

  it('повтор blocked — нет', () => {
    const h = harness([redesign()]);
    h.notifier.onActivity(ref2, live('working'));
    h.notifier.onActivity(ref2, live('blocked'));
    h.notifier.onActivity(ref2, live('blocked'));
    expect(h.notes).toHaveLength(1);
  });

  it('цель видима — нет', () => {
    const h = harness([redesign()]);
    h.visible.add(JSON.stringify({ kind: 'session', ref: ref2 }));
    h.notifier.onActivity(ref2, live('working'));
    h.notifier.onActivity(ref2, live('blocked'));
    expect(h.notes).toEqual([]);
  });

  it('prefs().needsYou: false — нет; prefs().finished: false — нет', () => {
    const h = harness([redesign()]);
    h.prefs = { ...h.prefs, needsYou: false, finished: false };
    h.notifier.onActivity(ref2, live('working'));
    h.notifier.onActivity(ref2, live('blocked'));
    h.notifier.onActivity(ref2, live('unseen'));
    expect(h.notes).toEqual([]);
  });

  it('sound: false → silent: true', () => {
    const h = harness([redesign()]);
    h.prefs = { ...h.prefs, sound: false };
    h.notifier.onActivity(ref2, live('working'));
    h.notifier.onActivity(ref2, live('blocked'));
    expect(h.notes[0]?.silent).toBe(true);
  });

  it.each(['closed', 'sleeping'] as const)('сессия %s с blocked в активности — нет', (lifecycle) => {
    const h = harness([entry('Redesign', [session('s-02', 'executor', { lifecycle })])]);
    h.notifier.onActivity(ref2, live('working'));
    h.notifier.onActivity(ref2, live('blocked'));
    expect(h.notes).toEqual([]);
  });

  it('сессии нет в снимке — уведомления нет, но уровень запомнен как у живой', () => {
    const h = harness([]);
    h.notifier.onActivity(ref2, live('working'));
    h.notifier.onActivity(ref2, live('blocked'));
    expect(h.notes).toEqual([]);
    // Появилась в снимке: повтор blocked — не переход.
    h.entries = [redesign()];
    h.notifier.onActivity(ref2, live('blocked'));
    expect(h.notes).toEqual([]);
  });
});

describe('createAttentionNotifier.onWorks (тесты 3 и 9 куска 4.3)', () => {
  it('тест 9: первый снимок с письмами человеку — ни одного; второй с новым письмом — одно', () => {
    const h = harness([]);
    h.notifier.onWorks([entry('Redesign', [session('s-01', 'planner')], [letter('m-1'), letter('m-2')])]);
    expect(h.notes).toEqual([]);
    h.notifier.onWorks([entry('Redesign', [session('s-01', 'planner')], [letter('m-1'), letter('m-2'), letter('m-3', { text: 'third' })])]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]?.body).toBe('third');
  });

  it('тест 3: question от S01 — тег mail:<workKey>, заголовок и первая строка письма', () => {
    const h = harness([]);
    const base = entry('Redesign', [session('s-01', 'planner')]);
    h.notifier.onWorks([base]);
    h.notifier.onWorks([{ ...base, map: { ...base.map, messages: [letter('m-1', { kind: 'question', text: 'Which API?\ndetails' })] } }]);
    expect(h.notes).toEqual([
      {
        title: 'Redesign · question from S01',
        body: 'Which API?',
        tag: 'mail:/tmp/p w-01',
        target: { kind: 'mail', projectPath: '/tmp/p', workId: 'w-01' },
        silent: false,
      },
    ]);
  });

  it('note и decision — «message from» и «decision from»', () => {
    const h = harness([]);
    const base = entry('Redesign', [session('s-01', 'planner')]);
    h.notifier.onWorks([base]);
    h.notifier.onWorks([{ ...base, map: { ...base.map, messages: [letter('m-1')] } }]);
    h.notifier.onWorks([{ ...base, map: { ...base.map, messages: [letter('m-1'), letter('m-2', { kind: 'decision' })] } }]);
    expect(h.notes.map((note) => note.title)).toEqual(['Redesign · message from S01', 'Redesign · decision from S01']);
  });

  it('письмо агента агенту и сообщение комнаты — нет; prefs().mail: false — нет; вкладка почты видна — нет', () => {
    const h = harness([]);
    const base = entry('Redesign', [session('s-01', 'planner')]);
    h.notifier.onWorks([base]);
    h.notifier.onWorks([
      { ...base, map: { ...base.map, messages: [letter('m-1', { to: ['s-02'] }), letter('m-2', { roomId: 'r-1', to: [] })] } },
    ]);
    expect(h.notes).toEqual([]);

    h.prefs = { ...h.prefs, mail: false };
    h.notifier.onWorks([{ ...base, map: { ...base.map, messages: [letter('m-3')] } }]);
    expect(h.notes).toEqual([]);

    h.prefs = { ...h.prefs, mail: true };
    h.visible.add(JSON.stringify({ kind: 'mail', projectPath: '/tmp/p', workId: 'w-01' }));
    h.notifier.onWorks([{ ...base, map: { ...base.map, messages: [letter('m-4')] } }]);
    expect(h.notes).toEqual([]);
  });
});

function notice(kind: HostNotice['kind'], ref: SessionRef | null, text = 'текст хоста по-русски'): HostNotice {
  return { kind, ref, text, at: '2026-01-01T00:00:00.000Z' };
}

describe('createAttentionNotifier.onHostNotice (тесты 10 и 11 куска 4.3)', () => {
  it('тест 10: launch-failed — заголовок, тело noticeText без ярлыка, тег notice:<kind>:<refKey>', () => {
    const h = harness([redesign()]);
    h.notifier.onHostNotice(notice('launch-failed', ref2));
    expect(h.notes).toEqual([
      {
        title: "Redesign · S02 executor — couldn't launch",
        body: "Couldn't launch this session.",
        tag: `notice:launch-failed:${refKey(ref2)}`,
        target: { kind: 'session', ref: ref2 },
        silent: false,
      },
    ]);
  });

  it('resume-failed — «couldn\'t resume»', () => {
    const h = harness([redesign()]);
    h.notifier.onHostNotice(notice('resume-failed', ref2));
    expect(h.notes).toMatchObject([{ title: "Redesign · S02 executor — couldn't resume", body: "Couldn't resume this session." }]);
  });

  it('тест 11: trust-wait с кириллическим text — текста нет, кириллицы в уведомлении нет вовсе', () => {
    const h = harness([redesign()]);
    h.notifier.onHostNotice(notice('trust-wait', ref3, 'сессия не отвечает с запуска'));
    expect(h.notes).toEqual([
      {
        title: 'Redesign · S03 backend — waiting for folder trust',
        body: 'Not responding since launch — may be waiting for folder trust.',
        tag: `notice:trust-wait:${refKey(ref3)}`,
        target: { kind: 'session', ref: ref3 },
        silent: false,
      },
    ]);
    expect(JSON.stringify(h.notes)).not.toMatch(/[Ѐ-ӿ]/);
  });

  it('тест 11: ref: null — уведомления нет; сессии нет в снимке — нет', () => {
    const h = harness([redesign()]);
    h.notifier.onHostNotice(notice('trust-wait', null));
    h.notifier.onHostNotice(notice('trust-wait', { ...ref2, sessionId: 's-99' }));
    expect(h.notes).toEqual([]);
  });

  it('прочие виды (map-lock, resume-limit) — нет', () => {
    const h = harness([redesign()]);
    h.notifier.onHostNotice(notice('map-lock', ref2));
    h.notifier.onHostNotice(notice('resume-limit', ref2));
    expect(h.notes).toEqual([]);
  });
});

describe('обрезка до 200 кодовых точек (тест 12 куска 4.3)', () => {
  const codePoints = (text: string): string[] => Array.from(text);
  const noLoneSurrogates = (text: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

  it('название работы из 201 эмодзи → заголовок ровно 200, последняя «…», непарных суррогатов нет', () => {
    const h = harness([entry('😀'.repeat(201), [session('s-02', 'executor', { task: 'x' })])]);
    h.notifier.onActivity(ref2, live('working'));
    h.notifier.onActivity(ref2, live('blocked'));
    const title = h.notes[0]?.title ?? '';
    expect(codePoints(title)).toHaveLength(200);
    expect(codePoints(title)[199]).toBe('…');
    expect(noLoneSurrogates(title)).toBe(true);
  });

  it('первая строка письма из 201 эмодзи — тело так же; текст ровно в 200 кодовых точек не меняется', () => {
    const h = harness([]);
    const base = entry('Redesign', [session('s-01', 'planner')]);
    h.notifier.onWorks([base]);
    h.notifier.onWorks([{ ...base, map: { ...base.map, messages: [letter('m-1', { text: '😀'.repeat(201) })] } }]);
    const body = h.notes[0]?.body ?? '';
    expect(codePoints(body)).toHaveLength(200);
    expect(codePoints(body)[199]).toBe('…');
    expect(noLoneSurrogates(body)).toBe(true);

    h.notifier.onWorks([{ ...base, map: { ...base.map, messages: [letter('m-1', { text: '😀'.repeat(201) }), letter('m-2', { text: '😀'.repeat(200) })] } }]);
    expect(h.notes[1]?.body).toBe('😀'.repeat(200));
  });
});

describe('wireAttentionNotifications на подставном мосте и настоящих сторах (тест 13 куска 4.3)', () => {
  let bridge: FakeBridge;
  const ref1: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };

  function emit(ref: SessionRef, activity: SessionActivity['activity']): void {
    bridge.emit('activity.changed', {
      ref,
      activity: live(activity),
      metrics: { tokensIn: 0, tokensOut: 0, durationMs: 0, unread: 0, subagents: 0, model: 'opus' },
    });
  }

  function wire(): () => void {
    const offActivity = useActivityStore.getState().init(bridge);
    const offNotify = wireAttentionNotifications(bridge, {
      prefs: () => DEFAULT_UI.notifications,
      isTargetVisible: () => false,
      entries: () => useWorksStore.getState().entries,
    });
    return () => {
      offNotify();
      offActivity();
    };
  }

  beforeEach(() => {
    bridge = createFakeBridge();
    useActivityStore.setState({ byRef: {} });
    useWorksStore.setState({
      entries: [entry('Redesign', [session('s-01', 'planner'), session('s-02', 'executor'), session('s-03', 'backend')])],
      branches: {},
      loading: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('повтор blocked двух сессий — база; третья working → blocked — одно; после переподключения повтор снова база', () => {
    const off = wire();
    emit(ref1, 'blocked');
    emit(ref2, 'blocked');
    expect(bridge.appNotified).toEqual([]);
    emit(ref3, 'working');
    emit(ref3, 'blocked');
    expect(bridge.appNotified.map((note) => note.title)).toEqual(['Redesign · S03 backend — needs you']);

    off();
    const offAgain = wire();
    emit(ref1, 'blocked');
    emit(ref2, 'blocked');
    emit(ref3, 'blocked');
    expect(bridge.appNotified).toHaveLength(1);
    offAgain();
  });

  it('host.notice моста доходит до уведомителя; после отписки — нет', () => {
    const off = wire();
    bridge.emit('host.notice', notice('launch-failed', ref2));
    expect(bridge.appNotified).toHaveLength(1);
    off();
    bridge.emit('host.notice', notice('launch-failed', ref2));
    expect(bridge.appNotified).toHaveLength(1);
  });

  it('первый снимок работ после подписки — база писем; следующий с новым письмом — уведомление', () => {
    const off = wire();
    const current = useWorksStore.getState().entries[0] as WorkEntry;
    useWorksStore.setState({ entries: [{ ...current, map: { ...current.map, messages: [letter('m-1')] } }] });
    expect(bridge.appNotified).toEqual([]);
    useWorksStore.setState({ entries: [{ ...current, map: { ...current.map, messages: [letter('m-1'), letter('m-2')] } }] });
    expect(bridge.appNotified.map((note) => note.tag)).toEqual(['mail:/tmp/p w-01']);
    off();
  });
});
