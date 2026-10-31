/** Настройки: дефолты / файл / env, битый JSON и старые ключи ушедшего TUI. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_WRITE_APPROVALS_VALUES,
  DEFAULT_CONFIG,
  ENV_NAMES,
  codexHooksWanted,
  configPath,
  loadConfig,
  parseSetting,
  saveConfig,
} from './config.js';
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
      sleepAfterMinutes: 0,
      sleepUnderPressureMinutes: 5,
      machineConcurrent: 'off',
      agentSkills: true,
      skillNavigator: true,
      codexWriteApprovals: 'auto',
      telegramEnabled: true,
      telegramNeedsYou: true,
      telegramFinished: false,
      telegramMail: true,
      telegramCards: true,
      leanAgents: true,
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
    });

    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config).toEqual({
      silenceThresholdMs: 5000,
      channelPush: false,
      messageRate: 5,
      resumeRate: 6,
      sleepAfterMinutes: 0,
      sleepUnderPressureMinutes: 5,
      machineConcurrent: 'off',
      agentSkills: true,
      skillNavigator: true,
      codexWriteApprovals: 'auto',
      telegramEnabled: true,
      telegramNeedsYou: true,
      telegramFinished: false,
      telegramMail: true,
      telegramCards: true,
      leanAgents: true,
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
    });
    expect(fromEnv.config).toEqual({
      silenceThresholdMs: 60_000,
      channelPush: true,
      messageRate: 7,
      resumeRate: 6,
      sleepAfterMinutes: 0,
      sleepUnderPressureMinutes: 5,
      machineConcurrent: 'off',
      agentSkills: true,
      skillNavigator: true,
      codexWriteApprovals: 'auto',
      telegramEnabled: true,
      telegramNeedsYou: true,
      telegramFinished: false,
      telegramMail: true,
      telegramCards: true,
      leanAgents: true,
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
    await write({ silenceThresholdMs: -1, fontSize: 99, agentSkills: false });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config.silenceThresholdMs).toBe(DEFAULT_CONFIG.silenceThresholdMs);
    expect(loaded.config.fontSize).toBe(DEFAULT_CONFIG.fontSize);
    expect(loaded.config.agentSkills).toBe(false);
    expect(loaded.warning).toBe(
      'silenceThresholdMs: expected a positive integer; fontSize: expected an integer from 8 to 32',
    );
  });

  it('битая переменная окружения не отменяет остальные', async () => {
    const loaded = await loadConfig(file(), {
      PARLEY_SILENCE_MS: 'долго',
      PARLEY_AGENT_SKILLS: 'off',
    });

    expect(loaded.config.silenceThresholdMs).toBe(DEFAULT_CONFIG.silenceThresholdMs);
    expect(loaded.config.agentSkills).toBe(false);
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
    });
    const loaded = await loadConfig(file(), {});

    expect(loaded.config).toEqual({ ...DEFAULT_CONFIG, messageRate: 5 });
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
    await saveConfig({ agentSkills: false }, file());

    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      prefix: 'w',
      theme: 'nord',
      sidebarWidth: 18,
      agentSkills: false,
    });
  });

  it('сообщает, какие ключи пришли из окружения', async () => {
    await write({ messageRate: 5 });
    const loaded = await loadConfig(file(), { PARLEY_AGENT_SKILLS: '0', PARLEY_CHANNEL_PUSH: 'мимо' });

    // Битая переменная ключ не перекрывает — и в список не попадает.
    expect(loaded.fromEnv).toEqual(['agentSkills']);
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
    ['sleepAfterMinutes', 'SLEEP_AFTER_MINUTES', '30', 30],
    ['sleepUnderPressureMinutes', 'SLEEP_UNDER_PRESSURE_MINUTES', '10', 10],
    ['machineConcurrent', 'MACHINE_CONCURRENT', 'auto', 'auto'],
    ['agentSkills', 'AGENT_SKILLS', 'off', false],
    ['agentSkills', 'AGENT_SKILLS', 'no', false],
    ['skillNavigator', 'SKILL_NAVIGATOR', 'off', false],
    ['codexWriteApprovals', 'CODEX_WRITE_APPROVALS', 'parley', 'parley'],
    ['telegramEnabled', 'TELEGRAM_ENABLED', 'off', false],
    ['telegramNeedsYou', 'TELEGRAM_NEEDS_YOU', 'off', false],
    ['telegramFinished', 'TELEGRAM_FINISHED', 'on', true],
    ['telegramMail', 'TELEGRAM_MAIL', 'off', false],
    ['telegramCards', 'TELEGRAM_CARDS', 'off', false],
    ['leanAgents', 'LEAN_AGENTS', 'off', false],
    ['fontFamily', 'FONT_FAMILY', 'Menlo', 'Menlo'],
    ['fontSize', 'FONT_SIZE', '18', 18],
    ['worktreeRoot', 'WORKTREE_ROOT', '/tmp/wt', '/tmp/wt'],
    ['workConcurrent', 'WORK_CONCURRENT', '12', 12],
    ['roomConcurrent', 'ROOM_CONCURRENT', '4', 4],
    ['workNewSessions', 'WORK_NEW_SESSIONS', '0', 0],
    ['roomNewSessions', 'ROOM_NEW_SESSIONS', '5', 5],
    ['workLaunches', 'WORK_LAUNCHES', '50', 50],
    ['roomLaunches', 'ROOM_LAUNCHES', '25', 25],
    ['workMessages', 'WORK_MESSAGES', '300', 300],
    ['roomMessages', 'ROOM_MESSAGES', '150', 150],
    ['fanout', 'FANOUT', '500', 500],
    ['swarmSessions', 'SWARM_SESSIONS', '10', 10],
    ['swarmConcurrent', 'SWARM_CONCURRENT', '4', 4],
    ['workSwarmSessions', 'WORK_SWARM_SESSIONS', '0', 0],
    ['workSwarms', 'WORK_SWARMS', '2', 2],
    ['swarmMinutes', 'SWARM_MINUTES', '0', 0],
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
    await write({ messageRate: 5, agentSkills: false });
    const loaded = await loadConfig(file(), {});
    expect(loaded.warning).toBeNull();
    expect(loaded.config.workConcurrent).toBe(DEFAULT_CONFIG.workConcurrent);
    expect(loaded.config.fanout).toBe(DEFAULT_CONFIG.fanout);
  });

  it('значение вне границ ключа — предупреждение, порог остаётся умолчанием; ноль нужен только новым сессиям', async () => {
    await write({ workConcurrent: 0, workNewSessions: 0, fanout: 2.5 });
    const loaded = await loadConfig(file(), {});
    expect(loaded.config.workConcurrent).toBe(DEFAULT_CONFIG.workConcurrent);
    expect(loaded.config.fanout).toBe(DEFAULT_CONFIG.fanout);
    expect(loaded.config.workNewSessions).toBe(0);
    expect(loaded.warning).toContain('workConcurrent: expected an integer from 1 to 64');
  });

  it('parseSetting: теми же границами, что у файла и окружения; пустая строка — не ноль', () => {
    expect(parseSetting('roomConcurrent', '3')).toEqual({ value: 3 });
    expect(parseSetting('workNewSessions', '0')).toEqual({ value: 0 });
    expect(parseSetting('workConcurrent', '0')).toEqual({ error: 'workConcurrent: expected an integer from 1 to 64' });
    expect(parseSetting('fanout', '')).toMatchObject({ error: expect.any(String) });
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

  it('parseSetting resumeRate: пустая строка и пробелы — ошибка, а не 0 (Number("") === 0)', () => {
    for (const blank of ['', '  ']) {
      expect(parseSetting('resumeRate', blank)).toEqual({
        error: 'resumeRate: expected an integer from 0 to 60',
      });
    }
  });

  it('PARLEY_RESUME_RATE из пробелов — жалоба, значение по умолчанию, ключ не заперт', async () => {
    // Number('  ') === 0: без проверки такая переменная молча заперла бы будильник на «выключен».
    const loaded = await loadConfig(file(), { PARLEY_RESUME_RATE: '  ' });
    expect(loaded.config.resumeRate).toBe(6);
    expect(loaded.warning).toBe('PARLEY_RESUME_RATE: expected an integer from 0 to 60');
    expect(loaded.fromEnv).toEqual([]);

    // Значение из файла пробелы тоже не сбрасывают в ноль.
    await write({ resumeRate: 3 });
    const withFile = await loadConfig(file(), { PARLEY_RESUME_RATE: '  ' });
    expect(withFile.config.resumeRate).toBe(3);
    expect(withFile.warning).toBe('PARLEY_RESUME_RATE: expected an integer from 0 to 60');
  });

  it('agentSkills — булев ключ: да/нет теми же словами', () => {
    expect(parseSetting('agentSkills', 'false')).toEqual({ value: false });
    expect(parseSetting('agentSkills', '1')).toEqual({ value: true });
    expect(parseSetting('agentSkills', 'мимо')).toEqual({ error: 'agentSkills: expected 0 or 1' });
  });

  it('булевы ключи — те же множества да/нет, что у окружения', () => {
    expect(parseSetting('agentSkills', 'yes')).toEqual({ value: true });
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
    await saveConfig({ agentSkills: false }, nested);

    expect(JSON.parse(await readFile(nested, 'utf8'))).toEqual({ agentSkills: false });
    expect((await readFile(nested, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('сохраняет чужие ключи и перекрывает свой', async () => {
    await write({ messageRate: 5, comment: 'моё' });
    await saveConfig({ messageRate: 7 }, file());

    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ messageRate: 7, comment: 'моё' });
  });

  it('битый файл перезаписывается целиком', async () => {
    await write('{ не json');
    await saveConfig({ agentSkills: true }, file());

    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({ agentSkills: true });
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

describe('leanAgents setting', () => {
  it('включён по умолчанию; выключается файлом, окружение сильнее файла', async () => {
    expect(DEFAULT_CONFIG.leanAgents).toBe(true);
    expect((await loadConfig(file(), {})).config.leanAgents).toBe(true);
    await write({ leanAgents: false });
    expect((await loadConfig(file(), {})).config.leanAgents).toBe(false);
    expect((await loadConfig(file(), { PARLEY_LEAN_AGENTS: '1' })).config.leanAgents).toBe(true);
    await write({});
    expect((await loadConfig(file(), { PARLEY_LEAN_AGENTS: '0' })).config.leanAgents).toBe(false);
  });
  it("settings.set: parseSetting разбирает 'true' и 'false' как agentSkills, мусор отвергает", () => {
    expect(parseSetting('leanAgents', 'true')).toEqual({ value: true });
    expect(parseSetting('leanAgents', 'false')).toEqual({ value: false });
    expect(parseSetting('leanAgents', 'FALSE')).toEqual({ value: false });
    expect(parseSetting('leanAgents', 'perhaps')).toEqual({ error: 'leanAgents: expected 0 or 1' });
  });
  it('неверное значение в файле — предупреждение с именем настройки, остаётся умолчание', async () => {
    await write({ leanAgents: 'invalid' });
    const value = await loadConfig(file(), {});
    expect(value.config.leanAgents).toBe(true);
    expect(value.warning).toContain('leanAgents');
  });
});

describe('sleepAfterMinutes setting', () => {
  it('по умолчанию 0 — сон выключен; файл и окружение задают порог, окружение запирает ключ', async () => {
    expect(DEFAULT_CONFIG.sleepAfterMinutes).toBe(0);
    expect((await loadConfig(file(), {})).config.sleepAfterMinutes).toBe(0);

    // Путь `settings.set` хоста: parseSetting → saveConfig → loadConfig.
    expect(parseSetting('sleepAfterMinutes', '60')).toEqual({ value: 60 });
    await saveConfig({ sleepAfterMinutes: 60 }, file());
    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config.sleepAfterMinutes).toBe(60);
    expect(fromFile.warning).toBeNull();
    expect(fromFile.fromEnv).toEqual([]);

    const fromEnv = await loadConfig(file(), { PARLEY_SLEEP_AFTER_MINUTES: '30' });
    expect(fromEnv.config.sleepAfterMinutes).toBe(30);
    // Ключ пришёл из окружения: файл его не перекроет, хост покажет замок с именем переменной.
    expect(fromEnv.fromEnv).toEqual(['sleepAfterMinutes']);
    expect(fromEnv.warning).toBeNull();
  });

  it('parseSetting: целое от 0 до 1440, ноль — своей веткой, остальное — ошибка с границами', () => {
    expect(parseSetting('sleepAfterMinutes', '0')).toEqual({ value: 0 });
    expect(parseSetting('sleepAfterMinutes', '1440')).toEqual({ value: 1440 });
    for (const bad of ['1441', '-1', 'abc', '2.5']) {
      expect(parseSetting('sleepAfterMinutes', bad)).toEqual({
        error: 'sleepAfterMinutes: expected an integer from 0 to 1440',
      });
    }
  });

  it('parseSetting: пустая строка и пробелы — ошибка, а не молчаливый ноль (Number("") === 0)', () => {
    for (const blank of ['', '  ']) {
      expect(parseSetting('sleepAfterMinutes', blank)).toEqual({
        error: 'sleepAfterMinutes: expected an integer from 0 to 1440',
      });
    }
  });

  it('пробелы вместо числа в окружении — жалоба с именем, значение без переменной, ключ не заперт', async () => {
    // Number('  ') === 0: без проверки такая переменная молча заперла бы сон на «выключен».
    const noFile = await loadConfig(file(), { PARLEY_SLEEP_AFTER_MINUTES: '  ' });
    expect(noFile.config.sleepAfterMinutes).toBe(0);
    expect(noFile.warning).toBe('PARLEY_SLEEP_AFTER_MINUTES: expected an integer from 0 to 1440');
    expect(noFile.fromEnv).toEqual([]);

    // Порог из файла переменная с пробелами не сбрасывает в ноль.
    await write({ sleepAfterMinutes: 60 });
    const withFile = await loadConfig(file(), { HARNAS_SLEEP_AFTER_MINUTES: '  ' });
    expect(withFile.config.sleepAfterMinutes).toBe(60);
    expect(withFile.warning).toBe('HARNAS_SLEEP_AFTER_MINUTES: expected an integer from 0 to 1440');
    expect(withFile.fromEnv).toEqual([]);
  });

  it('переменная нулевой длины — то же, что незаданная, как у всех настроек (envValue): без жалобы и замка', async () => {
    await write({ sleepAfterMinutes: 60 });
    const empty = await loadConfig(file(), { PARLEY_SLEEP_AFTER_MINUTES: '' });
    expect(empty.config.sleepAfterMinutes).toBe(60);
    expect(empty.warning).toBeNull();
    expect(empty.fromEnv).toEqual([]);
  });

  it('вне границ в файле и в окружении — жалоба с именем и умолчание 0; ключ в окружении не запирается', async () => {
    await write({ sleepAfterMinutes: 1441 });
    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config.sleepAfterMinutes).toBe(0);
    expect(fromFile.warning).toBe('sleepAfterMinutes: expected an integer from 0 to 1440');

    await write({});
    const fromEnv = await loadConfig(file(), { PARLEY_SLEEP_AFTER_MINUTES: 'abc' });
    expect(fromEnv.config.sleepAfterMinutes).toBe(0);
    expect(fromEnv.warning).toBe('PARLEY_SLEEP_AFTER_MINUTES: expected an integer from 0 to 1440');
    expect(fromEnv.fromEnv).toEqual([]);
  });

  it('ноль разрешён и в файле, и в окружении: окружение выключает сон поверх файла', async () => {
    await write({ sleepAfterMinutes: 0 });
    const zeroFile = await loadConfig(file(), {});
    expect(zeroFile.config.sleepAfterMinutes).toBe(0);
    expect(zeroFile.warning).toBeNull();

    await write({ sleepAfterMinutes: 60 });
    const zeroEnv = await loadConfig(file(), { PARLEY_SLEEP_AFTER_MINUTES: '0' });
    expect(zeroEnv.config.sleepAfterMinutes).toBe(0);
    expect(zeroEnv.fromEnv).toEqual(['sleepAfterMinutes']);
    expect(zeroEnv.warning).toBeNull();
  });
});

describe('sleepUnderPressureMinutes setting', () => {
  const EXPECTED = 'expected an integer from 1 to 60';

  it('по умолчанию 5; файл и окружение задают порог, окружение запирает ключ', async () => {
    expect(DEFAULT_CONFIG.sleepUnderPressureMinutes).toBe(5);
    expect((await loadConfig(file(), {})).config.sleepUnderPressureMinutes).toBe(5);

    // Путь `settings.set` хоста: parseSetting → saveConfig → loadConfig.
    expect(parseSetting('sleepUnderPressureMinutes', '20')).toEqual({ value: 20 });
    await saveConfig({ sleepUnderPressureMinutes: 20 }, file());
    const fromFile = await loadConfig(file(), {});
    expect(fromFile.config.sleepUnderPressureMinutes).toBe(20);
    expect(fromFile.warning).toBeNull();
    expect(fromFile.fromEnv).toEqual([]);

    const fromEnv = await loadConfig(file(), { PARLEY_SLEEP_UNDER_PRESSURE_MINUTES: '15' });
    expect(fromEnv.config.sleepUnderPressureMinutes).toBe(15);
    // Ключ пришёл из окружения: файл его не перекроет, хост покажет замок с именем переменной.
    expect(fromEnv.fromEnv).toEqual(['sleepUnderPressureMinutes']);
    expect(fromEnv.warning).toBeNull();
  });

  it('parseSetting: целое от 1 до 60; ноль, пустая строка и всё вне границ — ошибка с границами', () => {
    expect(parseSetting('sleepUnderPressureMinutes', '1')).toEqual({ value: 1 });
    expect(parseSetting('sleepUnderPressureMinutes', '60')).toEqual({ value: 60 });
    // Ноль здесь не «выключено»: сон выключает один ключ, `sleepAfterMinutes`. Пустая строка — не ноль (Number('') === 0).
    for (const bad of ['0', '61', '-1', 'abc', '2.5', '', '  ']) {
      expect(parseSetting('sleepUnderPressureMinutes', bad), JSON.stringify(bad)).toEqual({
        error: `sleepUnderPressureMinutes: ${EXPECTED}`,
      });
    }
  });

  it('вне границ в файле и в окружении — жалоба с именем и умолчание 5; ключ в окружении не запирается', async () => {
    for (const bad of [0, 61]) {
      await write({ sleepUnderPressureMinutes: bad });
      const fromFile = await loadConfig(file(), {});
      expect(fromFile.config.sleepUnderPressureMinutes, String(bad)).toBe(5);
      expect(fromFile.warning, String(bad)).toBe(`sleepUnderPressureMinutes: ${EXPECTED}`);
    }

    await write({});
    // Пробелы вместо числа — не ноль и не «выключено»: Number('  ') === 0 вне границ.
    for (const bad of ['0', 'abc', '  ']) {
      const fromEnv = await loadConfig(file(), { PARLEY_SLEEP_UNDER_PRESSURE_MINUTES: bad });
      expect(fromEnv.config.sleepUnderPressureMinutes, JSON.stringify(bad)).toBe(5);
      expect(fromEnv.warning, JSON.stringify(bad)).toBe(`PARLEY_SLEEP_UNDER_PRESSURE_MINUTES: ${EXPECTED}`);
      expect(fromEnv.fromEnv, JSON.stringify(bad)).toEqual([]);
    }
  });
});

describe('machineConcurrent setting', () => {
  const EXPECTED = 'expected "off", "auto" or an integer from 1 to 128';

  it('по умолчанию off — потолок, очередь и допуск выключены', async () => {
    expect(DEFAULT_CONFIG.machineConcurrent).toBe('off');
    const loaded = await loadConfig(file(), {});
    expect(loaded.config.machineConcurrent).toBe('off');
    expect(loaded.warning).toBeNull();
  });

  it('из файла: auto, off и целое от 1 до 128', async () => {
    for (const value of ['auto', 'off', 1, 12, 128]) {
      await write({ machineConcurrent: value });
      const loaded = await loadConfig(file(), {});
      expect(loaded.config.machineConcurrent, String(value)).toBe(value);
      expect(loaded.warning, String(value)).toBeNull();
      expect(loaded.fromEnv, String(value)).toEqual([]);
    }
  });

  it('из файла: регистр и пробелы разбираются как у parseSetting, значение хранится строчным', async () => {
    for (const [raw, stored] of [[' AUTO ', 'auto'], ['Off', 'off'], [' 12 ', 12]] as const) {
      await write({ machineConcurrent: raw });
      const loaded = await loadConfig(file(), {});
      expect(loaded.config.machineConcurrent, raw).toBe(stored);
      expect(loaded.warning, raw).toBeNull();
    }
  });

  it('вне границ или не того вида в файле — жалоба с именем и умолчание off', async () => {
    for (const bad of [0, 129, 1.5, -3, 'max', '', '  ', true, null, [8], { n: 8 }]) {
      await write({ machineConcurrent: bad });
      const loaded = await loadConfig(file(), {});
      expect(loaded.config.machineConcurrent, JSON.stringify(bad)).toBe('off');
      expect(loaded.warning, JSON.stringify(bad)).toBe(`machineConcurrent: ${EXPECTED}`);
    }
  });

  it('parseSetting: off и auto без учёта регистра и пробелов, целое 1–128, остальное — ошибка с границами', () => {
    expect(parseSetting('machineConcurrent', ' AUTO ')).toEqual({ value: 'auto' });
    expect(parseSetting('machineConcurrent', 'Off')).toEqual({ value: 'off' });
    expect(parseSetting('machineConcurrent', '1')).toEqual({ value: 1 });
    expect(parseSetting('machineConcurrent', '64')).toEqual({ value: 64 });
    expect(parseSetting('machineConcurrent', '128')).toEqual({ value: 128 });
    // Пустая строка и пробелы — ошибка, а не молчаливый «выключено» или ноль (Number('') === 0).
    for (const bad of ['', '  ', '0', '129', '-1', '1.5', 'max', 'on', 'true']) {
      expect(parseSetting('machineConcurrent', bad), JSON.stringify(bad)).toEqual({
        error: `machineConcurrent: ${EXPECTED}`,
      });
    }
  });

  it('путь settings.set: parseSetting → saveConfig → loadConfig, число и слово переживают файл', async () => {
    for (const text of ['auto', '24']) {
      const parsed = parseSetting('machineConcurrent', text);
      if ('error' in parsed) throw new Error(parsed.error);
      await saveConfig({ machineConcurrent: parsed.value }, file());
      const loaded = await loadConfig(file(), {});
      expect(loaded.config.machineConcurrent, text).toBe(parsed.value);
      expect(loaded.warning, text).toBeNull();
    }
  });

  it('PARLEY_MACHINE_CONCURRENT: auto, off и число; ключ попадает в fromEnv и перекрывает файл', async () => {
    await write({ machineConcurrent: 12 });
    for (const [raw, parsed] of [['auto', 'auto'], [' OFF ', 'off'], ['32', 32]] as const) {
      const loaded = await loadConfig(file(), { PARLEY_MACHINE_CONCURRENT: raw });
      expect(loaded.config.machineConcurrent, raw).toBe(parsed);
      expect(loaded.fromEnv, raw).toEqual(['machineConcurrent']);
      expect(loaded.warning, raw).toBeNull();
    }
  });

  it('битое значение в окружении — жалоба с именем переменной, файл не перекрыт, ключ не заперт', async () => {
    await write({ machineConcurrent: 12 });
    for (const bad of ['max', '0', '129', '  ']) {
      const loaded = await loadConfig(file(), { HARNAS_MACHINE_CONCURRENT: bad });
      expect(loaded.config.machineConcurrent, JSON.stringify(bad)).toBe(12);
      expect(loaded.warning, JSON.stringify(bad)).toBe(`HARNAS_MACHINE_CONCURRENT: ${EXPECTED}`);
      expect(loaded.fromEnv, JSON.stringify(bad)).toEqual([]);
    }
  });
});

describe('codexWriteApprovals setting', () => {
  /** Временный `config.json` с данными файла и `loadConfig(file, env)` — как в соседних тестах. */
  const loadFrom = async (fileData: unknown, env: NodeJS.ProcessEnv = {}) => {
    await write(fileData);
    return loadConfig(file(), env);
  };

  it('codexWriteApprovals: умолчание auto, значения из файла и среды', async () => {
    expect(DEFAULT_CONFIG.codexWriteApprovals).toBe('auto');
    expect((await loadFrom({})).config.codexWriteApprovals).toBe('auto');
    expect((await loadFrom({ codexWriteApprovals: 'parley' })).config.codexWriteApprovals).toBe('parley');
    expect((await loadFrom({}, { PARLEY_CODEX_WRITE_APPROVALS: 'terminal' })).config.codexWriteApprovals).toBe(
      'terminal',
    );
    // Окружение сильнее файла.
    expect(
      (await loadFrom({ codexWriteApprovals: 'parley' }, { PARLEY_CODEX_WRITE_APPROVALS: 'terminal' })).config
        .codexWriteApprovals,
    ).toBe('terminal');
    expect(CODEX_WRITE_APPROVALS_VALUES).toEqual(['auto', 'parley', 'terminal']);
  });

  it('неверное значение: предупреждение с именем настройки, остаётся умолчание', async () => {
    const fromFile = await loadFrom({ codexWriteApprovals: 'yes' });
    expect(fromFile.config.codexWriteApprovals).toBe('auto');
    expect(fromFile.warning).toMatch(/codexWriteApprovals: expected auto, parley or terminal/);

    const fromEnv = await loadFrom({}, { PARLEY_CODEX_WRITE_APPROVALS: 'yes' });
    expect(fromEnv.config.codexWriteApprovals).toBe('auto');
    expect(fromEnv.warning).toMatch(/PARLEY_CODEX_WRITE_APPROVALS: expected auto, parley or terminal/);
    expect(fromEnv.fromEnv).toEqual([]);
  });

  it('codexApprovals переносится: true → parley, false → terminal, новый ключ сильнее', async () => {
    const migrated = await loadFrom({ codexApprovals: true });
    expect(migrated.config.codexWriteApprovals).toBe('parley');
    expect(migrated.warning).toBeNull();
    expect((await loadFrom({ codexApprovals: false })).config.codexWriteApprovals).toBe('terminal');
    expect((await loadFrom({ codexApprovals: true, codexWriteApprovals: 'auto' })).config.codexWriteApprovals).toBe(
      'auto',
    );
    // Прежний ключ не попадает в настройки: читатель видит только новый.
    expect(migrated.config).not.toHaveProperty('codexApprovals');
  });

  it('PARLEY_CODEX_APPROVALS переносится так же; PARLEY_CODEX_WRITE_APPROVALS сильнее', async () => {
    const on = await loadFrom({}, { PARLEY_CODEX_APPROVALS: '1' });
    expect(on.config.codexWriteApprovals).toBe('parley');
    expect(on.fromEnv).toEqual(['codexWriteApprovals']);
    expect((await loadFrom({}, { PARLEY_CODEX_APPROVALS: '0' })).config.codexWriteApprovals).toBe('terminal');
    expect((await loadFrom({}, { HARNAS_CODEX_APPROVALS: 'on' })).config.codexWriteApprovals).toBe('parley');
    expect(
      (await loadFrom({}, { PARLEY_CODEX_APPROVALS: '1', PARLEY_CODEX_WRITE_APPROVALS: 'auto' })).config
        .codexWriteApprovals,
    ).toBe('auto');
    // Переменная перекрывает и новый ключ файла.
    expect((await loadFrom({ codexWriteApprovals: 'auto' }, { PARLEY_CODEX_APPROVALS: '1' })).config.codexWriteApprovals).toBe(
      'parley',
    );
    const bad = await loadFrom({}, { PARLEY_CODEX_APPROVALS: 'maybe' });
    expect(bad.config.codexWriteApprovals).toBe('auto');
    expect(bad.warning).toContain('PARLEY_CODEX_APPROVALS: expected 0 or 1');
  });

  it('codexHooksWanted: только parley', () => {
    expect(codexHooksWanted({ codexWriteApprovals: 'parley' })).toBe(true);
    expect(codexHooksWanted({ codexWriteApprovals: 'auto' })).toBe(false);
    expect(codexHooksWanted({ codexWriteApprovals: 'terminal' })).toBe(false);
  });

  it('parseSetting codexWriteApprovals', () => {
    expect(parseSetting('codexWriteApprovals', 'parley')).toEqual({ value: 'parley' });
    expect(parseSetting('codexWriteApprovals', 'auto')).toEqual({ value: 'auto' });
    expect(parseSetting('codexWriteApprovals', 'terminal')).toEqual({ value: 'terminal' });
    expect(parseSetting('codexWriteApprovals', 'on')).toEqual({
      error: 'codexWriteApprovals: expected auto, parley or terminal',
    });
  });
});

