/**
 * Операция `open` агента в main (спека браузера 2026-10-07, 3.7, 5.1–5.2, 7; этап B2): проверки доступа и адреса, просьба окну,
 * перевод его ответа в ответ агенту. Окно подменено: проверяется логика main, а раскладку и тост проверяют тесты рендерера.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BrowserAgentOpEvent, BrowserAgentOpenResult, BrowserAgentOwner, BrowserAgentResult } from '@parley/protocol';
import type { AgentOpenTab, AgentOpenTabResult } from '../../shared/browser-types.js';
import { workKey } from '../../shared/work-keys.js';
import { createAgentOps, loopbackHref, NOT_MOUNTED_NOTE, type AgentOps } from './agent-ops.js';

const REF = { projectPath: '/proj', workId: 'w-1', sessionId: 's-02' };
const OTHER_REF = { projectPath: '/proj', workId: 'w-2', sessionId: 's-01' };
const WORK = workKey(REF.projectPath, REF.workId);
const OTHER_WORK = workKey(OTHER_REF.projectPath, OTHER_REF.workId);
const PAGE = 'http://localhost:5173/form';
const OWN = { kind: 'session', sessionId: 's-02' } as const;
const room = (roomId: string): BrowserAgentOwner => ({ kind: 'room', roomId });

/** Окно отвечает на просьбу своим ответом (если он задан) сразу после неё, как ответил бы рендерер. */
function setup(overrides: { allowed?: boolean; reply?: AgentOpenTabResult | null; sent?: boolean; openMs?: number; owners?: BrowserAgentOwner[] } = {}) {
  const asked: AgentOpenTab[] = [];
  const state = { allowed: overrides.allowed ?? true, reply: overrides.reply === undefined ? { tabId: 'browser:aaaaaa', reused: false, mounted: true } : overrides.reply };
  const openTab = vi.fn((e: AgentOpenTab): boolean => {
    asked.push(e);
    if (overrides.sent === false) return false;
    if (state.reply !== null) {
      const reply = state.reply;
      queueMicrotask(() => ops.openTabResult(e.requestId, reply));
    }
    return true;
  });
  const ops: AgentOps = createAgentOps({ agentsAllowed: async () => state.allowed, openTab, ...(overrides.openMs === undefined ? {} : { openMs: overrides.openMs }) });
  const owners = overrides.owners ?? [OWN];
  const run = (args: unknown, ref = REF, op = 'open'): Promise<BrowserAgentResult> =>
    ops.run({ opId: 'op-1', ref, label: ref.sessionId === 's-02' ? 'S02' : 'S01', owners, op: op as BrowserAgentOpEvent['op'], args });
  return { ops, run, asked, openTab, state };
}

const codeOf = (result: BrowserAgentResult): string => (result.ok ? 'ok' : result.error.code);
const messageOf = (result: BrowserAgentResult): string => (result.ok ? '' : result.error.message);
function okResult(result: BrowserAgentResult): BrowserAgentOpenResult {
  if (!result.ok) throw new Error(`операция отказала: ${result.error.code} ${result.error.message}`);
  return result.result as BrowserAgentOpenResult;
}

