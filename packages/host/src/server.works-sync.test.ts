import path from 'node:path';
import type { Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WindowWorkMap } from '@parley/core';
import { WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE } from '@parley/protocol';
import type { Params, WorksMailStatePage, WorksSyncPage } from '@parley/protocol';
import { connectRaw, hello, tempHome, removeHome, waitConnected } from '../test/helpers.js';
import type { TestClient } from '../test/helpers.js';
import type { HostContext } from './context.js';
import { HostError } from './errors.js';
import { createHostServer } from './server.js';
import { WorksSyncHost, prepareWorksMailStateReply, prepareWorksSyncReply } from './works/works-sync.js';

const opened: Array<{ server: Server; client: TestClient; home: string; sync: WorksSyncHost }> = [];
afterEach(async () => {
  for (const { server, client, home, sync } of opened.splice(0)) {
    client.close(); sync.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await removeHome(home);
  }
});
async function boot(fallback = false) {
  const home = await tempHome();
  const sync = new WorksSyncHost({ pageBytes: 2048, captureMail: async key => ({ kind: 'captured', key, sourceVersion: 8, requiredStructuralVersion: 7, mail: { rooms: { ['💬'.repeat(3000)]: { total: 2, top: 2, lastAt: 'now', unread: 1, decision: null } }, unread: { letters: 1, rooms: { '': 1 } }, mentionCandidates: [] } }) });
  const entry = { projectPath: '/fixture', version: 7, map: { schemaVersion: 2, work: { id: 'w-1', title: '😀"\\', goal: 'goal', status: 'active', createdAt: 'x', updatedAt: 'x' }, sessions: Array.from({ length: 100 }, (_, i) => ({ id: `s-${i}`, task: '漢😀"\\'.repeat(100) })), rooms: [], messages: [] } as unknown as WindowWorkMap };
  await sync.publish([entry], [{ projectPath: entry.projectPath, workId: entry.map.work.id }], {});
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let clock = 0, writes = 0;
  const server = createHostServer({
    context: { version: 'fixture', liveSessions: () => 0, log } as unknown as HostContext,
    token: 'fixture', helloTimeoutMs: 1000, now: () => (++clock % 2 === 1 ? 0 : 2000),
    methodHandlers: {
      'works.sync': async (params, request) => prepareWorksSyncReply(sync, request.client, params as Params<'works.sync'>),
      'works.mailState': async (params, request) => prepareWorksMailStateReply(sync, request.client, params as Params<'works.mailState'>),
      'host.info': async () => ({ ordinary: true, json: 'not a trusted frame', bytes: 0 }),
      'works.list': async () => { throw new HostError('conflict', 'ordinary error'); },
    }, notificationHandlers: {},
    registerClient: client => {
      if (fallback) delete client.sendLine;
      else {
        const send = client.sendLine!;
        client.sendLine = line => { writes += 1; send(line); return false; };
      }
    }, unregisterClient: client => sync.dropClient(client.id),
  });
  const socket = path.join(home, 'sync.sock');
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  } catch (error) { sync.stop(); await removeHome(home); throw error; }
  const client = connectRaw(socket);
  await waitConnected(client.socket);
  const handshake = await hello(client, 'fixture', { features: [WORKS_SYNC_FEATURE, ROOMS_MAIL_FEATURE] });
  opened.push({ server, client, home, sync });
  return { client, sync, log, handshake, writes: () => writes };
}

describe('actual prepared works.sync RPC boundary', () => {
  it.each([false, true])('sends mail-only fragments through the same private boundary without a second encode/reply (fallback=%s)', async fallback => {
    const { client, sync, log, writes } = await boot(fallback);
    let encodes = 0;
    const original = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
      if (typeof value === 'object' && value !== null && ((value as { kind?: string }).kind === 'mail-page' && Object.hasOwn(value, 'records') || (value as { result?: { kind?: string } }).result?.kind === 'mail-page')) encodes += 1;
      return (original as (...args: unknown[]) => string)(value, ...args);
    }) as typeof JSON.stringify);
    try {
      client.send({ id: -Number.MAX_VALUE, method: 'works.mailState', params: { projectPath: '/fixture', workId: 'w-1' } });
      const response = await client.next();
      expect((response.result as WorksMailStatePage).kind).toBe('mail-page');
      // Одна проба малого конверта при старте; весь результат кодирует лишь fallback.
      expect(encodes).toBe(fallback ? 2 : 1);
      expect(writes()).toBe(fallback ? 0 : 1);
      expect(Buffer.byteLength(original(response) + '\n')).toBeLessThanOrEqual(sync.pageBytes);
      expect(log.warn).toHaveBeenCalledWith('медленный запрос', expect.objectContaining({ method: 'works.mailState', bytes: Buffer.byteLength(original(response.result)) }));
      client.send({ id: 905, method: 'host.info', params: {} });
      expect((await client.next()).id).toBe(905);
    } finally { spy.mockRestore(); }
  });
  it.each([false, true])('sends one bounded Unicode response; slow logs avoid page reencoding (fallback=%s)', async fallback => {
    const { client, sync, log, writes, handshake } = await boot(fallback);
    expect((handshake.result as { features: string[] }).features).toContain(WORKS_SYNC_FEATURE);
    let pageEncodes = 0;
    const original = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
      if (typeof value === 'object' && value !== null && (value as { kind?: string }).kind === 'page' && Object.hasOwn(value, 'records')) pageEncodes += 1;
      if (typeof value === 'object' && value !== null && typeof (value as { result?: unknown }).result === 'object' && (value as { result: { kind?: string } }).result?.kind === 'page') pageEncodes += 1;
      return (original as (...args: unknown[]) => string)(value, ...args);
    }) as typeof JSON.stringify);
    client.send({ id: -Number.MAX_VALUE, method: 'works.sync', params: { base: 0 } });
    const response = await client.next();
    spy.mockRestore();
    expect(response.id).toBe(-Number.MAX_VALUE);
    expect((response.result as WorksSyncPage).kind).toBe('page');
    expect(Buffer.byteLength(JSON.stringify(response) + '\n')).toBeLessThanOrEqual(sync.pageBytes);
    expect(pageEncodes).toBe(fallback ? 1 : 0);
    expect(writes()).toBe(fallback ? 0 : 1);
    expect(log.warn).toHaveBeenCalledWith('медленный запрос', expect.objectContaining({ method: 'works.sync', bytes: Buffer.byteLength(JSON.stringify(response.result)) }));
    client.send({ id: 902, method: 'host.info', params: {} });
    const ordinary = await client.next();
    expect(ordinary).toEqual({ id: 902, result: { ordinary: true, json: 'not a trusted frame', bytes: 0 } });
    client.send({ id: 903, method: 'works.list', params: {} });
    expect(await client.next()).toMatchObject({ id: 903, error: { code: 'conflict', message: 'ordinary error' } });
  });
});
