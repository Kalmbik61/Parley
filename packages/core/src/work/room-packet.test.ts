import { describe, expect, it } from 'vitest';
import { PACKET_MAX_BYTES, contextBytes } from './context-budget.js';
import type { DecisionJournalIntent, DecisionJournalMap } from './decision-journal.js';
import { mapLetterTx } from './letter-store.js';
import { addMessage, addSession } from './map.js';
import { buildRoomPacket, type PacketTarget, type RoomPacketResult } from './room-packet.js';
import { addRoom } from './rooms.js';
import type { PlanItem, RoomPlan, WindowWorkMap } from './types.js';

const AT = '2026-11-17T10:00:00.000Z';
const LATER = '2026-11-17T18:30:00.000Z';
const TOOLS = ['get_map', 'report', 'send_message'];

const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({
  id, title: `Item ${id}`, owner: 's-02', scope: 'scope', after: [], criteria: [], verifier: null, status: 'ready',
  evidence: null, note: null, log: [], ...over,
});

const plan = (roomId: string, over: Partial<RoomPlan> = {}): RoomPlan => ({
  id: 'pl-01', roomId, mode: 'verified', status: 'active', rev: 2, goal: 'Ship the packet', items: [item(1)], backlog: [],
  acceptedAt: AT, completedAt: null, cancelledAt: null, completionSummary: null, ...over,
});

const decision = (n: number, over: Partial<DecisionJournalIntent> = {}): DecisionJournalIntent => ({
  file: `2026-11-${String(10 + (n % 10)).padStart(2, '0')}-w-0054-r-01-p-${String(n).padStart(2, '0')}-rev-00.md`,
  workId: 'w-0054', roomId: 'r-01', proposalId: `p-${String(n).padStart(2, '0')}`, rev: 0, messageId: `m-${900 + n}`,
  acceptedAt: `2026-11-${String(10 + (n % 10)).padStart(2, '0')}T09:00:00.000Z`, kind: 'decision', snapshot: null, snapshotSha256: null,
  status: 'written', sha256: 'a'.repeat(64), bytes: 100, title: `Decision ${n}`, ...over,
});

/** Работа с четырьмя сессиями: комната r-01 (s-01 ведущий, s-02, s-03), владелец s-04 вне состава. */
function fixture(): DecisionJournalMap & WindowWorkMap {
  const map: DecisionJournalMap & WindowWorkMap = {
    schemaVersion: 2,
    work: { id: 'w-0054', title: 'Room packet', goal: '', status: 'active', createdAt: AT, updatedAt: AT },
    sessions: [], messages: [], rooms: [],
  };
  for (const label of ['lead', 'worker', 'checker', 'owner']) addSession(map, { provider: 'claude', label, task: 'fixture' }, AT);
  addRoom(map, { title: 'Agents', creator: 'human', members: ['s-01', 's-02', 's-03'], lead: 's-01', ownerId: 's-04' }, AT);
  return map;
}

const reads = (map: WindowWorkMap) => mapLetterTx(map).letters;
const build = (map: DecisionJournalMap & WindowWorkMap, target: PacketTarget, at = AT, tools: readonly string[] = TOOLS): RoomPacketResult =>
  buildRoomPacket(map, target, reads(map), tools, at);
const member = (sessionId: string, roomId = 'r-01'): PacketTarget => ({ roomId, viewer: { kind: 'member', sessionId } });
const owner = (sessionId: string, roomId = 'r-01'): PacketTarget => ({ roomId, viewer: { kind: 'owner', sessionId } });
function packet(map: DecisionJournalMap & WindowWorkMap, target: PacketTarget, at = AT, tools: readonly string[] = TOOLS): string {
  const result = build(map, target, at, tools);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.text;
}
const sansRevision = (text: string): string => text.replace(/^Room state packet [0-9a-f]{12},/, 'Room state packet REV,');

