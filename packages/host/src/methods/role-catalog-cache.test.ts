import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    const cached = createCachedCatalog(catalogWith(log), { signature: async (cwd) => cwd, readContext: async () => { reads++; await wait(20); return verified; } });
    const results = await Promise.all(Array.from({ length: 12 }, () => cached('/p', { codex: true })));
    expect(log.catalogs).toBe(1);
    expect(reads).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it('после окна склейки каталог собирается заново (файлы ролей свежие), а проверенная конфигурация Codex читается один раз', async () => {
    const log = { catalogs: 0 };
    let reads = 0;
    let time = 0;
    const cached = createCachedCatalog(catalogWith(log), { coalesceMs: 1000, contextTtlMs: 30_000, now: () => time, signature: async (cwd) => cwd, readContext: async () => { reads++; return verified; } });
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

  it('непроверенная конфигурация Codex не читается заново 59 с и читается после 60 с', async () => {
    const log = { catalogs: 0 };
    let reads = 0;
    let time = 0;
    const cached = createCachedCatalog(catalogWith(log), { coalesceMs: 1, now: () => time, signature: async () => 's', readContext: async () => { reads++; return unverified; } });
    await Promise.all([cached('/p', { codex: true }), cached('/p', { codex: true })]);
    expect(reads).toBe(1);
    for (const moment of [30_000, 59_999]) {
      time = moment;
      await cached('/p', { codex: true });
      expect(reads).toBe(1);
    }
    time = 60_001;
    await cached('/p', { codex: true });
    expect(reads).toBe(2);
  });

  it('отказ readContext кэшируется на 60 с', async () => {
    let reads = 0;
    let time = 0;
    const cached = createCachedCatalog(catalogWith({ catalogs: 0 }), { coalesceMs: 1, now: () => time, signature: async () => 's', readContext: async () => { reads++; throw new Error('codex завис'); } });
    await cached('/p', { codex: true });
    for (const moment of [30_000, 59_999]) {
      time = moment;
      await cached('/p', { codex: true });
      expect(reads).toBe(1);
    }
    time = 60_001;
    await cached('/p', { codex: true });
    expect(reads).toBe(2);
  });

  it('12 запросов с разными cwd и одной подписью запускают одно чтение', async () => {
    let reads = 0;
    const cached = createCachedCatalog(catalogWith({ catalogs: 0 }), { signature: async () => 'одна', readContext: async () => { reads++; return verified; } });
    await Promise.all(Array.from({ length: 12 }, (_, index) => cached(`/wt/${index}`, { codex: true })));
    expect(reads).toBe(1);
  });

  it('разные подписи запускают разные чтения, но не одновременно', async () => {
    let running = 0;
    let peak = 0;
    let reads = 0;
    const cached = createCachedCatalog(catalogWith({ catalogs: 0 }), {
      signature: async (cwd) => cwd,
      readContext: async () => {
        reads++;
        running++;
        peak = Math.max(peak, running);
        await wait(15);
        running--;
        return verified;
      },
    });
    await Promise.all(Array.from({ length: 4 }, (_, index) => cached(`/wt/${index}`, { codex: true })));
    expect(reads).toBe(4);
    expect(peak).toBe(1);
  });

  it('отказ одного чтения не останавливает очередь', async () => {
    let reads = 0;
    const cached = createCachedCatalog(catalogWith({ catalogs: 0 }), {
      signature: async (cwd) => cwd,
      readContext: async () => { reads++; if (reads === 1) throw new Error('сбой'); return verified; },
    });
    await Promise.all([cached('/a', { codex: true }), cached('/b', { codex: true })]);
    expect(reads).toBe(2);
  });

  describe('настоящая подпись', () => {
    const dirs: string[] = [];
    afterEach(async () => {
      await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });
    const prepare = async (): Promise<{ root: string; env: NodeJS.ProcessEnv }> => {
      const root = await mkdtemp(path.join(tmpdir(), 'role-sig-'));
      dirs.push(root);
      await mkdir(path.join(root, 'home'), { recursive: true });
      return { root, env: { CODEX_HOME: path.join(root, 'home') } };
    };
    const run = async (env: NodeJS.ProcessEnv, cwds: string[], counter: { reads: number }, catalogOptions: { codex: true }) => {
      const cached = createCachedCatalog(
        async (cwd, options: SessionRoleCatalogOptions = {}) => { await options.context?.({ ...codexOptions(cwd), env }); return buildRoleCatalog(); },
        { readContext: async () => { counter.reads++; return verified; } },
      );
      for (const cwd of cwds) await cached(cwd, catalogOptions);
    };

    it('worktree без своего .codex делят чтение, а с .codex читаются отдельно', async () => {
      const { root, env } = await prepare();
      const plain = [path.join(root, 'a'), path.join(root, 'b')];
      const counter = { reads: 0 };
      await run(env, plain, counter, { codex: true });
      expect(counter.reads).toBe(1);
      await mkdir(path.join(plain[1]!, '.codex'), { recursive: true });
      await writeFile(path.join(plain[1]!, '.codex', 'config.toml'), 'model = "x"\n');
      await run(env, plain, counter, { codex: true });
      expect(counter.reads).toBe(3);
    });

    it('создание .codex/config.toml после кэша меняет ключ', async () => {
      const { root, env } = await prepare();
      const cwd = path.join(root, 'a');
      const counter = { reads: 0 };
      const cached = createCachedCatalog(
        async (dir, options: SessionRoleCatalogOptions = {}) => { await options.context?.({ ...codexOptions(dir), env }); return buildRoleCatalog(); },
        { coalesceMs: 0, readContext: async () => { counter.reads++; return verified; } },
      );
      await cached(cwd, { codex: true });
      await cached(cwd, { codex: true });
      expect(counter.reads).toBe(1);
      await mkdir(path.join(cwd, '.codex'), { recursive: true });
      await writeFile(path.join(cwd, '.codex', 'config.toml'), 'model = "x"\n');
      await cached(cwd, { codex: true });
      expect(counter.reads).toBe(2);
      await writeFile(path.join(cwd, '.codex', 'config.toml'), 'model = "longer value"\n');
      await cached(cwd, { codex: true });
      expect(counter.reads).toBe(3);
    });

    it('правка пользовательского config.toml меняет ключ', async () => {
      const { root, env } = await prepare();
      const counter = { reads: 0 };
      const cached = createCachedCatalog(
        async (dir, options: SessionRoleCatalogOptions = {}) => { await options.context?.({ ...codexOptions(dir), env }); return buildRoleCatalog(); },
        { coalesceMs: 0, readContext: async () => { counter.reads++; return verified; } },
      );
      await cached(path.join(root, 'a'), { codex: true });
      await writeFile(path.join(root, 'home', 'config.toml'), 'model = "x"\n');
      await cached(path.join(root, 'a'), { codex: true });
      expect(counter.reads).toBe(2);
    });
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
