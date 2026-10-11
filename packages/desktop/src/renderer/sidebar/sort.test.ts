import { describe, expect, it } from 'vitest';
import type { Message, Proposal, Room, WorkEntry, WorkMap, WorkSession, WorkStatus } from '@parley/core';
import { workAttention, type Attention, type WorkAttention } from '../attention/derive.js';
import { workKey } from '../lib/tree-order.js';
import { activityMap, makeActivity, makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { archivedRows, buildSections, cardRows, compareWorks, homeRoomOf, neighborInOrder, visibleWorkOrder, type CardRow } from './sort.js';

function att(level: Attention, lastEventAt = '2026-09-27T09:00:00.000Z'): WorkAttention {
  return {
    level,
    needsYou: 0,
    unseen: 0,
    humanUnread: 0,
    roomsUnread: {},
    roomMentions: {},
    lastEventAt,
  };
}

function work(projectPath: string, id: string, status: WorkStatus = 'active', createdAt = '2026-09-27T08:00:00.000Z'): WorkEntry {
  return {
    projectPath,
    map: {
      schemaVersion: 2,
      work: { id, title: id, goal: '', status, createdAt, updatedAt: createdAt },
      sessions: [],
      messages: [],
      rooms: [],
    },
  };
}

const key = (e: WorkEntry): string => workKey(e.projectPath, e.map.work.id);
const keysOf = (works: WorkEntry[]): string[] => works.map((e) => e.map.work.id);

function build(
  entries: WorkEntry[],
  levels: Record<string, WorkAttention> = {},
  opts: {
    pinned?: string[];
    collapsed?: string[];
    showDone?: boolean;
    showArchived?: boolean;
    hidden?: string[];
    archivedShown?: string[];
  } = {},
) {
  const attention: Record<string, WorkAttention> = {};
  for (const e of entries) attention[key(e)] = levels[e.map.work.id] ?? att('idle');
  return buildSections({
    entries,
    attention,
    pinned: opts.pinned ?? [],
    collapsed: opts.collapsed ?? [],
    showDone: opts.showDone ?? true,
    showArchived: opts.showArchived ?? false,
    hidden: opts.hidden ?? [],
    archivedShown: opts.archivedShown ?? [],
  });
}

describe('compareWorks (5)', () => {
  const at = (level: Attention, time: string, createdAt: string) => ({ attention: att(level, time), createdAt });

  it('ранг важнее времени', () => {
    expect(compareWorks(at('needs-you', '2026-01-01T00:00:00.000Z', 'x'), at('working', '2026-09-01T00:00:00.000Z', 'x'))).toBeLessThan(0);
  });

  it('при равном ранге свежее выше', () => {
    expect(compareWorks(at('idle', '2026-09-02T00:00:00.000Z', 'x'), at('idle', '2026-09-01T00:00:00.000Z', 'x'))).toBeLessThan(0);
  });

  it('при равном времени старшая по созданию выше', () => {
    const t = '2026-09-02T00:00:00.000Z';
    expect(compareWorks(at('idle', t, '2026-01-01T00:00:00.000Z'), at('idle', t, '2026-02-01T00:00:00.000Z'))).toBeLessThan(0);
    expect(compareWorks(at('idle', t, '2026-02-01T00:00:00.000Z'), at('idle', t, '2026-01-01T00:00:00.000Z'))).toBeGreaterThan(0);
  });

  it('не-ISO время не обгоняет настоящее: самое старое', () => {
    const real = at('idle', '2026-09-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    for (const bad of ['w-9999', 's-01', '', 'garbage', '2026-09-01']) {
      expect(compareWorks(real, at('idle', bad, '2026-01-01T00:00:00.000Z'))).toBeLessThan(0);
      expect(compareWorks(at('idle', bad, '2026-01-01T00:00:00.000Z'), real)).toBeGreaterThan(0);
    }
  });

  it('ISO с миллисекундами и без, с Z и +00:00 сравниваются как время', () => {
    const c = '2026-01-01T00:00:00.000Z';
    expect(compareWorks(at('idle', '2026-09-27T10:00:00Z', c), at('idle', '2026-09-27T09:59:59.999+00:00', c))).toBeLessThan(0);
    expect(compareWorks(at('idle', '2026-09-27T10:00:00+00:00', c), at('idle', '2026-09-27T10:00:00.000Z', c))).toBe(0);
    // +03:00 — на три часа раньше того же настенного времени в Z.
    expect(compareWorks(at('idle', '2026-09-27T12:00:00+03:00', c), at('idle', '2026-09-27T10:00:00Z', c))).toBeGreaterThan(0);
  });
});

describe('buildSections (6)', () => {
  it('закреплённая не дублируется, title — Pinned, секция первая', () => {
    const a = work('/p/alpha', 'w1');
    const b = work('/p/alpha', 'w2');
    const sections = build([a, b], {}, { pinned: [key(a)] });
    expect(sections[0]).toMatchObject({ kind: 'pinned', key: 'pinned', title: 'Pinned', projectPath: null, collapsed: false });
    expect(keysOf(sections[0]!.works)).toEqual(['w1']);
    expect(sections[1]).toMatchObject({ kind: 'project', key: '/p/alpha', title: 'alpha', projectPath: '/p/alpha' });
    expect(keysOf(sections[1]!.works)).toEqual(['w2']);
  });

  it('без закреплённых секции Pinned нет', () => {
    expect(build([work('/p/alpha', 'w1')]).map((s) => s.kind)).toEqual(['project']);
  });

  it('archived нет; done в конце; при showDone: false done нет', () => {
    const list = [
      work('/p/a', 'done1', 'done'),
      work('/p/a', 'arch', 'archived'),
      work('/p/a', 'act', 'active'),
    ];
    const levels = { done1: att('needs-you', '2026-09-27T12:00:00.000Z') };
    expect(keysOf(build(list, levels)[0]!.works)).toEqual(['act', 'done1']);
    expect(keysOf(build(list, levels, { showDone: false })[0]!.works)).toEqual(['act']);
  });

  it('группы — по максимальному рангу, при равенстве — по имени папки', () => {
    const list = [
      work('/x/zeta', 'z1'),
      work('/x/beta', 'b1'),
      work('/x/alpha', 'a1'),
    ];
    const levels = {
      z1: att('needs-you'),
      b1: att('working', '2026-09-27T09:00:00.000Z'),
      a1: att('working', '2026-09-27T08:00:00.000Z'),
    };
    // Работа beta свежее, но порядок групп при равном ранге — по имени папки.
    expect(build(list, levels).map((s) => s.title)).toEqual(['zeta', 'alpha', 'beta']);
  });

  it('группы без показанных работ нет — кроме группы из одних архивных (спека архива, 6.1)', () => {
    const pinnedOnly = work('/p/one', 'w1');
    const archivedOnly = work('/p/two', 'w2', 'archived');
    const doneOnly = work('/p/three', 'w3', 'done');
    const sections = build([pinnedOnly, archivedOnly, doneOnly], {}, { pinned: [key(pinnedOnly)], showDone: false });
    expect(sections.map((s) => s.key)).toEqual(['pinned', '/p/two']);
  });

  it('закреплённая done при showDone: false пропадает и из Pinned', () => {
    const d = work('/p/a', 'd', 'done');
    const other = work('/p/a', 'o');
    const sections = build([d, other], {}, { pinned: [key(d)], showDone: false });
    expect(sections.map((s) => s.key)).toEqual(['/p/a']);
    const shown = build([d, other], {}, { pinned: [key(d)], showDone: true });
    expect(keysOf(shown[0]!.works)).toEqual(['d']);
  });

  it('закреплённая needs-you не поднимает группу своего проекта', () => {
    const hot = work('/p/zeta', 'hot');
    const cold = work('/p/zeta', 'cold');
    const warm = work('/p/alpha', 'warm');
    const levels = { hot: att('needs-you'), cold: att('idle'), warm: att('working') };
    const sections = build([hot, cold, warm], levels, { pinned: [key(hot)] });
    expect(sections.map((s) => s.title)).toEqual(['Pinned', 'alpha', 'zeta']);
  });

  it('равные ранг, время и создание: порядок не зависит от порядка entries', () => {
    const x = work('/p/a', 'wx');
    const y = work('/p/a', 'wy');
    const pinX = work('/p/b', 'px');
    const pinY = work('/p/b', 'py');
    const pinned = { pinned: [key(pinX), key(pinY)] };
    const forward = build([x, y, pinX, pinY], {}, pinned);
    const backward = build([pinY, pinX, y, x], {}, pinned);
    expect(forward.map((s) => keysOf(s.works))).toEqual([['px', 'py'], ['wx', 'wy']]);
    expect(backward.map((s) => keysOf(s.works))).toEqual(forward.map((s) => keysOf(s.works)));
  });

  it('collapsed — по collapsedProjects, works — показанные', () => {
    const sections = build([work('/p/a', 'w1'), work('/p/a', 'w2', 'archived')], {}, { collapsed: ['/p/a'] });
    expect(sections[0]!.collapsed).toBe(true);
    expect(sections[0]!.works).toHaveLength(1);
  });
});

// Тест 6 куска 6.3: показ архивных (спека 6.1, 6.7) — в конце своей секции, после done.
describe('buildSections — showArchived (тест 6 куска 6.3)', () => {
  const list = () => [
    work('/p/a', 'arch', 'archived'),
    work('/p/a', 'done1', 'done'),
    work('/p/a', 'act'),
  ];

  it('showArchived: false — как в 3.2: архивных нет', () => {
    expect(keysOf(build(list())[0]!.works)).toEqual(['act', 'done1']);
  });

  it('showArchived: true — архивная в конце своей секции, после done, даже со срочным вниманием', () => {
    const levels = { arch: att('needs-you', '2026-09-27T12:00:00.000Z') };
    expect(keysOf(build(list(), levels, { showArchived: true })[0]!.works)).toEqual(['act', 'done1', 'arch']);
  });

  it('showArchived: true и showDone: false — done скрыта, архивная видна', () => {
    expect(keysOf(build(list(), {}, { showArchived: true, showDone: false })[0]!.works)).toEqual(['act', 'arch']);
  });

  it('закреплённая архивная — в конце Pinned', () => {
    const arch = work('/p/a', 'arch', 'archived');
    const pin = work('/p/b', 'pin');
    const sections = build([arch, pin], {}, { pinned: [key(arch), key(pin)], showArchived: true });
    expect(sections[0]!.kind).toBe('pinned');
    expect(keysOf(sections[0]!.works)).toEqual(['pin', 'arch']);
  });

  it('внимание архивной не поднимает группу проекта, а группы из одних архивных сортируются устойчиво', () => {
    const hot = work('/p/a', 'hot', 'archived');
    const calm = work('/p/b', 'calm');
    const levels = { hot: att('needs-you'), calm: att('idle') };
    const sections = build([hot, calm], levels, { showArchived: true });
    expect(sections.map((section) => section.title)).toEqual(['b', 'a']);
    const onlyArchived = build([work('/p/b', 'b', 'archived'), work('/p/a', 'a', 'archived')], {}, { showArchived: true });
    expect(onlyArchived.map((section) => section.title)).toEqual(['a', 'b']);
  });
});

// Спека архива комнат и проектов, 6.1 и 6.3: группа проекта живёт, пока в нём есть работа любого статуса; архивные
// спрятаны под ссылкой «N archived»; убранный проект («Remove from list…») пропущен.
describe('buildSections — архивные работы под ссылкой и убранные проекты (спека архива, 6.1, 6.3)', () => {
  it('группа из одних архивных остаётся: шапка, пустой список, ссылка с числом', () => {
    const sections = build([work('/p/a', 'w1', 'archived'), work('/p/a', 'w2', 'archived')]);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ kind: 'project', key: '/p/a', title: 'a', projectPath: '/p/a', collapsed: false });
    expect(sections[0]!.works).toEqual([]);
    expect(sections[0]!.archived).toEqual({ count: 2, shown: false });
  });

  it('у проекта без архивных работ ссылки нет', () => {
    expect(build([work('/p/a', 'w1'), work('/p/a', 'w2', 'done')])[0]!.archived).toBeUndefined();
  });

  it('группа из одних архивных — ниже всех групп с работами', () => {
    const sections = build([work('/p/a', 'x', 'archived'), work('/p/z', 'y')]);
    expect(sections.map((section) => section.title)).toEqual(['z', 'a']);
  });

  it('ссылка считает архивные работы проекта, закреплённые тоже; закреплённая архивная из Pinned уходит', () => {
    const arch = work('/p/a', 'arch', 'archived');
    const archPinned = work('/p/a', 'archPin', 'archived');
    const live = work('/p/a', 'live');
    const sections = build([arch, archPinned, live], {}, { pinned: [key(archPinned)] });
    expect(sections.map((section) => section.key)).toEqual(['/p/a']);
    // Число в шапке — по показанным, число в ссылке — по всем архивным.
    expect(keysOf(sections[0]!.works)).toEqual(['live']);
    expect(sections[0]!.archived).toEqual({ count: 2, shown: false });
  });

  it('проект, чья единственная неархивная работа закреплена, остаётся группой ради ссылки', () => {
    const pin = work('/p/a', 'pin');
    const sections = build([pin, work('/p/a', 'arch', 'archived')], {}, { pinned: [key(pin)] });
    expect(sections.map((section) => section.key)).toEqual(['pinned', '/p/a']);
    expect(sections[1]!.works).toEqual([]);
    expect(sections[1]!.archived).toEqual({ count: 1, shown: false });
  });

  it('раскрытая ссылка: архивные проекта в конце группы, после done; другие проекты не затронуты', () => {
    const list = [
      work('/p/a', 'arch', 'archived'),
      work('/p/a', 'done1', 'done'),
      work('/p/a', 'act'),
      work('/p/b', 'archB', 'archived'),
      work('/p/b', 'actB'),
    ];
    const levels = { arch: att('needs-you', '2026-09-27T12:00:00.000Z') };
    const sections = build(list, levels, { archivedShown: ['/p/a'] });
    const a = sections.find((section) => section.key === '/p/a')!;
    const b = sections.find((section) => section.key === '/p/b')!;
    expect(keysOf(a.works)).toEqual(['act', 'done1', 'arch']);
    expect(a.archived).toEqual({ count: 1, shown: true });
    expect(keysOf(b.works)).toEqual(['actB']);
    expect(b.archived).toEqual({ count: 1, shown: false });
  });

  it('закреплённая архивная при раскрытой ссылке проекта стоит в его группе, а не в Pinned', () => {
    const archPinned = work('/p/a', 'archPin', 'archived');
    const sections = build([archPinned, work('/p/a', 'live')], {}, { pinned: [key(archPinned)], archivedShown: ['/p/a'] });
    expect(sections.map((section) => section.key)).toEqual(['/p/a']);
    expect(keysOf(sections[0]!.works)).toEqual(['live', 'archPin']);
  });

  it('общий showArchived раскрывает всё, и ссылки у групп нет', () => {
    const sections = build([work('/p/a', 'arch', 'archived'), work('/p/a', 'act')], {}, { showArchived: true });
    expect(keysOf(sections[0]!.works)).toEqual(['act', 'arch']);
    expect(sections[0]!.archived).toBeUndefined();
  });

  it('hidden прячет проект из одних архивных; при showArchived он на месте', () => {
    const list = [work('/p/a', 'w1', 'archived'), work('/p/b', 'w2')];
    expect(build(list, {}, { hidden: ['/p/a'] }).map((section) => section.key)).toEqual(['/p/b']);
    const all = build(list, {}, { hidden: ['/p/a'], showArchived: true });
    expect(all.map((section) => section.key)).toEqual(['/p/b', '/p/a']);
    expect(keysOf(all[1]!.works)).toEqual(['w1']);
  });

  it('hidden прячет и его закреплённые архивные, и раскрытую ссылку', () => {
    const arch = work('/p/a', 'arch', 'archived');
    expect(build([arch], {}, { hidden: ['/p/a'], pinned: [key(arch)], archivedShown: ['/p/a'] })).toEqual([]);
  });

  it('hidden не прячет проект с неархивной работой, пока окно не снимет путь из hiddenProjects', () => {
    const sections = build([work('/p/a', 'arch', 'archived'), work('/p/a', 'act')], {}, { hidden: ['/p/a'] });
    expect(sections.map((section) => section.key)).toEqual(['/p/a']);
    expect(keysOf(sections[0]!.works)).toEqual(['act']);
  });

  it('hidden с done-работой: done — неархивная, проект не прячется', () => {
    const sections = build([work('/p/a', 'd', 'done')], {}, { hidden: ['/p/a'] });
    expect(sections.map((section) => section.key)).toEqual(['/p/a']);
  });
});