describe('open (спека 5.1 browser_open)', () => {
  it('просьба окну — работа из ref события, адрес, сессия и её номер; ответ агенту — id вкладки t1, адрес, reused и заметки', async () => {
    const { run, asked } = setup();
    expect(okResult(await run({ url: PAGE }))).toEqual({ tab: 't1', owner: OWN, url: PAGE, reused: false, notes: [] });
    expect(asked).toEqual([{ requestId: expect.any(String) as unknown as string, workKey: WORK, url: PAGE, sessionId: 's-02', session: 'S02', owner: OWN }]);
  });

  it('id вкладок — свой счёт у каждой работы и стабильный: та же вкладка — тот же id, новая — следующий, другая работа — снова t1', async () => {
    const { run, state } = setup();
    expect(okResult(await run({ url: PAGE })).tab).toBe('t1');
    state.reply = { tabId: 'browser:bbbbbb', reused: false, mounted: true };
    expect(okResult(await run({ url: 'http://localhost:5173/other' })).tab).toBe('t2');
    state.reply = { tabId: 'browser:aaaaaa', reused: true, mounted: true };
    expect(okResult(await run({ url: PAGE }))).toMatchObject({ tab: 't1', reused: true });
    state.reply = { tabId: 'browser:cccccc', reused: false, mounted: true };
    expect(okResult(await run({ url: PAGE }, OTHER_REF)).tab).toBe('t1');
  });

  it('работу назвать нельзя: лишнее поле аргументов — bad_request, окну ничего; ключ работы берётся из ref', async () => {
    const { run, asked } = setup();
    expect(codeOf(await run({ url: PAGE, workKey: OTHER_WORK }))).toBe('bad_request');
    expect(codeOf(await run({ url: PAGE, tab: 't1' }))).toBe('bad_request');
    expect(codeOf(await run({}))).toBe('bad_request');
    expect(codeOf(await run({ url: '' }))).toBe('bad_request');
    expect(asked).toEqual([]);
    await run({ url: PAGE }, OTHER_REF);
    expect(asked.map((e) => e.workKey)).toEqual([OTHER_WORK]);
  });

  it('Фокус ревью 2: не loopback и обходные записи — not_loopback, окну ничего', async () => {
    const { run, asked } = setup();
    for (const url of [
      'https://example.com/',
      'http://localhost.evil.test/',
      'http://127.0.0.1.nip.io/',
      'http://0.0.0.0:5173/',
      'http://192.168.1.10:5173/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost@evil.com/',
      'file:///etc/hosts',
      'javascript:alert(1)',
      'data:text/html,x',
      'localhost:5173',
      '/relative',
      'not a url',
    ]) {
      expect(codeOf(await run({ url })), url).toBe('not_loopback');
    }
    expect(asked).toEqual([]);
  });

  it('адрес уходит окну без учётных данных, с фрагментом (маршрут SPA) и в виде, как его запишет раскладка', async () => {
    const { run, asked } = setup();
    expect(okResult(await run({ url: 'http://user:pw@LOCALHOST:5173/a?b=1#/route' })).url).toBe('http://localhost:5173/a?b=1#/route');
    expect(asked[0]?.url).toBe('http://localhost:5173/a?b=1#/route');
    expect(loopbackHref('http://127.1/')).toBe('http://127.0.0.1/');
    expect(loopbackHref('https://example.com/')).toBeNull();
  });

  it('общий выключатель «Let agents use the browser» — access_denied, окну ничего', async () => {
    const { run, asked } = setup({ allowed: false });
    const result = await run({ url: PAGE });
    expect(codeOf(result)).toBe('access_denied');
    expect(messageOf(result)).toContain('Let agents use the browser');
    expect(asked).toEqual([]);
  });

  it('неизвестная операция — unsupported', async () => {
    const { run, asked } = setup();
    expect(codeOf(await run({ code: '1' }, REF, 'evaluate'))).toBe('unsupported');
    expect(asked).toEqual([]);
  });

  it('предел вкладок — bad_request с советом; работы нет в окне — window_not_connected', async () => {
    const limit = setup({ reply: { error: 'limit' } });
    const refused = await limit.run({ url: PAGE });
    expect(codeOf(refused)).toBe('bad_request');
    expect(messageOf(refused)).toContain('10 browser tabs');
    const noWork = setup({ reply: { error: 'no_work' } });
    const unknown = await noWork.run({ url: PAGE });
    expect(codeOf(unknown)).toBe('window_not_connected');
    expect(messageOf(unknown)).toContain('try again in a moment');
  });

  it('работа не смонтирована — вкладка добавлена, ответ ok с заметкой, а не отказ', async () => {
    const { run } = setup({ reply: { tabId: 'browser:aaaaaa', reused: false, mounted: false } });
    expect(okResult(await run({ url: PAGE }))).toEqual({ tab: 't1', owner: OWN, url: PAGE, reused: false, notes: [NOT_MOUNTED_NOTE] });
  });
});

