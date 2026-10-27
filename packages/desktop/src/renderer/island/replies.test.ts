/** Ответ агента в строке Done: выбор текста из ленты (`lastReply`) и стор снимков — один на ключ, один повтор при пустом, уборка ключей. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem } from '@parley/core';
import { REPLY_RETRY_MS, lastReply, useIslandReplies } from './replies.js';
import { refKey } from '@parley/protocol';
import { activityMap, makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { islandModel } from './model.js';

const AT = '2026-10-13T10:00:00.000Z';
const prompt = (id: string, body: string): FeedItem => ({ id, at: AT, kind: 'prompt', text: body, images: 0 });
const text = (id: string, body: string): FeedItem => ({ id, at: AT, kind: 'text', messageId: null, text: body, streaming: false });
const tool = (id: string): FeedItem => ({ id, at: AT, kind: 'tool', toolUseId: id, name: 'Bash', input: {}, status: 'done' });

describe('lastReply', () => {
  it('последний текст после последнего промпта', () => {
    const items = [prompt('p1', 'first'), text('t1', 'old answer'), prompt('p2', 'second'), text('t2', 'draft'), tool('x1'), text('t3', 'final answer')];
    expect(lastReply(items)).toBe('final answer');
  });

  it('промпта нет — последний текст вообще', () => {
    expect(lastReply([text('t1', 'one'), tool('x1'), text('t2', 'two')])).toBe('two');
  });

  it('после последнего промпта текста ещё нет — null, ответ на прежний промпт не берётся', () => {
    expect(lastReply([prompt('p1', 'q'), text('t1', 'answer'), prompt('p2', 'next'), tool('x1')])).toBeNull();
  });

  it('пустая лента, текст из пробелов и пустая строка — null', () => {
    expect(lastReply([])).toBeNull();
    expect(lastReply([text('t1', '  \n\t ')])).toBeNull();
    expect(lastReply([text('t1', 'earlier'), text('t2', '')])).toBeNull();
  });

  it('пробелы и переносы схлопываются в один пробел, края срезаются', () => {
    expect(lastReply([text('t1', '  Done.\n\nChanged   two\tfiles.  \n')])).toBe('Done. Changed two files.');
  });
});

const REF = { projectPath: '/tmp/proj', workId: 'w-1', sessionId: 's-01' };
const snapshot = (items: FeedItem[]) => ({ items, revision: 1, schemaVersion: 1, mode: null, decisions: 'window' as const });
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Мост: `feed.snapshot` отвечает следующим ответом из очереди (после неё — последним). */
function bridge(...answers: Array<FeedItem[] | Error>) {
  let at = 0;
  return vi.fn(async () => {
    const answer = answers[Math.min(at, answers.length - 1)];
    at += 1;
    if (answer instanceof Error) throw answer;
    return snapshot(answer ?? []);
  });
}

