/** Настройки: дефолты / файл / env, битый JSON и старые ключи ушедшего TUI. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, ENV_NAMES, configPath, loadConfig, parseSetting, saveConfig } from './config.js';
import { DEFAULT_WORKTREE_ROOT } from './names.js';
import { DEFAULT_RESOURCE_LIMITS } from './work/resource-policy.js';

let home = '';
const file = (): string => path.join(home, 'config.json');

const write = (value: unknown): Promise<void> =>
  writeFile(file(), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-config-'));
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
      agentSkills: true,
      skillNavigator: true,
      fontFamily: "'SF Mono', Menlo, monospace",
      fontSize: 14,
      worktreeRoot: '~/parley/worktrees',
      ...DEFAULT_RESOURCE_LIMITS,
    });
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warning).toBeNull();
  });

  it('корень worktree по умолчанию — ~/parley/worktrees, а заданный человеком (и прежний ~/harnas/worktrees) остаётся как есть (R6, R9)', async () => {
    expect((await loadConfig(file(), {})).config.worktreeRoot).toBe(DEFAULT_WORKTREE_ROOT);
    expect(DEFAULT_CONFIG.worktreeRoot).toBe('~/parley/worktrees');

    await write({ worktreeRoot: '~/harnas/worktrees' });
    const pinned = await loadConfig(file(), {});
    expect(pinned.config.worktreeRoot).toBe('~/harnas/worktrees');
    expect(pinned.warning).toBeNull();
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
      agentSkills: true,
      skillNavigator: true,
      fontFamily: "'SF Mono', Menlo, monospace",
      fontSize: 14,
      worktreeRoot: '~/parley/worktrees',
      ...DEFAULT_RESOURCE_LIMITS,
    });
    expect(fromFile.warning).toBeNull();

    const fromEnv = await loadConfig(file(), {
      PARLEY_SILENCE_MS: '60000',
      PARLEY_CHANNEL_PUSH: '1',
      PARLEY_MESSAGE_RATE: '7',
      PARLEY_AUTO_LAUNCH: '1',
    });
    expect(fromEnv.config).toEqual({
      silenceThresholdMs: 60_000,
      channelPush: true,
      messageRate: 7,
      resumeRate: 6,
      autoLaunch: true,
      agentSkills: true,
      skillNavigator: true,
      fontFamily: "'SF Mono', Menlo, monospace",
      fontSize: 14,
      worktreeRoot: '~/parley/worktrees',
      ...DEFAULT_RESOURCE_LIMITS,
    });
    expect(fromEnv.warning).toBeNull();
  });

  it('agentSkills: по умолчанию включён, файл его выключает, окружение перекрывает файл', async () => {
    expect((await loadConfig(file(), {})).config.agentSkills).toBe(true);

    await write({ agentSkills: false });
    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config.agentSkills).toBe(false);
    expect(fromFile.warning).toBeNull();

    const fromEnv = await loadConfig(file(), { PARLEY_AGENT_SKILLS: '1' });
    expect(fromEnv.config.agentSkills).toBe(true);
    expect(fromEnv.fromEnv).toEqual(['agentSkills']);
    expect((await loadConfig(file(), { PARLEY_AGENT_SKILLS: 'off' })).config.agentSkills).toBe(false);
  });

  it('agentSkills: не булево в файле и мусор в окружении — жалоба и дефолт', async () => {
    await write({ agentSkills: 'нет' });
    const badFile = await loadConfig(file(), {});
    expect(badFile.config.agentSkills).toBe(true);
    expect(badFile.warning).toContain('agentSkills');

    await write({});
    const badEnv = await loadConfig(file(), { PARLEY_AGENT_SKILLS: 'может' });
    expect(badEnv.config.agentSkills).toBe(true);
    expect(badEnv.warning).toContain('PARLEY_AGENT_SKILLS');
    expect(badEnv.fromEnv).toEqual([]);
  });

  it('fontFamily и fontSize: файл перекрывает дефолт, окружение — файл', async () => {
    await write({ fontFamily: 'Fira Code', fontSize: 16 });
    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config.fontFamily).toBe('Fira Code');
    expect(fromFile.config.fontSize).toBe(16);
    expect(fromFile.warning).toBeNull();

    const fromEnv = await loadConfig(file(), { PARLEY_FONT_FAMILY: 'Menlo', PARLEY_FONT_SIZE: '20' });
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
    const badEnv = await loadConfig(file(), { PARLEY_FONT_SIZE: '999' });
    expect(badEnv.config.fontSize).toBe(DEFAULT_CONFIG.fontSize);
    expect(badEnv.warning).toContain('PARLEY_FONT_SIZE');
  });

  it('fontFamily: пустая строка в файле — жалоба и дефолт', async () => {
    await write({ fontFamily: '' });
    const loaded = await loadConfig(file(), {});
    expect(loaded.config.fontFamily).toBe(DEFAULT_CONFIG.fontFamily);
    expect(loaded.warning).toContain('fontFamily');
  });

  it('пустая переменная — то же, что незаданная', async () => {
    await write({ messageRate: 5 });

    expect((await loadConfig(file(), { PARLEY_MESSAGE_RATE: '' })).config.messageRate).toBe(5);
  });

  it('битый JSON — дефолты и предупреждение', async () => {
    await write('{ сломано');
    const loaded = await loadConfig(file(), {});

    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warning).toContain(`${file()} cannot be parsed: `);
  });

  it('не объект — тоже дефолты и предупреждение', async () => {
    await write([1, 2, 3]);
    const loaded = await loadConfig(file(), {});

    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warning).toBe(`${file()} cannot be parsed: expected an object`);
  });

  it('файл не читается (на его месте каталог) — дефолты и предупреждение', async () => {
    await mkdir(file());
    const loaded = await loadConfig(file(), {});

    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.warning).toContain(`${file()} cannot be read: `);
  });

  it('битое поле остаётся дефолтным, остальные читаются', async () => {
    await write({ silenceThresholdMs: -1, fontSize: 99, autoLaunch: false });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config.silenceThresholdMs).toBe(DEFAULT_CONFIG.silenceThresholdMs);
    expect(loaded.config.fontSize).toBe(DEFAULT_CONFIG.fontSize);
    expect(loaded.config.autoLaunch).toBe(false);
    expect(loaded.warning).toBe(
      'silenceThresholdMs: expected a positive integer; fontSize: expected an integer from 8 to 32',
    );
  });

  it('битая переменная окружения не отменяет остальные', async () => {
    const loaded = await loadConfig(file(), {
      PARLEY_SILENCE_MS: 'долго',
      PARLEY_AUTO_LAUNCH: 'off',
    });

    expect(loaded.config.silenceThresholdMs).toBe(DEFAULT_CONFIG.silenceThresholdMs);
    expect(loaded.config.autoLaunch).toBe(false);
    expect(loaded.warning).toBe('PARLEY_SILENCE_MS: expected a positive integer');
  });

  it('потолок писем меньше единицы — жалоба и дефолт, остальные поля целы', async () => {
    await write({ messageRate: 0, channelPush: true });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config.messageRate).toBe(DEFAULT_CONFIG.messageRate);
    expect(loaded.config.channelPush).toBe(true);
    expect(loaded.warning).toContain('messageRate');
  });

  it('PARLEY_CHANNEL_PUSH=0 гасит push', async () => {
    const loaded = await loadConfig(file(), { PARLEY_CHANNEL_PUSH: '0' });

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

  it('устаревшая переменная PARLEY_THREAD_WIDTH не даёт жалобы (кусок 4: док ушёл)', async () => {
    const loaded = await loadConfig(file(), { PARLEY_THREAD_WIDTH: '999' });

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

  it('переменные TUI (PARLEY_PREFIX, PARLEY_THEME и др.) больше не читаются и не дают жалобы', async () => {
    const loaded = await loadConfig(file(), {
      PARLEY_PREFIX: 'a',
      PARLEY_SIDEBAR_WIDTH: 'широкий',
      PARLEY_MOUSE: '0',
      PARLEY_ASCII: 'мимо',
      PARLEY_THEME: 'неон',
      PARLEY_ESCAPE_KEY: 'w',
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
    const loaded = await loadConfig(file(), { PARLEY_AUTO_LAUNCH: '0', PARLEY_CHANNEL_PUSH: 'мимо' });

    // Битая переменная ключ не перекрывает — и в список не попадает.
    expect(loaded.fromEnv).toEqual(['autoLaunch']);
  });

  it('без окружения список пуст', async () => {
    expect((await loadConfig(file(), {})).fromEnv).toEqual([]);
  });

  it('путь по умолчанию — config.json в PARLEY_HOME', () => {
    const saved = process.env.PARLEY_HOME;
    process.env.PARLEY_HOME = home;
    try {
      expect(configPath()).toBe(file());
    } finally {
      if (saved === undefined) delete process.env.PARLEY_HOME;
      else process.env.PARLEY_HOME = saved;
    }
  });
});

describe('переменные окружения: PARLEY_* и прежние HARNAS_* (R3)', () => {
  /** Для каждой настройки: ключ без префикса, значение из окружения и что из него выйдет. */
  const SETTINGS = [
    ['silenceThresholdMs', 'SILENCE_MS', '1234', 1234],
    ['channelPush', 'CHANNEL_PUSH', '0', false],
    ['messageRate', 'MESSAGE_RATE', '9', 9],
    ['resumeRate', 'RESUME_RATE', '3', 3],
    ['autoLaunch', 'AUTO_LAUNCH', 'off', false],
    ['agentSkills', 'AGENT_SKILLS', 'no', false],
    ['skillNavigator', 'SKILL_NAVIGATOR', 'off', false],
    ['fontFamily', 'FONT_FAMILY', 'Menlo', 'Menlo'],
    ['fontSize', 'FONT_SIZE', '18', 18],
    ['worktreeRoot', 'WORKTREE_ROOT', '/tmp/wt', '/tmp/wt'],
    ['workConcurrent', 'WORK_CONCURRENT', '12', 12],
    ['roomConcurrent', 'ROOM_CONCURRENT', '4', 4],
    ['workNewSessions', 'WORK_NEW_SESSIONS', '0', 0],
    ['roomNewSessions', 'ROOM_NEW_SESSIONS', '5', 5],
    ['spawnDepth', 'SPAWN_DEPTH', '2', 2],
    ['workLaunches', 'WORK_LAUNCHES', '50', 50],
    ['roomLaunches', 'ROOM_LAUNCHES', '25', 25],
    ['workMessages', 'WORK_MESSAGES', '300', 300],
    ['roomMessages', 'ROOM_MESSAGES', '150', 150],
    ['fanout', 'FANOUT', '500', 500],
  ] as const;

  it('ключи таблицы ENV_NAMES — соответствуют всем настройкам', () => {
    expect(Object.fromEntries(SETTINGS.map(([key, name]) => [key, name]))).toEqual(ENV_NAMES);
  });

  it.each(SETTINGS)('%s: берётся из PARLEY_%s', async (key, name, raw, parsed) => {
    const loaded = await loadConfig(file(), { [`PARLEY_${name}`]: raw });
    expect(loaded.config[key]).toBe(parsed);
    expect(loaded.fromEnv).toEqual([key]);
    expect(loaded.warning).toBeNull();
  });

  it.each(SETTINGS)('%s: прежняя HARNAS_%s читается как запасная', async (key, name, raw, parsed) => {
    const loaded = await loadConfig(file(), { [`HARNAS_${name}`]: raw });
    expect(loaded.config[key]).toBe(parsed);
    expect(loaded.fromEnv).toEqual([key]);
    expect(loaded.warning).toBeNull();
  });

  it('оба имени: главнее PARLEY_*', async () => {
    const loaded = await loadConfig(file(), { PARLEY_MESSAGE_RATE: '5', HARNAS_MESSAGE_RATE: '50' });
    expect(loaded.config.messageRate).toBe(5);
  });

  it('пустая PARLEY_* не перекрывает прежнюю: пустая — то же, что незаданная', async () => {
    const loaded = await loadConfig(file(), { PARLEY_MESSAGE_RATE: '', HARNAS_MESSAGE_RATE: '50' });
    expect(loaded.config.messageRate).toBe(50);
    expect(loaded.fromEnv).toEqual(['messageRate']);
  });

  it('файл не перекрывает переменную ни под одним из имён', async () => {
    await write({ messageRate: 3, fontSize: 12 });
    const loaded = await loadConfig(file(), { HARNAS_MESSAGE_RATE: '40', PARLEY_FONT_SIZE: '16' });
    expect(loaded.config.messageRate).toBe(40);
    expect(loaded.config.fontSize).toBe(16);
    expect([...loaded.fromEnv].sort()).toEqual(['fontSize', 'messageRate']);
  });

  it('жалоба на неверное значение называет ту переменную, которая задана', async () => {
    const fresh = await loadConfig(file(), { PARLEY_FONT_SIZE: '999' });
    expect(fresh.warning).toContain('PARLEY_FONT_SIZE');
    expect(fresh.warning).not.toContain('HARNAS_');

    const legacy = await loadConfig(file(), { HARNAS_FONT_SIZE: '999' });
    expect(legacy.warning).toContain('HARNAS_FONT_SIZE');
    expect(legacy.warning).not.toContain('PARLEY_');
    expect(legacy.fromEnv).toEqual([]);
  });

  it('дом по умолчанию: config.json лежит в HARNAS_HOME, пока PARLEY_HOME не задан', () => {
    const saved = { parley: process.env.PARLEY_HOME, harnas: process.env.HARNAS_HOME };
    delete process.env.PARLEY_HOME;
    process.env.HARNAS_HOME = home;
    try {
      expect(configPath()).toBe(file());
    } finally {
      if (saved.parley === undefined) delete process.env.PARLEY_HOME;
      else process.env.PARLEY_HOME = saved.parley;
      if (saved.harnas === undefined) delete process.env.HARNAS_HOME;
      else process.env.HARNAS_HOME = saved.harnas;
    }
  });
});

