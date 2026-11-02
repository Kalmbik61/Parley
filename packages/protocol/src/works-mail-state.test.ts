import { describe, expect, it } from 'vitest';
import { METHODS } from './methods.js';
import { WorksMailStateAssembler, worksMailStateRequest } from './works-mail-state.js';
import type { WorksMailStatePage, WorksMailStateRecord } from './works-mail-state.js';

const key = { projectPath: '/p', workId: 'w-1' };
const room = { total: 2, top: 3, lastAt: 'now', unread: 1, decision: null };
const mention = { id: 'm-3', roomId: null, from: 's-1', to: ['human'], at: 'now', text: '@human', kind: 'note', readBy: {} };
const records = (): WorksMailStateRecord[] => [
  { kind: 'mail-summary', key, unreadLetters: 1 },
  { kind: 'section', key, field: 'mailRooms', start: 0, items: [{ roomId: '', metadata: room }], final: true },
  { kind: 'section', key, field: 'unreadRooms', start: 0, items: [{ roomId: '', count: 1 }], final: true },
  { kind: 'section', key, field: 'mentionCandidates', start: 0, items: [mention], final: true },
];
function page(rows: unknown[], more: Partial<WorksMailStatePage> = {}): WorksMailStatePage {
  return { kind: 'mail-page', epoch: 'host', key, sourceVersion: 55, requiredStructuralVersion: 40, index: 0, cursor: 'a', next: null, records: rows as WorksMailStateRecord[], commit: true, ...more };
}
const assembler = () => new WorksMailStateAssembler({ epoch: 'host', key });