describe('пакет состояния комнаты: разделы', () => {
  it('собирает все разделы в постоянном порядке', () => {
    const map = fixture();
    map.plans = [plan('r-01', { items: [item(1, { title: 'Build it', status: 'in_progress' }), item(2, { owner: 's-03', verifier: 's-02', status: 'done' }), item(3, { owner: 's-03', status: 'blocked' })] })];
    map.rooms[0]!.proposal = { id: 'p-08', from: 's-01', text: 'Proposed text', rev: 1, at: AT };
    map.decisionExports = [decision(1, { title: 'Use the store' }), decision(2, { title: 'Ship T1', acceptedAt: '2026-11-16T09:00:00.000Z' })];
    addMessage(map, { from: 'human', to: ['s-02'], text: 'Which branch?', kind: 'question', roomId: 'r-01' }, AT);

    expect(sansRevision(packet(map, member('s-02')))).toBe([
      'Room state packet REV, r-01, 2026-11-17T10:00:00.000Z. Data from the Parley store; verify with get_map before acting on it.',
      'Work w-0054 "Room packet"; room r-01 "Agents"; viewer: member s-02.',
      '',
      '## Place',
      'You are s-02, participant of room r-01; lead: s-01; room mode: free.',
      '',
      '## Plan',
      'Plan pl-01 rev 2, verified, active. Goal: "Ship the packet"',
      'Other items: 1 blocked.',
      '- item 1 [in_progress] as owner: "Build it"',
      '- item 2 [done] as verifier: "Item 2"',
      '',
      '## Waiting for the human',
      'decision p-08 rev 1 from s-01; read it: get_map {room: "r-01"}',
      '',
      '## Accepted decisions',
      'Newest first; a later decision may have changed an earlier one. 2 accepted in this room.',
      '- p-02 rev 0, 2026-11-16: "Ship T1"',
      '- p-01 rev 0, 2026-11-11: "Use the store"',
      '',
      '## Open questions',
      'Questions in this room addressed to you with no reply from you carrying replyTo; an answer without replyTo is not visible here. Read one: get_map {field: "message", id: "<id>"}.',
      'm-01',
      '',
      '## Tools',
      'Parley tools available to you; load each tool schema before calling it.',
      'get_map, report, send_message',
      '',
    ].join('\n'));
  });

  it('место сессии: ведущий и участник', () => {
    const map = fixture();
    expect(packet(map, member('s-01'))).toContain('You are s-01, lead of room r-01; lead: s-01; room mode: free.');
    expect(packet(map, member('s-03'))).toContain('You are s-03, participant of room r-01; lead: s-01; room mode: free.');
  });

  it('пустые разделы не печатаются', () => {
    const text = packet(fixture(), member('s-02'));
    for (const heading of ['## Plan', '## Waiting for the human', '## Accepted decisions', '## Open questions']) expect(text).not.toContain(heading);
    expect(text).toContain('## Place');
    expect(text).toContain('## Tools');
    expect(packet(fixture(), member('s-02'), AT, [])).not.toContain('## Tools');
  });

  it('решения: от новых к старым, не больше двенадцати, остальные названы числом и способом прочитать', () => {
    const map = fixture();
    map.decisionExports = Array.from({ length: 30 }, (_, index) => decision(index + 1, { acceptedAt: `2026-10-${String(index + 1).padStart(2, '0')}T09:00:00.000Z` }));
    const text = packet(map, member('s-02'));
    expect(text).toContain('30 accepted in this room.');
    const listed = text.split('\n').filter((line) => line.startsWith('- p-'));
    expect(listed).toHaveLength(12);
    expect(listed[0]).toContain('p-30');
    expect(listed[11]).toContain('p-19');
    expect(text).toContain('… and 18 more: get_map {room: "r-01", field: "messages", kind: "decision"}');
  });

  it('ссылки на решения — чтение через get_map, без путей файловой системы: сессия в worktree, комната r-01 в двух рабочих областях', () => {
    const decisionsRead = 'get_map {room: "r-01", field: "messages", kind: "decision"}';
    const build = (workId: string, worktreePath: string | null): string => {
      const map = fixture();
      map.work.id = workId;
      if (worktreePath !== null) map.sessions[1]!.worktree = { path: worktreePath, branch: 'parley/x', base: 'master', createdAt: AT };
      // Решение 9 — самое новое по дате и с длинным заголовком, поэтому в числе показанных.
      map.decisionExports = Array.from({ length: 16 }, (_, index) => decision(index + 1, { workId, ...(index + 1 === 9 ? { title: 'я'.repeat(300) } : {}) }));
      return packet(map, member('s-02'));
    };
    const inWorktree = build('w-0054', '/work/trees/w-0054-s-02');
    const otherWork = build('w-0099', null);
    for (const text of [inWorktree, otherWork]) {
      expect(text).toContain(`[decision title is`);
      expect(text).toContain(`read the full text via ${decisionsRead}`);
      expect(text).toMatch(new RegExp(`… and 4 more: ${decisionsRead.replace(/[{}[\]()*+?.\\^$|]/g, '\\$&')}`));
      expect(text).not.toContain('.parley');
      expect(text).not.toContain('decisions/');
      expect(text).not.toContain('/work/trees');
    }
  });

  it('решения других комнат в пакет не входят', () => {
    const map = fixture();
    map.decisionExports = [decision(1, { roomId: 'r-02', title: 'Elsewhere' })];
    expect(packet(map, member('s-02'))).not.toContain('Elsewhere');
  });

  it('решение, не записанное в файл, берёт заголовок из текста экспорта', () => {
    const map = fixture();
    const pending: DecisionJournalIntent = { ...decision(1), status: 'pending', content: '# Pending title\n\nbody' };
    delete pending.title;
    delete pending.sha256;
    delete pending.bytes;
    map.decisionExports = [pending];
    expect(packet(map, member('s-02'))).toContain('"Pending title"');
  });
});

