import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { WorkEntry } from '@harnas/core';
import { workKey } from '../lib/tree-order.js';
import type { SidebarSection } from '../sidebar/sort.js';
import { useSidebarSectionsStore } from '../sidebar/use-sidebar-sections.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { workAttention, type WorkAttention } from './derive.js';
import { attentionTotals, badgeCount, useAttentionTotals } from './store.js';

function att(patch: Partial<WorkAttention>): WorkAttention {
  return { level: 'idle', needsYou: 0, unseen: 0, humanUnread: 0, roomsUnread: {}, lastEventAt: '2026-09-27T08:00:00.000Z', ...patch };
}

function section(key: string, works: WorkEntry[], collapsed = false): SidebarSection {
  return { kind: 'project', key, title: key, projectPath: key, works, collapsed };
}

const keyOf = (entry: WorkEntry): string => workKey(entry.projectPath, entry.map.work.id);

beforeEach(() => {
  useSidebarSectionsStore.setState({ sections: [], attention: {}, entries: null });
});

describe('badgeCount (тест 4)', () => {
  it('needsYou + humanUnread', () => {
    expect(badgeCount({ needsYou: 2, unseen: 5, humanUnread: 1 })).toBe(3);
  });
});

describe('attentionTotals (тест 14)', () => {
  it('домен — работы секций: свёрнутый проект входит, скрытая done и архивная в секциях — нет', () => {
    const open = makeWork('w-01', { projectPath: '/tmp/a' });
    const folded = makeWork('w-02', { projectPath: '/tmp/b' });
    const hiddenDone = makeWork('w-03', { projectPath: '/tmp/a', status: 'done' });
    const archived = makeWork('w-04', { projectPath: '/tmp/a', status: 'archived' });
    const byWork: Record<string, WorkAttention> = {
      [keyOf(open)]: att({ needsYou: 1, unseen: 2, humanUnread: 1 }),
      [keyOf(folded)]: att({ needsYou: 1, unseen: 0, humanUnread: 2 }),
      // Посчитано по всем работам снимка, но в секциях скрытой done нет.
      [keyOf(hiddenDone)]: att({ needsYou: 5, unseen: 5, humanUnread: 5 }),
      // Архивная лежит в секциях (как при временном показе 6.3), но не считается.
      [keyOf(archived)]: att({ needsYou: 7, unseen: 7, humanUnread: 7 }),
    };
    const sections = [section('/tmp/a', [open, archived]), section('/tmp/b', [folded], true)];
    expect(attentionTotals(sections, byWork)).toEqual({ needsYou: 2, unseen: 2, humanUnread: 3 });
  });

  // Спека окна 2026-09-29, 2.7: комната с ждущим решением — «нужен ты», как blocked: она в счётчике строки статуса и в
  // бейдже Dock (расчёт — `workAttention`), иначе клик по счётчику вёл бы не туда, куда «следующая» ведёт из палитры.
  it('ждущее решение входит в needsYou итогов и бейджа Dock наравне с blocked-сессией', () => {
    const proposal = { id: 'p-01', from: 's-01', text: 'Решение', rev: 0, at: '2026-09-29T10:00:00.000Z' };
    const entry = makeWork('w-01', {
      projectPath: '/tmp/a',
      sessions: [makeSession('s-01', 'a'), makeSession('s-02', 'b')],
      rooms: [{ ...makeRoom('r-01', 'R'), members: ['s-01', 's-02'], lead: 's-01', proposal }],
    });
    const byWork = { [keyOf(entry)]: workAttention(entry, {}) };
    const totals = attentionTotals([section('/tmp/a', [entry])], byWork);
    expect(totals).toEqual({ needsYou: 1, unseen: 0, humanUnread: 0 });
    expect(badgeCount(totals)).toBe(1);
  });

  it('работа без расчёта — нули', () => {
    expect(attentionTotals([section('/tmp/a', [makeWork('w-01', { projectPath: '/tmp/a' })])], {})).toEqual({
      needsYou: 0,
      unseen: 0,
      humanUnread: 0,
    });
  });
});

describe('useAttentionTotals', () => {
  it('читает стор секций и отдаёт тот же объект, пока числа не изменились', () => {
    const w = makeWork('w-01', { projectPath: '/tmp/a' });
    useSidebarSectionsStore.setState({ sections: [section('/tmp/a', [w])], attention: { [keyOf(w)]: att({ needsYou: 1 }) } });
    const { result } = renderHook(() => useAttentionTotals());
    const first = result.current;
    expect(first).toEqual({ needsYou: 1, unseen: 0, humanUnread: 0 });

    act(() => useSidebarSectionsStore.setState({ attention: { [keyOf(w)]: att({ needsYou: 1, level: 'needs-you' }) } }));
    expect(result.current).toBe(first);

    act(() => useSidebarSectionsStore.setState({ attention: { [keyOf(w)]: att({ unseen: 1 }) } }));
    expect(result.current).toEqual({ needsYou: 0, unseen: 1, humanUnread: 0 });
  });
});