describe('dedicated authoritative mail-state contract', () => {
  it('requires a work-bound start or continuation and registers a typed method', () => {
    for (const params of [{ ...key }, { ...key, cursor: 'c' }]) {
      expect(worksMailStateRequest.safeParse(params).success).toBe(true);
      expect(METHODS['works.mailState'].safeParse(params).success).toBe(true);
    }
    for (const params of [{ cursor: 'c' }, { ...key, cursor: '' }, { ...key, base: 1 }, { ...key, epoch: 'x' }]) expect(worksMailStateRequest.safeParse(params).success).toBe(false);
  });

  it('stages coherent pages and atomically replaces exact sparse/direct counts and candidates', () => {
    const a = assembler(), rows = records();
    expect(a.applyPage(page(rows.slice(0, 2), { next: 'b', commit: false })).state).toBe('staged');
    expect(a.value).toBeUndefined();
    expect(a.applyPage(page(rows.slice(2), { index: 1, cursor: 'b' })).state).toBe('committed');
    expect(a.value).toEqual({ epoch: 'host', key, sourceVersion: 55, requiredStructuralVersion: 40, mail: { rooms: { '': room }, unread: { letters: 1, rooms: { '': 1 } }, mentionCandidates: [mention] } });
    expect(Object.isFrozen(a.value!.mail.rooms[''])).toBe(true);
    expect(a.applyPage(page(rows)).state).toBe('rejected');
    expect(a.value!.mail.unread.letters).toBe(1);
    const empty = assembler();
    const cleared = records().map(row => row.kind === 'mail-summary' ? { ...row, unreadLetters: 0 } : { ...row, items: [] });
    expect(empty.applyPage(page(cleared)).state).toBe('committed');
    expect(empty.value!.mail).toEqual({ rooms: {}, unread: { letters: 0, rooms: {} }, mentionCandidates: [] });
  });

  it('assembles a huge Unicode element with a separate exact section completion', () => {
    const row = { roomId: 'r' + '💬'.repeat(10000), metadata: room };
    const json = JSON.stringify(row), split = 51;
    const a = assembler();
    const rows = records();
    const first = { kind: 'section-fragment', key, field: 'mailRooms', element: 0, index: 0, text: json.slice(0, split), final: false };
    expect(a.applyPage(page([rows[0], first], { next: 'b', commit: false })).state).toBe('staged');
    const last = { ...first, index: 1, text: json.slice(split), final: true };
    expect(a.applyPage(page([last, { kind: 'section', key, field: 'mailRooms', start: 1, items: [], final: true }, ...rows.slice(2)], { index: 1, cursor: 'b' })).state).toBe('committed');
    expect(Object.keys(a.value!.mail.rooms)).toEqual([row.roomId]);
  });

  it.each(['epoch', 'sourceVersion', 'requiredStructuralVersion', 'key', 'index', 'cursor'] as const)('rejects changed %s without exposing a partial replacement', field => {
    const a = assembler(), rows = records();
    expect(a.applyPage(page(rows.slice(0, 2), { next: 'b', commit: false })).state).toBe('staged');
    const bad = page(rows.slice(2), { index: 1, cursor: 'b' });
    Object.assign(bad, { [field]: field === 'key' ? { ...key, workId: 'other' } : typeof bad[field] === 'number' ? 999 : 'wrong' });
    expect(a.applyPage(bad).state).toBe('rejected'); expect(a.value).toBeUndefined();
  });

  it.each(['work', 'row', 'row-remove', 'field-remove', 'order', 'order-slice', 'branch', 'branch-remove', 'fragment'])('rejects structural record kind %s', kind => {
    expect(assembler().applyPage(page([...records(), { kind, key, field: 'sessions', row: {} }])).state).toBe('rejected');
  });

  it.each([
    (r: WorksMailStateRecord[]) => r.slice(1),
    (r: WorksMailStateRecord[]) => [...r, r[0]!],
    (r: WorksMailStateRecord[]) => [r[0]!, ...r.slice(2)],
    (r: WorksMailStateRecord[]) => r.map((v, i) => i === 1 ? { ...v, field: 'sessions' } : v),
    (r: WorksMailStateRecord[]) => r.map((v, i) => i === 1 ? { ...v, key: { ...key, workId: 'wrong' } } : v),
    (r: WorksMailStateRecord[]) => r.map((v, i) => i === 1 ? { ...v, start: 1 } : v),
    (r: WorksMailStateRecord[]) => r.map((v, i) => i === 1 ? { ...v, items: [{ roomId: '', metadata: room }, { roomId: '', metadata: room }] } : v),
    (r: WorksMailStateRecord[]) => r.map((v, i) => i === 2 ? { ...v, items: [{ roomId: '', count: 1 }, { roomId: '', count: 0 }] } : v),
    (r: WorksMailStateRecord[]) => r.map((v, i) => i === 3 ? { ...v, items: [mention, mention] } : v),
    (r: WorksMailStateRecord[]) => r.map((v, i) => i === 2 ? { ...v, items: [{ roomId: '', count: -1 }] } : v),
  ])('rejects malformed replacement %#', change => {
    const a = assembler(); expect(a.applyPage(page(change(records()))).state).toBe('rejected'); expect(a.value).toBeUndefined();
  });

  it('rejects missing prefix, stale expected epoch and unreachable dependency', () => {
    expect(assembler().applyPage(page(records(), { index: 1 })).state).toBe('rejected');
    expect(assembler().applyPage(page(records(), { epoch: 'old' })).state).toBe('rejected');
    expect(assembler().applyPage(page(records(), { requiredStructuralVersion: 56 })).state).toBe('rejected');
  });

  it('rejects duplicate/overlap fragments, unfinished fragments and conflicting completion', () => {
    const f = { kind: 'section-fragment', key, field: 'mailRooms', element: 0, index: 0, text: '{', final: false };
    for (const additions of [[f], [f, f], [f, records()[1]!], [records()[1]!, f]]) {
      expect(assembler().applyPage(page([records()[0]!, ...additions, ...records().slice(2)])).state).toBe('rejected');
    }
  });

  it('preserves arbitrary room keys as own data, including direct and prototype-like keys', () => {
    const rows = records();
    const keys = ['', '__proto__', 'constructor'];
    rows[1] = { kind: 'section', key, field: 'mailRooms', start: 0, items: keys.map(roomId => ({ roomId, metadata: room })), final: true };
    rows[2] = { kind: 'section', key, field: 'unreadRooms', start: 0, items: keys.map(roomId => ({ roomId, count: 0 })), final: true };
    const a = assembler(); expect(a.applyPage(page(rows)).state).toBe('committed');
    expect(Object.keys(a.value!.mail.rooms)).toEqual(keys);
    expect(Object.hasOwn(a.value!.mail.unread.rooms, '__proto__')).toBe(true);
    expect(a.value!.mail.unread.rooms.__proto__).toBe(0);
  });

  it('rejects unknown scalar/element fields, unordered and excessive canonical candidates', () => {
    const rows = records();
    for (const bad of [
      [{ ...rows[0], extra: 1 }, ...rows.slice(1)],
      [rows[0], { ...rows[1], items: [{ roomId: '', metadata: { ...room, extra: 1 } }] }, ...rows.slice(2)],
      [...rows.slice(0, 3), { ...rows[3], items: [{ ...mention, id: 'm-4' }, mention] }],
      [...rows.slice(0, 3), { ...rows[3], items: Array.from({ length: 201 }, (_, i) => ({ ...mention, id: `m-${i + 1}` })) }],
    ]) expect(assembler().applyPage(page(bad)).state).toBe('rejected');
  });
});
