import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestInfo } from '../context.js';
import type { CliUpdates } from '../providers/updates.js';
import { createProvidersList, createProvidersSkipUpdate } from './providers.js';

let home = '';
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-list-updates-'));
  process.env['PARLEY_HOME'] = home;
});
afterEach(async () => {
  delete process.env['PARLEY_HOME'];
  await rm(home, { recursive: true, force: true });
});

const info = { latest: '0.166.0', method: 'standalone', checkedAt: '2026-11-02T00:00:00.000Z' };

describe('providers.list: update', () => {
  it('поле update — из службы по команде провайдера (GLM делит строку claude); без службы поля нет', async () => {
    const current = vi.fn(async (command: string) => (command === 'codex' ? info : null));
    const versions = { ready: Promise.resolve(), get: (command: string) => (command === 'codex' ? '0.162.0' : null), fresh: async () => null };
    const list = createProvidersList(versions, undefined, undefined, undefined, undefined, undefined, { current });
    const result = await list({}, {} as RequestInfo);
    const byId = new Map(result.providers.map((provider) => [provider.id, provider] as const));
    expect(byId.get('codex')?.update).toEqual(info);
    expect(byId.get('claude')?.update).toBeNull();
    expect(byId.get('glm')?.update).toBeNull();
    expect(current).toHaveBeenCalledWith('codex', '0.162.0');
    expect(current).toHaveBeenCalledWith('claude', null);

    const without = await createProvidersList(versions)({}, {} as RequestInfo);
    expect(without.providers.every((provider) => !('update' in provider))).toBe(true);
  });
});

describe('providers.skipUpdate', () => {
  const request = () => {
    const broadcast = vi.fn();
    return { broadcast, info: { host: { broadcast } } as unknown as RequestInfo };
  };

  it('пропускает версию команды провайдера и сообщает окну providers.changed', async () => {
    const skip = vi.fn(async () => true);
    const { broadcast, info: req } = request();
    const result = await createProvidersSkipUpdate({ skip } as Pick<CliUpdates, 'skip'>)({ provider: 'glm' }, req);
    expect(result).toEqual({ ok: true });
    expect(skip).toHaveBeenCalledWith('claude');
    expect(broadcast).toHaveBeenCalledWith('providers.changed', { provider: 'glm' });
  });

  it('без службы проверки пропускать нечего — bad_request', async () => {
    await expect(createProvidersSkipUpdate()({ provider: 'codex' }, request().info)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('неизвестный провайдер или нечего пропускать — bad_request', async () => {
    const skip = vi.fn(async () => false);
    const handler = createProvidersSkipUpdate({ skip } as Pick<CliUpdates, 'skip'>);
    await expect(handler({ provider: 'нет-такого' }, request().info)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(handler({ provider: 'codex' }, request().info)).rejects.toMatchObject({ code: 'bad_request' });
  });
});
