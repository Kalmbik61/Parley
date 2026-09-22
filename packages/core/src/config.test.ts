/** Чек-лист приёмки TUI v2, пункт 14: дефолты / файл / env и битый JSON. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, configPath, loadConfig, parseSetting, saveConfig } from './config.js';

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
      channelPush: true,
      messageRate: 20,
      threadWidth: 30,
      autoLaunch: true,
      theme: 'mocha',
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
      channelPush: false,
      messageRate: 5,
      threadWidth: 24,
      autoLaunch: false,
    });

    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config).toEqual({
      prefix: 'w',
      sidebarWidth: 18,
      mouseCapture: false,
      ascii: true,
      silenceThresholdMs: 5000,
      channelPush: false,
      messageRate: 5,
      threadWidth: 24,
      autoLaunch: false,
      theme: 'mocha',
    });
    expect(fromFile.warning).toBeNull();

    const fromEnv = await loadConfig(file(), {
      HARNAS_PREFIX: 'a',
      HARNAS_SIDEBAR_WIDTH: '30',
      HARNAS_MOUSE: '1',
      HARNAS_ASCII: '0',
      HARNAS_SILENCE_MS: '60000',
      HARNAS_CHANNEL_PUSH: '1',
      HARNAS_MESSAGE_RATE: '7',
      HARNAS_THREAD_WIDTH: '40',
      HARNAS_AUTO_LAUNCH: '1',
    });
    expect(fromEnv.config).toEqual({
      prefix: 'a',
      sidebarWidth: 30,
      mouseCapture: true,
      ascii: false,
      silenceThresholdMs: 60_000,
      channelPush: true,
      messageRate: 7,
      threadWidth: 40,
      autoLaunch: true,
      theme: 'mocha',
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

  it('тред уже минимума и потолок писем меньше единицы — жалоба и дефолт', async () => {
    await write({ threadWidth: 20, messageRate: 0, channelPush: true });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config.threadWidth).toBe(DEFAULT_CONFIG.threadWidth);
    expect(loaded.config.messageRate).toBe(DEFAULT_CONFIG.messageRate);
    expect(loaded.config.channelPush).toBe(true);
    expect(loaded.warning).toContain('threadWidth');
    expect(loaded.warning).toContain('24');
    expect(loaded.warning).toContain('messageRate');
  });

  it('HARNAS_THREAD_WIDTH уже минимума — жалоба и дефолт, HARNAS_CHANNEL_PUSH=0 гасит push', async () => {
    const loaded = await loadConfig(file(), {
      HARNAS_THREAD_WIDTH: '20',
      HARNAS_CHANNEL_PUSH: '0',
    });

    expect(loaded.config.threadWidth).toBe(DEFAULT_CONFIG.threadWidth);
    expect(loaded.config.channelPush).toBe(false);
    expect(loaded.warning).toContain('HARNAS_THREAD_WIDTH');
  });

  it('HARNAS_ESCAPE_KEY больше не читается', async () => {
    const loaded = await loadConfig(file(), { HARNAS_ESCAPE_KEY: 'w' });

    expect(loaded.config.prefix).toBe('q');
    expect(loaded.warning).toBeNull();
  });

  it('theme: имя читается из файла', async () => {
    await write({ theme: 'nord' });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config.theme).toBe('nord');
    expect(loaded.warning).toBeNull();
  });

  it('theme: HARNAS_THEME перекрывает файл и попадает в fromEnv', async () => {
    await write({ theme: 'nord' });
    const loaded = await loadConfig(file(), { HARNAS_THEME: 'gruvbox' });

    expect(loaded.config.theme).toBe('gruvbox');
    expect(loaded.fromEnv).toContain('theme');
  });

  it('theme: неизвестное имя в файле — дефолт и жалоба, остальные поля целы', async () => {
    await write({ theme: 'неон', prefix: 'w' });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config.theme).toBe(DEFAULT_CONFIG.theme);
    expect(loaded.config.prefix).toBe('w');
    expect(loaded.warning).toContain('theme');
  });

  it('theme: неизвестное имя в HARNAS_THEME — дефолт и жалоба, ключа нет в fromEnv', async () => {
    const loaded = await loadConfig(file(), { HARNAS_THEME: 'неон' });

    expect(loaded.config.theme).toBe(DEFAULT_CONFIG.theme);
    expect(loaded.warning).toContain('HARNAS_THEME');
    expect(loaded.fromEnv).not.toContain('theme');
  });

  it('пустая HARNAS_THEME — то же самое, что незаданная', async () => {
    await write({ theme: 'nord' });

    expect((await loadConfig(file(), { HARNAS_THEME: '' })).config.theme).toBe('nord');
  });

  it('сообщает, какие ключи пришли из окружения', async () => {
    await write({ prefix: 'w' });
    const loaded = await loadConfig(file(), { HARNAS_MOUSE: '0', HARNAS_ASCII: 'мимо' });

    // Битая переменная ключ не перекрывает — и в список не попадает.
    expect(loaded.fromEnv).toEqual(['mouseCapture']);
  });

  it('без окружения список пуст', async () => {
    expect((await loadConfig(file(), {})).fromEnv).toEqual([]);
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

describe('parseSetting', () => {
  it('prefix — один знак', () => {
    expect(parseSetting('prefix', 'w')).toEqual({ value: 'w' });
    expect(parseSetting('prefix', 'ww')).toEqual({ error: 'prefix: ожидается один знак' });
  });

  it('числа — целое больше нуля', () => {
    expect(parseSetting('sidebarWidth', '30')).toEqual({ value: 30 });
    expect(parseSetting('silenceThresholdMs', '0')).toEqual({
      error: 'silenceThresholdMs: ожидается целое больше нуля',
    });
    expect(parseSetting('sidebarWidth', '2.5')).toMatchObject({ error: expect.any(String) });
  });

  it('messageRate и threadWidth — теми же правилами, что и у файла', () => {
    expect(parseSetting('messageRate', '7')).toEqual({ value: 7 });
    expect(parseSetting('threadWidth', '40')).toEqual({ value: 40 });
    expect(parseSetting('threadWidth', '20')).toEqual({
      error: 'threadWidth: ожидается целое не меньше 24',
    });
  });
});

describe('saveConfig', () => {
  it('файла нет — создаёт каталог и файл с одним ключом', async () => {
    const nested = path.join(home, 'глубже', 'config.json');
    await saveConfig({ autoLaunch: false }, nested);

    expect(JSON.parse(await readFile(nested, 'utf8'))).toEqual({ autoLaunch: false });
    expect((await readFile(nested, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('сохраняет чужие ключи и перекрывает свой', async () => {
    await write({ prefix: 'w', comment: 'моё' });
    await saveConfig({ prefix: 'a' }, file());

    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ prefix: 'a', comment: 'моё' });
  });

  it('битый файл перезаписывается целиком', async () => {
    await write('{ не json');
    await saveConfig({ ascii: true }, file());

    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ ascii: true });
  });
});
