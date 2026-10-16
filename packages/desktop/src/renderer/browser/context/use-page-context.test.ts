import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, type RenderHookResult } from '@testing-library/react';
import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import type { SavedContext } from '../../../shared/browser-types.js';
import { workKey } from '../../../shared/work-keys.js';
import { useLayoutStore } from '../../layout/store.js';
import { roomKey } from '../../lib/room-view.js';
import { useUiStore } from '../../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { makeRoom, makeWork } from '../../test-utils/work-fixtures.js';
import { resetDeliveryForTests, type ContextDraft } from './deliver.js';
import { usePageContext, type PageContext } from './use-page-context.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const KEY = workKey('/tmp/p', 'w-01');
const WITH_ROOM = makeWork('w-01', { projectPath: '/tmp/p', rooms: [makeRoom('r-01', 'review')] });
const NOWHERE = makeWork('w-01', { projectPath: '/tmp/p' });

let bridge: FakeBridge;

const draft = (label: string): ContextDraft => ({ kind: 'element', label, markdown: `# ${label}`, imagePath: null, count: 1 });
const roomPaths = (): readonly string[] => useUiStore.getState().composerAttachments[roomKey(KEY, 'r-01')] ?? [];

/** Хук на вкладке без поля `target`: цель — умолчание (здесь единственная комната). */
function mount(entry: WorkEntry): RenderHookResult<PageContext, unknown> {
  return renderHook(() =>
    usePageContext({ bridge, workKey: KEY, tabId: 'browser:t1', entry, stored: undefined, sendDeps: { bridge, session: () => null, openSession: vi.fn() } }),
  );
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  bridge = createFakeBridge();
  vi.mocked(toast).mockClear();
  resetDeliveryForTests();
  useUiStore.setState({ composerAttachments: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('usePageContext — очередь добавлений и цель (спека браузера 4.5)', () => {
  it('добавления подряд идут одной очередью: запись второго файла начинается после первого, чипы — в порядке кликов', async () => {
    const finish: Array<() => void> = [];
    const save = vi.spyOn(bridge.browser, 'saveContext').mockImplementation(
      (input) => new Promise<SavedContext>((resolve) => finish.push(() => resolve({ mdPath: `/h/${input.label}.md`, pngPath: null }))),
    );
    const { result } = mount(WITH_ROOM);
    expect(result.current.target).toEqual({ kind: 'room', roomId: 'r-01' });
    const both = Promise.all([result.current.add(draft('a')), result.current.add(draft('b'))]);
    await tick();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].label).toBe('a');
    finish[0]?.();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    finish[1]?.();
    expect(await both).toEqual(['room', 'room']);
    expect(roomPaths()).toEqual(['/h/a.md', '/h/b.md']);
  });

  it('отказ записи первого файла очередь не ломает: второй, что стоит за ним, добавляется', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(bridge.browser, 'saveContext').mockRejectedValueOnce({ code: 'failed', message: 'boom' });
    const { result } = mount(WITH_ROOM);
    expect(await Promise.all([result.current.add(draft('a')), result.current.add(draft('b'))])).toEqual(['failed', 'room']);
    expect(roomPaths()).toHaveLength(1);
    expect(roomPaths()[0]).toContain('element-b');
  });

  it('цели нет — тост «No session or room…», файл не пишется, ответ failed', async () => {
    const { result } = mount(NOWHERE);
    expect(result.current.target).toBeNull();
    await expect(result.current.add(draft('a'))).resolves.toBe('failed');
    expect(vi.mocked(toast).mock.calls).toEqual([['No session or room to add page context to']]);
    expect(bridge.browserCalls.filter((call) => call.method === 'saveContext')).toEqual([]);
  });
});

describe('usePageContext — страница панели хозяина (спека браузера 3.10, 4.5)', () => {
  const sendDeps = { bridge: undefined as unknown as FakeBridge, session: () => null, openSession: vi.fn() };

  /** Хук страницы панели: цель закреплена за хозяином `fixed`, `stored` и умолчание ни при чём. */
  function mountPinned(entry: WorkEntry, fixed: { kind: 'session'; sessionId: string } | { kind: 'room'; roomId: string }, stored?: { kind: 'room'; roomId: string }): RenderHookResult<PageContext, unknown> {
    return renderHook(() => usePageContext({ bridge, workKey: KEY, tabId: 'bp-000001', entry, stored, fixed, sendDeps: { ...sendDeps, bridge } }));
  }

  it('цель — хозяин панели, а не умолчание и не поле вкладки; комната хозяина получает файл', async () => {
    const work = makeWork('w-01', { projectPath: '/tmp/p', rooms: [makeRoom('r-01', 'review'), makeRoom('r-02', 'other')] });
    const { result } = mountPinned(work, { kind: 'room', roomId: 'r-02' }, { kind: 'room', roomId: 'r-01' });
    expect(result.current.target).toEqual({ kind: 'room', roomId: 'r-02' });
    await expect(result.current.add(draft('a'))).resolves.toBe('room');
    expect(useUiStore.getState().composerAttachments[roomKey(KEY, 'r-02')]).toHaveLength(1);
    expect(roomPaths()).toEqual([]);
  });

  it('хозяин исчез из карты — отката на умолчание и тоста нет: панель уберёт слежение за составом работы', () => {
    const { result } = mountPinned(NOWHERE, { kind: 'room', roomId: 'r-99' });
    expect(result.current.target).toEqual({ kind: 'room', roomId: 'r-99' });
    expect(vi.mocked(toast)).not.toHaveBeenCalled();
  });

  it('setTarget у закреплённой цели ничего не пишет в раскладку', () => {
    const { result } = mountPinned(WITH_ROOM, { kind: 'room', roomId: 'r-01' });
    const apply = vi.spyOn(useLayoutStore.getState(), 'apply');
    result.current.setTarget({ kind: 'room', roomId: 'r-02' });
    expect(apply).not.toHaveBeenCalled();
    expect(result.current.target).toEqual({ kind: 'room', roomId: 'r-01' });
  });
});
