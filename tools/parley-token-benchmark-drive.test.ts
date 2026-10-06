import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildHostEnv,
  changedFiles,
  classifyScreen,
  findTranscript,
  modelAlias,
  parseJournal,
  selectedOption,
  turnEnded,
} from './parley-token-benchmark-drive.js';

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'parley-drive-test-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const WORK_ROOT = '/repo/.parley/benchmark/work';
const COPY = `${WORK_ROOT}/obvious.native.cold.jev-off.skill-off.r1/project`;

/** Диалог доверия как в снимке: пробелы между словами теряются. */
const trustScreen = (selected: 'yes' | 'no', shownPath = COPY): string =>
  [
    'Accessing workspace:',
    shownPath,
    'Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?',
    selected === 'no' ? '❯ 1.No,exit' : '  1.No,exit',
    selected === 'yes' ? '❯ 2.Yes,Itrustthisfolder' : '  2.Yes,Itrustthisfolder',
    'Enter to confirm · Esc to cancel',
  ].join('\n');

describe('classifyScreen', () => {
  it('доверие: выделено No в копии прогона', () => {
    expect(classifyScreen(trustScreen('no'), COPY, WORK_ROOT)).toEqual({ kind: 'trust', selected: 'no', ours: true });
  });

  it('доверие: выделено Yes в копии прогона', () => {
    expect(classifyScreen(trustScreen('yes'), COPY, WORK_ROOT)).toEqual({ kind: 'trust', selected: 'yes', ours: true });
  });

  it('доверие: путь на экране чужой — не наша копия', () => {
    const screen = classifyScreen(trustScreen('yes', '/Users/someone/project'), COPY, WORK_ROOT);
    expect(screen).toEqual({ kind: 'trust', selected: 'yes', ours: false });
  });

  it('доверие: копия не под <out>/work — не наша, даже если путь показан', () => {
    const outside = '/Users/someone/project';
    expect(classifyScreen(trustScreen('yes', outside), outside, WORK_ROOT)).toMatchObject({ kind: 'trust', ours: false });
  });

  it('доверие: путь, разбитый переносом строки, всё равно находится', () => {
    const half = Math.floor(COPY.length / 2);
    const wrapped = trustScreen('no', `${COPY.slice(0, half)}\n${COPY.slice(half)}`);
    expect(classifyScreen(wrapped, COPY, WORK_ROOT)).toMatchObject({ kind: 'trust', selected: 'no', ours: true });
  });

  it('MCP проекта: «Esc to reject all»', () => {
    const text = '6newMCPserversfoundinthisproject\n❯ 1.Usethisandallfuture\nEsctorejectall';
    expect(classifyScreen(text, COPY, WORK_ROOT)).toEqual({ kind: 'mcp' });
    expect(classifyScreen('1 new MCP server found in this project\nEsc to reject all', COPY, WORK_ROOT)).toEqual({ kind: 'mcp' });
  });

  it('MCP без «Esc to reject all» не считается диалогом отказа', () => {
    expect(classifyScreen('6newMCPserversfoundinthisproject', COPY, WORK_ROOT)).toEqual({ kind: 'other' });
  });

  it('предупреждение о development channel', () => {
    const text = 'WARNING:Loadingdevelopmentchannels\n❯ 1.Iamusingthisforlocaldevelopment';
    expect(classifyScreen(text, COPY, WORK_ROOT)).toEqual({ kind: 'channel' });
  });

  it('обычный экран и пустой снимок — other', () => {
    expect(classifyScreen('>  \n? for shortcuts', COPY, WORK_ROOT)).toEqual({ kind: 'other' });
    expect(classifyScreen('', COPY, WORK_ROOT)).toEqual({ kind: 'other' });
  });
});

describe('selectedOption', () => {
  it('различает Yes, No и чужой пункт; без стрелки — null', () => {
    expect(selectedOption(trustScreen('yes'))).toBe('yes');
    expect(selectedOption(trustScreen('no'))).toBe('no');
    expect(selectedOption('❯ 3.Somethingelse')).toBe('other');
    expect(selectedOption('Yes, I trust this folder')).toBeNull();
  });
});

describe('modelAlias', () => {
  it('claude-… → псевдоним провайдера', () => {
    expect(modelAlias('claude-sonnet-5-5')).toBe('sonnet');
    expect(modelAlias('claude-opus-4-1')).toBe('opus');
    expect(modelAlias('claude-haiku-4-5')).toBe('haiku');
    expect(modelAlias('sonnet')).toBe('sonnet');
  });

  it('неизвестная модель — отказ', () => {
    expect(() => modelAlias('gpt-6-luna')).toThrow(/нет псевдонима/);
    expect(() => modelAlias('claude-fable-1')).toThrow(/нет псевдонима/);
  });
});

