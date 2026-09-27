import { describe, expect, it } from 'vitest';
import type { WorkEntry, WorkStatus } from '@harnas/core';
import type { Attention, WorkAttention } from '../attention/derive.js';
import { workKey } from '../lib/tree-order.js';
import { buildSections, compareWorks, visibleWorkOrder } from './sort.js';

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
  opts: { pinned?: string[]; collapsed?: string[]; showDone?: boolean } = {},
) {
  const attention: Record<string, WorkAttention> = {};
  for (const e of entries) attention[key(e)] = levels[e.map.work.id] ?? att('idle');
  return buildSections({
    entries,
    attention,
    pinned: opts.pinned ?? [],
    collapsed: opts.collapsed ?? [],
    showDone: opts.showDone ?? true,
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

  it('collapsed — по collapsedProjects, works — показанные', () => {
    const sections = build([work('/p/a', 'w1'), work('/p/a', 'w2', 'archived')], {}, { collapsed: ['/p/a'] });
    expect(sections[0]!.collapsed).toBe(true);
    expect(sections[0]!.works).toHaveLength(1);
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
