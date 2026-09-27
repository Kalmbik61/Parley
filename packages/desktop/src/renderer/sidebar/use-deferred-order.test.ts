import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { WorkEntry } from '@harnas/core';
import type { SidebarSection } from './sort.js';
import { useDeferredOrder } from './use-deferred-order.js';

function work(id: string, title = id): WorkEntry {
  return {
    projectPath: '/p/a',
    map: {
      schemaVersion: 2,
      work: { id, title, goal: '', status: 'active', createdAt: 'x', updatedAt: 'x' },
      sessions: [],
      messages: [],
      rooms: [],
    },
  };
}

function section(key: string, works: WorkEntry[]): SidebarSection {
  return { kind: 'project', key, title: key, projectPath: key, works, collapsed: false };
}

const shape = (sections: SidebarSection[]): string[][] =>
  sections.map((s) => [s.key, ...s.works.map((w) => w.map.work.id)]);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useDeferredOrder (7)', () => {
  it('под указателем держит порядок, данные свежие; уход отдаёт новый', () => {
    const first = [section('/p/a', [work('w1'), work('w2')]), section('/p/b', [work('w3')])];
    const { result, rerender } = renderHook(
      ({ sections, hovering }: { sections: SidebarSection[]; hovering: boolean }) => useDeferredOrder(sections, hovering),
      { initialProps: { sections: first, hovering: true } },
    );
    const second = [section('/p/b', [work('w3')]), section('/p/a', [work('w2', 'renamed'), work('w1')])];
    rerender({ sections: second, hovering: true });
    expect(shape(result.current)).toEqual([['/p/a', 'w1', 'w2'], ['/p/b', 'w3']]);
    expect(result.current[0]!.works[1]!.map.work.title).toBe('renamed');

    rerender({ sections: second, hovering: false });
    expect(shape(result.current)).toEqual([['/p/b', 'w3'], ['/p/a', 'w2', 'w1']]);
  });

  it('через 3000 мс новый порядок отдаётся и под указателем', () => {
    const first = [section('/p/a', [work('w1'), work('w2')])];
    const { result, rerender } = renderHook(
      ({ sections }: { sections: SidebarSection[] }) => useDeferredOrder(sections, true),
      { initialProps: { sections: first } },
    );
    rerender({ sections: [section('/p/a', [work('w2'), work('w1')])] });
    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(shape(result.current)).toEqual([['/p/a', 'w1', 'w2']]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shape(result.current)).toEqual([['/p/a', 'w2', 'w1']]);
  });

  it('новые изменения под указателем не продлевают срок: порядок не позже maxDeferMs от первого расхождения', () => {
    const ids = ['w1', 'w2', 'w3'];
    const { result, rerender } = renderHook(
      ({ sections }: { sections: SidebarSection[] }) => useDeferredOrder(sections, true),
      { initialProps: { sections: [section('/p/a', ids.map((id) => work(id)))] } },
    );
    // Порядок меняется каждые 500 мс, ни разу не возвращаясь к исходному.
    const orders = [['w2', 'w1', 'w3'], ['w3', 'w1', 'w2'], ['w2', 'w3', 'w1'], ['w3', 'w2', 'w1'], ['w1', 'w3', 'w2'], ['w2', 'w1', 'w3']];
    for (const order of orders.slice(0, 5)) {
      rerender({ sections: [section('/p/a', order.map((id) => work(id)))] });
      expect(shape(result.current)).toEqual([['/p/a', 'w1', 'w2', 'w3']]);
      act(() => {
        vi.advanceTimersByTime(500);
      });
    }
    // 2500 мс от первого расхождения: ещё держим.
    rerender({ sections: [section('/p/a', orders[5]!.map((id) => work(id)))] });
    expect(shape(result.current)).toEqual([['/p/a', 'w1', 'w2', 'w3']]);
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(shape(result.current)).toEqual([['/p/a', 'w1', 'w2', 'w3']]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shape(result.current)).toEqual([['/p/a', 'w2', 'w1', 'w3']]);
  });

  it('новая работа под указателем — в конце секции, удалённая пропадает сразу', () => {
    const first = [section('/p/a', [work('w1'), work('w2'), work('w3')])];
    const { result, rerender } = renderHook(
      ({ sections }: { sections: SidebarSection[] }) => useDeferredOrder(sections, true),
      { initialProps: { sections: first } },
    );
    rerender({ sections: [section('/p/a', [work('new'), work('w3'), work('w1')]), section('/p/new', [work('w9')])] });
    expect(shape(result.current)).toEqual([['/p/a', 'w1', 'w3', 'new'], ['/p/new', 'w9']]);
  });
});
