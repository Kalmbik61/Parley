import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { resetRolesStoreForTests, ROLES_STORE_TTL_MS, useRolesStore } from './roles.js';

const role = (readOnly: boolean) => ({ id: 'codex:review', name: 'Review', source: 'codex' as const, provider: 'codex', description: '', model: null, effort: null, readOnly });
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

beforeEach(() => { vi.useFakeTimers(); resetRolesStoreForTests(); });
afterEach(() => { vi.useRealTimers(); });

describe('стор ролей', () => {
  it('load по одному cwd — один вызов roles.list, повтор в пределах 3 с — ноль, после — новый', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('roles.list', async () => ({ roles: [role(false)], diagnostics: [], partial: false }));
    const load = (): void => useRolesStore.getState().load(bridge, { projectPath: '/p', cwd: '/p' });
    load(); load();
    await flush();
    expect(bridge.calls.filter(c => c.method === 'roles.list')).toHaveLength(1);
    expect(useRolesStore.getState().byCwd['/p']?.status).toBe('ready');
    vi.advanceTimersByTime(ROLES_STORE_TTL_MS - 1);
    load();
    expect(bridge.calls.filter(c => c.method === 'roles.list')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    load();
    await flush();
    expect(bridge.calls.filter(c => c.method === 'roles.list')).toHaveLength(2);
  });

  it('force перечитывает со status reloading и прежними ролями; ошибка оставляет прежние роли со status error', async () => {
    const bridge = createFakeBridge();
    let fail = false;
    bridge.setHandler('roles.list', async () => { if (fail) throw new Error('boom'); return { roles: [role(true)], diagnostics: [], partial: false }; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = useRolesStore.getState();
    store.load(bridge, { projectPath: '/p', cwd: '/p' });
    await flush();
    fail = true;
    store.load(bridge, { projectPath: '/p', cwd: '/p', force: true });
    expect(useRolesStore.getState().byCwd['/p']).toMatchObject({ status: 'reloading', roles: [expect.objectContaining({ readOnly: true })] });
    await flush();
    expect(useRolesStore.getState().byCwd['/p']).toMatchObject({ status: 'error', roles: [expect.objectContaining({ readOnly: true })] });
    warn.mockRestore();
  });

  it('force поверх запроса по TTL (status loading с прежними ролями) даёт reloading, а не loading', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('roles.list', async () => ({ roles: [role(true)], diagnostics: [], partial: false }));
    const store = useRolesStore.getState();
    store.load(bridge, { projectPath: '/p', cwd: '/p' });
    await flush();
    vi.advanceTimersByTime(ROLES_STORE_TTL_MS);
    store.load(bridge, { projectPath: '/p', cwd: '/p' });
    expect(useRolesStore.getState().byCwd['/p']?.status).toBe('loading');
    store.load(bridge, { projectPath: '/p', cwd: '/p', force: true });
    expect(useRolesStore.getState().byCwd['/p']?.status).toBe('reloading');
    await flush();
    expect(useRolesStore.getState().byCwd['/p']?.status).toBe('ready');
  });

  it('force поверх свежей ошибки (прежние роли сохранены) даёт reloading', async () => {
    const bridge = createFakeBridge();
    let fail = false;
    bridge.setHandler('roles.list', async () => { if (fail) throw new Error('boom'); return { roles: [role(true)], diagnostics: [], partial: false }; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = useRolesStore.getState();
    store.load(bridge, { projectPath: '/p', cwd: '/p' });
    await flush();
    fail = true;
    vi.advanceTimersByTime(ROLES_STORE_TTL_MS);
    store.load(bridge, { projectPath: '/p', cwd: '/p' });
    await flush();
    expect(useRolesStore.getState().byCwd['/p']?.status).toBe('error');
    fail = false;
    store.load(bridge, { projectPath: '/p', cwd: '/p', force: true });
    expect(useRolesStore.getState().byCwd['/p']?.status).toBe('reloading');
    warn.mockRestore();
  });
});