describe('removed Parley spawn settings', () => {
  it('ignores saved and environment autoLaunch/spawnDepth without warnings', async () => {
    await write({ autoLaunch: false, spawnDepth: 8 });
    const loaded = await loadConfig(file(), { PARLEY_AUTO_LAUNCH: '1', PARLEY_SPAWN_DEPTH: '2' });
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.config).not.toHaveProperty('autoLaunch');
    expect(loaded.config).not.toHaveProperty('spawnDepth');
    expect(loaded.warning).toBeNull();
    expect(loaded.fromEnv).toEqual([]);
  });
});

describe('настройки Telegram', () => {
  it('умолчания пяти ключей', () => {
    expect(DEFAULT_CONFIG.telegramEnabled).toBe(true);
    expect(DEFAULT_CONFIG.telegramNeedsYou).toBe(true);
    expect(DEFAULT_CONFIG.telegramFinished).toBe(false);
    expect(DEFAULT_CONFIG.telegramMail).toBe(true);
    expect(DEFAULT_CONFIG.telegramCards).toBe(true);
  });
  it('PARLEY_TELEGRAM_FINISHED=1 включает ключ и запирает его окружением', async () => {
    const loaded = await loadConfig(file(), { PARLEY_TELEGRAM_FINISHED: '1' });
    expect(loaded.config.telegramFinished).toBe(true);
    expect(loaded.fromEnv).toContain('telegramFinished');
  });
  it('parseSetting: булев ключ и ошибка на мусоре', () => {
    expect(parseSetting('telegramEnabled', 'false')).toEqual({ value: false });
    expect(parseSetting('telegramEnabled', 'maybe')).toEqual({ error: 'telegramEnabled: expected 0 or 1' });
  });
});
