import { describe, expect, it } from 'vitest';
import { addMessage, addSession, removeSession } from './map.js';
import { decisionsOf, participantLabel, recentDecisions, sessionTag, threadOf } from './thread.js';
import type { Message, MessageKind, WorkMap } from './types.js';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: {
    id: 'w-0001',
    title: 'Авторизация',
    goal: 'цель',
    status: 'active',
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedAt: '2026-09-08T09:00:00.000Z',
  },
  sessions: [],
  messages: [],
  rooms: [],
});

const at = (clock: string): string => `2026-09-08T${clock}:00.000Z`;

const letter = (
  map: WorkMap,
  from: string,
  to: string,
  clock: string,
  kind: MessageKind,
): Message => addMessage(map, { from, to: [to], text: `${from} → ${to}`, kind }, at(clock));

const ids = (messages: readonly Message[]): string[] => messages.map((message) => message.id);

/** Две группы в одной работе: `s-01 → (s-02 → s-03, s-04)` и `s-05 → s-06`. */
const forest = (): WorkMap => {
  const map = emptyMap();
  addSession(map, { provider: 'claude', label: 'план', task: 't' });
  addSession(map, { provider: 'claude', label: 'бэкенд', task: 't', parent: 's-01' });
  addSession(map, { provider: 'claude', label: 'тесты', task: 't', parent: 's-02' });
  addSession(map, { provider: 'claude', label: 'ревью', task: 't', parent: 's-01' });
  addSession(map, { provider: 'claude', label: 'релиз', task: 't' });
  addSession(map, { provider: 'claude', label: 'доки', task: 't', parent: 's-05' });
  letter(map, 's-01', 's-02', '10:00', 'note');
  letter(map, 's-02', 's-01', '10:05', 'question');
  letter(map, 's-03', 's-04', '10:10', 'decision');
  letter(map, 's-05', 's-06', '10:15', 'note');
  letter(map, 's-02', 's-06', '10:20', 'note');
  return map;
};

describe('threadOf', () => {
  it('у сессии с родителем — поддерево родителя: родитель, братья, она, потомки', () => {
    const thread = threadOf(forest(), 's-02');

    expect(thread.owner).toBe('s-01');
    expect([...thread.members].sort()).toEqual(['s-01', 's-02', 's-03', 's-04']);
    expect(ids(thread.messages)).toEqual(['m-01', 'm-02', 'm-03']);
  });

  it('корень с детьми — собственное поддерево, письма чужого корня не попадают', () => {
    const thread = threadOf(forest(), 's-01');

    expect(thread.owner).toBe('s-01');
    expect([...thread.members].sort()).toEqual(['s-01', 's-02', 's-03', 's-04']);
    expect(ids(thread.messages)).toEqual(['m-01', 'm-02', 'm-03']);
  });

  it('одинокий корень — вся работа: owner null, все сессии, все письма', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't' });
    addSession(map, { provider: 'codex', label: 'ревью', task: 't' });
    letter(map, 's-01', 's-02', '10:00', 'note');
    letter(map, 's-02', 's-01', '10:05', 'decision');

    const thread = threadOf(map, 's-01');

    expect(thread.owner).toBeNull();
    expect(thread.members).toEqual(['s-01', 's-02']);
    expect(ids(thread.messages)).toEqual(['m-01', 'm-02']);
  });

  it('письмо между двумя поддеревьями не попадает ни в один тред', () => {
    const map = forest();

    expect(ids(threadOf(map, 's-02').messages)).not.toContain('m-05');
    expect(ids(threadOf(map, 's-06').messages)).toEqual(['m-04']);
  });

  it('удалённая сессия не участник, её письма остаются', () => {
    const map = forest();
    removeSession(map, 's-03');

    const thread = threadOf(map, 's-02');

    expect(thread.members).not.toContain('s-03');
    expect([...thread.members].sort()).toEqual(['s-01', 's-02', 's-04']);
    expect(ids(thread.messages)).toEqual(['m-01', 'm-02', 'm-03']);
  });
});

describe('decisionsOf', () => {
  it('только kind decision, по времени at', () => {
    const map = forest();
    letter(map, 's-01', 's-04', '09:50', 'decision');

    expect(ids(decisionsOf(threadOf(map, 's-01')))).toEqual(['m-06', 'm-03']);
  });
});

describe('participantLabel', () => {
  it('живая — ярлык, удалённая — «s-03 (удалена)», чужой id — как есть', () => {
    const map = forest();

    expect(participantLabel(map, 's-01')).toBe('план');
    removeSession(map, 's-03');
    // Ярлыка удалённой в карте не остаётся — только id в `deletedSessions`.
    expect(participantLabel(map, 's-03')).toBe('s-03 (deleted)');
    expect(participantLabel(map, 's-99')).toBe('s-99');
  });
});

describe('sessionTag', () => {
  it.each([
    ['s-01', 'S01'],
    ['s-12', 'S12'],
    ['s-1', 'S1'],
    ['S01', 'S01'],
    ['s01', 's01'],
    ['session-1', 'session-1'],
    ['w-0010', 'w-0010'],
    ['s-', 's-'],
    ['', ''],
  ])('%s → %s', (id, expected) => {
    expect(sessionTag(id)).toBe(expected);
  });
});

describe('recentDecisions', () => {
  it('последние решения по порядку и общее число; заметки и вопросы не в счёте', () => {
    const map = emptyMap();
    addSession(map, { provider: 'claude', label: 'план', task: 't' });
    for (const [clock, kind] of [['10:00', 'decision'], ['10:01', 'note'], ['10:02', 'decision'], ['10:03', 'question'], ['10:04', 'decision']] as const) {
      addMessage(map, { from: 'human', to: ['s-01'], text: clock, kind }, at(clock));
    }
    const thread = threadOf(map, 's-01');
    const { shown, total } = recentDecisions(thread, 2);
    expect(total).toBe(3);
    expect(shown.map((message) => message.text)).toEqual(['10:02', '10:04']);
    expect(recentDecisions(thread, 10).shown).toEqual(decisionsOf(thread));
  });
});
