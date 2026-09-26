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
      resumeRate: 6,
      autoLaunch: true,
      theme: 'mocha',
      fontFamily: 'Menlo',
      fontSize: 13,
      worktreeRoot: '~/harnas/worktrees',
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
      resumeRate: 6,
      autoLaunch: false,
      theme: 'mocha',
      fontFamily: 'Menlo',
      fontSize: 13,
      worktreeRoot: '~/harnas/worktrees',
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
      resumeRate: 6,
      autoLaunch: true,
      theme: 'mocha',
      fontFamily: 'Menlo',
      fontSize: 13,
      worktreeRoot: '~/harnas/worktrees',
    });
    expect(fromEnv.warning).toBeNull();
  });

  it('fontFamily и fontSize: файл перекрывает дефолт, окружение — файл', async () => {
    await write({ fontFamily: 'Fira Code', fontSize: 16 });
    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config.fontFamily).toBe('Fira Code');
    expect(fromFile.config.fontSize).toBe(16);
    expect(fromFile.warning).toBeNull();

    const fromEnv = await loadConfig(file(), { HARNAS_FONT_FAMILY: 'Menlo', HARNAS_FONT_SIZE: '20' });
    expect(fromEnv.config.fontFamily).toBe('Menlo');
    expect(fromEnv.config.fontSize).toBe(20);
    expect(fromEnv.fromEnv).toEqual(expect.arrayContaining(['fontFamily', 'fontSize']));
  });

  it('fontSize: границы 8…32 — инвариант по диапазону, не одно число', async () => {
    await write({ fontSize: 7 });
    const tooSmall = await loadConfig(file(), {});
    expect(tooSmall.config.fontSize).toBe(DEFAULT_CONFIG.fontSize);
    expect(tooSmall.warning).toContain('fontSize');

    await write({ fontSize: 33 });
    const tooLarge = await loadConfig(file(), {});
    expect(tooLarge.config.fontSize).toBe(DEFAULT_CONFIG.fontSize);
    expect(tooLarge.warning).toContain('fontSize');

    await write({ fontSize: 8 });
    expect((await loadConfig(file(), {})).config.fontSize).toBe(8);

    await write({ fontSize: 32 });
    expect((await loadConfig(file(), {})).config.fontSize).toBe(32);

    await write({});
    const badEnv = await loadConfig(file(), { HARNAS_FONT_SIZE: '999' });
    expect(badEnv.config.fontSize).toBe(DEFAULT_CONFIG.fontSize);
    expect(badEnv.warning).toContain('HARNAS_FONT_SIZE');
  });

  it('fontFamily: пустая строка в файле — жалоба и дефолт', async () => {
    await write({ fontFamily: '' });
    const loaded = await loadConfig(file(), {});
    expect(loaded.config.fontFamily).toBe(DEFAULT_CONFIG.fontFamily);
    expect(loaded.warning).toContain('fontFamily');
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

  it('потолок писем меньше единицы — жалоба и дефолт, остальные поля целы', async () => {
    await write({ messageRate: 0, channelPush: true });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config.messageRate).toBe(DEFAULT_CONFIG.messageRate);
    expect(loaded.config.channelPush).toBe(true);
    expect(loaded.warning).toContain('messageRate');
  });

  it('HARNAS_CHANNEL_PUSH=0 гасит push', async () => {
    const loaded = await loadConfig(file(), { HARNAS_CHANNEL_PUSH: '0' });

    expect(loaded.config.channelPush).toBe(false);
    expect(loaded.warning).toBeNull();
  });

  it('устаревший ключ threadWidth в config.json читается без жалобы, saveConfig его сохраняет (кусок 4: док ушёл)', async () => {
    await write({ threadWidth: 20 });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warning).toBeNull();

    await saveConfig({ prefix: 'a' }, file());
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ threadWidth: 20, prefix: 'a' });
  });

  it('устаревшая переменная HARNAS_THREAD_WIDTH не даёт жалобы (кусок 4: док ушёл)', async () => {
    const loaded = await loadConfig(file(), { HARNAS_THREAD_WIDTH: '999' });

    expect(loaded.warning).toBeNull();
    expect(loaded.fromEnv).toEqual([]);
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

  it('messageRate — теми же правилами, что и у файла', () => {
    expect(parseSetting('messageRate', '7')).toEqual({ value: 7 });
  });

  it('resumeRate — целое от 0 до 60 и в файле, и в окружении, и в parseSetting', async () => {
    expect(parseSetting('resumeRate', '0')).toEqual({ value: 0 });
    expect(parseSetting('resumeRate', '60')).toEqual({ value: 60 });
    expect(parseSetting('resumeRate', '-1')).toMatchObject({ error: expect.any(String) });
    expect(parseSetting('resumeRate', '61')).toMatchObject({ error: expect.any(String) });
    expect(parseSetting('resumeRate', '2.5')).toMatchObject({ error: expect.any(String) });

    await write({ resumeRate: 61 });
    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config.resumeRate).toBe(6);
    expect(fromFile.warning).toContain('resumeRate');

    const fromEnv = await loadConfig(file(), { HARNAS_RESUME_RATE: '0' });
    expect(fromEnv.config.resumeRate).toBe(0);
    expect(fromEnv.fromEnv).toContain('resumeRate');
  });

  it('булевы ключи — те же множества да/нет, что у окружения', () => {
    expect(parseSetting('autoLaunch', 'yes')).toEqual({ value: true });
    expect(parseSetting('mouseCapture', '0')).toEqual({ value: false });
    expect(parseSetting('ascii', 'мимо')).toEqual({ error: 'ascii: ожидается 0 или 1' });
  });

  it('theme — только из THEME_NAMES', () => {
    expect(parseSetting('theme', 'nord')).toEqual({ value: 'nord' });
    expect(parseSetting('theme', 'неон')).toMatchObject({ error: expect.any(String) });
  });

  it('fontFamily — непустая строка', () => {
    expect(parseSetting('fontFamily', 'Fira Code')).toEqual({ value: 'Fira Code' });
    expect(parseSetting('fontFamily', '')).toMatchObject({ error: expect.any(String) });
  });

  it('fontSize — целое от 8 до 32', () => {
    expect(parseSetting('fontSize', '16')).toEqual({ value: 16 });
    expect(parseSetting('fontSize', '8')).toEqual({ value: 8 });
    expect(parseSetting('fontSize', '32')).toEqual({ value: 32 });
    expect(parseSetting('fontSize', '7')).toMatchObject({ error: expect.any(String) });
    expect(parseSetting('fontSize', '33')).toMatchObject({ error: expect.any(String) });
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
