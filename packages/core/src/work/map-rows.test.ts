import { describe, expect, it } from 'vitest';
import { addMessage, addSession, normalizeMap } from './map.js';
import {
  diffRows,
  ENTRY_FIELDS,
  mapToRows,
  rowIndex,
  rowsToMap,
  type EntryKind,
  type RowsDiff,
} from './map-rows.js';
import { reservePlanEffects } from './plan-effects.js';
import { resolveProposal, setProposal } from './proposals.js';
import { addRoom } from './rooms.js';
import { HUMAN, type PlanDraft, type WorkMap } from './types.js';
import { mapLetterTx } from './letter-store.js';
const lt = (map: Parameters<typeof mapLetterTx>[0]) => mapLetterTx(map).letters;

const AT = '2026-10-04T01:00:00.000Z';
const SOURCE = 'map-rows.test';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: {
    id: 'w-0001',
    title: 'Раскладка',
    goal: '',
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
  },
  sessions: [],
  messages: [],
  rooms: [],
});

/** Как с диска: чистый JSON, прошедший `normalizeMap` — тот вид, в котором карту видит `updateMap`. */
const asRead = (map: WorkMap): WorkMap =>
  normalizeMap(JSON.parse(JSON.stringify(map)) as unknown, SOURCE);

/**
 * Карта со всеми коллекциями, которые живут строками: три сессии, две комнаты, принятый план (план, снимок плана,
 * решение с экспортом, доставки), письма, намерение закрыть пункт бэклога, журнал ресурсов.
 */
function fullMap(): WorkMap {
  const map = emptyMap();
  for (const label of ['Lead', 'Owner', 'Reviewer']) {
    addSession(map, { provider: 'codex', label, task: 'Fixture' }, AT);
  }
  addRoom(
    map,
    {
      title: 'Plan',
      creator: HUMAN,
      members: ['s-01', 's-02', 's-03'],
      lead: 's-01',
      mode: 'verified',
    },
    AT,
  );
  addRoom(map, { title: 'Chat', creator: HUMAN, members: ['s-01', 's-02'] }, AT);
  const draft: PlanDraft = {
    mode: 'verified',
    goal: 'Done',
    items: [
      {
        id: 1,
        title: 'Item 1',
        owner: 's-02',
        scope: 'src/a.ts',
        criteria: ['Passing checks'],
        verifier: 's-03',
      },
    ],
  };
  const proposed = setProposal(map, 'r-01', 's-01', 'Decision', AT, { plan: draft });
  resolveProposal(
    map,
    lt(map),
    'r-01',
    proposed.proposalId,
    'accept',
    { rev: proposed.rev, planId: map.rooms[0]!.proposal!.plan!.id, planRev: 0 },
    AT,
  );
  reservePlanEffects(map, lt(map), 20, AT);
  addMessage(map, { from: 's-02', to: ['s-01'], text: 'ping' }, AT);

  const plan = map.plans![0]!;
  plan.status = 'completed';
  plan.completedAt = AT;
  plan.backlog = ['b-001'];
  map.planBacklogIntents = [
    {
      key: `${plan.id}/${plan.rev}/b-001/${AT}`,
      planId: plan.id,
      rev: plan.rev,
      backlogId: 'b-001',
      completedAt: AT,
      status: 'pending',
    },
  ];
  map.resources = { seq: 1, spawned: 1, spawnedByRoom: { 'r-01': 1 }, attempts: [] };
  return asRead(map);
}

/** Через базу карта проходит строками-строками: на выходе — то, что дал бы `readMap`. */
function roundTrip(map: WorkMap): WorkMap {
  const { work, extra, rows } = mapToRows(map);
  return normalizeMap(rowsToMap(work, extra, rows), SOURCE);
}

/** Что запишет `updateMap`, когда карта `before` превратилась в `after`: строки `before` уже в базе. */
function diffBetween(before: WorkMap, after: WorkMap): RowsDiff {
  const stored = mapToRows(before);
  const index = rowIndex(stored.rows);
  return diffRows({ work: stored.work, extra: stored.extra, index }, mapToRows(after, index));
}

const kindsOf = (diff: RowsDiff): EntryKind[] => diff.upserts.map((row) => row.kind);

