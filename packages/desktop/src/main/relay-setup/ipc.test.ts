import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { ControlCallError } from '../remote-control.js';
import { registerRelaySetupIpc } from './ipc.js';
import type { RelaySetupService } from './service.js';

function register(service: RelaySetupService) {
  let handler: ((event: unknown, ...args: unknown[]) => Promise<unknown>) | undefined;
  const ipcMain = { handle: (_channel: string, h: typeof handler) => void (handler = h) } as unknown as IpcMain;
  registerRelaySetupIpc(ipcMain, service);
  return (...args: unknown[]) => handler!({}, ...args);
}

describe('relay-setup:call', () => {
  it('accepts only the known methods', async () => {
    const call = vi.fn(async () => null);
    const invoke = register({ call, dispose: () => undefined } as unknown as RelaySetupService);
    await expect(invoke('exec', {})).rejects.toThrow(/unknown relay setup method/);
    await expect(invoke('shell', { command: 'id' })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
    await invoke('cancel', {});
    expect(call).toHaveBeenCalledWith('cancel', {});
  });

  it('an unexpected error never carries its text (and so no secret) to the window', async () => {
    const call = vi.fn(async () => {
      throw new Error('boom hunter2');
    });
    const invoke = register({ call, dispose: () => undefined } as unknown as RelaySetupService);
    const error = await invoke('begin', {}).catch((e: Error) => e);
    expect((error as Error).message).not.toContain('hunter2');
    expect((error as Error).message).toContain('setup_failed');
  });

  it('keeps the code of a refusal', async () => {
    const call = vi.fn(async () => {
      throw new ControlCallError('bad_input', 'Enter a port');
    });
    const invoke = register({ call, dispose: () => undefined } as unknown as RelaySetupService);
    expect(((await invoke('begin', {}).catch((e: Error) => e)) as Error).message).toContain('bad_input');
  });
});