describe('visibleWorkOrder (8)', () => {
  it('Pinned первыми; свёрнутых и скрытых done нет', () => {
    const p = work('/p/b', 'pin');
    const b1 = work('/p/b', 'b1');
    const bDone = work('/p/b', 'bdone', 'done');
    const a1 = work('/p/a', 'a1');
    const c1 = work('/p/c', 'c1');
    const sections = build([p, b1, bDone, a1, c1], {}, { pinned: [key(p)], collapsed: ['/p/c'], showDone: false });
    expect(visibleWorkOrder(sections)).toEqual([key(p), key(a1), key(b1)]);
  });
});

// Перенос из временного модуля клавиш раскладки 2.4 (удалён в 6.1b): сосед по порядку живёт рядом с порядком.
describe('neighborInOrder (тест 20 куска 3.4)', () => {
  it('соседняя по кругу; активной нет в порядке — ↓ первая, ↑ последняя; пусто — null', () => {
    expect(neighborInOrder(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(neighborInOrder(['a', 'b', 'c'], 'b', -1)).toBe('a');
    expect(neighborInOrder(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(neighborInOrder(['a', 'b', 'c'], 'x', 1)).toBe('a');
    expect(neighborInOrder(['a', 'b', 'c'], null, -1)).toBe('c');
    expect(neighborInOrder([], 'a', 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Кусок 5 плана «Organic»: ранги 2.7 в порядке сайдбара и состав строк карточки (спека окна 2026-09-29, 1.2).
// ---------------------------------------------------------------------------

describe('порядок сайдбара по рангам 2.7 (расчёт — attention/derive.ts, порядок — buildSections)', () => {
  const proposal: Proposal = { id: 'p-01', from: 's-01', text: 'Решение', rev: 0, at: '2026-09-29T10:00:00.000Z' };
  const mail: Message = {
    id: 'm-1',
    roomId: null,
    from: 's-01',
    to: ['human'],
    at: '2026-09-29T09:00:00.000Z',
    text: 'письмо',
    kind: 'note',
    readBy: {},
  };
  const ref = (entry: WorkEntry, sessionId: string) => ({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId });

  /** Пять работ одного проекта: решение, письмо, работающая, простаивающая и done с решением. */
  function fixtures() {
    const decision = makeWork('w-decision', { sessions: [makeSession('s-01', 'a')], rooms: [{ ...makeRoom('r-01', 'R'), members: ['s-01'], proposal }] });
    const letter = makeWork('w-mail', { sessions: [makeSession('s-01', 'a')], messages: [mail] });
    const busy = makeWork('w-busy', { sessions: [makeSession('s-01', 'a')] });
    const calm = makeWork('w-calm', { sessions: [makeSession('s-01', 'a')] });
    const done = makeWork('w-done', { status: 'done', sessions: [makeSession('s-01', 'a')], rooms: [{ ...makeRoom('r-01', 'R'), members: ['s-01'], proposal }] });
    const activity = activityMap([makeActivity(ref(busy, 's-01'), 'working')]);
    const entries = [calm, busy, letter, decision, done];
    const attention: Record<string, WorkAttention> = Object.fromEntries(entries.map((entry) => [key(entry), workAttention(entry, activity)]));
    return { entries, attention };
  }

  it('в группе: решение (ранг 4) выше письма человеку (3), выше работающей (2), выше простаивающей (1); done — внизу даже с решением', () => {
    const { entries, attention } = fixtures();
    const sections = buildSections({ entries, attention, pinned: [], collapsed: [], showDone: true, showArchived: false, hidden: [], archivedShown: [] });
    expect(keysOf(sections[0]!.works)).toEqual(['w-decision', 'w-mail', 'w-busy', 'w-calm', 'w-done']);
  });

  it('группы — по высшему рангу: проект с ждущим решением выше проекта с письмом, тот выше работающего и простаивающего', () => {
    const { entries: base } = fixtures();
    const move = (entry: WorkEntry, projectPath: string): WorkEntry => ({ ...entry, projectPath });
    const [calm, busy, letter, decision] = base;
    const entries = [move(calm!, '/p/a-calm'), move(busy!, '/p/b-busy'), move(letter!, '/p/c-mail'), move(decision!, '/p/d-decision')];
    const activity = activityMap([makeActivity({ projectPath: '/p/b-busy', workId: 'w-busy', sessionId: 's-01' }, 'working')]);
    const attention = Object.fromEntries(entries.map((entry) => [key(entry), workAttention(entry, activity)]));
    const sections = buildSections({ entries, attention, pinned: [], collapsed: [], showDone: true, showArchived: false, hidden: [], archivedShown: [] });
    // По имени папки было бы a, b, c, d — порядок задают только ранги.
    expect(sections.map((section) => section.title)).toEqual(['d-decision', 'c-mail', 'b-busy', 'a-calm']);
  });
});

describe('cardRows — состав строк карточки (1.2)', () => {
  const NOW = '2026-09-29T10:00:00.000Z';
  const sessions = (...ids: string[]): WorkSession[] => ids.map((id) => makeSession(id, id));
  const room = (id: string, members: string[], patch: Partial<Room> = {}): Room => ({ ...makeRoom(id, id), members, ...patch });
  const map = (list: WorkSession[], rooms: Room[] = [], messages: Message[] = []): WorkMap => makeWork('w-01', { sessions: list, rooms, messages }).map;
  /** `s-01` — сессия отдельной строкой, `r-01[s-02,s-03]` — комната с показанными участниками. */
  const shape = (rows: CardRow[]): string[] =>
    rows.map((row) => (row.kind === 'session' ? row.session.id : `${row.room.id}[${row.members.map((member) => member.id).join(',')}]`));

  it('комнат нет — строки сессий по treeOrder с глубиной; закрытые спрятаны, при showClosed стоят на своих местах', () => {
    const list = [makeSession('s-01', 'a'), makeSession('s-02', 'b', { lifecycle: 'closed' }), makeSession('s-03', 'c', { parent: 's-01' })];
    const rows = cardRows(map(list), false);
    expect(shape(rows)).toEqual(['s-01', 's-03']);
    expect(rows.map((row) => (row.kind === 'session' ? row.depth : -1))).toEqual([0, 1]);
    expect(shape(cardRows(map(list), true))).toEqual(['s-01', 's-03', 's-02']);
  });

  it('участник комнаты отдельной строкой не выводится: на месте первого участника стоит строка его комнаты', () => {
    const rows = cardRows(map(sessions('s-01', 's-02', 's-03', 's-04'), [room('r-01', ['s-02', 's-03'])]), false);
    expect(shape(rows)).toEqual(['s-01', 'r-01[s-02,s-03]', 's-04']);
  });

  it('место комнаты — первый её участник в порядке treeOrder, а не в порядке записи members', () => {
    const rows = cardRows(map(sessions('s-01', 's-02', 's-03', 's-04'), [room('r-01', ['s-04', 's-02'])]), false);
    expect(shape(rows)).toEqual(['s-01', 'r-01[s-04,s-02]', 's-03']);
  });

  it('участники в строке комнаты — в порядке записи: создатель-сессия, затем members', () => {
    const rows = cardRows(map(sessions('s-01', 's-02', 's-03'), [room('r-01', ['s-03', 's-01'], { creator: 's-02' })]), false);
    expect(shape(rows)).toEqual(['r-01[s-02,s-03,s-01]']);
    expect(rows[0]).toMatchObject({ kind: 'room', sessions: expect.arrayContaining([expect.objectContaining({ id: 's-02' })]) });
  });

  it('комнаты без живых участников — в конце, в порядке карты: все участники закрыты или участников нет вовсе', () => {
    const list = [makeSession('s-01', 'a'), makeSession('s-02', 'b', { lifecycle: 'closed' }), makeSession('s-03', 'c')];
    const rooms = [room('r-01', ['s-02']), room('r-02', []), room('r-03', ['s-03'])];
    expect(shape(cardRows(map(list, rooms), false))).toEqual(['s-01', 'r-03[s-03]', 'r-01[]', 'r-02[]']);
  });

  it('закрытые участники: не в строках развёрнутой комнаты (members), но в sessions — значки-счётчики считают всех; при showClosed — и в members', () => {
    const list = [makeSession('s-01', 'a'), makeSession('s-02', 'b', { lifecycle: 'closed' })];
    const [row] = cardRows(map(list, [room('r-01', ['s-01', 's-02'])]), false);
    expect(row).toMatchObject({ kind: 'room' });
    if (row?.kind !== 'room') throw new Error('строки комнаты нет');
    expect(row.members.map((member) => member.id)).toEqual(['s-01']);
    expect(row.sessions.map((member) => member.id)).toEqual(['s-01', 's-02']);
    const [shown] = cardRows(map(list, [room('r-01', ['s-01', 's-02'])]), true);
    expect(shown?.kind === 'room' ? shown.members.map((member) => member.id) : []).toEqual(['s-01', 's-02']);
  });

  it('место комнаты не прыгает от «N more closed»: первый по порядку участник закрыт — комната всё равно на месте первого живого', () => {
    const list = [makeSession('s-01', 'a', { lifecycle: 'closed' }), makeSession('s-02', 'b'), makeSession('s-03', 'c')];
    const rooms = [room('r-01', ['s-01', 's-03'])];
    expect(shape(cardRows(map(list, rooms), false))).toEqual(['s-02', 'r-01[s-03]']);
    expect(shape(cardRows(map(list, rooms), true))).toEqual(['s-02', 'r-01[s-01,s-03]']);
  });

  it('глубина строки комнаты — глубина её первого живого участника; комната в конце — 0', () => {
    const list = [makeSession('s-01', 'a'), makeSession('s-02', 'b', { parent: 's-01' }), makeSession('s-03', 'c', { lifecycle: 'closed' })];
    const rows = cardRows(map(list, [room('r-01', ['s-02']), room('r-02', ['s-03'])]), false);
    expect(shape(rows)).toEqual(['s-01', 'r-01[s-02]', 'r-02[]']);
    expect(rows.map((row) => (row.kind === 'room' ? row.depth : -1))).toEqual([-1, 1, 0]);
  });

  describe('старая карта: сессия в нескольких комнатах (решение 4)', () => {
    const list = sessions('s-01', 's-02', 's-03');

    it('стоит в комнате с самым ранним createdAt — не по порядку в массиве, — в остальных её строки нет', () => {
      const late = room('r-02', ['s-02', 's-03'], { createdAt: '2026-09-29T09:00:00.000Z' });
      const early = room('r-01', ['s-01', 's-02'], { createdAt: '2026-09-29T08:00:00.000Z' });
      // Поздняя комната лежит в массиве первой — порядок массива на выбор не влияет: s-02 стоит в ранней.
      const rows = cardRows(map(list, [late, early]), false);
      expect(shape(rows)).toEqual(['r-01[s-01,s-02]', 'r-02[s-03]']);
      // Без ранней комнаты в массиве s-02 стоял бы в поздней.
      expect(shape(cardRows(map(list, [late]), false))).toEqual(['s-01', 'r-02[s-02,s-03]']);
    });

    // Значки-счётчики свёрнутой комнаты, её тултип и правило развёртывания читают `sessions`: агент, что стоит в самой
    // ранней комнате, не считается в бейдже и тултипе позднейшей — иначе один и тот же агент шёл бы в двух комнатах.
    it('sessions — только те, что стоят в этой комнате: сессия из двух комнат числится лишь в самой ранней', () => {
      const late = room('r-02', ['s-02', 's-03'], { createdAt: '2026-09-29T09:00:00.000Z' });
      const early = room('r-01', ['s-01', 's-02'], { createdAt: '2026-09-29T08:00:00.000Z' });
      const rows = cardRows(map(list, [late, early]), false);
      const ids = (row: CardRow | undefined): string[] => (row?.kind === 'room' ? row.sessions.map((member) => member.id) : []);
      expect(ids(rows.find((row) => row.kind === 'room' && row.room.id === 'r-01'))).toEqual(['s-01', 's-02']);
      expect(ids(rows.find((row) => row.kind === 'room' && row.room.id === 'r-02'))).toEqual(['s-03']);
    });

    it('закрытая сессия из двух комнат: считается только в самой ранней — и там, и в её sessions она остаётся (закрытые входят)', () => {
      const closed = [makeSession('s-01', 'a'), makeSession('s-02', 'b', { lifecycle: 'closed' }), makeSession('s-03', 'c')];
      const early = room('r-01', ['s-01', 's-02'], { createdAt: '2026-09-29T08:00:00.000Z' });
      const late = room('r-02', ['s-02', 's-03'], { createdAt: '2026-09-29T09:00:00.000Z' });
      const rows = cardRows(map(closed, [early, late]), false);
      const byId = (id: string) => rows.find((row): row is Extract<CardRow, { kind: 'room' }> => row.kind === 'room' && row.room.id === id);
      expect(byId('r-01')?.sessions.map((member) => member.id)).toEqual(['s-01', 's-02']);
      expect(byId('r-01')?.members.map((member) => member.id)).toEqual(['s-01']);
      expect(byId('r-02')?.sessions.map((member) => member.id)).toEqual(['s-03']);
    });

    it('комната, где не осталось «своих» участников, стоит в конце; её значков и тултипа участников нет — сессия стоит в ранней', () => {
      const first = room('r-01', ['s-01', 's-02'], { createdAt: '2026-09-29T08:00:00.000Z' });
      const second = room('r-02', ['s-02'], { createdAt: '2026-09-29T09:00:00.000Z' });
      const rows = cardRows(map(list, [first, second]), false);
      expect(shape(rows)).toEqual(['r-01[s-01,s-02]', 's-03', 'r-02[]']);
      const last = rows[2];
      expect(last?.kind === 'room' ? last.sessions.map((member) => member.id) : ['нет строки комнаты']).toEqual([]);
    });

    it('равные createdAt — первая в массиве; битая дата проигрывает настоящей', () => {
      const a = room('r-01', ['s-01'], { createdAt: '2026-09-29T08:00:00.000Z' });
      const b = room('r-02', ['s-01'], { createdAt: '2026-09-29T08:00:00.000Z' });
      expect(shape(cardRows(map(list, [b, a]), false))).toEqual(['r-02[s-01]', 's-02', 's-03', 'r-01[]']);
      const bad = room('r-03', ['s-01'], { createdAt: 'garbage' });
      const good = room('r-04', ['s-01'], { createdAt: '2026-09-30T00:00:00.000Z' });
      expect(shape(cardRows(map(list, [bad, good]), false))).toEqual(['r-04[s-01]', 's-02', 's-03', 'r-03[]']);
    });

    it('создатель-сессия одной комнаты и участник другой — тоже в одной', () => {
      const created = room('r-01', ['s-02'], { creator: 's-01', createdAt: '2026-09-29T08:00:00.000Z' });
      const other = room('r-02', ['s-01', 's-03'], { createdAt: '2026-09-29T09:00:00.000Z' });
      expect(shape(cardRows(map(list, [created, other]), false))).toEqual(['r-01[s-01,s-02]', 'r-02[s-03]']);
    });
  });

  it('ведущий — roomLiveLead: назначенный, пока жив; закрытого подменяет первый живой; у старой карты без lead — первый из members', () => {
    const list = [makeSession('s-01', 'a', { lifecycle: 'closed' }), makeSession('s-02', 'b'), makeSession('s-03', 'c')];
    const lead = (rooms: Room[]) => {
      const [row] = cardRows(map(list, rooms), false);
      return row?.kind === 'room' ? row.lead : 'нет строки комнаты';
    };
    expect(lead([room('r-01', ['s-01', 's-02', 's-03'], { lead: 's-03' })])).toBe('s-03');
    expect(lead([room('r-01', ['s-01', 's-02', 's-03'], { lead: 's-01' })])).toBe('s-02');
    expect(lead([room('r-01', ['s-03', 's-02'], { lead: null })])).toBe('s-03');
  });

  it('время строки — время последнего события комнаты (сообщение или решение); решение и lead у старой карты не обязательны', () => {
    const message: Message = { id: 'm-1', roomId: 'r-01', from: 's-01', to: [], at: NOW, text: 't', kind: 'note', readBy: {} };
    const old = { id: 'r-01', title: 'Старая', creator: 'human', members: ['s-01'], createdAt: '2026-01-01T00:00:00.000Z' } as unknown as Room;
    const [row] = cardRows(map(sessions('s-01'), [old], [message]), false);
    expect(row).toMatchObject({ kind: 'room', lastAt: NOW });
    expect(row?.kind === 'room' ? row.lead : 'нет строки комнаты').toBe('s-01');
  });
});

// Архив комнат (спека 2026-10-08, 5.1): архивная комната уходит из основных строк под ссылку карточки.
describe('cardRows и archivedRows — архивные комнаты (5.1)', () => {
  const ARCHIVED_AT = '2026-10-08T12:00:00.000Z';
  const sessions3 = (): WorkSession[] => ['s-01', 's-02', 's-03'].map((id) => makeSession(id, id));
  const room = (id: string, members: string[], patch: Partial<Room> = {}): Room => ({ ...makeRoom(id, id), members, ...patch });
  const archivedRoom = (id: string, members: string[], patch: Partial<Room> = {}): Room => room(id, members, { archivedAt: ARCHIVED_AT, ...patch });
  const map = (list: WorkSession[], rooms: Room[]): WorkMap => makeWork('w-01', { sessions: list, rooms }).map;
  const shape = (rows: CardRow[]): string[] =>
    rows.map((row) => (row.kind === 'session' ? row.session.id : `${row.room.id}[${row.members.map((member) => member.id).join(',')}]`));

  it('архивная комната в основных строках не выводится, а её спящие и закрытые участники уходят вместе с ней', () => {
    const list = [makeSession('s-01', 'a'), makeSession('s-02', 'b', { lifecycle: 'sleeping' }), makeSession('s-03', 'c', { lifecycle: 'closed' })];
    const state = map(list, [archivedRoom('r-01', ['s-02', 's-03'])]);
    // Закрытая сессия не появляется строкой и при showClosed: её домашняя комната в архиве.
    expect(shape(cardRows(state, false))).toEqual(['s-01']);
    expect(shape(cardRows(state, true))).toEqual(['s-01']);
  });

  it('участник архивной комнаты с процессом (active, pending) остаётся обычной строкой сессии на своём месте', () => {
    const list = [makeSession('s-01', 'a'), makeSession('s-02', 'b'), makeSession('s-03', 'c', { lifecycle: 'pending' }), makeSession('s-04', 'd', { lifecycle: 'sleeping' })];
    const rows = cardRows(map(list, [archivedRoom('r-01', ['s-02', 's-03', 's-04'])]), false);
    expect(shape(rows)).toEqual(['s-01', 's-02', 's-03']);
    expect(rows.every((row) => row.kind === 'session')).toBe(true);
  });

  it('домашняя комната сессии: открытая раньше архивной, даже если архивная старше; без открытой — архивная', () => {
    const list = sessions3();
    const oldArchive = archivedRoom('r-01', ['s-01', 's-02'], { createdAt: '2026-09-29T08:00:00.000Z' });
    const newOpen = room('r-02', ['s-01'], { createdAt: '2026-09-29T09:00:00.000Z' });
    const state = map(list, [oldArchive, newOpen]);
    expect(homeRoomOf(state, 's-01')?.id).toBe('r-02');
    expect(homeRoomOf(state, 's-02')?.id).toBe('r-01');
    expect(homeRoomOf(state, 's-03')).toBeNull();
    // s-01 стоит в открытой комнате строкой комнаты; s-02 (active) — обычной строкой; в архивной остаётся пусто.
    expect(shape(cardRows(state, false))).toEqual(['r-02[s-01]', 's-02', 's-03']);
  });

  it('archivedRows: строки архивных комнат в порядке карты, у каждой archived и без archiveStops; открытые не входят', () => {
    const list = [makeSession('s-01', 'a'), makeSession('s-02', 'b', { lifecycle: 'sleeping' }), makeSession('s-03', 'c')];
    const state = map(list, [archivedRoom('r-01', ['s-02']), room('r-02', ['s-03']), archivedRoom('r-03', [])]);
    const rows = archivedRows(state, false);
    expect(rows.map((row) => row.room.id)).toEqual(['r-01', 'r-03']);
    expect(rows.every((row) => row.archived && row.archiveStops.length === 0)).toBe(true);
    expect(rows[0]?.members.map((member) => member.id)).toEqual(['s-02']);
    expect(cardRows(state, false).every((row) => row.kind === 'session' || !row.archived)).toBe(true);
  });

  it('в строке архивной комнаты нет работающих участников (они уже строки карточки); закрытые — только при showClosed', () => {
    const list = [makeSession('s-01', 'a'), makeSession('s-02', 'b', { lifecycle: 'sleeping' }), makeSession('s-03', 'c', { lifecycle: 'closed' })];
    const state = map(list, [archivedRoom('r-01', ['s-01', 's-02', 's-03'])]);
    const [hidden] = archivedRows(state, false);
    expect(hidden?.sessions.map((member) => member.id)).toEqual(['s-02', 's-03']);
    expect(hidden?.members.map((member) => member.id)).toEqual(['s-02']);
    const [shown] = archivedRows(state, true);
    expect(shown?.members.map((member) => member.id)).toEqual(['s-02', 's-03']);
  });

  it('archiveStops открытой комнаты — участники без другой открытой комнаты; архивная соседка в счёт не идёт', () => {
    const list = sessions3();
    const target = room('r-01', ['s-01', 's-02'], { createdAt: '2026-09-29T08:00:00.000Z' });
    const other = room('r-02', ['s-02', 's-03'], { createdAt: '2026-09-29T09:00:00.000Z' });
    const byId = (rooms: Room[]) => {
      const rows = cardRows(map(list, rooms), false);
      return rows.find((row): row is Extract<CardRow, { kind: 'room' }> => row.kind === 'room' && row.room.id === 'r-01');
    };
    // s-02 числится и в открытой r-02: остановка её не коснётся, так что при архивации r-01 остаётся только s-01.
    expect(byId([target, other])?.archived).toBe(false);
    expect(byId([target, other])?.archiveStops.map((member) => member.id)).toEqual(['s-01']);
    // Соседка в архиве — она комнатой не считается: оба участника остаются без открытой комнаты.
    expect(byId([target, { ...other, archivedAt: ARCHIVED_AT }])?.archiveStops.map((member) => member.id)).toEqual(['s-01', 's-02']);
  });
});