describe('mapToRows и rowsToMap', () => {
  it('карта со всеми коллекциями проходит туда и обратно без потерь', () => {
    const map = fullMap();
    for (const field of Object.values(ENTRY_FIELDS)) {
      expect(map[field]?.length, field).toBeGreaterThan(0);
    }
    expect(map.resources).toBeDefined();

    const { rows } = mapToRows(map);
    expect(new Set(rows.map((row) => row.kind))).toEqual(new Set(Object.keys(ENTRY_FIELDS)));
    expect(roundTrip(map)).toEqual(map);
  });

  it('незнакомое поле верхнего уровня возвращается как было, даже с именем из служебных', () => {
    const map = {
      ...fullMap(),
      futureField: { nested: [1, 2, { deep: true }] },
      present: 'чужое',
    } as WorkMap;
    const back = roundTrip(map) as unknown as Record<string, unknown>;

    expect(back).toEqual(map);
    expect(back['futureField']).toEqual({ nested: [1, 2, { deep: true }] });
    expect(back['present']).toBe('чужое');
  });

  it('карта без необязательных коллекций возвращает тот же набор полей, пустая коллекция остаётся пустой', () => {
    const minimal = asRead(emptyMap());
    expect(Object.keys(minimal).sort()).toEqual([
      'messages',
      'plans',
      'rooms',
      'schemaVersion',
      'sessions',
      'work',
    ]);
    expect(roundTrip(minimal)).toEqual(minimal);

    // Сырой объект, как его хранит база: ровно те поля, что были, — без `plans`, которое подставляет normalizeMap.
    const raw = emptyMap();
    const { work, extra, rows } = mapToRows(raw);
    const stored = rowsToMap(work, extra, rows) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      'messages',
      'rooms',
      'schemaVersion',
      'sessions',
      'work',
    ]);

    const withEmpty = { ...emptyMap(), planExports: [] } as WorkMap;
    const emptied = mapToRows(withEmpty);
    const back = rowsToMap(emptied.work, emptied.extra, emptied.rows) as Record<string, unknown>;
    expect(back['planExports']).toEqual([]);
    expect(Object.hasOwn(back, 'decisionExports')).toBe(false);
  });

  it('compact — только снимок для окна: в базу не попадает', () => {
    const map = { ...fullMap(), compact: { version: 1 } } as unknown as WorkMap;
    const { work, extra, rows } = mapToRows(map);
    const stored = rowsToMap(work, extra, rows) as Record<string, unknown>;

    expect(Object.hasOwn(stored, 'compact')).toBe(false);
    expect(extra).not.toContain('compact');
  });

  it('повторяющиеся id писем дают ключи m-07 и m-07#2 и оба возвращаются в исходном порядке', () => {
    const map = emptyMap();
    const letter = (text: string) => ({
      id: 'm-07',
      roomId: null,
      from: 's-01',
      to: ['s-02'],
      text,
      kind: 'note' as const,
      at: AT,
      readBy: {},
    });
    map.messages = [
      letter('первое'),
      { ...letter('другое'), id: 'm-08' },
      letter('второе'),
      letter('третье'),
    ];
    const normalized = asRead(map);

    const { rows } = mapToRows(normalized);
    const messages = rows.filter((row) => row.kind === 'message');
    expect(messages.map((row) => row.key)).toEqual(['m-07', 'm-08', 'm-07#2', 'm-07#3']);
    expect(new Set(messages.map((row) => row.key)).size).toBe(4);
    expect(roundTrip(normalized).messages.map((message) => message.text)).toEqual([
      'первое',
      'другое',
      'второе',
      'третье',
    ]);
  });

  it('ключи остальных видов: файл, тройка экспорта решения, key доставки', () => {
    const map = fullMap();
    const { rows } = mapToRows(map);
    const keys = (kind: EntryKind): string[] =>
      rows.filter((row) => row.kind === kind).map((row) => row.key);

    expect(keys('planExport')).toEqual(map.planExports!.map((row) => row.file));
    expect(keys('decisionExport')).toEqual(
      map.decisionExports!.map((row) => `${row.roomId}/${row.proposalId}/${row.rev}`),
    );
    expect(keys('planEffect')).toEqual(map.planEffects!.map((row) => row.key));
    expect(keys('planBacklogIntent')).toEqual(map.planBacklogIntents!.map((row) => row.key));
    expect(keys('room')).toEqual(['r-01', 'r-02']);
    expect(keys('plan')).toEqual(map.plans!.map((row) => row.id));
  });

  it('json строки — это JSON.stringify записи, а ord по умолчанию идёт с нуля подряд', () => {
    const map = fullMap();
    const { rows } = mapToRows(map);

    for (const row of rows.filter((candidate) => candidate.kind === 'session')) {
      const entry = map.sessions[row.ord]!;
      expect(row.json).toBe(JSON.stringify(entry));
      expect(row.key).toBe(entry.id);
    }
    expect(rows.filter((row) => row.kind === 'message').map((row) => row.ord)).toEqual(
      map.messages.map((_, index) => index),
    );
  });
});

