import { describe, expect, it } from 'vitest';
import { buildRoleCatalog } from '@parley/core';
import { createCachedCatalog } from './role-catalog-cache.js';

describe('кэш каталога ролей', () => {
  it('одновременные одинаковые запросы делят один сбор каталога', async () => {
    let calls = 0;
    const cached = createCachedCatalog(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return buildRoleCatalog();
    });
    const results = await Promise.all(Array.from({ length: 12 }, () => cached('/p', { codex: true })));
    expect(calls).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it('повтор в пределах TTL без нового сбора, после TTL — с новым; другой cwd — отдельный', async () => {
    let calls = 0;
    let time = 0;
    const cached = createCachedCatalog(async () => { calls++; return buildRoleCatalog(); }, { ttlMs: 1000, now: () => time });
    await cached('/p', { codex: true });
    time = 999;
    await cached('/p', { codex: true });
    expect(calls).toBe(1);
    await cached('/other', { codex: true });
    expect(calls).toBe(2);
    time = 1000;
    await cached('/p', { codex: true });
    expect(calls).toBe(3);
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