describe('buildHostEnv', () => {
  const operator: NodeJS.ProcessEnv = {
    HOME: '/Users/op', USER: 'op', LOGNAME: 'op', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'ru_RU.UTF-8', TERM: 'dumb',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '123', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_BASE_URL: 'https://x', AWS_SECRET_ACCESS_KEY: 'x', NODE_OPTIONS: '--inspect',
  };
  const runEnv = ['PARLEY_SKILL_NAVIGATOR=true', 'PARLEY_AGENT_SKILLS=false', 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=0'];
  const build = (claudeBinDir: string | null = null) => buildHostEnv({ base: operator, home: '/tmp/pbh', runEnv, tmpDir: '/var/tmp/x/', claudeBinDir });

  it('только разрешённый список, строка прогона и DISABLE_AUTOUPDATER=1', () => {
    expect(build()).toEqual({
      HOME: '/Users/op', USER: 'op', LOGNAME: 'op', PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
      TMPDIR: '/var/tmp/x/', PARLEY_HOME: '/tmp/pbh',
      PARLEY_SKILL_NAVIGATOR: 'true', PARLEY_AGENT_SKILLS: 'false', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0',
      DISABLE_AUTOUPDATER: '1',
    });
  });

  it('нет меток родительской сессии, ключей API и чужого окружения; функциональные хуки — из строки прогона', () => {
    const env = build();
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(env).not.toHaveProperty('CLAUDE_CODE_SSE_PORT');
    expect(Object.keys(env).filter((k) => k.startsWith('ANTHROPIC_'))).toEqual([]);
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS']).toBe('0');
  });

  it('каталог --claude-bin первым в PATH', () => {
    expect(build('/tmp/bin-x')['PATH']).toBe('/tmp/bin-x:/usr/bin:/bin');
  });

  it('строка прогона с меткой родительской сессии или ключом — отказ', () => {
    for (const bad of ['CLAUDECODE=1', 'CLAUDE_CODE_SSE_PORT=1', 'ANTHROPIC_API_KEY=x', 'novalue']) {
      expect(() => buildHostEnv({ base: operator, home: '/tmp/pbh', runEnv: [bad], tmpDir: '/t' })).toThrow(/не годится/);
    }
  });
});

describe('журнал хуков', () => {
  const rows = (...names: string[]): string => names.map((hook_event_name) => JSON.stringify({ hook_event_name })).join('\n');

  it('Stop после последнего UserPromptSubmit — ход закончен', () => {
    expect(turnEnded(parseJournal(rows('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop')))).toBe(true);
  });

  it('Stop только от прошлого хода — ход идёт', () => {
    expect(turnEnded(parseJournal(rows('UserPromptSubmit', 'Stop', 'UserPromptSubmit', 'PreToolUse')))).toBe(false);
  });

  it('нет запроса — не закончен, даже со Stop', () => {
    expect(turnEnded(parseJournal(rows('SessionStart', 'Stop')))).toBe(false);
    expect(turnEnded([])).toBe(false);
  });

  it('битая и пустая строки пропускаются', () => {
    const text = `${rows('UserPromptSubmit')}\n\n{"hook_event_na\n${rows('Stop')}\n`;
    expect(parseJournal(text)).toHaveLength(2);
    expect(turnEnded(parseJournal(text))).toBe(true);
  });
});

describe('changedFiles', () => {
  it('служебное не считается, переименование — по новому имени', () => {
    const porcelain = [
      ' M src/range.js',
      '?? notes.md',
      '?? .parley/works/w1/events/s1.jsonl',
      '?? PARLEY.md',
      '?? .omc/state/x.json',
      'R  old.js -> new.js',
      '',
    ].join('\n');
    expect(changedFiles(porcelain)).toEqual(['src/range.js', 'notes.md', 'new.js']);
  });

  it('чистая копия — пусто', () => {
    expect(changedFiles('')).toEqual([]);
  });
});

describe('findTranscript', () => {
  it('находит <uuid>.jsonl в одном из каталогов проектов', async () => {
    await mkdir(path.join(tmp, '-a'), { recursive: true });
    await mkdir(path.join(tmp, '-b'), { recursive: true });
    await writeFile(path.join(tmp, '-b', 'abc.jsonl'), '');
    expect(findTranscript(tmp, 'abc')).toBe(path.join(tmp, '-b', 'abc.jsonl'));
    expect(findTranscript(tmp, 'nope')).toBeNull();
    expect(findTranscript(path.join(tmp, 'missing'), 'abc')).toBeNull();
  });
});
