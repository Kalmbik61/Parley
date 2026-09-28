/** Настройки: дефолты / файл / env, битый JSON и старые ключи ушедшего TUI. */

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
      silenceThresholdMs: 30_000,
      channelPush: true,
      messageRate: 20,
      resumeRate: 6,
      autoLaunch: true,
      fontFamily: "'SF Mono', Menlo, monospace",
      fontSize: 14,
      worktreeRoot: '~/harnas/worktrees',
    });
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warning).toBeNull();
  });

  it('файл перекрывает дефолты, окружение — файл', async () => {
    await write({
      silenceThresholdMs: 5000,
      channelPush: false,
      messageRate: 5,
      autoLaunch: false,
    });

    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config).toEqual({
      silenceThresholdMs: 5000,
      channelPush: false,
      messageRate: 5,
      resumeRate: 6,
      autoLaunch: false,
      fontFamily: "'SF Mono', Menlo, monospace",
      fontSize: 14,
      worktreeRoot: '~/harnas/worktrees',
    });
    expect(fromFile.warning).toBeNull();

    const fromEnv = await loadConfig(file(), {
      HARNAS_SILENCE_MS: '60000',
      HARNAS_CHANNEL_PUSH: '1',
      HARNAS_MESSAGE_RATE: '7',
      HARNAS_AUTO_LAUNCH: '1',
    });
    expect(fromEnv.config).toEqual({
      silenceThresholdMs: 60_000,
      channelPush: true,
      messageRate: 7,
      resumeRate: 6,
      autoLaunch: true,
      fontFamily: "'SF Mono', Menlo, monospace",
      fontSize: 14,
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
    await write({ messageRate: 5 });

    expect((await loadConfig(file(), { HARNAS_MESSAGE_RATE: '' })).config.messageRate).toBe(5);
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
    await write({ silenceThresholdMs: -1, fontSize: 99, autoLaunch: false });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config.silenceThresholdMs).toBe(DEFAULT_CONFIG.silenceThresholdMs);
    expect(loaded.config.fontSize).toBe(DEFAULT_CONFIG.fontSize);
    expect(loaded.config.autoLaunch).toBe(false);
    expect(loaded.warning).toContain('silenceThresholdMs');
    expect(loaded.warning).toContain('fontSize');
  });

  it('битая переменная окружения не отменяет остальные', async () => {
    const loaded = await loadConfig(file(), {
      HARNAS_SILENCE_MS: 'долго',
      HARNAS_AUTO_LAUNCH: 'off',
    });

    expect(loaded.config.silenceThresholdMs).toBe(DEFAULT_CONFIG.silenceThresholdMs);
    expect(loaded.config.autoLaunch).toBe(false);
    expect(loaded.warning).toContain('HARNAS_SILENCE_MS');
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

    await saveConfig({ messageRate: 5 }, file());
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ threadWidth: 20, messageRate: 5 });
  });

  it('устаревшая переменная HARNAS_THREAD_WIDTH не даёт жалобы (кусок 4: док ушёл)', async () => {
    const loaded = await loadConfig(file(), { HARNAS_THREAD_WIDTH: '999' });

    expect(loaded.warning).toBeNull();
    expect(loaded.fromEnv).toEqual([]);
  });

  it('старый config.json с ключами TUI грузится как раньше: без жалобы, остальные поля целы', async () => {
    // Файл, который писал TUI: его ключи окну не нужны, но и ломать запуск они не должны.
    await write({
      prefix: 'w',
      sidebarWidth: 18,
      mouseCapture: false,
      ascii: true,
      theme: 'nord',
      messageRate: 5,
      autoLaunch: false,
    });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config).toEqual({ ...DEFAULT_CONFIG, messageRate: 5, autoLaunch: false });
    expect(loaded.warning).toBeNull();
    expect(loaded.fromEnv).toEqual([]);
  });

  it('старые ключи TUI с битыми значениями тоже не дают жалобы', async () => {
    // Раньше такие значения давали предупреждение; теперь ключи чужие и не проверяются.
    await write({ prefix: 'префикс', sidebarWidth: 0, theme: 'неон', channelPush: false });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config).toEqual({ ...DEFAULT_CONFIG, channelPush: false });
    expect(loaded.warning).toBeNull();
  });

  it('переменные TUI (HARNAS_PREFIX, HARNAS_THEME и др.) больше не читаются и не дают жалобы', async () => {
    const loaded = await loadConfig(file(), {
      HARNAS_PREFIX: 'a',
      HARNAS_SIDEBAR_WIDTH: 'широкий',
      HARNAS_MOUSE: '0',
      HARNAS_ASCII: 'мимо',
      HARNAS_THEME: 'неон',
      HARNAS_ESCAPE_KEY: 'w',
    });

    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warning).toBeNull();
    expect(loaded.fromEnv).toEqual([]);
  });

  it('saveConfig сохраняет старые ключи TUI в файле нетронутыми', async () => {
    await write({ prefix: 'w', theme: 'nord', sidebarWidth: 18 });
    await saveConfig({ autoLaunch: false }, file());

    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      prefix: 'w',
      theme: 'nord',
      sidebarWidth: 18,
      autoLaunch: false,
    });
  });

  it('сообщает, какие ключи пришли из окружения', async () => {
    await write({ messageRate: 5 });
    const loaded = await loadConfig(file(), { HARNAS_AUTO_LAUNCH: '0', HARNAS_CHANNEL_PUSH: 'мимо' });

    // Битая переменная ключ не перекрывает — и в список не попадает.
    expect(loaded.fromEnv).toEqual(['autoLaunch']);
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
  it('числа — целое больше нуля', () => {
    expect(parseSetting('silenceThresholdMs', '30')).toEqual({ value: 30 });
    expect(parseSetting('silenceThresholdMs', '0')).toEqual({
      error: 'silenceThresholdMs: ожидается целое больше нуля',
    });
    expect(parseSetting('silenceThresholdMs', '2.5')).toMatchObject({ error: expect.any(String) });
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
    expect(parseSetting('channelPush', '0')).toEqual({ value: false });
    expect(parseSetting('channelPush', 'мимо')).toEqual({ error: 'channelPush: ожидается 0 или 1' });
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
    await write({ messageRate: 5, comment: 'моё' });
    await saveConfig({ messageRate: 7 }, file());

    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ messageRate: 7, comment: 'моё' });
  });

  it('битый файл перезаписывается целиком', async () => {
    await write('{ не json');
    await saveConfig({ autoLaunch: true }, file());

    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ autoLaunch: true });
  });
});
