import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { addSession } from '../work/map.js';
import { createWork, readMap, readStoredMap, updateMap, workPaths } from '../work/store.js';
import type { WorkSession } from '../work/types.js';
import type { McpContext } from './context.js';
import { contextFromEnv } from './context.js';
import { createToolRunner, finishedState, STALE_AGENT, type ToolRunner } from './tools.js';

/**
 * Ограда прежнего агента (спека передачи сессии 6.1, 6.2): после замены агента осиротевший MCP-процесс прежнего не пишет
 * от имени сессии, а `wait_for` ждущих не считает переводимую сессию уснувшей.
 */

let home = '';
let project = '';
let workId = '';

const textOf = (result: Awaited<ReturnType<ToolRunner['call']>>): string => (result.content[0] as { text: string }).text;

const runnerWith = (agentRevision?: string, sessionId = 's-01'): ToolRunner =>
  createToolRunner({
    projectPath: project,
    workId,
    workDir: workPaths(project, workId).dir,
    sessionId,
    channel: false,
    messageRate: DEFAULT_CONFIG.messageRate,
    pollMs: 40,
    ...(agentRevision === undefined ? {} : { agentRevision }),
  } satisfies McpContext);

const setRevision = (revision: string | null): Promise<unknown> =>
  updateMap(project, workId, (map) => {
    map.sessions.find((session) => session.id === 's-01')!.agentRevision = revision;
  });

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  workId = (await createWork(project, { title: 'Работа', goal: '' })).work.id;
  await updateMap(project, workId, (map) => {
    addSession(map, { provider: 'claude', label: 'лид', task: 'вести' });
    addSession(map, { provider: 'claude', label: 'бэк', task: 'делать' });
  });
});

afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ограда агента', () => {
  it('сессия без ревизии в карте не огорожена: процесс без ревизии пишет как раньше', async () => {
    const result = await runnerWith().call('send_message', { to: 's-02', text: 'привет' });
    expect(result.isError).toBeFalsy();
    expect(readStoredMap(project, workId).messages.map((message) => message.text)).toContain('привет');
  });

  it('процесс прежнего агента (без ревизии или с чужой) получает отказ на запись, и карта не меняется', async () => {
    await setRevision('rev-new');
    for (const runner of [runnerWith(), runnerWith('rev-old')]) {
      const sent = await runner.call('send_message', { to: 's-02', text: 'от прежнего' });
      expect(sent.isError).toBe(true);
      expect(textOf(sent)).toBe(STALE_AGENT);
      const reported = await runner.call('report', { status: 'done', summary: 'итог прежнего' });
      expect(textOf(reported)).toBe(STALE_AGENT);
      const plan = await runner.call('publish_agent_plan', { steps: [{ step: 'шаг', status: 'pending' }] });
      expect(textOf(plan)).toBe(STALE_AGENT);
      const closed = await runner.call('close_session', { target: 's-01' });
      expect(textOf(closed)).toBe(STALE_AGENT);
    }
    const map = await readMap(project, workId);
    const session = map.sessions.find((item) => item.id === 's-01')!;
    expect(session.result).toBeNull();
    expect(session.summary).toBeNull();
    expect(session.lifecycle).not.toBe('closed');
    expect(readStoredMap(project, workId).messages.map((message) => message.text)).not.toContain('от прежнего');
  });

  it('прежний агент не забирает почту нового: check_inbox и wait_for огорожены', async () => {
    await setRevision('rev-new');
    await updateMap(project, workId, (_map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: 's-02', to: ['s-01'], text: 'новому агенту' });
    });
    const old = runnerWith('rev-old');
    expect(textOf(await old.call('check_inbox', {}))).toBe(STALE_AGENT);
    expect(textOf(await old.call('wait_for', { target: 'inbox', timeoutSec: 1 }))).toBe(STALE_AGENT);
    const unread = readStoredMap(project, workId).messages.filter((message) => message.readBy['s-01'] === undefined);
    expect(unread.map((message) => message.text)).toEqual(['новому агенту']);
  });

  it('wait_for, начатый до замены агента, не забирает письмо, пришедшее после неё', async () => {
    const old = runnerWith();
    const waiting = old.call('wait_for', { target: 'inbox', timeoutSec: 5 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setRevision('rev-new');
    await updateMap(project, workId, (_map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: 's-02', to: ['s-01'], text: 'после замены' });
    });
    const result = await waiting;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(STALE_AGENT);
    const unread = readStoredMap(project, workId).messages.filter((message) => message.readBy['s-01'] === undefined);
    expect(unread.map((message) => message.text)).toEqual(['после замены']);
  });

  it('чтение не огорожено', async () => {
    await setRevision('rev-new');
    const result = await runnerWith('rev-old').call('get_map', {});
    expect(result.isError).toBeFalsy();
    // get_capacity тоже только читает: прежний агент видит ёмкость машины.
    const capacity = await runnerWith('rev-old').call('get_capacity', {});
    expect(capacity.isError).toBeFalsy();
  });

  it('процесс нового агента с той же ревизией пишет', async () => {
    await setRevision('rev-new');
    const result = await runnerWith('rev-new').call('send_message', { to: 's-02', text: 'от нового' });
    expect(result.isError).toBeFalsy();
    expect(readStoredMap(project, workId).messages.map((message) => message.text)).toContain('от нового');
  });

  it('ревизия другой сессии не мешает: ограда сверяет только свою', async () => {
    await setRevision('rev-new');
    const result = await runnerWith(undefined, 's-02').call('send_message', { to: 's-01', text: 'коллеге' });
    expect(result.isError).toBeFalsy();
  });

  it('ревизия читается из окружения под обоими именами', () => {
    const dir = path.join(project, '.parley', 'works', 'w-0001');
    expect(contextFromEnv({ PARLEY_WORK_DIR: dir, PARLEY_AGENT_REVISION: 'rev-a' }).agentRevision).toBe('rev-a');
    expect(contextFromEnv({ HARNAS_WORK_DIR: dir, HARNAS_AGENT_REVISION: 'rev-b' }).agentRevision).toBe('rev-b');
    expect(contextFromEnv({ PARLEY_WORK_DIR: dir })).not.toHaveProperty('agentRevision');
  });
});

describe('finishedState при замене агента', () => {
  const base = { result: null, stuck: null, lifecycle: 'sleeping' } as unknown as WorkSession;

  it('переводимая сессия не считается уснувшей и застрявшей', () => {
    const switching = { id: 'req', to: 'custom-claude-2', since: '2026-10-30T00:00:00.000Z' };
    expect(finishedState({ ...base, switching })).toBeNull();
    expect(finishedState({ ...base, switching, stuck: { kind: 'limit' } } as unknown as WorkSession)).toBeNull();
  });

  it('без замены — как раньше', () => {
    expect(finishedState(base)).toBe('sleeping');
    expect(finishedState({ ...base, switching: null })).toBe('sleeping');
    expect(finishedState({ ...base, lifecycle: 'active' } as WorkSession)).toBeNull();
  });
});