describe('пороги бюджета (P37)', () => {
  it('по умолчанию комната уже работы, а у каждого порога есть видимое число', () => {
    expect(DEFAULT_CONFIG.roomConcurrent).toBeLessThan(DEFAULT_CONFIG.workConcurrent);
    expect(DEFAULT_CONFIG.roomNewSessions).toBeLessThan(DEFAULT_CONFIG.workNewSessions);
    expect(DEFAULT_CONFIG.roomLaunches).toBeLessThan(DEFAULT_CONFIG.workLaunches);
    expect(DEFAULT_CONFIG.roomMessages).toBeLessThan(DEFAULT_CONFIG.workMessages);
  });

  it('старый файл без порогов читается с умолчаниями и без предупреждения', async () => {
    await write({ messageRate: 5, autoLaunch: false });
    const loaded = await loadConfig(file(), {});
    expect(loaded.warning).toBeNull();
    expect(loaded.config.workConcurrent).toBe(DEFAULT_CONFIG.workConcurrent);
    expect(loaded.config.fanout).toBe(DEFAULT_CONFIG.fanout);
  });

  it('значение вне границ ключа — предупреждение, порог остаётся умолчанием; ноль нужен только новым сессиям', async () => {
    await write({ workConcurrent: 0, workNewSessions: 0, spawnDepth: 99, fanout: 2.5 });
    const loaded = await loadConfig(file(), {});
    expect(loaded.config.workConcurrent).toBe(DEFAULT_CONFIG.workConcurrent);
    expect(loaded.config.spawnDepth).toBe(DEFAULT_CONFIG.spawnDepth);
    expect(loaded.config.fanout).toBe(DEFAULT_CONFIG.fanout);
    expect(loaded.config.workNewSessions).toBe(0);
    expect(loaded.warning).toContain('workConcurrent: expected an integer from 1 to 64');
    expect(loaded.warning).toContain('spawnDepth: expected an integer from 1 to 8');
  });

  it('parseSetting: теми же границами, что у файла и окружения; пустая строка — не ноль', () => {
    expect(parseSetting('roomConcurrent', '3')).toEqual({ value: 3 });
    expect(parseSetting('workNewSessions', '0')).toEqual({ value: 0 });
    expect(parseSetting('workConcurrent', '0')).toEqual({ error: 'workConcurrent: expected an integer from 1 to 64' });
    expect(parseSetting('fanout', '')).toMatchObject({ error: expect.any(String) });
    expect(parseSetting('spawnDepth', '9')).toMatchObject({ error: expect.any(String) });
  });

  it('человек меняет порог явно: saveConfig пишет ключ, остальные и чужие ключи остаются', async () => {
    await write({ messageRate: 5, theme: 'nord' });
    await saveConfig({ workConcurrent: 14 }, file());
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ messageRate: 5, theme: 'nord', workConcurrent: 14 });
    expect((await loadConfig(file(), {})).config.workConcurrent).toBe(14);
  });
});

