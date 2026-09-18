/** Чек-лист приёмки TUI v2, пункт 14: дефолты / файл / env и битый JSON. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, configPath, loadConfig } from './config.js';

let home = '';
const file = (): string => path.join(home, 'config.json');

const write = (value: unknown): Promise<void> =>
  writeFile(file(), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-config-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('файла нет — дефолты без предупреждения', async () => {
    const loaded = await loadConfig(file(), {});

    expect(loaded.config).toEqual({
      prefix: 'q',
      sidebarWidth: 26,
      mouseCapture: true,
      ascii: false,
      silenceThresholdMs: 30_000,
      autoLaunch: true,
    });
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warning).toBeNull();
  });

  it('файл перекрывает дефолты, окружение — файл', async () => {
    await write({
      prefix: 'w',
      sidebarWidth: 18,
      mouseCapture: false,
      ascii: true,
      silenceThresholdMs: 5000,
      autoLaunch: false,
    });

    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config).toEqual({
      prefix: 'w',
      sidebarWidth: 18,
      mouseCapture: false,
      ascii: true,
      silenceThresholdMs: 5000,
      autoLaunch: false,
    });
    expect(fromFile.warning).toBeNull();

    const fromEnv = await loadConfig(file(), {
      HARNAS_PREFIX: 'a',
      HARNAS_SIDEBAR_WIDTH: '30',
      HARNAS_MOUSE: '1',
      HARNAS_ASCII: '0',
      HARNAS_SILENCE_MS: '60000',
      HARNAS_AUTO_LAUNCH: '1',
    });
    expect(fromEnv.config).toEqual({
      prefix: 'a',
      sidebarWidth: 30,
      mouseCapture: true,
      ascii: false,
      silenceThresholdMs: 60_000,
      autoLaunch: true,
    });
    expect(fromEnv.warning).toBeNull();
  });

  it('пустая переменная — то же, что незаданная', async () => {
    await write({ prefix: 'w' });

    expect((await loadConfig(file(), { HARNAS_PREFIX: '' })).config.prefix).toBe('w');
  });

  it('битый JSON — дефолты и предупреждение', async () => {
    await write('{ сломано');
    const loaded = await loadConfig(file(), {});

    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warning).toContain('не парсится');
  });

  it('не объект — тоже дефолты и предупреждение', async () => {
    await write([1, 2, 3]);
    const loaded = await loadConfig(file(), {});

    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warning).toContain('не парсится');
  });

  it('битое поле остаётся дефолтным, остальные читаются', async () => {
    await write({ prefix: 'префикс', sidebarWidth: 0, ascii: true });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config.prefix).toBe(DEFAULT_CONFIG.prefix);
    expect(loaded.config.sidebarWidth).toBe(DEFAULT_CONFIG.sidebarWidth);
    expect(loaded.config.ascii).toBe(true);
    expect(loaded.warning).toContain('prefix');
    expect(loaded.warning).toContain('sidebarWidth');
  });

  it('битая переменная окружения не отменяет остальные', async () => {
    const loaded = await loadConfig(file(), {
      HARNAS_SIDEBAR_WIDTH: 'широкий',
      HARNAS_MOUSE: 'off',
    });

    expect(loaded.config.sidebarWidth).toBe(DEFAULT_CONFIG.sidebarWidth);
    expect(loaded.config.mouseCapture).toBe(false);
    expect(loaded.warning).toContain('HARNAS_SIDEBAR_WIDTH');
  });

  it('HARNAS_ESCAPE_KEY больше не читается', async () => {
    const loaded = await loadConfig(file(), { HARNAS_ESCAPE_KEY: 'w' });

    expect(loaded.config.prefix).toBe('q');
    expect(loaded.warning).toBeNull();
  });

  it('путь по умолчанию — config.json в HARNAS_HOME', () => {
    const saved = process.env.HARNAS_HOME;
    process.env.HARNAS_HOME = home;
    try {
      expect(configPath()).toBe(file());
    } finally {
      if (saved === undefined) delete process.env.HARNAS_HOME;
      else process.env.HARNAS_HOME = saved;
    }
  });
});