describe('open: выбор хозяина (спека 5.1, 3.10)', () => {
  const ownerAsked = async (owners: BrowserAgentOwner[], args: Record<string, unknown>) => {
    const { run, asked } = setup({ owners });
    const result = await run({ url: PAGE, ...args });
    return { result, owner: asked[0]?.owner, asked };
  };

  it('без own и room: комнат нет — браузер своего чата', async () => {
    const { result, owner } = await ownerAsked([OWN], {});
    expect(owner).toEqual(OWN);
    expect(okResult(result).owner).toEqual(OWN);
  });

  it('без own и room: ровно одна комната — её браузер; две — браузер своего чата', async () => {
    const one = await ownerAsked([OWN, room('r-01')], {});
    expect(one.owner).toEqual(room('r-01'));
    expect(okResult(one.result).owner).toEqual(room('r-01'));
    const two = await ownerAsked([OWN, room('r-01'), room('r-02')], {});
    expect(two.owner).toEqual(OWN);
  });

  it('own: true — браузер чата, даже если сессия в одной комнате', async () => {
    expect((await ownerAsked([OWN, room('r-01')], { own: true })).owner).toEqual(OWN);
  });

  it('own: false ведёт себя как без own', async () => {
    expect((await ownerAsked([OWN, room('r-01')], { own: false })).owner).toEqual(room('r-01'));
  });

  it('room из owners — браузер этой комнаты, даже когда комнат две', async () => {
    const { owner } = await ownerAsked([OWN, room('r-01'), room('r-02')], { room: 'r-02' });
    expect(owner).toEqual(room('r-02'));
  });

  it('room вне owners — access_denied, окну ничего', async () => {
    const { result, asked } = await ownerAsked([OWN, room('r-01')], { room: 'r-09' });
    expect(codeOf(result)).toBe('access_denied');
    expect(messageOf(result)).toContain('r-09');
    expect(asked).toEqual([]);
  });

  it('own вместе с room — bad_request, окну ничего', async () => {
    const { result, asked } = await ownerAsked([OWN, room('r-01')], { own: true, room: 'r-01' });
    expect(codeOf(result)).toBe('bad_request');
    expect(asked).toEqual([]);
  });

  it('в owners нет самой сессии — access_denied; хост без owners вовсе — unsupported', async () => {
    const noSelf = await ownerAsked([room('r-01')], {});
    expect(codeOf(noSelf.result)).toBe('access_denied');
    expect(noSelf.asked).toEqual([]);
    const { ops } = setup();
    const old = await ops.run({ opId: 'op-1', ref: REF, label: 'S02', op: 'open', args: { url: PAGE } } as unknown as BrowserAgentOpEvent);
    expect(codeOf(old)).toBe('unsupported');
  });
});

describe('окно ушло или молчит (Фокус ревью, п. 4)', () => {
  it('окна нет (просьба не ушла) и окно закрылось посреди вызова — window_not_connected сразу', async () => {
    const none = setup({ sent: false });
    expect(codeOf(await none.run({ url: PAGE }))).toBe('window_not_connected');
    const ops = createAgentOps({
      agentsAllowed: async () => true,
      openTab: () => {
        throw new Error('Object has been destroyed');
      },
    });
    const result = await ops.run({ opId: 'op-1', ref: REF, label: 'S02', owners: [OWN], op: 'open', args: { url: PAGE } });
    expect(codeOf(result)).toBe('window_not_connected');
  });

  it('окно молчит — timeout через openMs; поздний ответ ничего не ломает и ничего не принимает', async () => {
    const { run, ops, asked } = setup({ reply: null, openMs: 30 });
    expect(codeOf(await run({ url: PAGE }))).toBe('timeout');
    expect(() => ops.openTabResult(asked[0]?.requestId ?? '', { tabId: 'browser:late00', reused: false, mounted: true })).not.toThrow();
    expect(() => ops.openTabResult('never-asked', { error: 'limit' })).not.toThrow();
  });

  it('ответ на чужую просьбу не закрывает другую: каждая ждёт свой requestId', async () => {
    const { run, ops, asked } = setup({ reply: null, openMs: 200 });
    const first = run({ url: PAGE });
    const second = run({ url: 'http://localhost:5173/second' });
    await Promise.resolve();
    expect(asked).toHaveLength(2);
    ops.openTabResult(asked[1]?.requestId ?? '', { tabId: 'browser:bbbbbb', reused: false, mounted: true });
    expect(okResult(await second).url).toBe('http://localhost:5173/second');
    ops.openTabResult(asked[0]?.requestId ?? '', { tabId: 'browser:aaaaaa', reused: false, mounted: true });
    expect(okResult(await first).url).toBe(PAGE);
  });
});
