import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeWorkDb, createWork, deleteWorkFiles, mapLetterTx, readLetters, readMap, WorkNotFoundError, writeLetters } from '@parley/core';
import type { Message, Room, SessionActivity, WorkEntry, WorkSession } from '@parley/core';
import type { SessionRef, WorksSnapshot } from '@parley/protocol';
// Счётчик кэша карт ядра — только для тестов, из пакета он не экспортируется; тот же экземпляр модуля, что у `@parley/core`.
import { mapCacheStats } from '../../../core/dist/work/store.js';
import { activityTransition, emptyMemory, mailTriggers, sessionWhere, storeTriggerLetters, worksTriggers as triggersWith, type NotifyMemory, type TriggerLetters } from './notify.js';

const ref: SessionRef = { projectPath: '/p/my_harnas', workId: 'w-01', sessionId: 's-01' };
const session = (lifecycle: WorkSession['lifecycle'] = 'active'): WorkSession => ({ id: 's-01', lifecycle, result: null }) as unknown as WorkSession;
const live = (activity: SessionActivity['activity']): SessionActivity => ({ activity }) as SessionActivity;

describe('activityTransition', () => {
  it('первое значение — база', () => {
    expect(activityTransition(emptyMemory(), ref, session(), live('blocked'))).toBeNull();
  });
  it('idle → blocked → needs-you, повтор blocked → null', () => {
    const memory = emptyMemory();
    activityTransition(memory, ref, session(), live('idle'));
    expect(activityTransition(memory, ref, session(), live('blocked'))).toBe('needs-you');
    expect(activityTransition(memory, ref, session(), live('blocked'))).toBeNull();
  });
  it('working → unseen → unseen', () => {
    const memory = emptyMemory();
    activityTransition(memory, ref, session(), live('working'));
    expect(activityTransition(memory, ref, session(), live('unseen'))).toBe('unseen');
  });
  it('переход в working и idle поводом не является', () => {
    const memory = emptyMemory();
    activityTransition(memory, ref, session(), live('blocked'));
    expect(activityTransition(memory, ref, session(), live('working'))).toBeNull();
    expect(activityTransition(memory, ref, session(), live('idle'))).toBeNull();
  });
  it('закрытая сессия не даёт повода', () => {
    const memory = emptyMemory();
    activityTransition(memory, ref, session(), live('idle'));
    expect(activityTransition(memory, ref, session('closed'), live('blocked'))).toBeNull();
  });
  // Спека подписок К16: «needs you» в Telegram — тот же уровень, что в окне. Лимит и слетевший вход оставляют ход
  // законченным (`unseen`/`idle`), но `need` у живой сессии значит «нужен ты» (core `sessionAttention`).
  const withNeed = (activity: SessionActivity['activity'], kind: string): SessionActivity =>
    ({ activity, need: { kind } }) as unknown as SessionActivity;
  it('живая сессия с need при законченном ходе (лимит, вход) — needs-you; повтор — null', () => {
    const memory = emptyMemory();
    activityTransition(memory, ref, session(), live('working'));
    expect(activityTransition(memory, ref, session(), withNeed('unseen', 'limit'))).toBe('needs-you');
    expect(activityTransition(memory, ref, session(), withNeed('unseen', 'limit'))).toBeNull();
    expect(activityTransition(memory, ref, session(), live('working'))).toBeNull();
    expect(activityTransition(memory, ref, session(), withNeed('idle', 'sign-in'))).toBe('needs-you');
  });
  it('need у спящей и закрытой сессии — не повод', () => {
    for (const lifecycle of ['sleeping', 'closed'] as const) {
      const memory = emptyMemory();
      activityTransition(memory, ref, session(lifecycle), live('idle'));
      expect(activityTransition(memory, ref, session(lifecycle), withNeed('unseen', 'limit'))).toBeNull();
    }
  });
});

const message = (id: string, over: Partial<Message> = {}): Message =>
  ({ id, roomId: null, from: 's-01', to: ['human'], at: '2026-10-20T10:00:00Z', text: 'hello', kind: 'note', readBy: {}, ...over }) as Message;
const room = (over: Partial<Room> = {}): Room => ({ id: 'r-01', title: 'Auth', members: ['s-01'], proposal: null, ...over }) as Room;
const entry = (messages: Message[] = [], rooms: Room[] = []): WorkEntry =>
  ({ projectPath: '/p/my_harnas', map: { work: { id: 'w-01', title: 'Parley' }, sessions: [], messages, rooms } }) as unknown as WorkEntry;
const snap = (e: WorkEntry): WorksSnapshot => ({ entries: [e], branches: {} });
/** Письма снимка в памяти: в настоящем хосте их читают из базы работы (спека хранилища 6.2). */
const memoryLetters: TriggerLetters = {
  humanUnread: (e) => mapLetterTx(e.map).letters.unreadFor('human'),
  lastHumanLetter: (e, roomId) => mapLetterTx(e.map).letters.query({ roomId, from: 'human', limit: 1, newestFirst: true })[0],
};
const worksTriggers = (memory: NotifyMemory, snapshot: WorksSnapshot) => triggersWith(memory, snapshot, undefined, memoryLetters);
const slot = (id: string, rev: number): NonNullable<Room['proposal']> => ({ id, from: 's-01', text: 'go', rev, at: '2026-10-20T10:00:00Z' });

