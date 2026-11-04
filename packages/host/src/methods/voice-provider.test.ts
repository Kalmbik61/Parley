import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestInfo } from '../context.js';
import { createVoiceProviderHandlers } from './voice-provider.js';

// Маркер вместо настоящего ключа: тест ищет его во всех выходах методов.
const MARKER = 'marker-0123456789abcdef';
const request = {} as RequestInfo;
let home: string;
const previous = process.env.PARLEY_HOME;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-voice-'));
  process.env.PARLEY_HOME = home;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previous;
  await rm(home, { recursive: true, force: true });
});

const call = (handlers: ReturnType<typeof createVoiceProviderHandlers>, name: string, params: unknown = {}): Promise<unknown> =>
  (handlers[name] as unknown as (params: unknown, request: RequestInfo) => Promise<unknown>)(params, request);

describe('voiceProvider handlers', () => {
  it('the marker appears in no method result; only secretHint goes out', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const handlers = createVoiceProviderHandlers(fetchImpl as unknown as typeof fetch);
    expect(await call(handlers, 'voiceProvider.get')).toEqual({ keySet: false, secretHint: null });
    const outputs = [
      await call(handlers, 'voiceProvider.setKey', { key: MARKER }),
      await call(handlers, 'voiceProvider.get'),
      await call(handlers, 'voiceProvider.check'),
    ];
    expect(outputs[0]).toEqual({ keySet: true, secretHint: '\u2022\u2022\u2022\u2022cdef' });
    expect(outputs[2]).toEqual({ ok: true, model: 'gpt-live-1' });
    expect(JSON.stringify(outputs)).not.toContain(MARKER);
    expect(await call(handlers, 'voiceProvider.clearKey')).toEqual({ keySet: false, secretHint: null });
  });

  it('check returns a reason code without the marker, even when the network error carries it', async () => {
    const statuses: Array<[number, string]> = [[401, 'invalid_key'], [404, 'model_unavailable'], [429, 'rate_limited'], [500, 'unknown']];
    for (const [status, code] of statuses) {
      const handlers = createVoiceProviderHandlers((async () => new Response(MARKER, { status })) as unknown as typeof fetch);
      await call(handlers, 'voiceProvider.setKey', { key: MARKER });
      const result = await call(handlers, 'voiceProvider.check');
      expect(result).toEqual({ ok: false, code });
      expect(JSON.stringify(result)).not.toContain(MARKER);
    }
    const failing = createVoiceProviderHandlers((async () => {
      throw new Error(`boom ${MARKER}`);
    }) as unknown as typeof fetch);
    const result = await call(failing, 'voiceProvider.check');
    expect(result).toEqual({ ok: false, code: 'network' });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it('check without a key reports no_key and does not call the network', async () => {
    const fetchImpl = vi.fn();
    const handlers = createVoiceProviderHandlers(fetchImpl as unknown as typeof fetch);
    expect(await call(handlers, 'voiceProvider.check')).toEqual({ ok: false, code: 'no_key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a malformed key is rejected without echoing it', async () => {
    const handlers = createVoiceProviderHandlers();
    const error = await call(handlers, 'voiceProvider.setKey', { key: `bad key ${MARKER}` }).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(MARKER);
  });
});
