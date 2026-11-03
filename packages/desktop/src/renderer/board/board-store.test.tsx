import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowWorkEntry } from '@parley/core';
import type { BacklogSnapshot } from '@parley/protocol';
import { BoardSync } from './BoardSync.js';
import { dropSlot, ensureSlot, loadSlot, useBoardStore } from './board-store.js';
import type { BoardBridge } from './board-store.js';
import { useHostStore } from '../store/host.js';
import { useWorksStore } from '../store/works.js';

const REQUIRED = [
  'backlog.get', 'backlog.subscribe', 'backlog.unsubscribe', 'backlog.add', 'backlog.update', 'backlog.remove',
  'backlog.prepareTake', 'backlog.take', 'backlog.move', 'backlog.transfer', 'backlog.inbox',
  'backlog.suggestions.accept', 'backlog.suggestions.dismiss', 'backlog.preferences.set', 'backlog.file.set', 'rooms.send',
];
const INBOX = '/home/.parley/inbox';
const snap = (projectPath: string, title = 'Item', version = 'v1'): BacklogSnapshot => ({
  projectPath, sharedProjectPath: projectPath, version, file: { relativePath: '.parley/backlog.md', exists: true }, rule: 'problems',
  diagnostics: [], suggestions: [], items: [{ id: 'b-001', title, details: '', checked: false, section: null }],
});
const entry = (projectPath: string, workId: string, status = 'active'): WindowWorkEntry =>
  ({ projectPath, map: { work: { id: workId, status }, sessions: [], rooms: [] } }) as unknown as WindowWorkEntry;
const connect = (methods: string[] = REQUIRED, connections = 1): void => {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '1', methods }, connections });
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  let listener: ((event: { projectPath: string; unavailable?: true }) => void) | undefined;
  const call = vi.fn(async (method: string, params: { projectPath?: string }) => {
    if (method === 'backlog.inbox') return { projectPath: INBOX };
    if (method === 'backlog.unsubscribe') return { ok: true };
    return snap(params.projectPath ?? '');
  });
  const bridge = { call, on: vi.fn((_event: string, next: typeof listener) => { listener = next; return vi.fn(); }) } as unknown as BoardBridge;
  return { bridge, call, changed: (event: { projectPath: string; unavailable?: true }) => listener?.(event) };
}
const calls = (call: ReturnType<typeof fixture>['call'], method: string): unknown[] =>
  call.mock.calls.filter(row => row[0] === method).map(row => row[1]);
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => {
  useBoardStore.setState({ supported: false, slots: new Map(), inboxPath: null, filter: { kind: 'all' } });
  useWorksStore.setState({ entries: [entry('/a', 'w-01'), entry('/b', 'w-01')] });
  connect();
});
afterEach(cleanup);

