import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addSession, createWork, updateMap } from '@parley/core';
import { COMPACT_WORKS_FEATURE, encodeLine } from '@parley/protocol';
import { createClient } from '../client.js';
import { createHostContext } from '../context.js';
import { createWorksService } from './works-service.js';
import type { WorksService } from './works-service.js';

// Шпион кодировщика кадров: в хосте им кодируется каждый кадр клиенту.
vi.mock('@parley/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parley/protocol')>();
  return { ...actual, encodeLine: vi.fn(actual.encodeLine) };
});

let home = '';
let project = '';
let service: WorksService | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  await service?.stop();
  service = undefined;
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeSocket(): { socket: Socket; written: string[] } {
  const written: string[] = [];
  const socket = { destroyed: false, writableLength: 0, write: (chunk: string) => written.push(chunk) } as unknown as Socket;
  return { socket, written };
}

describe('рассылка снимка', () => {
  it('снимок для окна кодируется один раз на рассылку, а не по разу на клиента; оба получают одну и ту же строку', async () => {
    const handle = createHostContext({
      version: '0.0.0',
      paths: { dir: '', socket: '', token: '', pid: '', log: '' },
      log: { info: () => {}, warn: () => {}, error: () => {} },
      onIdleChange: () => {},
      registerShutdownHook: () => {},
      requestShutdown: async () => {},
    });
    const first = fakeSocket();
    const second = fakeSocket();
    handle.addClient(createClient(first.socket, 'a', [COMPACT_WORKS_FEATURE]));
    handle.addClient(createClient(second.socket, 'b', [COMPACT_WORKS_FEATURE]));
    const { work } = await createWork(project, { title: 'W' });
    await updateMap(project, work.id, (map) => {
      addSession(map, { provider: 'claude', label: 'a', task: 't' });
    });
    service = createWorksService(handle.context, { debounceMs: 5 });
    await service.start();
    await vi.waitFor(() => expect(first.written.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const worksFrames = (): number =>
      vi.mocked(encodeLine).mock.calls.filter(([message]) => 'event' in message && message.event === 'works.changed').length;
    // Каждая рассылка снимка: один кадр на кодировщик, сколько бы клиентов ни слушало.
    const sent = first.written.filter((line) => line.includes('"works.changed"')).length;
    expect(sent).toBeGreaterThan(0);
    expect(second.written.filter((line) => line.includes('"works.changed"')).length).toBe(sent);
    expect(worksFrames()).toBe(sent);
    expect(first.written.filter((line) => line.includes('"works.changed"'))).toEqual(second.written.filter((line) => line.includes('"works.changed"')));
  });
});
