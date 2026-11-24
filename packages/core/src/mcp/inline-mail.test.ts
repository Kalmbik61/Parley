import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { addSession } from '../work/map.js';
import { createWork, readStoredMap, updateMap, workPaths } from '../work/store.js';
import { HUMAN } from '../work/types.js';
import type { McpContext } from './context.js';
import { createToolRunner, INLINE_MAIL_LINE, INLINE_MAIL_MAX_CHARS, STALE_AGENT, takeInlineMail } from './tools.js';

/** Письма вместе с указателем (`takeInlineMail`): та же страница и пометка, что у `check_inbox`, в пределе символов. */

let home = '';
let project = '';
let workId = '';

const contextOf = (sessionId: string, agentRevision?: string): McpContext => ({
  projectPath: project,
  workId,
  workDir: workPaths(project, workId).dir,
  sessionId,
  channel: false,
  messageRate: DEFAULT_CONFIG.messageRate,
  ...(agentRevision === undefined ? {} : { agentRevision }),
});

/** Письмо сессии s-01 сессии s-02: прямое, не из комнаты. */
const say = (text: string): Promise<unknown> =>
  updateMap(project, workId, (_map, letters) => {
    letters.add({ kind: 'note', from: 's-01', to: ['s-02'], text, roomId: null });
  });

const unreadBy = (sessionId: string): number => readStoredMap(project, workId).messages.filter((m) => m.readBy[sessionId] === undefined).length;

const pageOf = (text: string): { messages: { text: string; roomTask?: { role: string } }[]; remaining?: number; hint?: string } =>
  JSON.parse(text.slice(INLINE_MAIL_LINE.length + 1));

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  workId = (await createWork(project, { title: 'Работа', goal: '' })).work.id;
  await updateMap(project, workId, (map) => {
    for (const label of ['лид', 'бэк', 'ревью']) addSession(map, { provider: 'claude', label, task: 'делать' });
  });
});

afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('takeInlineMail', () => {
  it('два письма: строка и компактный JSON с обоими, письма прочитаны, текст в пределе', async () => {
    await say('первое');
    await say('второе');
    const taken = takeInlineMail(contextOf('s-02'), 's-02')!;
    expect(taken.letters).toBe(2);
    expect(taken.text.startsWith(`${INLINE_MAIL_LINE}\n`)).toBe(true);
    expect(taken.text.length).toBeLessThanOrEqual(INLINE_MAIL_MAX_CHARS);
    const json = taken.text.slice(INLINE_MAIL_LINE.length + 1);
    expect(json).not.toContain('\n');
    expect(json).toBe(JSON.stringify(JSON.parse(json)));
    expect(pageOf(taken.text).messages.map((m) => m.text)).toEqual(['первое', 'второе']);
    expect(unreadBy('s-02')).toBe(0);
  });

  it('писем больше, чем влезает: остаток и подсказка есть, лишние остаются непрочитанными', async () => {
    for (const index of [1, 2, 3, 4, 5]) await say(`${index}:${'ж'.repeat(3000)}`);
    const taken = takeInlineMail(contextOf('s-02'), 's-02')!;
    expect(taken.text.length).toBeLessThanOrEqual(INLINE_MAIL_MAX_CHARS);
    const page = pageOf(taken.text);
    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.messages.length).toBeLessThan(5);
    expect(page.remaining).toBe(5 - page.messages.length);
    expect(page.hint).toContain('more unread: call check_inbox again.');
    expect(unreadBy('s-02')).toBe(5 - page.messages.length);
  });

  it('одно письмо, не влезающее в предел, урезается, а не теряется', async () => {
    await say('"\\\n'.repeat(20_000));
    const taken = takeInlineMail(contextOf('s-02'), 's-02')!;
    expect(taken.letters).toBe(1);
    expect(taken.text.length).toBeLessThanOrEqual(INLINE_MAIL_MAX_CHARS);
    expect(pageOf(taken.text).messages).toHaveLength(1);
    expect(unreadBy('s-02')).toBe(0);
  });

  it('непрочитанного нет: null', () => {
    expect(takeInlineMail(contextOf('s-02'), 's-02')).toBeNull();
  });

  it('устаревшая ревизия агента: исключение, письма не помечены', async () => {
    await say('письмо');
    await updateMap(project, workId, (map) => {
      map.sessions.find((session) => session.id === 's-02')!.agentRevision = 'rev-new';
    });
    expect(() => takeInlineMail(contextOf('s-02', 'rev-old'), 's-02')).toThrow(STALE_AGENT);
    expect(unreadBy('s-02')).toBe(1);
    // Тот же запуск, но с верной ревизией, письмо получает.
    expect(takeInlineMail(contextOf('s-02', 'rev-new'), 's-02')?.letters).toBe(1);
  });

  it('сессию усыпляют (ограда): null, письма не помечены', async () => {
    await say('письмо');
    await updateMap(project, workId, (map) => {
      map.sessions.find((session) => session.id === 's-02')!.autoSleepPending = { at: '2026-11-11T10:00:00.000Z' } as never;
    });
    expect(takeInlineMail(contextOf('s-02'), 's-02')).toBeNull();
    expect(unreadBy('s-02')).toBe(1);
  });

  it('задача человека всем в комнате: roomTask остаётся в доставленной странице', async () => {
    const runner = createToolRunner({ ...contextOf('s-01') });
    const created = await runner.call('create_room', { title: 'комната', members: ['s-01', 's-02', 's-03'], lead: 's-01' });
    expect(created.isError).toBeFalsy();
    // Приглашение в комнату — тоже письмо: читаем его, как это делает агент.
    takeInlineMail(contextOf('s-02'), 's-02');
    await updateMap(project, workId, (_map, letters) => {
      letters.add({ kind: 'note', from: HUMAN, to: [], text: 'Делаем вход', roomId: 'r-01' });
    });
    const page = pageOf(takeInlineMail(contextOf('s-02'), 's-02')!.text);
    const task = page.messages.find((m) => m.text === 'Делаем вход');
    expect(task?.roomTask?.role).toBe('member');
  });
});
