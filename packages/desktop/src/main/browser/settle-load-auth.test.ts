/**
 * `settleLoad` с basic-auth: вкладка, ждущая логин человека, не держит агента до `loadMs` — ответ `false` сразу.
 */
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { settleLoad } from './agent-actions.js';

function loading(): WebContents {
  const emitter = new EventEmitter() as EventEmitter & { id: number; isLoading(): boolean };
  emitter.id = 3;
  emitter.isLoading = () => true;
  return emitter as unknown as WebContents;
}

describe('settleLoad и basic-auth', () => {
  it('запрос уже висит — false сразу', async () => {
    const result = await settleLoad(loading(), 60_000, new AbortController().signal, { isPending: () => true, onPending: () => () => undefined });
    expect(result).toBe(false);
  });

  it('запрос появился во время ожидания — false сразу, подписка снята', async () => {
    let fire: () => void = () => undefined;
    const off = vi.fn();
    const promise = settleLoad(loading(), 60_000, new AbortController().signal, {
      isPending: () => false,
      onPending: (_id, listener) => {
        fire = listener;
        return off;
      },
    });
    fire();
    expect(await promise).toBe(false);
    expect(off).toHaveBeenCalled();
  });

  it('без запроса загрузка дожидается did-stop-loading', async () => {
    const contents = loading();
    const promise = settleLoad(contents, 60_000, new AbortController().signal, { isPending: () => false, onPending: () => () => undefined });
    (contents as unknown as EventEmitter).emit('did-stop-loading');
    expect(await promise).toBe(true);
  });
});
