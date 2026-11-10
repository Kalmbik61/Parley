import { describe, expect, it } from 'vitest';
import type { SessionActivity } from './activity.js';
import { mapLetterTx } from './letter-store.js';
import { addSession } from './map.js';
import { addRoom } from './rooms.js';
import { nudgeText, silentEndingText, silentTurnEnd, silentTurnStep, tellSilentEnding } from './silent-endings.js';
import { PARLEY, type WindowWorkMap } from './types.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const emptyMap = (): WindowWorkMap => ({ schemaVersion: 2,
  work: { id: 'w-0001', title: '', goal: '', status: 'active', createdAt: '', updatedAt: '' },
  sessions: [], rooms: [], messages: [],
});

/**
 * Карта из четырёх сессий: s-02 — исполнитель (создатель s-04), s-01 ведёт комнату r-01 с s-02.
 * Получатели s-02 по `reportRecipients`: s-01 (ведущий), затем s-04 (создатель). s-02 спит, как после выхода процесса.
 */
const setup = () => {
  const map = emptyMap();
  for (let n = 1; n <= 4; n += 1) {
    addSession(map, { provider: 'claude', label: `s${n}`, task: '', ...(n === 2 ? { createdBy: 's-04' } : {}) });
  }
  addRoom(map, { title: 'Room', creator: 's-01', ownerId: 's-01', members: ['s-01', 's-02'], lead: 's-01' });
  for (const session of map.sessions) session.lifecycle = 'active';
  map.sessions[1]!.lifecycle = 'sleeping';
  return { map, letters: mapLetterTx(map).letters };
};

const EXIT = { kind: 'exit', exitCode: 137 } as const;

describe('тексты тихих концовок', () => {
  it('тексты решения 2 дословно', () => {
    expect(silentEndingText('s-05', { kind: 'exit', exitCode: 137 })).toBe(
      's-05 stopped (exit code 137) without a result. A letter to s-05 resumes it.');
    expect(silentEndingText('s-05', { kind: 'exit', exitCode: 1, signal: 9 })).toBe(
      's-05 stopped (signal 9) without a result. A letter to s-05 resumes it.');
    expect(silentEndingText('s-05', { kind: 'exit', exitCode: 1, signal: 0 })).toBe(
      's-05 stopped (exit code 1) without a result. A letter to s-05 resumes it.');
    expect(silentEndingText('s-05', { kind: 'stop' })).toBe('s-05 was stopped by the human without a result.');
    expect(silentEndingText('s-05', { kind: 'close' })).toBe('s-05 was closed by the human without a result.');
    expect(silentEndingText('s-05', { kind: 'turn' })).toBe('s-05 ended its turn without a report.');
    expect(nudgeText(['s-01', 's-02'])).toBe(
      'You ended your turn without calling report. Call report {status: "done" | "failed", summary: "…"}, or tell s-01, s-02 what blocks you with send_message.');
  });
});

