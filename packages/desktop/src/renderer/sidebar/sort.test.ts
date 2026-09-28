import { describe, expect, it } from 'vitest';
import type { WorkEntry, WorkStatus } from '@harnas/core';
import type { Attention, WorkAttention } from '../attention/derive.js';
import { workKey } from '../lib/tree-order.js';
import { buildSections, compareWorks, neighborInOrder, visibleWorkOrder } from './sort.js';

function att(level: Attention, lastEventAt = '2026-09-27T09:00:00.000Z'): WorkAttention {
  return { level, needsYou: 0, unseen: 0, humanUnread: 0, roomsUnread: {}, lastEventAt };
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
  opts: { pinned?: string[]; collapsed?: string[]; showDone?: boolean; showArchived?: boolean } = {},
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

  it('группы без показанных работ нет', () => {
    const pinnedOnly = work('/p/one', 'w1');
    const archivedOnly = work('/p/two', 'w2', 'archived');
    const doneOnly = work('/p/three', 'w3', 'done');
    const sections = build([pinnedOnly, archivedOnly, doneOnly], {}, { pinned: [key(pinnedOnly)], showDone: false });
    expect(sections.map((s) => s.key)).toEqual(['pinned']);
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
