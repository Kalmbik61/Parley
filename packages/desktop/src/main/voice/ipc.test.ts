import { describe, expect, it } from 'vitest';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { createFakeVoiceServices } from './services.js';
import { MAX_PCM_BYTES, registerVoiceIpc, toArrayBuffer } from './ipc.js';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function setup() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
  const services = createFakeVoiceServices('ok');
  registerVoiceIpc({ ipcMain: ipcMain as never, services });
  const sent: Array<[string, unknown]> = [];
  const event = { sender: { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push([channel, payload]) } };
  const invoke = (channel: string, ...args: unknown[]) => (handlers.get(channel) as Handler)(event, ...args);
  return { invoke, sent, services };
}

describe('toArrayBuffer', () => {
  it('ArrayBuffer и Uint8Array — да, нечётная длина, пусто, больше предела и прочее — нет', () => {
    expect(toArrayBuffer(new ArrayBuffer(4))?.byteLength).toBe(4);
    expect(toArrayBuffer(new Uint8Array([1, 2]))?.byteLength).toBe(2);
    expect(toArrayBuffer(new ArrayBuffer(3))).toBeNull();
    expect(toArrayBuffer(new ArrayBuffer(0))).toBeNull();
    expect(toArrayBuffer(new ArrayBuffer(MAX_PCM_BYTES + 2))).toBeNull();
    expect(toArrayBuffer('pcm')).toBeNull();
  });
});

describe('registerVoiceIpc', () => {
  it('download шлёт прогресс отправителю каналом voice:progress', async () => {
    const { invoke, sent } = setup();
    await expect(invoke('voice:download-model', 'base')).resolves.toEqual({ ok: true });
    expect(sent.map(([channel]) => channel)).toContain('voice:progress');
  });

  it('чужой id модели и чужой язык — bad_request до служб', async () => {
    const { invoke } = setup();
    await expect(invoke('voice:download-model', '../../etc')).rejects.toSatisfy((error: unknown) => decodeIpcError(error).code === 'bad_request');
    await expect(invoke('voice:transcribe', { pcm: new ArrayBuffer(2), language: 'ru -m x', model: 'base' })).rejects.toSatisfy(
      (error: unknown) => decodeIpcError(error).code === 'bad_request',
    );
  });

  it('transcribe, mic-status, request-mic отвечают службами', async () => {
    const { invoke } = setup();
    await expect(invoke('voice:transcribe', { pcm: new ArrayBuffer(2), language: 'ru', model: 'base' })).resolves.toEqual({ text: 'ok' });
    await expect(invoke('voice:mic-status')).resolves.toBe('granted');
    await expect(invoke('voice:request-mic')).resolves.toBe(true);
  });
});