describe('parseSetting', () => {
  it('числа — целое больше нуля', () => {
    expect(parseSetting('silenceThresholdMs', '30')).toEqual({ value: 30 });
    expect(parseSetting('silenceThresholdMs', '0')).toEqual({
      error: 'silenceThresholdMs: expected a positive integer',
    });
    expect(parseSetting('silenceThresholdMs', '2.5')).toMatchObject({ error: expect.any(String) });
  });

  it('messageRate — теми же правилами, что и у файла', () => {
    expect(parseSetting('messageRate', '7')).toEqual({ value: 7 });
  });

  it('resumeRate — целое от 0 до 60 и в файле, и в окружении, и в parseSetting', async () => {
    expect(parseSetting('resumeRate', '0')).toEqual({ value: 0 });
    expect(parseSetting('resumeRate', '60')).toEqual({ value: 60 });
    expect(parseSetting('resumeRate', '-1')).toEqual({
      error: 'resumeRate: expected an integer from 0 to 60',
    });
    expect(parseSetting('resumeRate', '61')).toMatchObject({ error: expect.any(String) });
    expect(parseSetting('resumeRate', '2.5')).toMatchObject({ error: expect.any(String) });

    await write({ resumeRate: 61 });
    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config.resumeRate).toBe(6);
    expect(fromFile.warning).toContain('resumeRate');

    const fromEnv = await loadConfig(file(), { PARLEY_RESUME_RATE: '0' });
    expect(fromEnv.config.resumeRate).toBe(0);
    expect(fromEnv.fromEnv).toContain('resumeRate');
  });

  it('agentSkills — булев ключ: да/нет теми же словами', () => {
    expect(parseSetting('agentSkills', 'false')).toEqual({ value: false });
    expect(parseSetting('agentSkills', '1')).toEqual({ value: true });
    expect(parseSetting('agentSkills', 'мимо')).toEqual({ error: 'agentSkills: expected 0 or 1' });
  });

  it('булевы ключи — те же множества да/нет, что у окружения', () => {
    expect(parseSetting('autoLaunch', 'yes')).toEqual({ value: true });
    expect(parseSetting('channelPush', '0')).toEqual({ value: false });
    expect(parseSetting('channelPush', 'мимо')).toEqual({ error: 'channelPush: expected 0 or 1' });
  });

  it('fontFamily — непустая строка', () => {
    expect(parseSetting('fontFamily', 'Fira Code')).toEqual({ value: 'Fira Code' });
    expect(parseSetting('fontFamily', '')).toEqual({
      error: 'fontFamily: expected a non-empty string',
    });
    expect(parseSetting('worktreeRoot', '')).toEqual({
      error: 'worktreeRoot: expected a non-empty string',
    });
  });

  it('fontSize — целое от 8 до 32', () => {
    expect(parseSetting('fontSize', '16')).toEqual({ value: 16 });
    expect(parseSetting('fontSize', '8')).toEqual({ value: 8 });
    expect(parseSetting('fontSize', '32')).toEqual({ value: 32 });
    expect(parseSetting('fontSize', '7')).toEqual({
      error: 'fontSize: expected an integer from 8 to 32',
    });
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

describe('skillNavigator setting', () => {
  it('включён по умолчанию с 2026-10-06 и выключается файлом, окружением (PARLEY_, HARNAS_) — независимо от agentSkills', async () => {
    expect(DEFAULT_CONFIG.skillNavigator).toBe(true);
    expect((await loadConfig(file(), {})).config.skillNavigator).toBe(true);
    await write({ agentSkills: false, skillNavigator: false });
    expect((await loadConfig(file(), {})).config).toMatchObject({ agentSkills: false, skillNavigator: false });
    // Окружение сильнее файла в обе стороны.
    expect((await loadConfig(file(), { PARLEY_SKILL_NAVIGATOR: '1' })).config.skillNavigator).toBe(true);
    expect((await loadConfig(file(), { HARNAS_SKILL_NAVIGATOR: 'true' })).config.skillNavigator).toBe(true);
    await write({ agentSkills: true });
    for (const off of ['false', '0', 'no', 'off', 'OFF']) {
      expect((await loadConfig(file(), { PARLEY_SKILL_NAVIGATOR: off })).config.skillNavigator).toBe(false);
      expect((await loadConfig(file(), { HARNAS_SKILL_NAVIGATOR: off })).config.skillNavigator).toBe(false);
    }
    expect(parseSetting('skillNavigator', 'true')).toEqual({ value: true });
    expect(parseSetting('skillNavigator', 'false')).toEqual({ value: false });
  });
  it('invalid input reports a safe setting error and keeps the default', async () => {
    await write({ skillNavigator: 'invalid' });
    const value = await loadConfig(file(), {});
    expect(value.config.skillNavigator).toBe(true); expect(value.warning).toContain('skillNavigator');
  });
});