describe('пакет состояния комнаты: что в него не попадает', () => {
  it('отменённый и ещё не принятый план в пакет не попадает', () => {
    for (const status of ['cancelled', 'proposed', 'completed'] as const) {
      const map = fixture();
      map.plans = [plan('r-01', { status })];
      expect(packet(map, member('s-02'))).not.toContain('## Plan');
    }
    const map = fixture();
    map.plans = [plan('r-01', { status: 'completing' })];
    expect(packet(map, member('s-02'))).toContain('verified, completing');
  });

  it('план другой комнаты в пакет не попадает', () => {
    const map = fixture();
    addRoom(map, { title: 'Other', creator: 'human', members: ['s-03'], lead: 's-03' }, AT);
    map.plans = [plan('r-02')];
    expect(packet(map, member('s-02'))).not.toContain('## Plan');
  });

  it('решение, принятое после переделок, стоит в истории один раз', () => {
    const map = fixture();
    map.decisionExports = [decision(5, { rev: 0 }), decision(5, { rev: 2, file: '2026-11-15-w-0054-r-01-p-05-rev-02.md' })];
    const lines = packet(map, member('s-02')).split('\n').filter((line) => line.startsWith('- p-05'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('rev 2');
  });

  it('вопрос с ответом по replyTo не попадает, ответ без replyTo его не снимает', () => {
    const map = fixture();
    const answered = addMessage(map, { from: 'human', to: ['s-02'], text: 'Q1', kind: 'question', roomId: 'r-01' }, AT);
    const plainReply = addMessage(map, { from: 'human', to: ['s-02'], text: 'Q2', kind: 'question', roomId: 'r-01' }, AT);
    const broadcast = addMessage(map, { from: 's-01', to: [], text: 'Q3', kind: 'question', roomId: 'r-01' }, AT);
    addMessage(map, { from: 's-02', to: [], text: 'answer', kind: 'note', roomId: 'r-01', replyTo: answered.id }, AT);
    addMessage(map, { from: 's-02', to: [], text: 'answer without link', kind: 'note', roomId: 'r-01' }, AT);
    addMessage(map, { from: 'human', to: ['s-03'], text: 'for someone else', kind: 'question', roomId: 'r-01' }, AT);
    addMessage(map, { from: 'human', to: ['s-02'], text: 'not a question', kind: 'note', roomId: 'r-01' }, AT);
    const text = packet(map, member('s-02'));
    expect(text).toContain(`${broadcast.id}, ${plainReply.id}`);
    expect(text).not.toContain(answered.id);
    expect(text).not.toMatch(/\bm-6\b|\bm-7\b/);
  });
});

describe('пакет состояния комнаты: бюджет', () => {
  const huge = 'я'.repeat(600);

  it('поле, не влезшее в предел, заменяется ссылкой по inlineOrRef', () => {
    const map = fixture();
    map.work.title = huge;
    map.rooms[0]!.title = huge;
    map.plans = [plan('r-01', { goal: huge, items: [item(1, { title: huge })] })];
    map.decisionExports = [decision(1, { title: huge })];
    const text = packet(map, member('s-02'));
    for (const what of ['work title', 'room title', 'plan goal', 'item title', 'decision title']) expect(text).toMatch(new RegExp(`\\[${what} is \\d+ bytes \\(limit \\d+\\), sha256 [0-9a-f]{12}; not inlined`));
    expect(text).not.toContain(huge);
    expect(contextBytes(text)).toBeLessThanOrEqual(PACKET_MAX_BYTES);
  });

  it('много пунктов сессии: список кончается строкой «… and K more», итог в пределе', () => {
    const map = fixture();
    map.plans = [plan('r-01', { items: Array.from({ length: 200 }, (_, index) => item(index + 1, { title: 'x'.repeat(190) })) })];
    const result = build(map, member('s-02'));
    expect(result.ok && result.bytes).toBeLessThanOrEqual(PACKET_MAX_BYTES);
    expect(packet(map, member('s-02'))).toMatch(/… and \d+ more: get_map \{field: "plan", id: "pl-01", rev: 2\}/);
  });

  it('много вопросов и инструментов: оба раздела кончаются строкой «… and K more»', () => {
    const map = fixture();
    for (let index = 0; index < 1500; index += 1) addMessage(map, { from: 'human', to: ['s-02'], text: `Q${index}`, kind: 'question', roomId: 'r-01' }, AT);
    const names = Array.from({ length: 600 }, (_, index) => `tool_number_${index}`);
    const result = build(map, member('s-02'), AT, names);
    expect(result.ok && result.bytes).toBeLessThanOrEqual(PACKET_MAX_BYTES);
    const text = packet(map, member('s-02'), AT, names);
    expect(text).toMatch(/… and \d+ more: get_map \{room: "r-01", field: "messages", kind: "question"\}/);
    expect(text).toMatch(/… and \d+ more: list the tools of your MCP client/);
    expect(text).toContain('## Tools');
  });

  it('всё сразу: итог не больше предела, доля решений — остаток, а не ноль без пояснения', () => {
    const map = fixture();
    map.plans = [plan('r-01', { items: Array.from({ length: 60 }, (_, index) => item(index + 1, { title: 'y'.repeat(150) })) })];
    map.decisionExports = Array.from({ length: 40 }, (_, index) => decision(index + 1, { title: 'z'.repeat(150) }));
    for (let index = 0; index < 100; index += 1) addMessage(map, { from: 'human', to: ['s-02'], text: `Q${index}`, kind: 'question', roomId: 'r-01' }, AT);
    const names = Array.from({ length: 80 }, (_, index) => `parley_tool_${index}`);
    const result = build(map, member('s-02'), AT, names);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBe(contextBytes(result.text));
    expect(result.bytes).toBeLessThanOrEqual(PACKET_MAX_BYTES);
    expect(result.text).toContain('## Accepted decisions');
    expect(result.text).toMatch(/… and \d+ more: get_map \{room: "r-01", field: "messages", kind: "decision"\}/);
  });

  it('когда решения не помещаются ни одним, раздел называет все как непоказанные', () => {
    const map = fixture();
    map.plans = [plan('r-01', { items: Array.from({ length: 300 }, (_, index) => item(index + 1, { title: 'w'.repeat(190) })) })];
    map.decisionExports = Array.from({ length: 5 }, (_, index) => decision(index + 1));
    const text = packet(map, member('s-02'));
    expect(contextBytes(text)).toBeLessThanOrEqual(PACKET_MAX_BYTES);
    expect(text).toContain('5 accepted in this room.');
  });
});

describe('пакет состояния комнаты: окно просмотра вопросов', () => {
  const NOTE = 'Only the last 1000 letters of this room were scanned; earlier letters were not: get_map {room: "r-01", field: "messages", kind: "question"}.';
  const notes = (map: DecisionJournalMap & WindowWorkMap, count: number): void => {
    for (let index = 0; index < count; index += 1) addMessage(map, { from: 's-03', to: [], text: `note ${index}`, kind: 'note', roomId: 'r-01' }, AT);
  };

  it('вопрос старше последней тысячи писем не ищется, и раздел говорит об этом', () => {
    const map = fixture();
    const old = addMessage(map, { from: 'human', to: ['s-02'], text: 'old question', kind: 'question', roomId: 'r-01' }, AT);
    notes(map, 1000);
    const text = packet(map, member('s-02'));
    expect(text).not.toContain(`${old.id},`);
    expect(text).toContain('## Open questions');
    expect(text).toContain(NOTE);
    expect(contextBytes(text)).toBeLessThanOrEqual(PACKET_MAX_BYTES);
  });

  it('вопрос внутри окна показан вместе со строкой о непросмотренных письмах', () => {
    const map = fixture();
    notes(map, 1000);
    const fresh = addMessage(map, { from: 'human', to: ['s-02'], text: 'fresh', kind: 'question', roomId: 'r-01' }, AT);
    const text = packet(map, member('s-02'));
    expect(text).toContain(fresh.id);
    expect(text).toContain(NOTE);
  });

  it('ровно тысяча писем в комнате — просмотрены все, строки нет', () => {
    const map = fixture();
    const first = addMessage(map, { from: 'human', to: ['s-02'], text: 'q', kind: 'question', roomId: 'r-01' }, AT);
    notes(map, 999);
    const text = packet(map, member('s-02'));
    expect(text).toContain(first.id);
    expect(text).not.toContain('letters of this room were scanned');
  });
});

describe('пакет состояния комнаты: проекция владельца и отказы', () => {
  it('владелец вне состава получает только разделы комнаты', () => {
    const map = fixture();
    map.plans = [plan('r-01', { items: [item(1), item(2, { status: 'done' })] })];
    map.rooms[0]!.proposal = { id: 'p-08', from: 's-01', text: 'x', rev: 0, at: AT };
    map.decisionExports = [decision(1)];
    addMessage(map, { from: 'human', to: ['s-04'], text: 'Q', kind: 'question', roomId: 'r-01' }, AT);
    const text = packet(map, owner('s-04'));
    expect(text).toContain('viewer: owner s-04.');
    expect(text).toContain('Items: 1 ready, 1 done.');
    expect(text).toContain('## Waiting for the human');
    expect(text).toContain('## Accepted decisions');
    for (const absent of ['## Place', '## Open questions', '## Tools', 'as owner', 'You are']) expect(text).not.toContain(absent);
  });

  it('владелец с участием в другой комнате получает разделы названной комнаты', () => {
    const map = fixture();
    addRoom(map, { title: 'Side', creator: 'human', members: ['s-04', 's-02'], lead: 's-04' }, AT);
    map.decisionExports = [decision(1, { title: 'Agents decision' }), decision(2, { roomId: 'r-02', title: 'Side decision', file: '2026-11-11-w-0054-r-02-p-02-rev-00.md' })];
    const text = packet(map, owner('s-04', 'r-01'));
    expect(text).toContain('room r-01 "Agents"');
    expect(text).toContain('Agents decision');
    expect(text).not.toContain('Side decision');
    expect(text).not.toContain('## Place');
  });

  it('владелец двух комнат получает разделы именно названной', () => {
    const map = fixture();
    addRoom(map, { title: 'Second', creator: 'human', members: ['s-02'], lead: 's-02', ownerId: 's-04' }, AT);
    map.decisionExports = [decision(1, { title: 'First decision' }), decision(2, { roomId: 'r-02', title: 'Second decision', file: '2026-11-11-w-0054-r-02-p-02-rev-00.md' })];
    const second = packet(map, owner('s-04', 'r-02'));
    expect(second).toContain('room r-02 "Second"');
    expect(second).toContain('Second decision');
    expect(second).not.toContain('First decision');
    const first = packet(map, owner('s-04', 'r-01'));
    expect(first).toContain('First decision');
    expect(first).not.toContain('Second decision');
  });

  it('отказывает: нет комнаты, комната закрыта, смотрящий не участник и не владелец', () => {
    const map = fixture();
    expect(build(map, member('s-02', 'r-99'))).toMatchObject({ ok: false, reason: 'no-room' });
    expect(build(map, member('s-04'))).toMatchObject({ ok: false, reason: 'not-participant' });
    expect(build(map, owner('s-02'))).toMatchObject({ ok: false, reason: 'not-participant' });
    expect(build(map, owner('s-04')).ok).toBe(true);
    for (const session of map.sessions) session.lifecycle = 'closed';
    expect(build(map, member('s-02'))).toMatchObject({ ok: false, reason: 'room-closed' });
    expect(build(map, owner('s-04'))).toMatchObject({ ok: false, reason: 'room-closed' });
  });
});

describe('пакет состояния комнаты: ревизия', () => {
  const revision = (map: DecisionJournalMap & WindowWorkMap, target: PacketTarget, at = AT): string => {
    const result = build(map, target, at);
    if (!result.ok) throw new Error('refused');
    return result.revision;
  };

  it('не зависит от времени сборки и стоит в первой строке', () => {
    const map = fixture();
    const first = build(map, member('s-02'), AT);
    const second = build(map, member('s-02'), LATER);
    expect(first.ok && second.ok && first.revision === second.revision).toBe(true);
    if (first.ok) expect(first.text.split('\n')[0]).toContain(`Room state packet ${first.revision}, r-01, ${AT}.`);
    expect(first.ok && second.ok && first.text !== second.text).toBe(true);
  });

  it('меняется при изменении любого раздела', () => {
    const base = revision(fixture(), member('s-02'));
    const changed: Array<(map: DecisionJournalMap & WindowWorkMap) => void> = [
      (map) => { map.plans = [plan('r-01')]; },
      (map) => { map.rooms[0]!.proposal = { id: 'p-01', from: 's-01', text: 'x', rev: 0, at: AT }; },
      (map) => { map.decisionExports = [decision(1)]; },
      (map) => { addMessage(map, { from: 'human', to: ['s-02'], text: 'Q', kind: 'question', roomId: 'r-01' }, AT); },
      (map) => { map.rooms[0]!.mode = 'verified'; },
      (map) => { map.rooms[0]!.lead = 's-02'; },
    ];
    const seen = new Set([base]);
    for (const change of changed) {
      const map = fixture();
      change(map);
      const next = revision(map, member('s-02'));
      expect(seen.has(next)).toBe(false);
      seen.add(next);
    }
    const toolsChanged = build(fixture(), member('s-02'), AT, ['get_map']);
    expect(toolsChanged.ok && toolsChanged.revision).not.toBe(base);
  });

  it('меняется при смене одной только комнаты, работы или смотрящего', () => {
    const one = fixture();
    const other = fixture();
    other.rooms[0]!.id = 'r-07';
    expect(revision(other, member('s-02', 'r-07'))).not.toBe(revision(one, member('s-02')));

    const work = fixture();
    work.work.id = 'w-0099';
    expect(revision(work, member('s-02'))).not.toBe(revision(fixture(), member('s-02')));

    // Владелец s-04 и владелец s-05: комната и содержимое те же, различается только смотрящий в заголовке.
    const first = fixture();
    const second = fixture();
    addSession(second, { provider: 'claude', label: 'second owner', task: 'fixture' }, AT);
    second.rooms[0]!.ownerId = 's-05';
    expect(revision(second, owner('s-05'))).not.toBe(revision(first, owner('s-04')));
  });
});
