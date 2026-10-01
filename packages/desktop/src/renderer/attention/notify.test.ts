/**
 * Тесты 2, 3, 9–13 куска 4.3: когда окно шлёт уведомление macOS, с каким текстом, тегом и
 * целью. Настоящих уведомлений здесь нет — `notify` подставной или журнал подставного моста.
 * Кусок 8 «Organic» — решение ведущего, ждущее человека: когда уведомлять, окно или macOS, тег и замена.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, Proposal, Room, SessionActivity, WorkEntry, WorkSession } from '@parley/core';
import { refKey, type HostNotice, type SessionRef } from '@parley/protocol';
import type { AppNote, FocusTarget } from '../../shared/bridge.js';
import { DEFAULT_UI, type UiFile } from '../../shared/ui-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useActivityStore } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { createAttentionNotifier, wireAttentionNotifications } from './notify.js';
import { useWindowNotesStore, type WindowNote } from './window-notes.js';

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

function entry(title: string, sessions: WorkSession[], messages: Message[] = [], rooms: Room[] = []): WorkEntry {
  return {
    projectPath: '/tmp/p',
    map: {
      schemaVersion: 2,
      rooms,
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
  /** Окно в фокусе: решение — карточкой в окне, а не уведомлением macOS (кусок 8). */
  active: boolean;
  windowNotes: WindowNote[];
  hidden: string[];
  notifier: ReturnType<typeof createAttentionNotifier>;
}