describe('worksTriggers: база', () => {
  it('первый снимок — база без поводов', () => {
    const triggers = worksTriggers(emptyMemory(), snap(entry([message('m-01')], [room({ proposal: slot('p-01', 0) })])));
    expect(triggers).toEqual({ decisions: [], closed: [] });
  });
  it('письма снимка не повод: после базы их приносит только onMail', () => {
    const memory = emptyMemory();
    worksTriggers(memory, snap(entry()));
    const next = snap(entry([message('m-01')], [room()]));
    expect(worksTriggers(memory, next)).toEqual({ decisions: [], closed: [] });
  });
});

describe('mailTriggers: письма из записи', () => {
  it('без базы (первого снимка) письмо молчит; после базы то же письмо уже повод', () => {
    const memory = emptyMemory();
    const first = entry([], [room()]);
    expect(mailTriggers(memory, first, [message('m-01')])).toEqual([]);
    worksTriggers(memory, snap(first));
    expect(mailTriggers(memory, first, [message('m-01')]).map((l) => l.message.id)).toEqual(['m-01']);
  });
  it('новое письмо и @human в комнате появляются один раз', () => {
    const memory = emptyMemory();
    const first = entry([], [room()]);
    worksTriggers(memory, snap(first));
    const mention = message('m-02', { roomId: 'r-01', to: [], text: 'ping @human please' });
    expect(mailTriggers(memory, first, [message('m-01'), mention]).map((l) => l.message.id)).toEqual(['m-01', 'm-02']);
    expect(mailTriggers(memory, first, [message('m-01'), mention])).toEqual([]);
  });
  it('прочитанное, своё и чужое сессии письмо поводом не служит', () => {
    const memory = emptyMemory();
    const first = entry([], [room()]);
    worksTriggers(memory, snap(first));
    const read = message('m-01', { readBy: { human: '2026-10-20T10:01:00Z' } });
    const mine = message('m-02', { from: 'human', to: ['s-01'] });
    const other = message('m-03', { to: ['s-02'] });
    const plain = message('m-04', { roomId: 'r-01', to: [], text: 'no mention here' });
    expect(mailTriggers(memory, first, [read, mine, other, plain])).toEqual([]);
  });
  it('письмо, непрочитанное уже на базе, молчит, когда его приносит запись', () => {
    const memory = emptyMemory();
    const known = entry([message('m-01')], [room()]);
    worksTriggers(memory, snap(known));
    expect(mailTriggers(memory, known, [message('m-01')])).toEqual([]);
  });
});

describe('worksTriggers: решения', () => {
  it('новый слот → new', () => {
    const memory = emptyMemory();
    worksTriggers(memory, snap(entry([], [room()])));
    const triggers = worksTriggers(memory, snap(entry([], [room({ proposal: slot('p-01', 0) })])));
    expect(triggers.decisions.map((d) => d.change)).toEqual(['new']);
    expect(worksTriggers(memory, snap(entry([], [room({ proposal: slot('p-01', 0) })]))).decisions).toEqual([]);
  });
  it('тот же id с rev+1 → revised и closed.now === revised', () => {
    const memory = emptyMemory();
    worksTriggers(memory, snap(entry([], [room({ proposal: slot('p-01', 0) })])));
    const triggers = worksTriggers(memory, snap(entry([], [room({ proposal: slot('p-01', 1) })])));
    expect(triggers.decisions.map((d) => d.change)).toEqual(['revised']);
    expect(triggers.closed.map((c) => [c.now, c.previous])).toEqual([['revised', { id: 'p-01', rev: 0 }]]);
  });
  it('слот исчез после «Decision accepted.» → accepted', () => {
    const memory = emptyMemory();
    worksTriggers(memory, snap(entry([], [room({ proposal: slot('p-01', 0) })])));
    const letter = message('m-09', { roomId: 'r-01', from: 'human', to: ['s-01'], text: 'Decision accepted.' });
    const triggers = worksTriggers(memory, snap(entry([letter], [room()])));
    expect(triggers.closed.map((c) => [c.roomId, c.now])).toEqual([['r-01', 'accepted']]);
    expect(worksTriggers(memory, snap(entry([letter], [room()]))).closed).toEqual([]);
  });
  it('слот исчез после возврата → returned, без письма → gone', () => {
    const returned = emptyMemory();
    worksTriggers(returned, snap(entry([], [room({ proposal: slot('p-01', 0) })])));
    const letter = message('m-09', { roomId: 'r-01', from: 'human', to: ['s-01'], text: 'Returned for rework: no' });
    expect(worksTriggers(returned, snap(entry([letter], [room()]))).closed[0]?.now).toBe('returned');

    const gone = emptyMemory();
    worksTriggers(gone, snap(entry([], [room({ proposal: slot('p-01', 0) })])));
    expect(worksTriggers(gone, snap(entry([], [room()]))).closed[0]?.now).toBe('gone');
  });
});

