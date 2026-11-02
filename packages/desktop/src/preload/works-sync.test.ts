import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { createWorksSyncBridge } from './works-sync.js';

describe('works sync preload', () => {
  it('requests replay only after subscription, acknowledges consumer completion and rejects old streams', async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const ipc = { on: (channel: string, handler: (...args: unknown[]) => void) => handlers.set(channel, handler), send: vi.fn() };
    const bridge = createWorksSyncBridge(ipc as unknown as IpcRenderer);
    expect(ipc.send).not.toHaveBeenCalled();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const batch = vi.fn(() => pending);
    const status = vi.fn();
    const unsubscribe = bridge.subscribe(batch, status);
    const stream = ipc.send.mock.calls[0]?.[1];
    const payload = { kind: 'works-sync-batch', transaction: { mode: 'reset', epoch: 'a', base: 0, target: 1 }, index: 0, records: [], commit: true };
    handlers.get('works-sync:batch')?.({}, stream, 10, payload);
    expect(batch).toHaveBeenCalledWith(payload);
    expect(ipc.send).not.toHaveBeenCalledWith('works-sync:ack', stream, 10);
    finish();
    await vi.waitFor(() => expect(ipc.send).toHaveBeenCalledWith('works-sync:ack', stream, 10));
    handlers.get('works-sync:status')?.({}, stream, { state: 'loading' });
    expect(status).toHaveBeenCalledTimes(1);
    unsubscribe();
    handlers.get('works-sync:batch')?.({}, stream, 11, payload);
    expect(batch).toHaveBeenCalledTimes(1);
    bridge.retry();
    expect(ipc.send).toHaveBeenCalledWith('works-sync:retry');
  });
});
