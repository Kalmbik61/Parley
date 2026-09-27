/**
 * Тест 4 куска 4.3 (модульная часть): переход по цели уведомления — работа и вкладка сразу,
 * вспышка и фокус терминала только когда вкладка показана.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { WorkEntry, WorkSession } from '@harnas/core';
import type { FocusTarget } from '../../shared/bridge.js';
import { refKey } from '@harnas/protocol';
import { useLayoutStore } from '../layout/store.js';
import { useWorksStore } from '../store/works.js';
import { terminalSurfaces, type TerminalSurfaceHandle } from '../terminal/surface-registry.js';
import { applyFocusTarget, buildFocusTargetDeps, type FocusTargetDeps } from './focus-target.js';

function session(id: string): WorkSession {
  return {
    id,
    provider: 'claude',
    label: 'executor',
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
    worktree: null,
  };
}

const work: WorkEntry = {
  projectPath: '/tmp/p',
  map: {
    schemaVersion: 2,
    rooms: [{ id: 'r-1', name: 'design', members: [], createdAt: '2026-01-01', createdBy: 'human' }] as unknown as WorkEntry['map']['rooms'],
    work: { id: 'w-01', title: 'Redesign', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
    sessions: [session('s-02')],
    messages: [],
  },
};
const key = '/tmp/p w-01';

function deps(shown: boolean): { deps: FocusTargetDeps; calls: string[]; surface: TerminalSurfaceHandle; settle: () => Promise<void> } {
  const calls: string[] = [];
  let resolveShown: (value: boolean) => void = () => {};
  const surface: TerminalSurfaceHandle = {
    focus: vi.fn(() => calls.push('focus')),
    scrollToBottom: vi.fn(() => calls.push('scrollToBottom')),
    search: null,
    openSearch: vi.fn(),
  };
  const result: FocusTargetDeps = {
    works: [work],
    setActiveWork: (workKey) => calls.push(`setActiveWork ${workKey}`),
    openTab: (workKey, tab) => calls.push(`openTab ${workKey} ${tab.id}`),
    whenShown: () => new Promise<boolean>((resolve) => (resolveShown = resolve)),
    surface: () => surface,
    flash: (workKey, tabId) => calls.push(`flash ${workKey} ${tabId}`),
  };
  return {
    deps: result,
    calls,
    surface,
    settle: async () => {
      resolveShown(shown);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('applyFocusTarget (тест 4 куска 4.3)', () => {
  const target: FocusTarget = { kind: 'session', ref: { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-02' } };

  it('сессия: setActiveWork и openTab(terminal) сразу; flash, scrollToBottom и focus — после whenShown → true', async () => {
    const h = deps(true);
    expect(applyFocusTarget(target, h.deps)).toBe(true);
    expect(h.calls).toEqual([`setActiveWork ${key}`, `openTab ${key} terminal:s-02`]);
    await h.settle();
    expect(h.calls.slice(2)).toEqual([`flash ${key} terminal:s-02`, 'scrollToBottom', 'focus']);
  });

  it('whenShown → false — ни вспышки, ни фокуса', async () => {
    const h = deps(false);
    applyFocusTarget(target, h.deps);
    await h.settle();
    expect(h.calls).toEqual([`setActiveWork ${key}`, `openTab ${key} terminal:s-02`]);
  });

  it('удалённая сессия и удалённая работа → false, ничего не открыто', () => {
    const h = deps(true);
    expect(applyFocusTarget({ kind: 'session', ref: { ...target.ref, sessionId: 's-99' } }, h.deps)).toBe(false);
    expect(applyFocusTarget({ kind: 'mail', projectPath: '/tmp/p', workId: 'w-99' }, h.deps)).toBe(false);
    expect(applyFocusTarget({ kind: 'room', projectPath: '/tmp/p', workId: 'w-01', roomId: 'r-99' }, h.deps)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('почта и комната: вкладки mail и room:<id>, вспышка без фокуса терминала', async () => {
    const h = deps(true);
    expect(applyFocusTarget({ kind: 'mail', projectPath: '/tmp/p', workId: 'w-01' }, h.deps)).toBe(true);
    await h.settle();
    expect(h.calls).toEqual([`setActiveWork ${key}`, `openTab ${key} mail`, `flash ${key} mail`]);

    const r = deps(true);
    expect(applyFocusTarget({ kind: 'room', projectPath: '/tmp/p', workId: 'w-01', roomId: 'r-1' }, r.deps)).toBe(true);
    await r.settle();
    expect(r.calls).toEqual([`setActiveWork ${key}`, `openTab ${key} room:r-1`, `flash ${key} room:r-1`]);
  });
});

describe('buildFocusTargetDeps (раунд fix-main-r1, п.4)', () => {
  it('works — из стора в момент сборки, surface — из реестра поверхностей, openTab — в раскладку работы', () => {
    useWorksStore.setState({ entries: [work] });
    const apply = vi.spyOn(useLayoutStore.getState(), 'apply');
    const handle: TerminalSurfaceHandle = { focus: vi.fn(), scrollToBottom: vi.fn(), search: null, openSearch: vi.fn(), clear: vi.fn() };
    const ref = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-02' };
    terminalSurfaces.set(refKey(ref), handle);
    try {
      const built = buildFocusTargetDeps();
      expect(built.works).toBe(useWorksStore.getState().entries);
      expect(built.surface(ref)).toBe(handle);
      built.openTab(key, { kind: 'mail', id: 'mail' });
      expect(apply).toHaveBeenCalledWith(key, expect.any(Function));
    } finally {
      terminalSurfaces.delete(refKey(ref));
      apply.mockRestore();
    }
  });

  it('focus-target не импортирует TerminalSurface: цикла TerminalSurface ↔ focus-target нет', () => {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'focus-target.ts'), 'utf8');
    expect(source).not.toMatch(/from '\.\.\/terminal\/TerminalSurface\.js'/);
  });
});