function harness(entries: WorkEntry[]): Harness {
  const h: Harness = {
    notes: [],
    prefs: { ...DEFAULT_UI.notifications },
    visible: new Set(),
    entries,
    active: false,
    windowNotes: [],
    hidden: [],
    notifier: null as unknown as ReturnType<typeof createAttentionNotifier>,
  };
  h.notifier = createAttentionNotifier({
    notify: (note) => h.notes.push(note),
    prefs: () => h.prefs,
    isTargetVisible: (target: FocusTarget) => h.visible.has(JSON.stringify(target)),
    entries: () => h.entries,
    windowActive: () => h.active,
    showInWindow: (note) => h.windowNotes.push(note),
    hideInWindow: (tag) => h.hidden.push(tag),
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

  // Метка безымянной работы `UNTITLED_WORK` core стоит в карте, пока не придёт автозаголовок: в уведомлении —
  // «Untitled workspace», а не сырая метка и не её прежняя русская запись из карты старой сборки.
  it('безымянная работа — «Untitled workspace» в заголовке письма и уведомления хоста', () => {
    for (const title of ['untitled', 'без названия']) {
      const base = entry(title, [session('s-01', 'planner'), session('s-02', 'executor')]);
      const h = harness([base]);
      h.notifier.onWorks([base]);
      h.notifier.onWorks([{ ...base, map: { ...base.map, messages: [letter('m-1', { kind: 'question' })] } }]);
      h.notifier.onHostNotice(notice('launch-failed', ref2));
      expect(h.notes.map((note) => note.title)).toEqual([
        'Untitled workspace · question from S01',
        "Untitled workspace · S02 executor — couldn't launch",
      ]);
    }
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

function room(id: string, title: string, proposal: Proposal | null, overrides: Partial<Room> = {}): Room {
  return { id, title, creator: 'human', members: ['s-01', 's-02'], createdAt: '2026-01-01T00:00:00.000Z', lead: 's-01', proposal, ...overrides };
}

function proposal(id: string, rev = 0, from = 's-01'): Proposal {
  return { id, from, text: 'Split the work between S01 and S02', rev, at: '2026-01-01T00:00:00.000Z' };
}

/** Работа с двумя сессиями и заданными комнатами: ведущий комнат — `s-01`. */
function roomsEntry(rooms: Room[]): WorkEntry {
  return entry('Redesign', [session('s-01', 'planner'), session('s-02', 'executor')], [], rooms);
}

describe('createAttentionNotifier.onWorks — решение ведущего в комнате (кусок 8, спека окна 2026-09-29, 1.10)', () => {
  const TAG = 'proposal:/tmp/p w-01:r-01';
  const TARGET: FocusTarget = { kind: 'room', projectPath: '/tmp/p', workId: 'w-01', roomId: 'r-01' };

  /** Уведомитель, у которого первый снимок — комната без решения: база есть, дальше всё — «после подключения». */
  function started(): Harness {
    const h = harness([]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', null)])]);
    return h;
  }

  it('новое решение при окне не в фокусе — уведомление macOS: заголовок, «collected positions», тег proposal:<workKey>:<roomId>, цель — комната', () => {
    const h = started();
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    expect(h.notes).toEqual([
      {
        title: 'Decision waiting for you',
        body: 'Возвраты · S01 collected positions',
        tag: TAG,
        target: TARGET,
        silent: false,
      },
    ]);
    expect(h.windowNotes).toEqual([]);
  });

  it('замена того же решения (rev вырос) — «revised the decision» под тем же тегом; повтор того же rev молчит', () => {
    const h = started();
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01', 1))])]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01', 1))])]);
    expect(h.notes.map((note) => [note.body, note.tag])).toEqual([
      ['Возвраты · S01 collected positions', TAG],
      ['Возвраты · S01 revised the decision', TAG],
    ]);
  });

  it('то же решение (id и rev) снимок за снимком уведомляет один раз — чужие изменения карты его не повторяют', () => {
    const h = started();
    const waiting = roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))]);
    h.notifier.onWorks([waiting]);
    h.notifier.onWorks([{ ...waiting, map: { ...waiting.map, messages: [letter('m-1', { roomId: 'r-01', to: [] })] } }]);
    h.notifier.onWorks([waiting]);
    expect(h.notes).toHaveLength(1);
  });

  it('первый снимок — база: решение, ждавшее на старте окна, не уведомляет; следующая замена — уведомляет', () => {
    const h = harness([]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    expect(h.notes).toEqual([]);
    expect(h.windowNotes).toEqual([]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    expect(h.notes).toEqual([]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01', 1))])]);
    expect(h.notes.map((note) => note.body)).toEqual(['Возвраты · S01 revised the decision']);
  });

  it('после ответа человека новое решение получает новый id — снова «collected positions»', () => {
    const h = started();
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', null)])]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-02'))])]);
    expect(h.notes.map((note) => note.body)).toEqual([
      'Возвраты · S01 collected positions',
      'Возвраты · S01 collected positions',
    ]);
  });

  /** Ответ человека на решение комнаты `r-01`, как его пишет `resolveProposal` core: письмо ведущему `s-01`. */
  const answer = (id: string, text: string): Message =>
    letter(id, { roomId: 'r-01', from: 'human', to: ['s-01'], text, at: '2026-01-01T00:05:00.000Z' });
  const RETURNED = 'Returned for rework: add the tests';
  const roomWith = (decision: Proposal | null, messages: Message[]): WorkEntry => {
    const base = roomsEntry([room('r-01', 'Возвраты', decision)]);
    return { ...base, map: { ...base.map, messages } };
  };

  it('после возврата на доработку новое решение (новый id) — «revised the decision», а не «collected positions»', () => {
    const h = started();
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    h.notifier.onWorks([roomWith(null, [answer('m-1', RETURNED)])]);
    h.notifier.onWorks([roomWith(proposal('p-02'), [answer('m-1', RETURNED)])]);
    expect(h.notes.map((note) => [note.body, note.tag])).toEqual([
      ['Возвраты · S01 collected positions', TAG],
      ['Возвраты · S01 revised the decision', TAG],
    ]);
  });

  it('возврат без заметки («Returned for rework.») тоже возврат', () => {
    const h = started();
    h.notifier.onWorks([roomWith(null, [answer('m-1', 'Returned for rework.')])]);
    h.notifier.onWorks([roomWith(proposal('p-02'), [answer('m-1', 'Returned for rework.')])]);
    expect(h.notes.map((note) => note.body)).toEqual(['Возвраты · S01 revised the decision']);
  });

  it('после принятия новое решение — снова «collected positions»: прежний возврат в ленте его не делает «revised»', () => {
    const h = started();
    // p-01 вернули, p-02 принял человек (письмо «Decision accepted.» новее возврата), ведущий принёс p-03.
    const history = [answer('m-1', RETURNED), answer('m-2', 'Decision accepted.')];
    h.notifier.onWorks([roomWith(proposal('p-02'), [answer('m-1', RETURNED)])]);
    h.notifier.onWorks([roomWith(null, history)]);
    h.notifier.onWorks([roomWith(proposal('p-03'), history)]);
    expect(h.notes.map((note) => note.body)).toEqual([
      'Возвраты · S01 revised the decision',
      'Возвраты · S01 collected positions',
    ]);
  });

  it('возврат в другой комнате «revised» не даёт: признак — возврат в ленте этой комнаты', () => {
    const h = harness([]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', null), room('r-02', 'Отчёты', null)])]);
    const base = roomsEntry([room('r-01', 'Возвраты', null), room('r-02', 'Отчёты', proposal('p-01'))]);
    h.notifier.onWorks([{ ...base, map: { ...base.map, messages: [answer('m-1', RETURNED)] } }]);
    expect(h.notes.map((note) => note.body)).toEqual(['Отчёты · S01 collected positions']);
  });

  it('окно открыли между возвратом и новым решением (возврат уже в базовом снимке) — «revised» всё равно', () => {
    const h = harness([]);
    h.notifier.onWorks([roomWith(null, [answer('m-1', RETURNED)])]);
    h.notifier.onWorks([roomWith(proposal('p-02'), [answer('m-1', RETURNED)])]);
    expect(h.notes.map((note) => note.body)).toEqual(['Возвраты · S01 revised the decision']);
  });

  it('«revised» после возврата — и карточкой в окне, с тем же тегом', () => {
    const h = started();
    h.active = true;
    h.notifier.onWorks([roomWith(null, [answer('m-1', RETURNED)])]);
    h.notifier.onWorks([roomWith(proposal('p-02'), [answer('m-1', RETURNED)])]);
    expect(h.windowNotes).toEqual([
      { tag: TAG, title: 'Decision waiting for you', body: 'Возвраты · S01 revised the decision', target: TARGET },
    ]);
    expect(h.notes).toEqual([]);
  });

  it('работа на миг выпала из снимка и вернулась с тем же решением — второго уведомления нет', () => {
    const h = started();
    const waiting = roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))]);
    h.notifier.onWorks([waiting]);
    h.notifier.onWorks([]);
    h.notifier.onWorks([waiting]);
    expect(h.notes).toHaveLength(1);
  });

  it('окно в фокусе — карточка в окне с тем же текстом и тегом, уведомления macOS нет; не в фокусе — наоборот', () => {
    const h = started();
    h.active = true;
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    expect(h.windowNotes).toEqual([
      { tag: TAG, title: 'Decision waiting for you', body: 'Возвраты · S01 collected positions', target: TARGET },
    ]);
    expect(h.notes).toEqual([]);

    h.active = false;
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01', 1))])]);
    expect(h.windowNotes).toHaveLength(1);
    expect(h.notes.map((note) => note.body)).toEqual(['Возвраты · S01 revised the decision']);
  });

  it('вкладка комнаты видна — ни карточки, ни уведомления macOS', () => {
    const h = started();
    h.visible.add(JSON.stringify(TARGET));
    h.active = true;
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    h.active = false;
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01', 1))])]);
    expect(h.windowNotes).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it('prefs().needsYou: false — ни карточки, ни уведомления; решение при этом запомнено — включение не повторяет его', () => {
    const h = started();
    h.prefs = { ...h.prefs, needsYou: false };
    h.active = true;
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    expect(h.windowNotes).toEqual([]);
    expect(h.notes).toEqual([]);

    h.prefs = { ...h.prefs, needsYou: true };
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    expect(h.windowNotes).toEqual([]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01', 1))])]);
    expect(h.windowNotes.map((note) => note.body)).toEqual(['Возвраты · S01 revised the decision']);
  });

  it('prefs().mail: false решений не касается', () => {
    const h = started();
    h.prefs = { ...h.prefs, mail: false };
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    expect(h.notes).toHaveLength(1);
  });

  it('sound: false → silent: true у уведомления macOS', () => {
    const h = started();
    h.prefs = { ...h.prefs, sound: false };
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    expect(h.notes[0]?.silent).toBe(true);
  });

  it('ответ человека гасит карточку в окне — один раз, по тегу комнаты', () => {
    const h = started();
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01'))])]);
    expect(h.hidden).toEqual([]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', null)])]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', null)])]);
    expect(h.hidden).toEqual([TAG]);
  });

  it('ярлык ведущего — по proposal.from: автор s-12 → «S12»', () => {
    const h = started();
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01', 0, 's-12'))])]);
    expect(h.notes[0]?.body).toBe('Возвраты · S12 collected positions');
  });

  it('две комнаты одной работы — два уведомления с разными тегами', () => {
    const h = harness([]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', null), room('r-02', 'Отчёты', null)])]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Возвраты', proposal('p-01')), room('r-02', 'Отчёты', proposal('p-02'))])]);
    expect(h.notes.map((note) => [note.tag, note.body])).toEqual([
      ['proposal:/tmp/p w-01:r-01', 'Возвраты · S01 collected positions'],
      ['proposal:/tmp/p w-01:r-02', 'Отчёты · S01 collected positions'],
    ]);
  });

  it('длинное название комнаты режется до 200 кодовых точек, заголовок цел', () => {
    const h = started();
    h.notifier.onWorks([roomsEntry([room('r-01', '😀'.repeat(201), proposal('p-01'))])]);
    const body = h.notes[0]?.body ?? '';
    expect(Array.from(body)).toHaveLength(200);
    expect(Array.from(body)[199]).toBe('…');
    expect(h.notes[0]?.title).toBe('Decision waiting for you');
  });

  it('комната карты до 2026-09-29 — без lead и proposal — не ждёт решения и не ломает разбор', () => {
    const h = harness([]);
    const old = { id: 'r-01', title: 'Старая', creator: 'human', members: ['s-01'], createdAt: '2026-01-01' } as unknown as Room;
    h.notifier.onWorks([roomsEntry([old])]);
    h.notifier.onWorks([roomsEntry([old])]);
    expect(h.notes).toEqual([]);
    expect(h.hidden).toEqual([]);
  });

  it('в уведомлении нет кириллицы из слов окна: заголовок и «collected positions» — английские', () => {
    const h = started();
    h.notifier.onWorks([roomsEntry([room('r-01', 'Room', proposal('p-01'))])]);
    h.notifier.onWorks([roomsEntry([room('r-01', 'Room', proposal('p-01', 1))])]);
    expect(JSON.stringify(h.notes)).not.toMatch(/[Ѐ-ӿ]/);
  });
});

