import { describe, expect, it } from 'vitest';
import { buildRoleCatalog } from '@parley/core';
import type { CodexContextOptions, CodexRoleContext, SessionRoleCatalogOptions } from '@parley/core';
import { createCachedCatalog } from './role-catalog-cache.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const codexOptions = (cwd: string): CodexContextOptions => ({ cwd, command: 'codex', configArgs: [], env: {} });
const verified: CodexRoleContext = { verified: true, layers: [], diagnostics: [] };
const unverified: CodexRoleContext = { verified: false, layers: [], diagnostics: [{ source: 'codex', code: 'context-unverified' }] };

/** Каталог, который, как настоящий, читает конфигурацию Codex через переданный адаптер. */
const catalogWith = (log: { catalogs: number }) => async (cwd: string, options: SessionRoleCatalogOptions = {}) => {
  log.catalogs++;
  await options.context?.(codexOptions(cwd));
  return buildRoleCatalog();
};

describe('кэш каталога ролей', () => {
  it('одновременные одинаковые запросы делят один сбор каталога', async () => {
    const log = { catalogs: 0 };
    let reads = 0;
    const cached = createCachedCatalog(catalogWith(log), { readContext: async () => { reads++; await wait(20); return verified; } });
    const results = await Promise.all(Array.from({ length: 12 }, () => cached('/p', { codex: true })));
    expect(log.catalogs).toBe(1);
    expect(reads).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it('после окна склейки каталог собирается заново (файлы ролей свежие), а проверенная конфигурация Codex читается один раз', async () => {
    const log = { catalogs: 0 };
    let reads = 0;
    let time = 0;
    const cached = createCachedCatalog(catalogWith(log), { coalesceMs: 1000, contextTtlMs: 30_000, now: () => time, readContext: async () => { reads++; return verified; } });
    await cached('/p', { codex: true });
    time = 999;
    await cached('/p', { codex: true });
    expect(log.catalogs).toBe(1);
    time = 1000;
    await cached('/p', { codex: true });
    expect(log.catalogs).toBe(2);
    expect(reads).toBe(1);
    time = 31_000;
    await cached('/p', { codex: true });
    expect(reads).toBe(2);
    await cached('/other', { codex: true });
    expect(reads).toBe(3);
  });

  it('непроверенная конфигурация Codex не держится дольше своего чтения', async () => {
    const log = { catalogs: 0 };
    let reads = 0;
    let time = 0;
    const cached = createCachedCatalog(catalogWith(log), { coalesceMs: 1000, now: () => time, readContext: async () => { reads++; return unverified; } });
    await Promise.all([cached('/p', { codex: true }), cached('/p', { codex: true })]);
    expect(reads).toBe(1);
    time = 1000;
    await cached('/p', { codex: true });
    expect(reads).toBe(2);
  });

  it('ошибка не кэшируется', async () => {
    let calls = 0;
    const cached = createCachedCatalog(async () => {
      calls++;
      if (calls === 1) throw new Error('codex завис');
      return buildRoleCatalog();
    });
    await expect(cached('/p', { codex: true })).rejects.toThrow('codex завис');
    await cached('/p', { codex: true });
    expect(calls).toBe(2);
  });
});
