/** Чистые выводы из ленты (план 2026-10-01, Task 3): идёт ли ход, модель, строка вызова. */

import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { currentModel, firstLine, toolHeadline, turnActive } from './feed-model.js';

const AT = '2026-10-01T00:00:00.000Z';
const prompt: FeedItem = { id: 'p', at: AT, kind: 'prompt', text: 'hi', images: 0 };
const turn: FeedItem = { id: 'u', at: AT, kind: 'turn', durationMs: 1 };
const error: FeedItem = { id: 'e', at: AT, kind: 'error', error: 'x', message: null };
const text = (streaming: boolean): FeedItem => ({ id: `t${String(streaming)}`, at: AT, kind: 'text', messageId: 'm', text: 'a', streaming });
const tool = (status: 'running' | 'done'): FeedItem => ({
  id: `tool-${status}`,
  at: AT,
  kind: 'tool',
  toolUseId: 'tu',
  name: 'Bash',
  input: {},
  status,
});
const agent: FeedItem = {
  id: 'a',
  at: AT,
  kind: 'agent',
  toolUseId: 'ta',
  agentId: 'g',
  agentType: 'Explore',
  description: null,
  prompt: null,
  model: null,
  background: true,
  status: 'running',
  toolCount: 0,
  children: [],
};

describe('turnActive', () => {
  it('пусто и после конца хода — хода нет', () => {
    expect(turnActive([])).toBe(false);
    expect(turnActive([prompt, text(false), turn])).toBe(false);
    expect(turnActive([prompt, error])).toBe(false);
  });

  it('после последнего turn есть промпт — ход идёт', () => {
    expect(turnActive([prompt, turn, prompt])).toBe(true);
    expect(turnActive([prompt, turn, prompt, text(false), tool('done')])).toBe(true);
  });

  it('без промпта: вызов в работе или текст, который пишется, — ход идёт', () => {
    expect(turnActive([turn, tool('running')])).toBe(true);
    expect(turnActive([turn, text(true)])).toBe(true);
    expect(turnActive([turn, tool('done'), text(false)])).toBe(false);
  });

  it('живой субагент после конца хода родителя хода не держит', () => {
    expect(turnActive([prompt, agent, turn])).toBe(false);
    expect(turnActive([turn, agent])).toBe(false);
  });
});

describe('currentModel', () => {
  it('из последнего старта сессии или смены модели; нет — null', () => {
    expect(currentModel([prompt])).toBeNull();
    const start: FeedItem = { id: 's', at: AT, kind: 'notice', notice: { type: 'session-start', source: 'startup', model: 'opus' } };
    const empty: FeedItem = { id: 's2', at: AT, kind: 'notice', notice: { type: 'session-start', source: 'resume', model: null } };
    const swap: FeedItem = { id: 'm', at: AT, kind: 'notice', notice: { type: 'model-switch', from: 'opus', to: 'sonnet', source: 'user' } };
    expect(currentModel([start, prompt])).toBe('opus');
    expect(currentModel([start, swap])).toBe('sonnet');
    expect(currentModel([start, empty])).toBe('opus');
  });
});

describe('toolHeadline', () => {
  it('Bash — команда, Edit/Write/Read — путь, MCP — сервер и инструмент, прочее — имя', () => {
    expect(toolHeadline('Bash', { command: 'ls -la' })).toEqual({ name: 'Bash', summary: 'ls -la' });
    expect(toolHeadline('Edit', { file_path: '/a.ts' })).toEqual({ name: 'Edit', summary: '/a.ts' });
    expect(toolHeadline('Write', { file_path: '/b.ts' }).summary).toBe('/b.ts');
    expect(toolHeadline('Read', { file_path: '/c.ts' }).summary).toBe('/c.ts');
    expect(toolHeadline('mcp__parley__get_map', {})).toEqual({ name: 'parley · get_map', summary: null });
    expect(toolHeadline('Glob', { pattern: '*' })).toEqual({ name: 'Glob', summary: null });
    expect(toolHeadline('Bash', { command: 42 }).summary).toBeNull();
  });

  it('firstLine — первая непустая строка', () => {
    expect(firstLine('\n\n  # Plan\nstep')).toBe('# Plan');
    expect(firstLine('  \n')).toBeNull();
  });
});
