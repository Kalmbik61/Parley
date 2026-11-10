/**
 * Читатель лимитов Codex с памятью (часть 12, задача 2): стоимость опроса не зависит от числа старых
 * каталогов дня, неизменившиеся файлы не открываются, а самая новая запись всё равно побеждает.
 * Системные вызовы считаются сквозной подменой `node:fs/promises`; всё во временном каталоге.
 */

import { mkdir, mkdtemp, rm, utimes, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ readdir: 0, stat: 0, open: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = ((...args: Parameters<typeof actual.readdir>) => {
    calls.readdir += 1;
    return actual.readdir(...args);
  }) as typeof actual.readdir;
  const stat = ((...args: Parameters<typeof actual.stat>) => {
    calls.stat += 1;
    return actual.stat(...args);
  }) as typeof actual.stat;
  const open = ((...args: Parameters<typeof actual.open>) => {
    calls.open += 1;
    return actual.open(...args);
  }) as typeof actual.open;
  return { ...actual, readdir, stat, open, default: { ...actual, readdir, stat, open } };
});

const { createCodexLimitsReader } = await import('./limits.js');

const NOW_SEC = Date.parse('2026-09-29T12:00:00.000Z') / 1000;
const limitsLine = (used: number, at: string): string =>
  `${JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: NOW_SEC + 3600 } },
    },
  })}\n`;
const AT = '2026-09-29T11:00:00.000Z';

let root = '';
let seq = 0;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-limits-reader-'));
  calls.readdir = 0;
  calls.stat = 0;
  calls.open = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Rollout в каталоге дня `Y-M-D`; mtime — `modified` (секунды от эпохи). */
async function rollout(day: string, used: number | null, modified: number): Promise<string> {
  const dir = path.join(root, ...day.split('-'));
  await mkdir(dir, { recursive: true });
  seq += 1;
  const file = path.join(dir, `rollout-${day}T10-00-00-019a0000-0000-7000-8000-${String(seq).padStart(12, '0')}.jsonl`);
  await writeFile(file, used === null ? '{"type":"session_meta"}\n' : limitsLine(used, AT));
  await utimes(file, modified, modified);
  return file;
}

const count = (): { readdir: number; stat: number; open: number } => ({ ...calls });

describe('createCodexLimitsReader: стоимость опроса', () => {
  async function build(oldDays: number): Promise<{ live: string }> {
    for (let day = 1; day <= oldDays; day += 1) {
      const stamp = String(day).padStart(2, '0');
      for (let n = 0; n < 5; n += 1) await rollout(`2026-08-${stamp}`, 10, 1000 + day);
    }
    for (let n = 0; n < 3; n += 1) await rollout('2026-09-28', 20, 2_000_000 + n);
    for (let n = 0; n < 3; n += 1) await rollout('2026-09-29', 30, 3_000_000 + n);
    const live = await rollout('2026-07-01', 40, 1500);
    return { live };
  }

  it('stat за опрос — по файлам двух новейших дней и живым, не по истории', async () => {
    const stats: number[] = [];
    const readdirs: number[] = [];
    for (const oldDays of [0, 30]) {
      await rm(root, { recursive: true, force: true });
      await mkdir(root, { recursive: true });
      const { live } = await build(oldDays);
      const before = count();
      await createCodexLimitsReader(root).read([live]);
      stats.push(calls.stat - before.stat);
      readdirs.push(calls.readdir - before.readdir);
    }
    expect(stats).toEqual([7, 7]);
    expect(readdirs[0]).toBe(readdirs[1]);
  });

  it('повторный опрос без изменений не открывает файлов; дописанный самый свежий читается один раз', async () => {
    const files = [await rollout('2026-09-29', 30, 3_000_000), await rollout('2026-09-29', 31, 3_000_001)];
    const reader = createCodexLimitsReader(root);
    expect((await reader.read())?.fiveHour?.usedPercent).toBe(31);
    const opened = calls.open;
    expect((await reader.read())?.fiveHour?.usedPercent).toBe(31);
    expect(calls.open - opened).toBe(0);

    await appendFile(files[1] as string, limitsLine(55, '2026-09-29T11:30:00.000Z'));
    expect((await reader.read())?.fiveHour?.usedPercent).toBe(55);
    expect(calls.open - opened).toBe(1);
  });
});

describe('createCodexLimitsReader: самая новая запись побеждает', () => {
  it('живой файл в старом каталоге, самый свежий по mtime, — его лимиты', async () => {
    await rollout('2026-09-29', 20, 1000);
    await rollout('2026-09-28', 21, 900);
    await rollout('2026-09-27', 22, 800);
    const old = await rollout('2026-09-01', 77, 5000);
    expect((await createCodexLimitsReader(root).read([old]))?.fiveHour?.usedPercent).toBe(77);
  });

  it('тот же файл не живой при трёх новых днях — не виден', async () => {
    await rollout('2026-09-29', 20, 1000);
    await rollout('2026-09-28', 21, 900);
    await rollout('2026-09-01', 77, 5000);
    expect((await createCodexLimitsReader(root).read([]))?.fiveHour?.usedPercent).toBe(20);
  });

  it('сессия, начатая после первого опроса, и смена суток: новый каталог дня виден со следующего опроса', async () => {
    await rollout('2026-09-28', 10, 1000);
    const reader = createCodexLimitsReader(root);
    expect((await reader.read())?.fiveHour?.usedPercent).toBe(10);
    await rollout('2026-09-29', 66, 2000);
    expect((await reader.read())?.fiveHour?.usedPercent).toBe(66);
  });

  it('исчезнувший файл забывается и не возвращает старые числа', async () => {
    const newest = await rollout('2026-09-29', 66, 2000);
    await rollout('2026-09-29', 12, 1000);
    const reader = createCodexLimitsReader(root);
    expect((await reader.read())?.fiveHour?.usedPercent).toBe(66);
    await rm(newest);
    expect((await reader.read())?.fiveHour?.usedPercent).toBe(12);
  });

  it('файл без лимитов у самого свежего: берётся следующий, а потом его дописанные лимиты побеждают', async () => {
    const fresh = await rollout('2026-09-29', null, 2000);
    await rollout('2026-09-29', 12, 1000);
    const reader = createCodexLimitsReader(root);
    expect((await reader.read())?.fiveHour?.usedPercent).toBe(12);
    await appendFile(fresh, limitsLine(88, '2026-09-29T11:40:00.000Z'));
    expect((await reader.read())?.fiveHour?.usedPercent).toBe(88);
  });
});
