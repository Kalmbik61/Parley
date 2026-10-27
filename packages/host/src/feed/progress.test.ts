import { createHash } from 'node:crypto';
import { emptyFeedState, type FeedAgent, type FeedItem, type FeedState, type FeedTool } from '@parley/core';
import { FEED_PROGRESS_MAX_BYTES, progressResult } from '@parley/protocol';
import { describe, expect, it } from 'vitest';
import { projectProgress } from './progress.js';

const at = '2026-10-26T12:00:00.000Z';
const digest = (id: string): string => createHash('sha256').update(id).digest('hex');
const tool = (id: string, changes: Partial<FeedTool> = {}): FeedTool => ({
  id, at, kind: 'tool', toolUseId: id, name: 'Read', input: {}, status: 'running', ...changes,
});
const state = (...items: FeedItem[]): FeedState => ({ ...emptyFeedState(), items });
const unavailable = (revision: number) => ({ revision, availability: 'unavailable', current: null, recent: [], truncated: false });

describe('projectProgress', () => {
  it('distinguishes missing state from an available empty feed and uses feed revision, not seq', () => {
    expect(projectProgress(null, 19)).toEqual(unavailable(0));
    expect(projectProgress({ ...state(), seq: 900 }, 19)).toEqual({
      revision: 19, availability: 'available', current: null, recent: [], truncated: false,
    });
  });

  it('keeps only the last 20 unique tools, without adding an earlier running current', () => {
    const items = Array.from({ length: 21 }, (_, i) => tool(String(i), { status: i === 0 ? 'running' : 'done' }));
    const result = projectProgress(state(...items), 31);
    expect(result.recent.map((line) => line.id)).toEqual(items.slice(1).map((item) => digest(item.id)));
    expect(result.current).toBeNull();
    expect(result.truncated).toBe(true);
  });

  it('replaces duplicates with final status at their original position, before taking the tail', () => {
    const items = Array.from({ length: 21 }, (_, i) => tool(String(i)));
    const result = projectProgress(state(...items, tool('0', { status: 'failed' }), tool('20', { status: 'rejected', endedAt: at })), 32);
    expect(result.recent).toHaveLength(20);
    expect(result.recent[0]?.id).toBe(digest('1'));
    expect(result.recent.at(-1)).toMatchObject({ id: digest('20'), status: 'rejected', endedAt: at });
    expect(result.current).toEqual(result.recent.at(-2));
    expect(new Set(result.recent.map((line) => line.id)).size).toBe(20);
  });

  it('chooses the last running row in feed order, without sorting timestamps', () => {
    const result = projectProgress(state(tool('first', { at: '2026-10-27T12:00:00.000Z' }), tool('last'), tool('finished', { status: 'done' })), 3);
    expect(result.current).toEqual(result.recent[1]);
    expect(result.current?.id).toBe(digest('last'));
    expect(result.truncated).toBe(false);
  });

  it('excludes non-tools, agent cards and nested children from both current and the tail limit', () => {
    const agent: FeedAgent = {
      id: 'agent', at, kind: 'agent', toolUseId: 'spawn', agentId: 'child', agentType: null,
      description: 'secret description', prompt: 'secret prompt', model: null, background: false,
      status: 'running', toolCount: 1, children: [tool('nested')], transcriptPath: '/secret/transcript',
    };
    const others: FeedItem[] = [agent, { id: 'text', at, kind: 'text', messageId: null, text: 'secret text', streaming: false }];
    const result = projectProgress(state(tool('main'), ...others, ...Array.from({ length: 22 }, (_, i) => tool(`child-${i}`, { agentId: 'child' }))), 4);
    expect(result.recent.map((line) => line.id)).toEqual([digest('main')]);
    expect(result.current).toEqual(result.recent[0]);
    expect(result.truncated).toBe(false);
  });

  it.each([
    ['Read', 'read'], ['ViewImage', 'read'], ['WebFetch', 'read'],
    ['Edit', 'edit'], ['Write', 'edit'], ['Delete', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
    ['Bash', 'execute'], ['Glob', 'search'], ['Grep', 'search'], ['WebSearch', 'search'],
    ['Agent', 'delegate'], ['Task', 'delegate'], ['mcp__secret__Read', 'other'], ['unknown Bash Read', 'other'],
  ])('maps known tool %s to an enum without guessing unknown names', (name, category) => {
    expect(projectProgress(state(tool('id', { name })), 5).recent[0]?.category).toBe(category);
  });

  it('normalizes valid source times to ISO24, including offsets and missing milliseconds', () => {
    const result = projectProgress(state(tool('id', { at: '2026-10-26T15:00:00+03:00', endedAt: '2026-10-26T12:01:00Z', status: 'done' })), 6);
    expect(result.recent[0]).toEqual({ id: digest('id'), at, endedAt: '2026-10-26T12:01:00.000Z', category: 'read', status: 'done' });
  });

  it.each(['secret invalid date', '', '2026-02-30T12:00:00Z', '+010000-01-01T00:00:00.000Z'])('fails closed for invalid or non-ISO24-representable at: %s', (value) => {
    expect(projectProgress(state(tool('good'), tool('bad', { at: value })), 42)).toEqual(unavailable(42));
  });

  it('fails closed for invalid endedAt or an unknown status, without retaining earlier history', () => {
    expect(projectProgress(state(tool('good'), tool('bad', { endedAt: 'secret end' })), 43)).toEqual(unavailable(43));
    expect(projectProgress(state(tool('good'), tool('bad', { status: 'secret status' as FeedTool['status'] })), 43)).toEqual(unavailable(43));
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('returns a strict unavailable result for invalid revision %s', (revision) => {
    const result = projectProgress(state(tool('id')), revision);
    expect(result).toEqual(unavailable(0));
    expect(progressResult.safeParse(result).success).toBe(true);
  });

  it('projects allowlisted fields only, hashes even short ids, and never reads sensitive input', () => {
    const canary = '敏感🔒SECRET';
    const item = {
      ...tool(canary, { name: `${canary} Read`, response: { text: canary, size: 1, truncated: false } }),
      args: canary, path: canary, command: canary, error: canary, prompt: canary,
      transcriptPath: canary, providerSessionId: canary, provider: canary, startedAtProcess: canary,
      patch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [canary] }],
      get input(): Record<string, unknown> { throw new Error('Sensitive input must not be read'); },
    } as FeedTool;
    const result = projectProgress(state(item, tool('x')), Number.MAX_SAFE_INTEGER);
    expect(result.recent[0]).toEqual({ id: digest(canary), at, category: 'other', status: 'running' });
    expect(result.recent[1]?.id).toBe(digest('x'));
    for (const row of result.recent) expect(row.id).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(canary);
    for (const key of ['name', 'input', 'args', 'response', 'patch', 'path', 'command', 'error', 'prompt', 'transcriptPath', 'providerSessionId', 'provider', 'startedAtProcess', 'toolUseId']) {
      expect(serialized).not.toContain(`"${key}":`);
    }
    expect(progressResult.safeParse(result).success).toBe(true);
  });

  it('bounds the entire UTF-8 result with maximum history and huge sensitive fields, without mutating state', () => {
    const secret = '🔒秘密'.repeat(10_000);
    const items = Array.from({ length: 30 }, (_, i) => tool(`${secret}${i}`, {
      name: secret, input: { args: secret, path: secret, command: secret }, endedAt: at,
      response: { text: secret, size: secret.length, truncated: false },
    }));
    const source = state(...items);
    const before = JSON.stringify(source);
    const result = projectProgress(source, Number.MAX_SAFE_INTEGER);
    expect(result.availability).toBe('available');
    expect(result.recent).toHaveLength(20);
    expect(result.current).toEqual(result.recent.at(-1));
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(FEED_PROGRESS_MAX_BYTES);
    expect(progressResult.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('秘密');
    expect(JSON.stringify(source)).toBe(before);
  });
});
