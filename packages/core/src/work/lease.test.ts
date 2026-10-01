import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWork } from './store.js';
import { hostLeaseActive, readHostLease, removeHostLease, writeHostLease } from './lease.js';

let home = '';
let project = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
});

afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('writeHostLease / readHostLease', () => {
  it('пишет и читает аренду', async () => {
    const map = await createWork(project, { title: 'Авторизация' });
    const lease = { pid: process.pid, startedAtProcess: '2026-09-26T10:00:00.000Z', since: '2026-09-26T10:00:00.000Z' };

    await writeHostLease(project, map.work.id, lease);

    expect(await readHostLease(project, map.work.id)).toEqual(lease);
  });

  it('файла нет — null', async () => {
    const map = await createWork(project, { title: 'Авторизация' });
    expect(await readHostLease(project, map.work.id)).toBeNull();
  });
});

describe('hostLeaseActive', () => {
  it('свой pid и настоящее время старта — жива', async () => {
    const map = await createWork(project, { title: 'Авторизация' });
    const now = Date.now();
    await writeHostLease(project, map.work.id, {
      pid: process.pid,
      startedAtProcess: new Date(now).toISOString(),
      since: new Date(now).toISOString(),
    });

    expect(await hostLeaseActive(project, map.work.id)).toBe(true);
  });

  it('мёртвый pid — не жива', async () => {
    const map = await createWork(project, { title: 'Авторизация' });
    await writeHostLease(project, map.work.id, {
      pid: 999_999,
      startedAtProcess: null,
      since: new Date().toISOString(),
    });

    expect(await hostLeaseActive(project, map.work.id)).toBe(false);
  });

  it('время старта не совпало — не жива: pid переиспользован другим процессом', async () => {
    const map = await createWork(project, { title: 'Авторизация' });
    await writeHostLease(project, map.work.id, {
      pid: process.pid,
      startedAtProcess: '2000-01-01T00:00:00.000Z',
      since: new Date().toISOString(),
    });

    expect(await hostLeaseActive(project, map.work.id)).toBe(false);
  });

  it('аренды нет — не жива', async () => {
    const map = await createWork(project, { title: 'Авторизация' });
    expect(await hostLeaseActive(project, map.work.id)).toBe(false);
  });
});

describe('removeHostLease', () => {
  it('снимает свою аренду', async () => {
    const map = await createWork(project, { title: 'Авторизация' });
    await writeHostLease(project, map.work.id, {
      pid: process.pid,
      startedAtProcess: null,
      since: new Date().toISOString(),
    });

    await removeHostLease(project, map.work.id, process.pid);

    expect(await readHostLease(project, map.work.id)).toBeNull();
  });

  it('чужой pid — файл не трогает', async () => {
    const map = await createWork(project, { title: 'Авторизация' });
    const lease = { pid: process.pid, startedAtProcess: null, since: new Date().toISOString() };
    await writeHostLease(project, map.work.id, lease);

    await removeHostLease(project, map.work.id, 999_999);

    expect(await readHostLease(project, map.work.id)).toEqual(lease);
  });
});
