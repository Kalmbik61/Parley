import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultCodexRoot } from './codex/discover.js';
import { defaultRoot } from './discover.js';

const CLAUDE_ENV = 'PARLEY_CLAUDE_PROJECTS_DIR';
const CODEX_ENV = 'PARLEY_CODEX_SESSIONS_DIR';
/** Прежние имена тех же переменных читаются как запасные (R3). */
const LEGACY_CLAUDE_ENV = 'HARNAS_CLAUDE_PROJECTS_DIR';
const LEGACY_CODEX_ENV = 'HARNAS_CODEX_SESSIONS_DIR';

afterEach(() => {
  for (const name of [CLAUDE_ENV, CODEX_ENV, LEGACY_CLAUDE_ENV, LEGACY_CODEX_ENV]) delete process.env[name];
});

describe('корни истории агентов (раунд lane-r3, п. 1)', () => {
  it('без переменных — прежние пути в домашней папке', () => {
    expect(defaultRoot()).toBe(path.join(homedir(), '.claude', 'projects'));
    expect(defaultCodexRoot()).toBe(path.join(homedir(), '.codex', 'sessions'));
  });

  it('переменные окружения переопределяют оба корня', () => {
    process.env[CLAUDE_ENV] = '/tmp/история-клода';
    process.env[CODEX_ENV] = '/tmp/история-кодекса';
    expect(defaultRoot()).toBe('/tmp/история-клода');
    expect(defaultCodexRoot()).toBe('/tmp/история-кодекса');
  });

  it('пустая переменная — как отсутствующая', () => {
    process.env[CLAUDE_ENV] = '';
    process.env[CODEX_ENV] = '';
    expect(defaultRoot()).toBe(path.join(homedir(), '.claude', 'projects'));
    expect(defaultCodexRoot()).toBe(path.join(homedir(), '.codex', 'sessions'));
  });

  it('прежние HARNAS_* читаются, а PARLEY_* главнее', () => {
    process.env[LEGACY_CLAUDE_ENV] = '/tmp/старая-история-клода';
    process.env[LEGACY_CODEX_ENV] = '/tmp/старая-история-кодекса';
    expect(defaultRoot()).toBe('/tmp/старая-история-клода');
    expect(defaultCodexRoot()).toBe('/tmp/старая-история-кодекса');

    process.env[CLAUDE_ENV] = '/tmp/новая-история-клода';
    process.env[CODEX_ENV] = '/tmp/новая-история-кодекса';
    expect(defaultRoot()).toBe('/tmp/новая-история-клода');
    expect(defaultCodexRoot()).toBe('/tmp/новая-история-кодекса');
  });
});
