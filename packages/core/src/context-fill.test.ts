import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeContextFill,
  codexContextFill,
  contextFile,
  parseContextFill,
  readContextFill,
} from './context-fill.js';

const AT = '2026-10-15T10:00:00.000Z';

describe('claudeContextFill (спека 4.1)', () => {
  it('процент, окно и занятые токены — вход, запись и чтение кэша', () => {
    expect(
      claudeContextFill(
        {
          used_percentage: 82.4,
          context_window_size: 200_000,
          current_usage: { input_tokens: 800, cache_creation_input_tokens: 4_000, cache_read_input_tokens: 160_000, output_tokens: 900 },
        },
        AT,
      ),
    ).toEqual({ usedPercent: 82.4, windowTokens: 200_000, usedTokens: 164_800, at: AT });
  });

  it('без current_usage и размера окна — только процент', () => {
    expect(claudeContextFill({ used_percentage: 8 }, AT)).toEqual({ usedPercent: 8, windowTokens: null, usedTokens: null, at: AT });
  });

  it('нет числового used_percentage — null', () => {
    expect(claudeContextFill({ used_percentage: '8' }, AT)).toBeNull();
    expect(claudeContextFill({ used_percentage: Number.NaN }, AT)).toBeNull();
    expect(claudeContextFill(null, AT)).toBeNull();
    expect(claudeContextFill(undefined, AT)).toBeNull();
  });

  it('процент за пределами 0–100 обрезается', () => {
    expect(claudeContextFill({ used_percentage: 130 }, AT)?.usedPercent).toBe(100);
    expect(claudeContextFill({ used_percentage: -5 }, AT)?.usedPercent).toBe(0);
  });

  it('ровно 0 — нет наблюдения: так строка статуса приходит сразу после /compact (спека 9, п. 4)', () => {
    expect(
      claudeContextFill(
        { used_percentage: 0, current_usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        AT,
      ),
    ).toBeNull();
    expect(claudeContextFill({ used_percentage: 0 }, AT)).toBeNull();
  });
});

describe('codexContextFill (спека 4.2, формула Codex TUI)', () => {
  it('базовые 12 000 токенов не считаются: окно 272 000, занято 142 000 → 50 %', () => {
    expect(codexContextFill({ model_context_window: 272_000, last_token_usage: { total_tokens: 142_000 } }, AT)).toEqual({
      usedPercent: 50,
      windowTokens: 272_000,
      usedTokens: 142_000,
      at: AT,
    });
  });

  it('total_tokens нет — вход + выход', () => {
    expect(
      codexContextFill({ model_context_window: 272_000, last_token_usage: { input_tokens: 130_000, output_tokens: 12_000 } }, AT)?.usedTokens,
    ).toBe(142_000);
  });

  it('меньше базы — 0 %', () => {
    expect(codexContextFill({ model_context_window: 272_000, last_token_usage: { total_tokens: 5_000 } }, AT)?.usedPercent).toBe(0);
  });

  it('нет окна или last_token_usage — null', () => {
    expect(codexContextFill({ last_token_usage: { total_tokens: 1 } }, AT)).toBeNull();
    expect(codexContextFill({ model_context_window: 272_000 }, AT)).toBeNull();
    expect(codexContextFill(null, AT)).toBeNull();
  });
});

describe('parseContextFill / readContextFill', () => {
  let workDir = '';
  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'parley-context-'));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('файл строки статуса читается как есть', async () => {
    const fill = { usedPercent: 41.5, windowTokens: 200_000, usedTokens: 83_000, at: AT };
    await mkdir(path.join(workDir, 'context'));
    await writeFile(contextFile(workDir, 's-01'), `${JSON.stringify(fill)}\n`);
    expect(await readContextFill(workDir, 's-01')).toEqual(fill);
  });

  it('нет файла, битый JSON, не та форма, плохой id — null', async () => {
    expect(await readContextFill(workDir, 's-01')).toBeNull();
    expect(parseContextFill('{')).toBeNull();
    expect(parseContextFill(JSON.stringify({ usedPercent: '1', at: AT }))).toBeNull();
    expect(parseContextFill(JSON.stringify({ usedPercent: 1, at: 'вчера' }))).toBeNull();
    expect(await readContextFill(workDir, '../s-01')).toBeNull();
  });
});