describe('diffRows', () => {
  it('карта без изменений не даёт ни upsert, ни delete, ни workChanged', () => {
    const map = fullMap();
    const diff = diffBetween(map, structuredClone(map));

    expect(diff).toEqual({ upserts: [], deletes: [], workChanged: false });
  });

  it('добавление письма в конец даёт ровно один upsert', () => {
    const before = fullMap();
    const after = structuredClone(before);
    addMessage(after, { from: 's-01', to: ['s-02'], text: 'новое' }, AT);

    const diff = diffBetween(before, after);
    expect(diff.upserts).toHaveLength(1);
    expect(diff.upserts[0]).toMatchObject({ kind: 'message', ord: before.messages.length });
    expect(diff.deletes).toEqual([]);
  });

  it('изменение readBy одного письма даёт ровно один upsert', () => {
    const before = fullMap();
    const after = structuredClone(before);
    const target = after.messages[0]!;
    target.readBy['s-02'] = AT;

    const diff = diffBetween(before, after);
    expect(diff.upserts).toHaveLength(1);
    expect(diff.upserts[0]).toMatchObject({ kind: 'message', key: target.id, ord: 0 });
    expect(diff.deletes).toEqual([]);
  });

  it('удаление сессии из середины даёт один delete и ни одного upsert остальным', () => {
    const before = fullMap();
    const after = structuredClone(before);
    after.sessions = after.sessions.filter((session) => session.id !== 's-02');

    const diff = diffBetween(before, after);
    expect(diff.deletes).toEqual([{ kind: 'session', key: 's-02' }]);
    expect(diff.upserts).toEqual([]);
  });

  it('новая сессия после удаления из середины встаёт в конец с ord = max + 1, прежние ord сохраняются', () => {
    const before = fullMap();
    const stored = mapToRows(before);
    const index = rowIndex(stored.rows);
    const after = structuredClone(before);
    after.sessions = after.sessions.filter((session) => session.id !== 's-02');
    addSession(after, { provider: 'codex', label: 'Новая', task: 'Fixture' }, AT);

    const next = mapToRows(after, index);
    const sessions = next.rows.filter((row) => row.kind === 'session');
    expect(sessions.map((row) => [row.key, row.ord])).toEqual([
      ['s-01', 0],
      ['s-03', 2],
      ['s-04', 3],
    ]);
  });

  it('перестановка двух комнат даёт перенумерацию только коллекции комнат', () => {
    const before = fullMap();
    const after = structuredClone(before);
    after.rooms.reverse();

    const diff = diffBetween(before, after);
    expect(kindsOf(diff)).toEqual(['room', 'room']);
    expect(diff.upserts.map((row) => [row.key, row.ord])).toEqual([
      ['r-02', 0],
      ['r-01', 1],
    ]);
    expect(diff.deletes).toEqual([]);
  });

  it('новый ключ перед старым нумерует коллекцию заново с нуля', () => {
    const before = fullMap();
    const after = structuredClone(before);
    const extra = addMessage(after, { from: 's-01', to: ['s-02'], text: 'вставка' }, AT);
    after.messages = [extra, ...after.messages.filter((message) => message.id !== extra.id)];

    const diff = diffBetween(before, after);
    const messages = diff.upserts.filter((row) => row.kind === 'message');
    expect(messages).toHaveLength(before.messages.length + 1);
    expect(messages[0]).toMatchObject({ key: extra.id, ord: 0 });
    expect(diff.upserts.filter((row) => row.kind !== 'message')).toEqual([]);
  });

  it('массивы, заменённые клонами (как в plans.ts), дают пустой diff: изменения ищутся по содержимому, не по ссылке', () => {
    const before = fullMap();
    const after = structuredClone(before);
    after.plans = structuredClone(after.plans)!;
    after.planEffects = structuredClone(after.planEffects)!;

    expect(diffBetween(before, after)).toEqual({ upserts: [], deletes: [], workChanged: false });
  });

  it('изменение work.title выставляет workChanged, и только его', () => {
    const before = fullMap();
    const after = structuredClone(before);
    after.work.title = 'Новое имя';

    expect(diffBetween(before, after)).toEqual({ upserts: [], deletes: [], workChanged: true });
  });

  it('изменение resources или незнакомого поля тоже выставляет workChanged', () => {
    const before = fullMap();
    const resourced = structuredClone(before);
    resourced.resources!.seq += 1;
    expect(diffBetween(before, resourced)).toEqual({ upserts: [], deletes: [], workChanged: true });

    const foreign = { ...structuredClone(before), futureField: 1 } as WorkMap;
    expect(diffBetween(before, foreign)).toEqual({ upserts: [], deletes: [], workChanged: true });
  });
});

describe('rowIndex', () => {
  it('ключ индекса — вид и ключ записи через нулевой символ', () => {
    const map = fullMap();
    const { rows } = mapToRows(map);
    const index = rowIndex(rows);

    expect(index.size).toBe(rows.length);
    expect(index.get('session\u0000s-01')).toBe(
      rows.find((row) => row.kind === 'session' && row.key === 's-01'),
    );
    expect(index.get('room\u0000r-02')?.key).toBe('r-02');
  });
});