describe('sessionWhere', () => {
  it('название работы и папка проекта', () => {
    expect(sessionWhere(entry())).toBe('Parley · my_harnas');
  });
});

// Спека хранилища 6.2: без подставленного чтения письма берутся из базы работы, а не из снимка.
describe('worksTriggers: письма из базы работы (по умолчанию)', () => {
  let root = '';
  let project = '';
  let previous: string | undefined;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'parley-notify-'));
    project = path.join(root, 'project');
    await mkdir(project);
    await mkdir(path.join(root, 'home'));
    previous = process.env['PARLEY_HOME'];
    process.env['PARLEY_HOME'] = path.join(root, 'home');
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env['PARLEY_HOME'];
    else process.env['PARLEY_HOME'] = previous;
    await rm(root, { recursive: true, force: true });
  });

  /** Снимок без писем: настоящая работа в базе, а в снимке хоста о письмах ничего нет. */
  const bare = (workId: string, rooms: Room[] = []): WorksSnapshot => ({
    entries: [{ projectPath: project, map: { work: { id: workId, title: 'Parley' }, sessions: [], messages: [], rooms } } as unknown as WorkEntry],
    branches: {},
  });
  const say = (workId: string, over: { roomId?: string | null; from?: string; to?: string[]; text?: string }): void => {
    writeLetters(project, workId, (letters) => {
      letters.add({ roomId: over.roomId ?? null, from: over.from ?? 's-01', to: over.to ?? ['human'], text: over.text ?? 'hello', kind: 'note' });
    });
  };

  it('письмо человеку из записи — повод, повтор — нет; карта из базы при этом не загружается', async () => {
    const workId = (await createWork(project, { title: 'Parley' })).work.id;
    const memory = emptyMemory();
    const snapshotOf = async (): Promise<WorksSnapshot> => ({
      entries: [{ projectPath: project, map: await readMap(project, workId) } as unknown as WorkEntry],
      branches: {},
    });
    triggersWith(memory, await snapshotOf());
    say(workId, { text: 'из базы' });
    const next = await snapshotOf();
    const added = readLetters(project, workId, { limit: 100 });
    expect(added).toHaveLength(1);

    // Спека хранилища 6.2: повод считается по письмам записи — кэш карт на каждое письмо база не перебирает.
    const before = mapCacheStats();
    const entryOf = next.entries[0] as WorkEntry;
    expect(mailTriggers(memory, entryOf, added).map((item) => item.message.text)).toEqual(['из базы']);
    expect(mailTriggers(memory, entryOf, added)).toEqual([]);
    expect(mapCacheStats()).toEqual(before);
  });

  it('база: письмо, непрочитанное на старте, из базы работы молчит, когда его приносит запись', async () => {
    const workId = (await createWork(project, { title: 'Parley' })).work.id;
    say(workId, { text: 'до старта' });
    const memory = emptyMemory();
    const entryOf = { projectPath: project, map: await readMap(project, workId) } as unknown as WorkEntry;
    triggersWith(memory, { entries: [entryOf], branches: {} });
    expect(mailTriggers(memory, entryOf, readLetters(project, workId, { limit: 100 }))).toEqual([]);
  });

  it('слот решения исчез: итог — по последнему письму человека в базе', async () => {
    const workId = (await createWork(project, { title: 'Parley' })).work.id;
    const memory = emptyMemory();
    triggersWith(memory, bare(workId, [room({ proposal: slot('p-01', 0) })]));
    say(workId, { roomId: 'r-01', from: 'human', to: ['s-01'], text: 'Decision accepted.' });
    const triggers = triggersWith(memory, bare(workId, [room()]));
    expect(triggers.closed.map((c) => [c.roomId, c.now])).toEqual([['r-01', 'accepted']]);
  });

  it('работу удалили, пока она ещё в снимке, — писем нет, сбоя нет', async () => {
    const workId = (await createWork(project, { title: 'Parley' })).work.id;
    const memory = emptyMemory();
    triggersWith(memory, bare(workId, [room({ proposal: slot('p-01', 0) })]));
    await deleteWorkFiles(project, workId);
    const triggers = triggersWith(memory, bare(workId, [room()]));
    expect(triggers.closed.map((c) => c.now)).toEqual(['gone']);
  });

  it('lastHumanLetter: работы нет в базе — письма нет; сбой не из-за пропавшей работы идёт наружу', async () => {
    const entry = bare('w-9999').entries[0] as WorkEntry;
    expect(storeTriggerLetters.lastHumanLetter(entry, 'r-01')).toBeUndefined();

    // Дом — путь внутри обычного файла: базу не открыть, и это не `WorkNotFoundError`, а значит и не «работы нет».
    closeWorkDb();
    const blocker = path.join(root, 'blocker');
    await writeFile(blocker, 'файл на месте каталога');
    process.env['PARLEY_HOME'] = path.join(blocker, 'home');
    let thrown: unknown;
    try {
      storeTriggerLetters.lastHumanLetter(entry, 'r-01');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(WorkNotFoundError);
  });
});