describe('tellSilentEnding', () => {
  it('выход без итога — одно письмо всем получателям', () => {
    const { map, letters } = setup();
    expect(tellSilentEnding(map, letters, 's-02', EXIT, iso(NOW))).toBe(true);
    expect(map.messages).toHaveLength(1);
    expect(map.messages[0]).toMatchObject({
      from: PARLEY, roomId: null, to: ['s-01', 's-04'], kind: 'note',
      text: 's-02 stopped (exit code 137) without a result. A letter to s-02 resumes it.',
    });
    expect(map.sessions[1]!.silentEnding).toEqual({ assignment: null, told: ['exit'], nudgedAt: null });
  });

  it('вид — раз на задание; другой вид пишет второе письмо; новое задание даёт чистую отметку', () => {
    const { map, letters } = setup();
    expect(tellSilentEnding(map, letters, 's-02', EXIT, iso(NOW))).toBe(true);
    expect(tellSilentEnding(map, letters, 's-02', EXIT, iso(NOW + MIN))).toBe(false);
    expect(tellSilentEnding(map, letters, 's-02', { kind: 'stop' }, iso(NOW + 2 * MIN))).toBe(true);
    expect(map.messages).toHaveLength(2);
    // Новое письмо-задание от s-04 получает id m-03.
    letters.add({ roomId: null, from: 's-04', to: ['s-02'], text: 'again', kind: 'note', at: iso(NOW + 3 * MIN) });
    expect(tellSilentEnding(map, letters, 's-02', EXIT, iso(NOW + 4 * MIN))).toBe(true);
    expect(map.sessions[1]!.silentEnding).toEqual({ assignment: 'm-03', told: ['exit'], nudgedAt: null });
  });

  it('нет письма: сон хоста, итог задания, рой, нет получателей, не то состояние', () => {
    const slept = setup();
    slept.map.sessions[1]!.autoSleep = { reason: 'idle', at: iso(NOW), waitTarget: null };
    expect(tellSilentEnding(slept.map, slept.letters, 's-02', EXIT, iso(NOW))).toBe(false);

    const done = setup();
    done.map.sessions[1]!.result = 'done';
    done.map.sessions[1]!.resultAt = iso(NOW - MIN);
    expect(tellSilentEnding(done.map, done.letters, 's-02', EXIT, iso(NOW))).toBe(false);

    const swarm = setup();
    swarm.map.swarms = [{ id: 'sw-01', tag: 't', creator: { kind: 'human' }, objective: 'o', queen: 's-03',
      members: [{ sessionId: 's-02', role: 'drone', n: 1, addedAt: iso(NOW), handedAt: null }],
      status: 'running', createdAt: iso(NOW), endedAt: null, result: null, failure: null, seenAt: null, expiredAt: null }];
    expect(tellSilentEnding(swarm.map, swarm.letters, 's-02', EXIT, iso(NOW))).toBe(false);

    const alone = emptyMap();
    addSession(alone, { provider: 'claude', label: 'a', task: '' });
    alone.sessions[0]!.lifecycle = 'sleeping';
    expect(tellSilentEnding(alone, mapLetterTx(alone).letters, 's-01', EXIT, iso(NOW))).toBe(false);
    expect(alone.sessions[0]!.silentEnding).toBeUndefined();

    const awake = setup();
    awake.map.sessions[1]!.lifecycle = 'active';
    expect(tellSilentEnding(awake.map, awake.letters, 's-02', { kind: 'stop' }, iso(NOW))).toBe(false);
    expect(tellSilentEnding(awake.map, awake.letters, 's-02', { kind: 'close' }, iso(NOW))).toBe(false);
    expect([slept, done, swarm, awake].map((one) => one.map.messages.length)).toEqual([0, 0, 0, 0]);
  });

  it('старый итог не в счёт: итог раньше нового письма-задания', () => {
    const { map, letters } = setup();
    map.sessions[1]!.result = 'done';
    map.sessions[1]!.resultAt = iso(NOW - 10 * MIN);
    letters.add({ roomId: null, from: 's-04', to: ['s-02'], text: 'more work', kind: 'note', at: iso(NOW - MIN) });
    expect(tellSilentEnding(map, letters, 's-02', EXIT, iso(NOW))).toBe(true);
    expect(map.messages[1]).toMatchObject({ to: ['s-01', 's-04'] });
  });

  it('close: спящий ждущий этой сессии не в получателях', () => {
    const { map, letters } = setup();
    map.sessions[1]!.lifecycle = 'closed';
    map.sessions[3]!.lifecycle = 'sleeping';
    map.sessions[3]!.autoSleep = { reason: 'idle', at: iso(NOW), waitTarget: 's-02' };
    expect(tellSilentEnding(map, letters, 's-02', { kind: 'close' }, iso(NOW))).toBe(true);
    expect(map.messages[0]).toMatchObject({ to: ['s-01'], text: 's-02 was closed by the human without a result.' });
  });
});

