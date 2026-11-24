import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  kimiModelsFile,
  loadProviders,
  resolveModelEffort,
  selectableModels,
  supportsEffort,
} from '@parley/core';
import { createProvidersList } from '../methods/providers.js';
import type { RequestInfo } from '../methods/context.js';
import { parseKimiModels, probeKimiModels, startKimiCatalog } from './kimi-catalog.js';

const raw = JSON.stringify({
  providers: { secret: 'credential-sentinel' },
  models: {
    'kimi-code/k3': {
      displayName: 'K3',
      supportEfforts: ['low', 'high', 'max'],
      apiKey: 'credential-sentinel',
    },
    'kimi-code/fast': { displayName: 'Fast' },
  },
});
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let dir = '';
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('keeps only selectable aliases, names and validated effort tokens', () => {
  expect(parseKimiModels(raw)).toEqual([
    {
      id: 'kimi-code/k3',
      label: 'K3',
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
        { id: 'max', label: 'Max' },
      ],
    },
    { id: 'kimi-code/fast', label: 'Fast', efforts: null },
  ]);
  expect(parseKimiModels('{broken credential-sentinel')).toBeNull();
  expect(
    parseKimiModels(
      JSON.stringify({
        models: {
          '-flag': { displayName: 'Bad' },
          safe: { displayName: 'Safe', supportEfforts: ['bad value'] },
        },
      }),
    ),
  ).toBeNull();
});

it('shares refreshes, persists sanitized metadata, and exposes the same launch choices', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kimi-catalog-test-'));
  vi.stubEnv('PARLEY_HOME', dir);
  let now = 0;
  let release!: (value: string) => void;
  const probe = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const changed = vi.fn();
  const catalog = startKimiCatalog(probe, log, changed, { now: () => now, maxAgeMs: 100 });
  const joined = catalog.refresh();
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
  release(raw);
  await Promise.all([catalog.ready, joined]);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(await readFile(kimiModelsFile(), 'utf8')).not.toContain('credential-sentinel');
  const entry = (await loadProviders()).kimi!;
  expect(selectableModels(entry)).toEqual(parseKimiModels(raw));
  expect(supportsEffort(entry)).toBe(true);
  expect(resolveModelEffort(entry, { model: 'kimi-code/k3', effort: 'max' })).toEqual({
    choice: { model: 'kimi-code/k3', effort: 'max' },
  });
  expect(resolveModelEffort(entry, { model: 'kimi-code/fast', effort: 'high' })).toHaveProperty(
    'error',
  );
  expect(resolveModelEffort(entry, { model: 'kimi-code/k3', effort: 'medium' })).toHaveProperty(
    'error',
  );
  catalog.refreshIfStale();
  expect(probe).toHaveBeenCalledTimes(1);
  now = 101;
  probe.mockImplementation(async () => '{broken credential-sentinel');
  catalog.refreshIfStale();
  await catalog.refresh();
  expect(probe).toHaveBeenCalledTimes(2);
  expect(selectableModels((await loadProviders()).kimi!)).toEqual(parseKimiModels(raw));
  expect(
    JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]),
  ).not.toContain('credential-sentinel');
});

it('bounds the real command and tolerates missing, older, failing and hanging CLIs', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kimi-probe-test-'));
  const file = path.join(dir, 'fake.mjs');
  await writeFile(
    file,
    `#!/usr/bin/env node\nif (process.argv.slice(2).join(' ') !== 'provider list --json') process.exit(2);\n${'process.stdout.write(' + JSON.stringify(raw) + ');'}`,
  );
  await chmod(file, 0o755);
  const options = {
    env: { ...process.env, PARLEY_FIXTURE_KIMI_BIN: file },
    killGraceMs: 10,
    timeoutMs: 2000,
  };
  expect(parseKimiModels(await probeKimiModels('fixture-kimi', options))).toEqual(
    parseKimiModels(raw),
  );
  expect(await probeKimiModels('fixture-kimi', { ...options, maxBytes: 10 })).toBeNull();
  await writeFile(file, '#!/usr/bin/env node\nprocess.exit(1);');
  expect(await probeKimiModels('fixture-kimi', options)).toBeNull();
  await writeFile(file, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);');
  expect(await probeKimiModels('fixture-kimi', { ...options, timeoutMs: 30 })).toBeNull();
  expect(await probeKimiModels(path.join(dir, 'missing'), options)).toBeNull();
});

it('refreshes after an active pre-login probe and never logs rejected raw output', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kimi-login-catalog-'));
  vi.stubEnv('PARLEY_HOME', dir);
  let release!: (value: string) => void;
  const probe = vi
    .fn<() => Promise<string>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(raw)
    .mockRejectedValueOnce(new Error('credential-sentinel'));
  const catalog = startKimiCatalog(probe, log, vi.fn());
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
  const afterLogin = catalog.invalidate();
  release('{}');
  await afterLogin;
  expect(probe).toHaveBeenCalledTimes(2);
  expect(selectableModels((await loadProviders()).kimi!)).toEqual(parseKimiModels(raw));
  await catalog.refresh();
  expect(
    JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]),
  ).not.toContain('credential-sentinel');
});

it('discovers the installed binary at its expected path when the host PATH is stale', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kimi-path-catalog-'));
  const bin = path.join(dir, '.kimi-code/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'kimi'), `#!/bin/sh\nprintf '%s' '${raw}'\n`, { mode: 0o755 });
  expect(parseKimiModels(await probeKimiModels('kimi', { env: { PATH: '', HOME: dir } }))).toEqual(
    parseKimiModels(raw),
  );
});

it('provider listing stays responsive during a pending catalog probe and reads its completed result', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kimi-list-catalog-'));
  vi.stubEnv('PARLEY_HOME', dir);
  let release!: (value: string) => void;
  const probe = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const catalog = startKimiCatalog(probe, log, vi.fn());
  const refreshIfStale = vi.spyOn(catalog, 'refreshIfStale');
  const list = createProvidersList(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    catalog,
  );
  const before = await list({}, {} as RequestInfo);
  expect(before.providers.find((entry) => entry.id === 'kimi')?.models).toBeNull();
  expect(before.providers.some((entry) => entry.id === 'codex')).toBe(true);
  expect(refreshIfStale).toHaveBeenCalled();
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
  release(raw);
  await catalog.ready;
  const after = await list({}, {} as RequestInfo);
  expect(after.providers.find((entry) => entry.id === 'kimi')?.models).toEqual(
    parseKimiModels(raw),
  );
});

it('uses the alias for an absent name and clears stale choices on a valid empty catalog', async () => {
  expect(parseKimiModels('{"models":{"alias":{}}}')).toEqual([
    { id: 'alias', label: 'alias', efforts: null },
  ]);
  expect(parseKimiModels('{"models":{}}')).toEqual([]);
  dir = await mkdtemp(path.join(tmpdir(), 'kimi-empty-catalog-'));
  vi.stubEnv('PARLEY_HOME', dir);
  const probe = vi.fn().mockResolvedValueOnce(raw).mockResolvedValueOnce('{"models":{}}');
  const catalog = startKimiCatalog(probe, log, vi.fn());
  await catalog.ready;
  await catalog.invalidate();
  const entry = (await loadProviders()).kimi!;
  expect(selectableModels(entry)).toEqual([]);
  expect(supportsEffort(entry)).toBe(false);
  expect(resolveModelEffort(entry, { model: 'kimi-code/k3' })).toHaveProperty('error');
});