describe('BoardSync', () => {
  it('подписка на каждый проект и Входящие', async () => {
    const { bridge, call } = fixture();
    render(<BoardSync bridge={bridge} />);
    await flush(); await flush();
    expect(calls(call, 'backlog.subscribe')).toEqual(expect.arrayContaining([{ projectPath: '/a' }, { projectPath: '/b' }, { projectPath: INBOX }]));
    expect(calls(call, 'backlog.subscribe').length).toBe(3);
    const state = useBoardStore.getState();
    expect(state.supported).toBe(true);
    expect(state.inboxPath).toBe(INBOX);
    expect(state.slots.get('/a')?.live).toBe(true);
    expect(state.slots.get('/a')?.snapshot?.projectPath).toBe('/a');
  });

  it('backlog.changed перечитывает только свой проект', async () => {
    const { bridge, call, changed } = fixture();
    render(<BoardSync bridge={bridge} />);
    await flush(); await flush();
    call.mockClear();
    act(() => changed({ projectPath: '/a' }));
    await flush();
    expect(call.mock.calls.map(row => [row[0], row[1]])).toEqual([['backlog.get', { projectPath: '/a' }]]);
  });

  it('unavailable снимает live, снимок остаётся', async () => {
    const { bridge, changed } = fixture();
    render(<BoardSync bridge={bridge} />);
    await flush(); await flush();
    act(() => changed({ projectPath: '/a', unavailable: true }));
    const slot = useBoardStore.getState().slots.get('/a');
    expect(slot?.live).toBe(false);
    expect(slot?.snapshot).toBeTruthy();
  });

  it('проект пропал из работ — unsubscribe и слот удалён', async () => {
    const { bridge, call } = fixture();
    render(<BoardSync bridge={bridge} />);
    await flush(); await flush();
    act(() => useWorksStore.setState({ entries: [entry('/a', 'w-01')] }));
    await flush();
    expect(calls(call, 'backlog.unsubscribe')).toEqual([{ projectPath: '/b' }]);
    expect(useBoardStore.getState().slots.has('/b')).toBe(false);
    expect(useBoardStore.getState().slots.has('/a')).toBe(true);
  });

  it('смена карты работ без смены проектов не подписывает заново', async () => {
    const { bridge, call } = fixture();
    render(<BoardSync bridge={bridge} />);
    await flush(); await flush();
    call.mockClear();
    act(() => useWorksStore.setState({ entries: [entry('/b', 'w-09'), entry('/a', 'w-02')] }));
    await flush();
    expect(call).not.toHaveBeenCalled();
  });

  it('отказ subscribe — backlog.get без live', async () => {
    const { bridge, call } = fixture();
    const base = call.getMockImplementation()!;
    call.mockImplementation(async (method, params) => {
      if (method === 'backlog.subscribe' && params.projectPath === '/a') throw new Error('no live');
      return base(method, params);
    });
    render(<BoardSync bridge={bridge} />);
    await flush(); await flush(); await flush();
    expect(calls(call, 'backlog.get')).toEqual([{ projectPath: '/a' }]);
    const slot = useBoardStore.getState().slots.get('/a');
    expect(slot?.live).toBe(false);
    expect(slot?.snapshot?.projectPath).toBe('/a');
  });

  it('переподключение хоста — подписки заново', async () => {
    const { bridge, call } = fixture();
    render(<BoardSync bridge={bridge} />);
    await flush(); await flush();
    expect(calls(call, 'backlog.subscribe').length).toBe(3);
    act(() => connect(REQUIRED, 2));
    await flush(); await flush();
    expect(calls(call, 'backlog.subscribe').length).toBe(6);
  });

  it('переподключение — live сброшен до нового ответа, пропавший проект удалён', async () => {
    const { bridge, call } = fixture();
    render(<BoardSync bridge={bridge} />);
    await flush(); await flush();
    expect(useBoardStore.getState().slots.get('/a')?.live).toBe(true);
    expect(useBoardStore.getState().slots.has('/b')).toBe(true);
    const base = call.getMockImplementation()!;
    const pending = deferred<BacklogSnapshot>();
    call.mockImplementation(async (method, params) => {
      if (method === 'backlog.subscribe' && params.projectPath === '/a') return pending.promise;
      return base(method, params);
    });
    // Проект /b пропал за время разрыва: набор путей и связь меняются в одном проходе эффекта.
    act(() => { useWorksStore.setState({ entries: [entry('/a', 'w-01')] }); connect(REQUIRED, 2); });
    await flush(); await flush();
    const slots = useBoardStore.getState().slots;
    expect(slots.get('/a')?.live).toBe(false);
    expect(slots.get('/a')?.snapshot).toBeTruthy();
    expect(slots.has('/b')).toBe(false);
    expect(slots.get(INBOX)?.live).toBe(true);
    pending.resolve(snap('/a', 'Item', 'v2'));
    await flush(); await flush();
    expect(useBoardStore.getState().slots.get('/a')?.live).toBe(true);
  });

  it('старый хост без backlog.move — supported false и ни одного вызова', async () => {
    const { bridge, call } = fixture();
    connect(REQUIRED.filter(method => method !== 'backlog.move'));
    render(<BoardSync bridge={bridge} />);
    await flush(); await flush();
    expect(useBoardStore.getState().supported).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it('запоздавший ответ get не затирает свежий снимок', async () => {
    const { bridge, call, changed } = fixture();
    render(<BoardSync bridge={bridge} />);
    await flush(); await flush();
    const base = call.getMockImplementation()!;
    const slow = deferred<BacklogSnapshot>();
    let first = true;
    call.mockImplementation(async (method, params) => {
      if (method === 'backlog.get' && params.projectPath === '/a') {
        if (first) { first = false; return slow.promise; }
        return snap('/a', 'fresh', 'v3');
      }
      return base(method, params);
    });
    act(() => changed({ projectPath: '/a' }));
    act(() => changed({ projectPath: '/a' }));
    await flush(); await flush();
    expect(useBoardStore.getState().slots.get('/a')?.snapshot?.items[0]?.title).toBe('fresh');
    slow.resolve(snap('/a', 'stale', 'v2'));
    await flush(); await flush();
    expect(useBoardStore.getState().slots.get('/a')?.snapshot?.items[0]?.title).toBe('fresh');
  });

  it('changed до ответа subscribe — слот всё равно live', async () => {
    const { bridge, call, changed } = fixture();
    const base = call.getMockImplementation()!;
    const pending = deferred<BacklogSnapshot>();
    call.mockImplementation(async (method, params) => {
      if (method === 'backlog.subscribe' && params.projectPath === '/a') return pending.promise;
      if (method === 'backlog.get' && params.projectPath === '/a') return snap('/a', 'fresh', 'v2');
      return base(method, params);
    });
    render(<BoardSync bridge={bridge} />);
    await flush(); await flush();
    expect(useBoardStore.getState().slots.get('/a')?.live).toBe(false);
    act(() => changed({ projectPath: '/a' }));
    await flush(); await flush();
    expect(useBoardStore.getState().slots.get('/a')?.snapshot?.items[0]?.title).toBe('fresh');
    expect(useBoardStore.getState().slots.get('/a')?.live).toBe(false);
    pending.resolve(snap('/a', 'stale', 'v1'));
    await flush(); await flush();
    const slot = useBoardStore.getState().slots.get('/a');
    expect(slot?.live).toBe(true);
    expect(slot?.snapshot?.items[0]?.title).toBe('fresh');
  });

  it('dropSlot не сбрасывает счётчик запросов: запоздавший ответ не совпадает с новым', async () => {
    const { bridge, call } = fixture();
    const late = deferred<BacklogSnapshot>();
    const base = call.getMockImplementation()!;
    let gets = 0;
    call.mockImplementation(async (method, params) => {
      if (method === 'backlog.get' && params.projectPath === '/a' && ++gets === 1) return late.promise;
      if (method === 'backlog.get' && params.projectPath === '/a') return snap('/a', 'new', 'v2');
      return base(method, params);
    });
    ensureSlot('/a');
    const first = loadSlot(bridge, '/a', false);
    dropSlot('/a');
    ensureSlot('/a');
    await loadSlot(bridge, '/a', false);
    expect(useBoardStore.getState().slots.get('/a')?.snapshot?.items[0]?.title).toBe('new');
    late.resolve(snap('/a', 'stale', 'v1'));
    await first;
    expect(useBoardStore.getState().slots.get('/a')?.snapshot?.items[0]?.title).toBe('new');
  });

  it('setSending ставит и снимает пометку с подписью цели', () => {
    useBoardStore.setState({ sending: new Map() });
    useBoardStore.getState().setSending('/a#b-001', 'S01');
    expect(useBoardStore.getState().sending.get('/a#b-001')).toBe('S01');
    useBoardStore.getState().setSending('/a#b-001', null);
    expect(useBoardStore.getState().sending.size).toBe(0);
  });
});
