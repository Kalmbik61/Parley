import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultCodexRoot } from './codex/discover.js';
import { defaultRoot } from './discover.js';

const CLAUDE_ENV = 'HARNAS_CLAUDE_PROJECTS_DIR';
const CODEX_ENV = 'HARNAS_CODEX_SESSIONS_DIR';

afterEach(() => {
  delete process.env[CLAUDE_ENV];
  delete process.env[CODEX_ENV];
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
});
