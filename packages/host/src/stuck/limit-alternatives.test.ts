import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderLimits, ProviderReadiness } from '@parley/core';
import { limitAlternatives } from './limit-alternatives.js';

let home = '';

/** Запись `custom-providers.json`: второй аккаунт Claude Code. */
const account = (id: string, label: string): Record<string, unknown> => ({
  id,
  label,
  preset: null,
  baseUrl: 'https://api.example.com/anthropic',
  auth: 'bearer',
  models: { opus: 'm-big', sonnet: 'm-mid', haiku: 'm-small', subagent: 'm-mid' },
  contextWindow: null,
  linkClaude: true,
});

const READY: ProviderReadiness = { needs: null, error: null, version: null };
const ready = async (): Promise<ProviderReadiness> => READY;
const noLimits = { get: (): ProviderLimits | null => null };

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-alternatives-'));
  process.env['PARLEY_HOME'] = home;
  await writeFile(path.join(home, 'custom-providers.json'), JSON.stringify({ version: 1, providers: [account('custom-x', 'Claude Code X')] }));
});

afterEach(async () => {
  delete process.env['PARLEY_HOME'];
  await rm(home, { recursive: true, force: true });
});

describe('limitAlternatives — другие вошедшие аккаунты того же CLI (спека подписок 5.8)', () => {
  it('вошедший аккаунт того же семейства — в списке, с лимитами из службы', async () => {
    const five: ProviderLimits = {
      fiveHour: { usedPercent: 12, resetsAt: '2026-10-22T14:00:00.000Z' },
      week: null,
      at: '2026-10-22T10:00:00.000Z',
    };
    const result = await limitAlternatives('claude', {
      limits: { get: (id) => (id === 'custom-x' ? five : null) },
      signedIn: (id) => id === 'custom-x',
      readiness: ready,
    });
    expect(result).toEqual([{ id: 'custom-x', label: 'Claude Code X', limits: five }]);
  });

  it('служба входа ничего не знает (null) — пусто: так на этапе 1', async () => {
    expect(await limitAlternatives('claude', { limits: noLimits, signedIn: () => null, readiness: ready })).toEqual([]);
  });

  it('аккаунт без входа (false) — не в списке', async () => {
    expect(await limitAlternatives('claude', { limits: noLimits, signedIn: () => false, readiness: ready })).toEqual([]);
  });

  it('вошёл, но готовность говорит «нет CLI», «нет ключа» или ошибку — не в списке', async () => {
    for (const readiness of [
      { needs: 'cli', error: null, version: null },
      { needs: 'key', error: null, version: null },
      { needs: null, error: 'incompatible runner', version: null },
    ] as const) {
      const result = await limitAlternatives('claude', {
        limits: noLimits,
        signedIn: () => true,
        readiness: async () => readiness,
      });
      expect(result, JSON.stringify(readiness)).toEqual([]);
    }
  });

  it('готовность по умолчанию — настоящая `providerReadiness`: CLI не найден — пусто', async () => {
    const saved = process.env['PARLEY_CLAUDE_BIN'];
    process.env['PARLEY_CLAUDE_BIN'] = path.join(home, 'no-such-claude');
    try {
      expect(await limitAlternatives('claude', { limits: noLimits, signedIn: () => true })).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env['PARLEY_CLAUDE_BIN'];
      else process.env['PARLEY_CLAUDE_BIN'] = saved;
    }
  });

  it('сам застрявший не попадает в список; остальные того же семейства — да', async () => {
    const result = await limitAlternatives('custom-x', { limits: noLimits, signedIn: () => true, readiness: ready });
    const ids = result.map((item) => item.id);
    expect(ids).not.toContain('custom-x');
    expect(ids).toContain('claude');
    expect(ids).not.toContain('codex');
  });

  it('провайдер без семейства (codex) или неизвестный — пусто', async () => {
    const deps = { limits: noLimits, signedIn: () => true, readiness: ready };
    expect(await limitAlternatives('codex', deps)).toEqual([]);
    expect(await limitAlternatives('нет-такого', deps)).toEqual([]);
  });
});