describe('стор ответов острова', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useIslandReplies.getState().prune(new Set());
  });
  afterEach(() => {
    useIslandReplies.getState().bind(null);
    useIslandReplies.getState().prune(new Set());
    vi.useRealTimers();
  });

  it('Codex Done без Chat: два worktree не смешивают ответы, пустой ответ приходит после штатного обновления source', async () => {
    const entries = ['/tmp/codex-a', '/tmp/codex-b'].map((projectPath) => makeWork('w-1', {
      projectPath, sessions: [makeSession('s-01', 'codex', { provider: 'codex' })],
    }));
    const refs = entries.map((entry) => ({ projectPath: entry.projectPath, workId: 'w-1', sessionId: 's-01' }));
    const none = new Set<string>();
    const model = islandModel(entries, activityMap(refs.map((ref) => makeActivity(ref, 'unseen', { turnEndedAt: AT }))), none, none, none);
    const rows = model.groups.flatMap((group) => group.rows).filter((row) => row.kind === 'session' && row.state === 'done');
    expect(rows).toHaveLength(2);
    let updated = false;
    const call = vi.fn(async (_method: string, params: { ref: typeof REF }) => snapshot(
      params.ref.projectPath === refs[0]!.projectPath ? [text('a', 'First worktree')] : updated ? [text('b', 'Second worktree')] : [],
    ));
    useIslandReplies.getState().bind(call as never);
    for (const row of rows) if (row.kind === 'session' && row.state === 'done') useIslandReplies.getState().fetch(row.ref, row.doneKey);
    await flush();
    const firstKey = `${refKey(refs[0]!)}\u0000${AT}`;
    const secondKey = `${refKey(refs[1]!)}\u0000${AT}`;
    expect(useIslandReplies.getState().texts).toEqual({ [firstKey]: 'First worktree', [secondKey]: null });
    updated = true;
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS);
    expect(useIslandReplies.getState().texts).toEqual({ [firstKey]: 'First worktree', [secondKey]: 'Second worktree' });
    expect(call.mock.calls.map(([method]) => method)).toEqual(['feed.snapshot', 'feed.snapshot', 'feed.snapshot']);
    for (const ref of refs) expect(call).toHaveBeenCalledWith('feed.snapshot', { ref, scope: 'attention' });
  });

  it('снимок на ключ один: повторный fetch с тем же ключом ничего не зовёт; другой ключ — свой снимок', async () => {
    const call = bridge([text('t1', 'All done')]);
    useIslandReplies.getState().bind(call as never);
    useIslandReplies.getState().fetch(REF, 'k1');
    useIslandReplies.getState().fetch(REF, 'k1');
    await flush();
    useIslandReplies.getState().fetch(REF, 'k1');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('feed.snapshot', { ref: REF, scope: 'attention' });
    expect(useIslandReplies.getState().texts).toEqual({ k1: 'All done' });
    useIslandReplies.getState().fetch(REF, 'k2');
    await flush();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('текста ещё нет — один повтор через REPLY_RETRY_MS, и текст ложится в стор', async () => {
    const call = bridge([prompt('p1', 'q')], [prompt('p1', 'q'), text('t1', 'Finished')]);
    useIslandReplies.getState().bind(call as never);
    useIslandReplies.getState().fetch(REF, 'k1');
    await flush();
    expect(useIslandReplies.getState().texts).toEqual({ k1: null });
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS - 1);
    expect(call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(call).toHaveBeenCalledTimes(2);
    expect(useIslandReplies.getState().texts).toEqual({ k1: 'Finished' });
  });

  it('и повтор пуст — больше снимков нет: ровно два на ключ', async () => {
    const call = bridge([prompt('p1', 'q')]);
    useIslandReplies.getState().bind(call as never);
    useIslandReplies.getState().fetch(REF, 'k1');
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS * 5);
    expect(call).toHaveBeenCalledTimes(2);
    expect(useIslandReplies.getState().texts).toEqual({ k1: null });
  });

  it('ошибка вызова — null без повторов', async () => {
    const call = bridge(new Error('host gone'));
    useIslandReplies.getState().bind(call as never);
    useIslandReplies.getState().fetch(REF, 'k1');
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS * 5);
    expect(call).toHaveBeenCalledTimes(1);
    expect(useIslandReplies.getState().texts).toEqual({ k1: null });
  });

  it('prune выкидывает ключи вне набора вместе с текстом; вернувшийся ключ снимается заново', async () => {
    const call = bridge([text('t1', 'Answer')]);
    useIslandReplies.getState().bind(call as never);
    useIslandReplies.getState().fetch(REF, 'k1');
    useIslandReplies.getState().fetch(REF, 'k2');
    await flush();
    expect(useIslandReplies.getState().texts).toEqual({ k1: 'Answer', k2: 'Answer' });
    useIslandReplies.getState().prune(new Set(['k2']));
    expect(useIslandReplies.getState().texts).toEqual({ k2: 'Answer' });
    useIslandReplies.getState().fetch(REF, 'k2');
    expect(call).toHaveBeenCalledTimes(2);
    useIslandReplies.getState().fetch(REF, 'k1');
    await flush();
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('снимок ушёл, пока ключ убрали, — ответ отброшен, повтор не заводится', async () => {
    let finish!: (value: ReturnType<typeof snapshot>) => void;
    const pending = new Promise<ReturnType<typeof snapshot>>((done) => {
      finish = done;
    });
    const call = vi.fn(() => pending);
    useIslandReplies.getState().bind(call as never);
    useIslandReplies.getState().fetch(REF, 'k1');
    useIslandReplies.getState().prune(new Set());
    finish(snapshot([text('t1', 'Too late')]));
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_MS * 2);
    expect(useIslandReplies.getState().texts).toEqual({});
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('мост не привязан — ничего не зовётся и ключ не занят: после bind снимок заказывается', async () => {
    useIslandReplies.getState().fetch(REF, 'k1');
    await flush();
    expect(useIslandReplies.getState().texts).toEqual({});
    const call = bridge([text('t1', 'Bound')]);
    useIslandReplies.getState().bind(call as never);
    useIslandReplies.getState().fetch(REF, 'k1');
    await flush();
    expect(call).toHaveBeenCalledTimes(1);
    expect(useIslandReplies.getState().texts).toEqual({ k1: 'Bound' });
  });
});
