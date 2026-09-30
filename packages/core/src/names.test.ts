import { describe, expect, it } from 'vitest';
import {
  BRANCH_PREFIX,
  DEFAULT_WORKTREE_ROOT,
  ENV_PREFIX,
  HOME_DIR,
  LEGACY_ENV_PREFIX,
  LEGACY_HOME_DIR,
  LEGACY_SKILL_NAME,
  LEGACY_STATE_DIR,
  MCP_SERVER_NAME,
  PRODUCT,
  SKILL_NAME,
  STATE_DIR,
  STATE_DIRS,
  bothEnv,
  envName,
  envRaw,
  envValue,
} from './names.js';

describe('names.ts — таблица R1 дословно', () => {
  it('константы', () => {
    expect(PRODUCT).toBe('Parley');
    expect([HOME_DIR, LEGACY_HOME_DIR]).toEqual(['.parley', '.harnas']);
    expect([STATE_DIR, LEGACY_STATE_DIR]).toEqual(['.parley', '.harnas']);
    expect(STATE_DIRS).toEqual(['.parley', '.harnas']);
    expect([ENV_PREFIX, LEGACY_ENV_PREFIX]).toEqual(['PARLEY_', 'HARNAS_']);
    expect(MCP_SERVER_NAME).toBe('parley');
    expect([SKILL_NAME, LEGACY_SKILL_NAME]).toEqual(['parley', 'harnas']);
    expect(BRANCH_PREFIX).toBe('parley/');
    expect(DEFAULT_WORKTREE_ROOT).toBe('~/parley/worktrees');
  });
});

describe('envValue', () => {
  it('новое имя главнее прежнего', () => {
    expect(envValue({ PARLEY_HOME: '/new', HARNAS_HOME: '/old' }, 'HOME')).toBe('/new');
  });

  it('нет нового — читается прежнее', () => {
    expect(envValue({ HARNAS_HOME: '/old' }, 'HOME')).toBe('/old');
  });

  it('ни одного — undefined', () => {
    expect(envValue({}, 'HOME')).toBeUndefined();
    expect(envValue({ PARLEY_OTHER: 'x', HOME: '/h' }, 'HOME')).toBeUndefined();
  });

  it('пустая строка — то же, что не задано: она не перекрывает запасное имя', () => {
    expect(envValue({ PARLEY_HOME: '', HARNAS_HOME: '/old' }, 'HOME')).toBe('/old');
    expect(envValue({ PARLEY_HOME: '', HARNAS_HOME: '' }, 'HOME')).toBeUndefined();
    expect(envValue({ PARLEY_HOME: undefined, HARNAS_HOME: '/old' }, 'HOME')).toBe('/old');
  });

  it('читает process.env-подобный слепок с любыми ключами', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin', PARLEY_CLAUDE_BIN: '/opt/claude' };
    expect(envValue(env, 'CLAUDE_BIN')).toBe('/opt/claude');
  });
});

describe('envName', () => {
  it('называет то имя, под которым задано значение', () => {
    expect(envName({ PARLEY_MESSAGE_RATE: '5' }, 'MESSAGE_RATE')).toBe('PARLEY_MESSAGE_RATE');
    expect(envName({ HARNAS_MESSAGE_RATE: '5' }, 'MESSAGE_RATE')).toBe('HARNAS_MESSAGE_RATE');
  });

  it('оба заданы — новое; пустое новое — прежнее; ни одного — undefined', () => {
    expect(envName({ PARLEY_MESSAGE_RATE: '5', HARNAS_MESSAGE_RATE: '6' }, 'MESSAGE_RATE')).toBe(
      'PARLEY_MESSAGE_RATE',
    );
    expect(envName({ PARLEY_MESSAGE_RATE: '', HARNAS_MESSAGE_RATE: '6' }, 'MESSAGE_RATE')).toBe(
      'HARNAS_MESSAGE_RATE',
    );
    expect(envName({}, 'MESSAGE_RATE')).toBeUndefined();
    expect(envName({ PARLEY_MESSAGE_RATE: '' }, 'MESSAGE_RATE')).toBeUndefined();
  });

  it('согласован с envValue: имя всегда указывает на то значение, которое вернул envValue', () => {
    const envs = [
      { PARLEY_X: 'a', HARNAS_X: 'b' },
      { PARLEY_X: '', HARNAS_X: 'b' },
      { HARNAS_X: 'b' },
      { PARLEY_X: 'a' },
      {},
    ];
    for (const env of envs) {
      const name = envName(env, 'X');
      expect(name === undefined ? undefined : (env as Record<string, string>)[name]).toBe(envValue(env, 'X'));
    }
  });
});

describe('envRaw', () => {
  it('пустая строка остаётся значением: так читаются подмены бинарей («бинаря нет»)', () => {
    expect(envRaw({ PARLEY_GLM_BIN: '' }, 'GLM_BIN')).toBe('');
    expect(envRaw({ HARNAS_GLM_BIN: '' }, 'GLM_BIN')).toBe('');
  });

  it('первым считается то из двух имён, что определено; новое — раньше прежнего', () => {
    expect(envRaw({ PARLEY_GLM_BIN: '', HARNAS_GLM_BIN: '/opt/glm' }, 'GLM_BIN')).toBe('');
    expect(envRaw({ HARNAS_GLM_BIN: '/opt/glm' }, 'GLM_BIN')).toBe('/opt/glm');
    expect(envRaw({ PARLEY_GLM_BIN: '/new', HARNAS_GLM_BIN: '/old' }, 'GLM_BIN')).toBe('/new');
    expect(envRaw({}, 'GLM_BIN')).toBeUndefined();
  });
});

describe('bothEnv', () => {
  it('одно значение под обоими именами: сначала все новые, потом все прежние', () => {
    const both = bothEnv({ WORK_DIR: '/w', SESSION_ID: 's-01' });
    expect(both).toEqual({
      PARLEY_WORK_DIR: '/w',
      PARLEY_SESSION_ID: 's-01',
      HARNAS_WORK_DIR: '/w',
      HARNAS_SESSION_ID: 's-01',
    });
    expect(Object.keys(both)).toEqual([
      'PARLEY_WORK_DIR',
      'PARLEY_SESSION_ID',
      'HARNAS_WORK_DIR',
      'HARNAS_SESSION_ID',
    ]);
  });

  it('пусто на входе — пусто на выходе', () => {
    expect(bothEnv({})).toEqual({});
  });
});