// Parley 0.3.0: сообщение комнаты с `@human` — письмо человеку: уведомление «S02 mentioned you in <комната>», по одному
// на комнату; настройка та же, что у писем (`prefs().mail`), цель — вкладка комнаты.
describe('createAttentionNotifier.onWorks — упоминание человека в комнате (Parley 0.3.0)', () => {
  const TAG = 'mention:/tmp/p w-01:r-01';
  const TARGET: FocusTarget = {
    kind: 'room',
    projectPath: '/tmp/p',
    workId: 'w-01',
    roomId: 'r-01',
  };
  const mention = (id: string, patch: Partial<Message> = {}): Message =>
    letter(id, {
      roomId: 'r-01',
      from: 's-02',
      to: [],
      text: 'Ready for review, @human',
      ...patch,
    });
  /** Работа с комнатами `rooms` (по умолчанию — `r-01` «Mobile APP») и заданными сообщениями. */
  const withMessages = (
    messages: Message[],
    rooms: Room[] = [room('r-01', 'Mobile APP', null)],
  ): WorkEntry => {
    const base = roomsEntry(rooms);
    return { ...base, map: { ...base.map, messages } };
  };

  /** Уведомитель, у которого первый снимок — комната без сообщений: база есть, дальше всё — «после подключения». */
  function started(): Harness {
    const h = harness([]);
    h.notifier.onWorks([withMessages([])]);
    return h;
  }

  it('новое упоминание — одно уведомление macOS: заголовок «S02 mentioned you in Mobile APP», выдержка из текста, тег mention:<workKey>:<roomId>, цель — комната', () => {
    const h = started();
    h.notifier.onWorks([
      withMessages([mention('m-1', { text: '\n\nReady for review, @human\nsecond line' })]),
    ]);
    expect(h.notes).toEqual([
      {
        title: 'S02 mentioned you in Mobile APP',
        body: 'Ready for review, @you',
        tag: TAG,
        target: TARGET,
        silent: false,
      },
    ]);
    // Карточкой в окне показываются только решения.
    expect(h.windowNotes).toEqual([]);
  });

  it('первый снимок — база: упоминание, ждавшее на старте окна, не уведомляет; следующее — уведомляет', () => {
    const h = harness([]);
    h.notifier.onWorks([withMessages([mention('m-1')])]);
    expect(h.notes).toEqual([]);
    h.notifier.onWorks([withMessages([mention('m-1')])]);
    expect(h.notes).toEqual([]);
    h.notifier.onWorks([
      withMessages([mention('m-1'), mention('m-2', { text: 'Second ping, @human' })]),
    ]);
    expect(h.notes.map((note) => note.body)).toEqual(['Second ping, @you']);
  });

  it('prefs().mail: false — нет, и упоминание запомнено: включение настройки его не повторяет', () => {
    const h = started();
    h.prefs = { ...h.prefs, mail: false };
    h.notifier.onWorks([withMessages([mention('m-1')])]);
    expect(h.notes).toEqual([]);
    h.prefs = { ...h.prefs, mail: true };
    h.notifier.onWorks([withMessages([mention('m-1')])]);
    expect(h.notes).toEqual([]);
  });

  it('вкладка комнаты видна — уведомления нет; видна вкладка другой комнаты — есть', () => {
    const h = started();
    h.visible.add(JSON.stringify(TARGET));
    h.notifier.onWorks([withMessages([mention('m-1')])]);
    expect(h.notes).toEqual([]);
    h.visible.clear();
    h.visible.add(JSON.stringify({ ...TARGET, roomId: 'r-02' }));
    h.notifier.onWorks([withMessages([mention('m-1'), mention('m-2')])]);
    expect(h.notes).toHaveLength(1);
  });

  it('два новых упоминания в одной комнате — одно уведомление, текст — самого позднего', () => {
    const h = started();
    h.notifier.onWorks([
      withMessages([
        mention('m-1', { text: 'First, @human' }),
        mention('m-2', { text: 'Second, @human' }),
      ]),
    ]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toMatchObject({ body: 'Second, @you', tag: TAG });
  });

  it('упоминания в двух комнатах — два уведомления с тегами своих комнат и своими отправителями', () => {
    const h = harness([]);
    const rooms = [room('r-01', 'Mobile APP', null), room('r-02', 'Backend', null)];
    h.notifier.onWorks([withMessages([], rooms)]);
    h.notifier.onWorks([
      withMessages(
        [
          mention('m-1', { roomId: 'r-02', from: 's-01', text: 'API is ready, @human' }),
          mention('m-2', { text: 'Ready for review, @human' }),
        ],
        rooms,
      ),
    ]);
    expect(h.notes.map((note) => [note.tag, note.title, note.body])).toEqual([
      ['mention:/tmp/p w-01:r-01', 'S02 mentioned you in Mobile APP', 'Ready for review, @you'],
      ['mention:/tmp/p w-01:r-02', 'S01 mentioned you in Backend', 'API is ready, @you'],
    ]);
  });

  it('не уведомляют: без @human, @humans, от человека, системное, письмо без комнаты, прочитанное', () => {
    const h = started();
    h.notifier.onWorks([
      withMessages([
        mention('m-1', { text: 'just a status' }),
        mention('m-2', { text: 'ask the @humans' }),
        mention('m-3', { from: 'human', to: ['s-01'] }),
        mention('m-4', { from: 'system' }),
        mention('m-5', { roomId: null, to: ['s-01'] }),
        mention('m-6', { readBy: { human: '2026-01-01T00:05:00.000Z' } }),
      ]),
    ]);
    expect(h.notes).toEqual([]);
  });

  it('не уведомляют и там, где лента чипа не рисует: @human в коде, в подписи и адресе ссылки', () => {
    const h = started();
    h.notifier.onWorks([
      withMessages([
        mention('m-1', { text: 'run `@human` in the shell' }),
        mention('m-2', { text: '```\n@human\n```' }),
        mention('m-3', { text: '[ask @human](https://x.dev)' }),
        mention('m-4', { text: 'see https://github.com/@human' }),
      ]),
    ]);
    expect(h.notes).toEqual([]);
    // А в выделении лента чип рисует, и уведомление идёт.
    h.notifier.onWorks([
      withMessages([
        mention('m-1', { text: 'run `@human` in the shell' }),
        mention('m-5', { text: 'cc **@human**' }),
      ]),
    ]);
    expect(h.notes.map((note) => note.body)).toEqual(['cc @you']);
  });

  it('упоминание, уже бывшее в прошлом снимке и всё ещё не прочитанное, второй раз не уведомляет', () => {
    const h = started();
    h.notifier.onWorks([withMessages([mention('m-1')])]);
    h.notifier.onWorks([withMessages([mention('m-1'), mention('m-2', { text: 'plain status' })])]);
    expect(h.notes).toHaveLength(1);
  });

  it('пустое название комнаты — «Room»', () => {
    const h = harness([]);
    h.notifier.onWorks([withMessages([], [room('r-01', '', null)])]);
    h.notifier.onWorks([withMessages([mention('m-1')], [room('r-01', '', null)])]);
    expect(h.notes[0]?.title).toBe('S02 mentioned you in Room');
  });

  it('письмо человеку и упоминание в одном снимке — два уведомления: mail:<workKey> и mention:<workKey>:<roomId>', () => {
    const h = started();
    h.notifier.onWorks([
      withMessages([letter('m-1', { kind: 'question', text: 'Which API?' }), mention('m-2')]),
    ]);
    expect(h.notes.map((note) => [note.tag, note.title])).toEqual([
      ['mail:/tmp/p w-01', 'Redesign · question from S01'],
      [TAG, 'S02 mentioned you in Mobile APP'],
    ]);
  });

  it('sound: false → silent: true; длинная первая строка — выдержка в 140 знаков и «…», заголовок цел', () => {
    const h = started();
    h.prefs = { ...h.prefs, sound: false };
    h.notifier.onWorks([withMessages([mention('m-1', { text: `@human ${'😀'.repeat(201)}` })])]);
    expect(h.notes[0]?.silent).toBe(true);
    // «@you » — пять знаков, остальные 135 — эмодзи: всего 140 знаков и «…».
    expect(h.notes[0]?.body).toBe(`@you ${'😀'.repeat(135)}…`);
    expect(h.notes[0]?.title).toBe('S02 mentioned you in Mobile APP');
  });

  it('тело — выдержка, как у цитаты ответа: разрыв пропущен, разметка снята, текст в одну строку', () => {
    const h = started();
    h.notifier.onWorks([
      withMessages([
        mention('m-1', {
          text: '---\n> - **Ready** for [review](https://x.dev/1), @human\nsecond line',
        }),
      ]),
    ]);
    expect(h.notes.map((note) => note.body)).toEqual(['Ready for review, @you']);
  });

  it('подписи упоминаний — по карте работы, как у чипов ленты: @s01 — «S01 planner», нет в карте — тег, код остаётся кодом', () => {
    const h = started();
    h.notifier.onWorks([
      withMessages([
        mention('m-1', { text: 'Ask @s01 or @s09, @human; but `@s01` and `@human` stay code' }),
      ]),
    ]);
    expect(h.notes.map((note) => note.body)).toEqual([
      'Ask @S01 planner or @S09, @you; but @s01 and @human stay code',
    ]);
  });

  it('письма человеку по-прежнему — первая строка как есть: выдержка только у упоминаний', () => {
    const h = started();
    h.notifier.onWorks([
      withMessages([letter('m-1', { kind: 'question', text: '**Which** API, @s01?' })]),
    ]);
    expect(h.notes.map((note) => note.body)).toEqual(['**Which** API, @s01?']);
  });

  it('в уведомлении нет кириллицы из слов окна: заголовок — английский', () => {
    const h = started();
    h.notifier.onWorks([withMessages([mention('m-1')])]);
    expect(JSON.stringify(h.notes)).not.toMatch(/[Ѐ-ӿ]/);
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
    useWindowNotesStore.setState({ notes: [] });
    useUiStore.setState({ windowFocused: true, documentVisible: true });
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

  it('упоминание человека в комнате: первый снимок работ — база; следующий с новым упоминанием — уведомление macOS с целью-комнатой', () => {
    const off = wire();
    const current = useWorksStore.getState().entries[0] as WorkEntry;
    const base = { ...current, map: { ...current.map, rooms: [room('r-01', 'Mobile APP', null)] } };
    const mention = (id: string): Message =>
      letter(id, { roomId: 'r-01', from: 's-02', to: [], text: 'Take a look, @human' });
    useWorksStore.setState({
      entries: [{ ...base, map: { ...base.map, messages: [mention('m-1')] } }],
    });
    expect(bridge.appNotified).toEqual([]);
    useWorksStore.setState({
      entries: [{ ...base, map: { ...base.map, messages: [mention('m-1'), mention('m-2')] } }],
    });
    expect(bridge.appNotified).toMatchObject([
      {
        title: 'S02 mentioned you in Mobile APP',
        body: 'Take a look, @you',
        tag: 'mention:/tmp/p w-01:r-01',
        target: { kind: 'room', projectPath: '/tmp/p', workId: 'w-01', roomId: 'r-01' },
      },
    ]);
    off();
  });

  /** Снимок работы с комнатой `r-01` и решением (или без него) — заменой `entries` стора работ. */
  function setRoom(decision: Proposal | null): void {
    const current = useWorksStore.getState().entries[0] as WorkEntry;
    useWorksStore.setState({ entries: [{ ...current, map: { ...current.map, rooms: [room('r-01', 'Возвраты', decision)] } }] });
  }

  it('решение в комнате: окно в фокусе — карточка в окне, а не macOS; окно не в фокусе — уведомление macOS, а не карточка', () => {
    const off = wire();
    setRoom(null);
    setRoom(proposal('p-01'));
    expect(useWindowNotesStore.getState().notes).toMatchObject([
      { tag: 'proposal:/tmp/p w-01:r-01', title: 'Decision waiting for you', body: 'Возвраты · S01 collected positions' },
    ]);
    expect(bridge.appNotified).toEqual([]);

    // Окно без фокуса — то же решение, но замена: системное уведомление с тем же тегом.
    useUiStore.setState({ windowFocused: false });
    setRoom(proposal('p-01', 1));
    expect(bridge.appNotified).toMatchObject([
      { tag: 'proposal:/tmp/p w-01:r-01', title: 'Decision waiting for you', body: 'Возвраты · S01 revised the decision', target: { kind: 'room', roomId: 'r-01' } },
    ]);
    expect(useWindowNotesStore.getState().notes).toHaveLength(1);
    off();
  });

  it('свёрнутое окно (документ скрыт) при фокусе — уведомление macOS: показать карточку некому', () => {
    const off = wire();
    setRoom(null);
    useUiStore.setState({ documentVisible: false });
    setRoom(proposal('p-01'));
    expect(bridge.appNotified).toHaveLength(1);
    expect(useWindowNotesStore.getState().notes).toEqual([]);
    off();
  });

  it('перезапуск окна и переподключение к хосту (новая подписка, первый снимок — база): то же решение не уведомляет вновь', () => {
    const off = wire();
    setRoom(null);
    setRoom(proposal('p-01'));
    expect(useWindowNotesStore.getState().notes).toHaveLength(1);
    off();
    useWindowNotesStore.setState({ notes: [] });

    const offAgain = wire();
    // `works.list` после подключения отдаёт тот же снимок с тем же решением.
    setRoom(proposal('p-01'));
    setRoom(proposal('p-01'));
    expect(useWindowNotesStore.getState().notes).toEqual([]);
    expect(bridge.appNotified).toEqual([]);
    // А замена уже после базы — новость.
    setRoom(proposal('p-01', 1));
    expect(useWindowNotesStore.getState().notes).toHaveLength(1);
    offAgain();
  });

  it('ответ человека на решение гасит его карточку в окне', () => {
    const off = wire();
    setRoom(null);
    setRoom(proposal('p-01'));
    expect(useWindowNotesStore.getState().notes).toHaveLength(1);
    setRoom(null);
    expect(useWindowNotesStore.getState().notes).toEqual([]);
    off();
  });
});