describe('silentTurnStep', () => {
  /** Живая сессия s-02 с получателями s-01 и s-04 и без непрочитанного. */
  const live = () => {
    const one = setup();
    one.map.sessions[1]!.lifecycle = 'active';
    return one;
  };

  it('ход: напоминание, письмо получателям, дальше тишина', () => {
    const { map, letters } = live();
    expect(silentTurnStep(map, letters, 's-02', iso(NOW))).toBe('nudged');
    expect(map.messages[0]).toMatchObject({ from: PARLEY, to: ['s-02'], text: nudgeText(['s-01', 's-04']) });
    // Сессия прочла напоминание (иначе у неё непрочитанное и сторож молчит).
    letters.markRead('s-02', [map.messages[0]!.id], iso(NOW + MIN));
    expect(silentTurnStep(map, letters, 's-02', iso(NOW + 5 * MIN))).toBe('told');
    expect(map.messages[1]).toMatchObject({
      from: PARLEY, roomId: null, to: ['s-01', 's-04'], text: 's-02 ended its turn without a report.',
    });
    expect(silentTurnStep(map, letters, 's-02', iso(NOW + 10 * MIN))).toBeNull();
    expect(map.messages).toHaveLength(2);
    expect(map.sessions[1]!.silentEnding).toEqual({ assignment: null, told: ['turn'], nudgedAt: iso(NOW) });
  });

  it('письмо сессии после напоминания: отметка без письма', () => {
    const { map, letters } = live();
    expect(silentTurnStep(map, letters, 's-02', iso(NOW))).toBe('nudged');
    letters.markRead('s-02', [map.messages[0]!.id], iso(NOW + MIN));
    letters.add({ roomId: null, from: 's-02', to: ['s-01'], text: 'blocked on X', kind: 'note', at: iso(NOW + 2 * MIN) });
    expect(silentTurnStep(map, letters, 's-02', iso(NOW + 5 * MIN))).toBeNull();
    expect(map.messages).toHaveLength(2);
    expect(map.sessions[1]!.silentEnding).toEqual({ assignment: null, told: ['turn'], nudgedAt: iso(NOW) });
    expect(silentTurnStep(map, letters, 's-02', iso(NOW + 10 * MIN))).toBeNull();
  });

  it('ход не трогает: ведущего живой комнаты, сессию с живым ребёнком, с непрочитанным, со stuck, с итогом', () => {
    const lead = live();
    lead.map.rooms[0]!.lead = 's-02';
    lead.map.rooms[0]!.ownerId = 's-04';
    expect(silentTurnStep(lead.map, lead.letters, 's-02', iso(NOW))).toBeNull();

    const parent = live();
    addSession(parent.map, { provider: 'claude', label: 'child', task: '', createdBy: 's-02' });
    parent.map.sessions[4]!.lifecycle = 'active';
    expect(silentTurnStep(parent.map, parent.letters, 's-02', iso(NOW))).toBeNull();

    const unread = live();
    unread.letters.add({ roomId: null, from: 's-04', to: ['s-02'], text: 'task', kind: 'note', at: iso(NOW - MIN) });
    expect(silentTurnStep(unread.map, unread.letters, 's-02', iso(NOW))).toBeNull();

    const stuck = live();
    stuck.map.sessions[1]!.stuck = { kind: 'approval', since: iso(NOW - MIN), detail: null, resetsAt: null, window: null, account: null };
    expect(silentTurnStep(stuck.map, stuck.letters, 's-02', iso(NOW))).toBeNull();

    const done = live();
    done.map.sessions[1]!.result = 'done';
    done.map.sessions[1]!.resultAt = iso(NOW - MIN);
    expect(silentTurnStep(done.map, done.letters, 's-02', iso(NOW))).toBeNull();

    // Участник комнаты, которого завёл человек: письма-задания нет, создателя нет — задания у него нет.
    const member = live();
    delete member.map.sessions[1]!.createdBy;
    expect(silentTurnStep(member.map, member.letters, 's-02', iso(NOW))).toBeNull();

    for (const one of [lead, parent, stuck, done, member]) expect(one.map.messages).toHaveLength(0);
    expect(unread.map.messages).toHaveLength(1);
    expect(unread.map.sessions[1]!.silentEnding).toBeUndefined();
    expect(member.map.sessions[1]!.silentEnding).toBeUndefined();
  });

  it('участник комнаты, которого завёл человек: напоминание появляется с письмом-заданием', () => {
    const { map, letters } = live();
    delete map.sessions[1]!.createdBy;
    expect(silentTurnStep(map, letters, 's-02', iso(NOW))).toBeNull();
    // Ведущий s-01 даёт часть s-02; читаем письмо, чтобы непрочитанного не осталось (id m-01).
    letters.add({ roomId: 'r-01', from: 's-01', to: ['s-02'], text: 'your part', kind: 'note', at: iso(NOW + MIN) });
    letters.markRead('s-02', [map.messages[0]!.id], iso(NOW + 2 * MIN));
    expect(silentTurnStep(map, letters, 's-02', iso(NOW + 5 * MIN))).toBe('nudged');
    expect(map.messages[1]).toMatchObject({ from: PARLEY, to: ['s-02'], text: nudgeText(['s-01']) });
  });
});

describe('silentTurnEnd', () => {
  const START = NOW - 60 * MIN;
  /** Сессия кончила ход 10 минут назад, хуки были после запуска, ничто её не держит. */
  const idle = (patch: Partial<SessionActivity> = {}): SessionActivity => ({
    activity: 'idle', subagents: 0, tasks: [], waitingFor: null, heldByBackground: false, runningBackground: [],
    turnEndedAt: iso(NOW - 10 * MIN), turnBoundaryAt: null, lastEventAt: iso(NOW - 9 * MIN),
    source: 'hooks', hooksMissing: false, need: null, ...patch,
  });

  it('idle и unseen с концом хода дают время конца хода', () => {
    expect(silentTurnEnd(idle(), START)).toBe(NOW - 10 * MIN);
    expect(silentTurnEnd(idle({ activity: 'unseen' }), START)).toBe(NOW - 10 * MIN);
  });

  it('конец хода раньше запуска процесса — время запуска', () => {
    expect(silentTurnEnd(idle({ turnEndedAt: iso(NOW - 70 * MIN) }), START)).toBe(START);
  });

  it('иначе null', () => {
    const need = { kind: 'limit', since: iso(NOW), detail: null, resetsAt: null, window: null, account: null } as const;
    const cases: Array<SessionActivity | null | undefined> = [
      null, undefined,
      idle({ activity: 'working', turnEndedAt: null }),
      idle({ waitingFor: 'inbox' }),
      idle({ need }),
      idle({ quietTurn: true }),
      idle({ runningBackground: ['shell'] }),
      idle({ lastEventAt: null }),
      idle({ lastEventAt: iso(START - MIN) }),
      idle({ turnEndedAt: null }),
    ];
    expect(cases.map((one) => silentTurnEnd(one, START))).toEqual(cases.map(() => null));
  });
});
