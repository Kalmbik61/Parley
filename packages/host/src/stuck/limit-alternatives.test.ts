import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderEntry, ProviderLimits, ProviderReadiness } from '@parley/core';
import { limitAlternatives } from './limit-alternatives.js';

let home = '';

/** Запись `custom-providers.json`: второй аккаунт Claude Code (вход проверяет служба входа). */
const account = (id: string, label: string): Record<string, unknown> => ({ kind: 'claude-account', id, label, link: false });

/** Запись `custom-providers.json`: свой провайдер с адресом и ключом — не аккаунт, входа у него нет. */
const endpoint = (id: string, label: string): Record<string, unknown> => ({
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
const NEEDS_KEY: ProviderReadiness = { needs: 'key', error: null, version: null };

/** Готовность-заглушка (без поиска `claude` в PATH): все готовы, кроме перечисленных — им не хватает ключа. */
const readyExcept =
  (...ids: string[]) =>
  async (entry: ProviderEntry): Promise<ProviderReadiness> =>
    ids.includes(entry.id) ? NEEDS_KEY : READY;
/** У `glm` в тестовом доме нет сохранённого ключа Z.ai, остальные готовы. */
const ready = readyExcept('glm');
const noLimits = { get: (): ProviderLimits | null => null };

async function writeRegistry(...providers: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(path.join(home, 'custom-providers.json'), JSON.stringify({ version: 1, providers }));
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-alternatives-'));
  process.env['PARLEY_HOME'] = home;
  await writeRegistry(account('custom-claude-2', 'Claude Code 2'));
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
      limits: { get: (id) => (id === 'custom-claude-2' ? five : null) },
      signedIn: (id) => id === 'custom-claude-2',
      readiness: ready,
    });
    expect(result).toEqual([{ id: 'custom-claude-2', label: 'Claude Code 2', limits: five }]);
  });

  it('служба входа ничего не знает (null) — аккаунт не в списке', async () => {
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

  it('вошедший аккаунт проходит готовность с signedIn: true — без подмены её его же вход не отказывает (задача 6)', async () => {
    // Настоящая `providerReadiness`: заглушка `claude` печатает версию выше минимума аккаунта.
    const stub = path.join(home, 'claude-stub');
    await writeFile(stub, '#!/bin/sh\necho "2.1.306 (Claude Code)"\n');
    await chmod(stub, 0o755);
    const saved = process.env['PARLEY_CLAUDE_BIN'];
    process.env['PARLEY_CLAUDE_BIN'] = stub;
    try {
      const signedIn = await limitAlternatives('claude', { limits: noLimits, signedIn: (id) => id === 'custom-claude-2' });
      expect(signedIn).toEqual([{ id: 'custom-claude-2', label: 'Claude Code 2', limits: null }]);
      // Служба входа молчит (null) — аккаунт не подтверждён, готовность его не спасает.
      expect(await limitAlternatives('claude', { limits: noLimits, signedIn: () => null })).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env['PARLEY_CLAUDE_BIN'];
      else process.env['PARLEY_CLAUDE_BIN'] = saved;
    }
  });

  it('сам застрявший не попадает в список; остальные того же семейства — да', async () => {
    const result = await limitAlternatives('custom-claude-2', { limits: noLimits, signedIn: () => true, readiness: ready });
    const ids = result.map((item) => item.id);
    expect(ids).not.toContain('custom-claude-2');
    expect(ids).toContain('claude');
    expect(ids).not.toContain('codex');
  });

  it('провайдер без семейства (codex) или неизвестный — пусто', async () => {
    const deps = { limits: noLimits, signedIn: () => true, readiness: ready };
    expect(await limitAlternatives('codex', deps)).toEqual([]);
    expect(await limitAlternatives('нет-такого', deps)).toEqual([]);
  });
});

describe('limitAlternatives — не аккаунты семейства: вошедшим считает чистая готовность (решение 8, спека подписок 5.8)', () => {
  it('застрял аккаунт: глобальный Claude Code в списке, хотя служба входа его не знает (null)', async () => {
    const week: ProviderLimits = {
      fiveHour: null,
      week: { usedPercent: 40, resetsAt: '2026-10-26T07:00:00.000Z' },
      at: '2026-10-22T10:00:00.000Z',
    };
    const result = await limitAlternatives('custom-claude-2', {
      limits: { get: (id) => (id === 'claude' ? week : null) },
      signedIn: () => null,
      readiness: ready,
    });
    expect(result).toEqual([{ id: 'claude', label: 'Claude Code', limits: week }]);
  });

  it('застрял глобальный claude: аккаунт — только по входу службы, `glm` — без ключа не в списке', async () => {
    const deps = { limits: noLimits, readiness: ready };
    expect(await limitAlternatives('claude', { ...deps, signedIn: () => null })).toEqual([]);
    expect(await limitAlternatives('claude', { ...deps, signedIn: () => false })).toEqual([]);
    expect((await limitAlternatives('claude', { ...deps, signedIn: () => true })).map((item) => item.id)).toEqual(['custom-claude-2']);
  });

  it('не аккаунт с чистой готовностью (glm с ключом) — в списке, а вход службы не спрашивают', async () => {
    const asked: string[] = [];
    const result = await limitAlternatives('claude', {
      limits: noLimits,
      signedIn: (id) => {
        asked.push(id);
        return false;
      },
      readiness: readyExcept(),
    });
    expect(result.map((item) => item.id)).toEqual(['glm']);
    expect(asked).toEqual(['custom-claude-2']);
  });

  it('не аккаунт без ключа, без CLI или с ошибкой раннера — не в списке, как бы ни ответил вход', async () => {
    for (const readiness of [
      { needs: 'cli', error: null, version: null },
      { needs: 'key', error: null, version: null },
      { needs: null, error: 'incompatible runner', version: null },
    ] as const) {
      const result = await limitAlternatives('custom-claude-2', {
        limits: noLimits,
        signedIn: () => true,
        readiness: async () => readiness,
      });
      expect(result, JSON.stringify(readiness)).toEqual([]);
    }
  });

  it('свой провайдер с адресом тоже не аккаунт: его готовность решает, вход — нет', async () => {
    await writeRegistry(endpoint('custom-x', 'Claude Code X'));
    const deps = { limits: noLimits, signedIn: () => false };
    expect((await limitAlternatives('claude', { ...deps, readiness: ready })).map((item) => item.id)).toEqual(['custom-x']);
    expect(await limitAlternatives('claude', { ...deps, readiness: readyExcept('glm', 'custom-x') })).toEqual([]);
  });

  it('готовность по умолчанию — настоящая: глобальный claude без CLI в PATH не попадает в список', async () => {
    const saved = process.env['PARLEY_CLAUDE_BIN'];
    process.env['PARLEY_CLAUDE_BIN'] = path.join(home, 'no-such-claude');
    try {
      expect(await limitAlternatives('custom-claude-2', { limits: noLimits, signedIn: () => null })).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env['PARLEY_CLAUDE_BIN'];
      else process.env['PARLEY_CLAUDE_BIN'] = saved;
    }
  });
});
