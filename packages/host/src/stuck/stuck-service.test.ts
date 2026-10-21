import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMessage,
  addRoom,
  addSession,
  archiveRoom,
  backLetter,
  backLine,
  createWork,
  HUMAN,
  PARLEY,
  readMap,
  STUCK_REPORT_MS,
  stuckLetter,
  stuckLine,
  SYSTEM,
  transitionSession,
  updateMap,
  workPaths,
  type LimitAlternative,
  type Message,
  type NeedKind,
  type SessionNeed,
  type WorkMap,
  type WorkSession,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ActivityService, SessionLive } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { WorksService } from '../works/works-service.js';
import { createStuckService, stuckReportFromEnv } from './stuck-service.js';
import type { StuckServiceOptions } from './stuck-service.js';

let home = '';
let project = '';
let workId = '';
let cached: WorkMap;
let logErrors: string[] = [];
let stoppers: Array<() => void> = [];
let listeners: Array<(ref: SessionRef, value: SessionLive) => void> = [];

const START = '2026-10-22T12:00:00.000Z';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-stuck-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-stuck-project-'));
  process.env['PARLEY_HOME'] = home;
  logErrors = [];
  stoppers = [];
  listeners = [];
  // Часы и таймеры фальшивые, диск настоящий: `setImmediate` и `performance` остаются живыми.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date(START));
});

afterEach(async () => {
  for (const stop of stoppers) stop();
  vi.useRealTimers();
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------------------------
// Стенд
// ---------------------------------------------------------------------------------------------

const realTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Дать службе дописать то, что она начала: настоящие I/O карты, фальшивые таймеры. */
async function quiet(ms = 120): Promise<void> {
  const end = performance.now() + ms;
  do {
    await realTick();
  } while (performance.now() < end);
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const end = performance.now() + 5000;
  while (!(await check())) {
    if (performance.now() > end) throw new Error('не дождались условия');
    await realTick();
  }
}

/** Сдвинуть часы и таймеры на `ms`; службе остаётся время дописать карту. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await quiet();
}

function fakeHost(): HostContext {
  return {
    log: { info: () => {}, warn: () => {}, error: (message: string) => logErrors.push(message) },
  } as unknown as HostContext;
}

const fakeWorks = {
  entry: (projectPath: string) => ({ projectPath, map: cached }),
} as unknown as WorksService;

const fakeActivity = {
  onChange(listener: (ref: SessionRef, value: SessionLive) => void) {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((item) => item !== listener);
    };
  },
} as unknown as ActivityService;

const refOf = (sessionId: string): SessionRef => ({ projectPath: project, workId, sessionId });

async function refresh(): Promise<WorkMap> {
  cached = await readMap(project, workId);
  return cached;
}

/** Событие активности сессии с заданным `need`: как его публикует служба активности. */
function fire(sessionId: string, need: SessionNeed | null): void {
  const value = { activity: { activity: 'blocked', need }, metrics: null } as unknown as SessionLive;
  for (const listener of listeners) listener(refOf(sessionId), value);
}

/** То же, с свежим снимком работ и ожиданием, пока служба допишет карту. */
async function emit(sessionId: string, need: SessionNeed | null): Promise<void> {
  await refresh();
  fire(sessionId, need);
  await quiet();
}

const needOf = (kind: NeedKind, extra: Partial<SessionNeed> = {}): SessionNeed => ({
  kind,
  since: new Date().toISOString(),
  detail: null,
  resetsAt: null,
  window: null,
  account: null,
  ...extra,
});

/** Работа с тремя активными сессиями `claude`; `setup` дополняет карту (комнаты, письма). */
async function makeWork(
  setup: (map: WorkMap, ids: [string, string, string]) => void = () => {},
  provider = 'claude',
): Promise<[string, string, string]> {
  const created = await createWork(project, { title: 'Работа' });
  workId = created.work.id;
  let ids: [string, string, string] = ['', '', ''];
  await updateMap(project, workId, (map) => {
    const made = [0, 1, 2].map((index) => {
      const session = addSession(map, { provider, label: `сессия ${index}`, task: 'сделать' });
      transitionSession(map, session.id, 'active');
      return session.id;
    });
    ids = [made[0] ?? '', made[1] ?? '', made[2] ?? ''];
    setup(map, ids);
  });
  await refresh();
  return ids;
}

function boot(options: StuckServiceOptions = {}): { stop(): void } {
  const service = createStuckService(fakeHost(), fakeWorks, fakeActivity, options);
  service.start();
  stoppers.push(() => service.stop());
  return service;
}

const sessionOf = (map: WorkMap, id: string): WorkSession => {
  const found = map.sessions.find((session) => session.id === id);
  if (found === undefined) throw new Error(`нет сессии ${id}`);
  return found;
};

const lines = (map: WorkMap): Message[] => map.messages.filter((message) => message.from === SYSTEM);
const letters = (map: WorkMap): Message[] => map.messages.filter((message) => message.from === PARLEY);
const whoOf = (id: string, provider = 'Claude Code'): { id: string; provider: string } => ({ id, provider });
const stuckOf = async (id: string): Promise<SessionNeed | null | undefined> =>
  sessionOf(await readMap(project, workId), id).stuck;

const inRoom = (lead: string, ...others: string[]) => (map: WorkMap) => {
  addRoom(map, { title: 'Комната', creator: HUMAN, members: [lead, ...others], lead });
};

/** Часы на `ms` после начала теста. */
const after = (ms: number): Date => new Date(Date.parse(START) + ms);

// ---------------------------------------------------------------------------------------------
// Пороги
// ---------------------------------------------------------------------------------------------

describe('служба «застрял» — пороги (спека застрявших 3.5, 4.4)', () => {
  it('одобрение: на 90 с карта нетронута, на 130 с — stuck, строка в комнате и письмо ведущему', async () => {
    const [lead, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot();
    const need = needOf('approval', { detail: 'npm install' });
    await emit(worker, need);

    await advance(90_000);
    let map = await readMap(project, workId);
    expect(sessionOf(map, worker).stuck ?? null).toBeNull();
    expect(map.messages).toHaveLength(0);

    await advance(40_000);
    await until(async () => (await stuckOf(worker)) != null);
    map = await readMap(project, workId);
    const at = after(STUCK_REPORT_MS);
    expect(sessionOf(map, worker).stuck).toEqual(need);
    expect(lines(map).map((line) => line.text)).toEqual([stuckLine(whoOf(worker), need, at, false)]);
    expect(lines(map)[0]?.to).toEqual([HUMAN]);
    expect(letters(map)).toHaveLength(1);
    expect(letters(map)[0]).toMatchObject({
      from: PARLEY,
      to: [lead],
      roomId: 'r-01',
      kind: 'note',
      text: stuckLetter(whoOf(worker), need, at),
    });
  });

  it('короткие эпизоды не копятся: три по 60 с с паузами — ни stuck, ни сообщений', async () => {
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot();
    for (let round = 0; round < 3; round += 1) {
      await emit(worker, needOf('approval', { detail: `команда ${round}` }));
      await advance(60_000);
      await emit(worker, null);
      await advance(20_000);
    }
    await advance(200_000);
    const map = await readMap(project, workId);
    expect(sessionOf(map, worker).stuck ?? null).toBeNull();
    expect(map.messages).toHaveLength(0);
  });

  it('вопрос — тот же порог 2 минуты; reportMs из опций перекрывает его (рычаг E2E)', async () => {
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot({ reportMs: 200 });
    await emit(worker, needOf('question'));
    await advance(150);
    expect((await stuckOf(worker)) ?? null).toBeNull();
    await advance(100);
    await until(async () => (await stuckOf(worker)) != null);
    expect((await stuckOf(worker))?.kind).toBe('question');
  });

  it('лимит, вход и экран старта — сразу, без ожидания порога', async () => {
    for (const kind of ['limit', 'sign-in', 'startup'] as const) {
      const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
      boot();
      const need = needOf(kind, { detail: kind === 'sign-in' ? 'Not logged in' : null, account: kind === 'sign-in' ? 'auth' : null });
      await emit(worker, need);
      await until(async () => (await stuckOf(worker)) != null);
      expect(await stuckOf(worker), kind).toEqual(need);
      expect(lines(await readMap(project, workId)), kind).toHaveLength(1);
      stoppers.pop()?.();
      listeners = [];
    }
  });

  it('эпизод по сессии и виду, а не по точному since: since сменился — таймер не перезапущен', async () => {
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot();
    await emit(worker, needOf('approval', { detail: 'первая' }));
    await advance(60_000);
    const latest = needOf('approval', { detail: 'вторая', since: after(60_001).toISOString() });
    await emit(worker, latest);
    await advance(59_000);
    expect((await stuckOf(worker)) ?? null).toBeNull();
    await advance(2_000);
    await until(async () => (await stuckOf(worker)) != null);
    // Доклад — по последнему значению эпизода, одним письмом.
    expect(await stuckOf(worker)).toEqual(latest);
    expect(letters(await readMap(project, workId))).toHaveLength(1);
  });

  it('вопрос → одобрение внутри эпизода: эпизод не открывается заново (спека 3.5)', async () => {
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot();
    await emit(worker, needOf('question'));
    await advance(30_000);
    await emit(worker, needOf('approval', { detail: 'rm -rf build' }));
    await advance(91_000);
    await until(async () => (await stuckOf(worker)) != null);
    expect((await stuckOf(worker))?.kind).toBe('approval');
    expect(letters(await readMap(project, workId))).toHaveLength(1);
  });

  it('stop() снимает таймеры: после него доклада нет', async () => {
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    const service = boot();
    await emit(worker, needOf('approval'));
    service.stop();
    await advance(200_000);
    const map = await readMap(project, workId);
    expect(sessionOf(map, worker).stuck ?? null).toBeNull();
    expect(map.messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Доклад: комната, получатели, письма
// ---------------------------------------------------------------------------------------------

describe('служба «застрял» — доклад (спека застрявших 5.2, 8)', () => {
  it('лимит: строка в комнате и письмо с альтернативами; провайдер называется по реестру', async () => {
    const [lead, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    const alternative: LimitAlternative = { id: 'custom-x', label: 'Claude Code X', limits: null };
    const asked: string[] = [];
    boot({
      alternatives: async (provider) => {
        asked.push(provider);
        return [alternative];
      },
    });
    const need = needOf('limit', { resetsAt: after(3_600_000).toISOString(), window: 'session' });
    await emit(worker, need);
    await until(async () => (await stuckOf(worker)) != null);
    const map = await readMap(project, workId);
    expect(asked).toEqual(['claude']);
    expect(lines(map).map((line) => line.text)).toEqual([stuckLine(whoOf(worker), need, after(0), false)]);
    expect(letters(map).map((letter) => [letter.to, letter.text])).toEqual([
      [[lead], stuckLetter(whoOf(worker), need, after(0), [alternative])],
    ]);
    expect(letters(map)[0]?.text).toContain('Claude Code X');
  });

  it('альтернативы спрашивают только у лимита; их сбой письма не отменяет', async () => {
    const [, worker, third] = await makeWork((map, [a, b, c]) => inRoom(a, b, c)(map));
    let calls = 0;
    boot({
      alternatives: async () => {
        calls += 1;
        throw new Error('реестр сломан');
      },
    });
    await emit(worker, needOf('sign-in', { detail: 'Not logged in', account: 'auth' }));
    await until(async () => (await stuckOf(worker)) != null);
    expect(calls).toBe(0);

    const need = needOf('limit');
    await emit(third, need);
    await until(async () => (await stuckOf(third)) != null);
    expect(calls).toBe(1);
    const map = await readMap(project, workId);
    expect(letters(map).at(-1)?.text).toBe(stuckLetter(whoOf(third), need, after(0), []));
    expect(logErrors).toHaveLength(1);
  });

  it('аккаунт называется по label реестра (`custom-providers.json`), а не по id', async () => {
    await writeFile(
      path.join(home, 'custom-providers.json'),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: 'custom-x',
            label: 'Claude Code X',
            preset: null,
            baseUrl: 'https://api.example.com/anthropic',
            auth: 'bearer',
            models: { opus: 'm-big', sonnet: 'm-mid', haiku: 'm-small', subagent: 'm-mid' },
            contextWindow: null,
            linkClaude: true,
          },
        ],
      }),
    );
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map), 'custom-x');
    boot({ alternatives: async () => [] });
    const need = needOf('limit');
    await emit(worker, need);
    await until(async () => (await stuckOf(worker)) != null);
    const map = await readMap(project, workId);
    expect(lines(map)[0]?.text).toBe(stuckLine(whoOf(worker, 'Claude Code X'), need, after(0), false));
    expect(lines(map)[0]?.text).toContain('Claude Code X usage limit');
  });

  it('застрял ведущий: письма только отправителям непрочитанных, не человеку и не системе; строка с хвостом про «Make lead»', async () => {
    const [lead, worker, third] = await makeWork((map, [a, b, c]) => {
      inRoom(a, b, c)(map);
      addMessage(map, { from: b, to: [a], text: 'жду твоего ответа' });
      addMessage(map, { from: HUMAN, to: [a], text: 'человек писал' });
      addMessage(map, { from: SYSTEM, to: [a], text: 'система писала' });
    });
    boot({ alternatives: async () => [] });
    const need = needOf('limit', { resetsAt: after(7_200_000).toISOString() });
    await emit(lead, need);
    await until(async () => (await stuckOf(lead)) != null);
    const map = await readMap(project, workId);
    const line = lines(map).find((item) => item.text.includes('usage limit'));
    expect(line?.text).toBe(stuckLine(whoOf(lead), need, after(0), true));
    expect(line?.text).toContain('leads this room');
    const sent = letters(map);
    expect(sent.map((letter) => letter.to)).toEqual([[worker]]);
    expect(sent.some((letter) => letter.to.includes(third))).toBe(false);
    expect(sent[0]?.roomId).toBe('r-01');
  });

  it('получатели: ведущий и отправитель непрочитанных — каждый один раз, без самой сессии и без закрытых', async () => {
    const [lead, worker, third] = await makeWork((map, [a, b, c]) => {
      inRoom(a, b, c)(map);
      addMessage(map, { from: c, to: [b], text: 'ответь мне' });
      addMessage(map, { from: a, to: [b], text: 'и мне' });
      addMessage(map, { from: c, to: [b], text: 'ещё раз' });
      transitionSession(map, c, 'closed');
    });
    boot();
    await emit(worker, needOf('approval'));
    await advance(STUCK_REPORT_MS + 1_000);
    await until(async () => (await stuckOf(worker)) != null);
    const sent = letters(await readMap(project, workId));
    expect(sent.map((letter) => letter.to)).toEqual([[lead]]);
    expect(sent.some((letter) => letter.to.includes(third))).toBe(false);
  });

  it('нет комнаты: письма без комнаты только отправителям непрочитанных, строки в ленте нет', async () => {
    const [first, second, third] = await makeWork((map, [a, , c]) => {
      addMessage(map, { from: a, to: [c], text: 'ответь мне' });
      addMessage(map, { from: HUMAN, to: [c], text: 'человек' });
    });
    boot({ alternatives: async () => [] });
    const need = needOf('limit');
    await emit(third, need);
    await until(async () => (await stuckOf(third)) != null);
    const map = await readMap(project, workId);
    expect(lines(map)).toHaveLength(0);
    const sent = letters(map);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: PARLEY,
      to: [first],
      roomId: null,
      kind: 'note',
      text: stuckLetter(whoOf(third), need, after(0), []),
    });
    expect(sent.some((letter) => letter.to.includes(second))).toBe(false);
  });

  it('архивная комната: stuck записан, ни строки, ни писем', async () => {
    const [, worker] = await makeWork((map, [a, b]) => {
      inRoom(a, b)(map);
      addMessage(map, { from: a, to: [b], text: 'до архива' });
      archiveRoom(map, 'r-01');
    });
    const before = (await readMap(project, workId)).messages.length;
    boot({ alternatives: async () => [] });
    const need = needOf('limit');
    await emit(worker, need);
    await until(async () => (await stuckOf(worker)) != null);
    const map = await readMap(project, workId);
    expect(sessionOf(map, worker).stuck).toEqual(need);
    expect(map.messages).toHaveLength(before);
  });

  it('сбой updateMap — строка в логе, без исключения наружу', async () => {
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot({ alternatives: async () => [] });
    await rm(workPaths(project, workId).dir, { recursive: true, force: true });
    fire(worker, needOf('limit'));
    await quiet();
    expect(logErrors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Смена внутри эпизода и конец
// ---------------------------------------------------------------------------------------------

describe('служба «застрял» — смена внутри эпизода и конец (спека застрявших 4.4, 8)', () => {
  it('после доклада появилось время сброса: stuck обновлён, писем нет', async () => {
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot({ alternatives: async () => [] });
    await emit(worker, needOf('limit'));
    await until(async () => (await stuckOf(worker)) != null);
    const before = (await readMap(project, workId)).messages.length;

    const later = needOf('limit', { resetsAt: after(1_800_000).toISOString(), window: 'week' });
    await emit(worker, later);
    await until(async () => (await stuckOf(worker))?.resetsAt != null);
    const map = await readMap(project, workId);
    expect(sessionOf(map, worker).stuck).toEqual(later);
    expect(map.messages).toHaveLength(before);
  });

  it('лимит кончился: строка «back» и письмо «back» тем же получателям, stuck снят', async () => {
    const [lead, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot({ alternatives: async () => [] });
    await emit(worker, needOf('limit'));
    await until(async () => (await stuckOf(worker)) != null);

    await emit(worker, null);
    await until(async () => (await stuckOf(worker)) === null);
    const map = await readMap(project, workId);
    expect(lines(map).map((line) => line.text).at(-1)).toBe(backLine(worker, 'limit'));
    expect(letters(map).at(-1)).toMatchObject({ to: [lead], roomId: 'r-01', text: backLetter(worker, 'limit') });
  });

  it('вход и экран старта: «back» тоже с письмом', async () => {
    for (const kind of ['sign-in', 'startup'] as const) {
      const [lead, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
      boot();
      await emit(worker, needOf(kind, { account: kind === 'sign-in' ? 'auth' : null }));
      await until(async () => (await stuckOf(worker)) != null);
      await emit(worker, null);
      await until(async () => (await stuckOf(worker)) === null);
      const map = await readMap(project, workId);
      expect(lines(map).at(-1)?.text, kind).toBe(backLine(worker, kind));
      expect(letters(map).at(-1), kind).toMatchObject({ to: [lead], text: backLetter(worker, kind) });
      stoppers.pop()?.();
      listeners = [];
    }
  });

  it('события подряд, без ожидания между ними, идут по порядку: доклад, затем «back»', async () => {
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot({ alternatives: async () => [] });
    const need = needOf('limit');
    fire(worker, need);
    fire(worker, null);
    await until(async () => lines(await readMap(project, workId)).length === 2);
    const map = await readMap(project, workId);
    expect(lines(map).map((line) => line.text)).toEqual([
      stuckLine(whoOf(worker), need, after(0), false),
      backLine(worker, 'limit'),
    ]);
    expect(sessionOf(map, worker).stuck).toBeNull();
  });

  it('одобрение после доклада: только строка «back», письма нет', async () => {
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot();
    await emit(worker, needOf('approval', { detail: 'npm install' }));
    await advance(STUCK_REPORT_MS + 1_000);
    await until(async () => (await stuckOf(worker)) != null);
    const lettersBefore = letters(await readMap(project, workId)).length;

    await emit(worker, null);
    await until(async () => (await stuckOf(worker)) === null);
    const map = await readMap(project, workId);
    expect(lines(map).at(-1)?.text).toBe(backLine(worker, 'approval'));
    expect(letters(map)).toHaveLength(lettersBefore);
  });

  it('спящая или закрытая сессия: stuck снимается молча', async () => {
    for (const lifecycle of ['sleeping', 'closed'] as const) {
      const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
      boot({ alternatives: async () => [] });
      await emit(worker, needOf('limit'));
      await until(async () => (await stuckOf(worker)) != null);
      const before = (await readMap(project, workId)).messages.length;

      await updateMap(project, workId, (map) => {
        transitionSession(map, worker, lifecycle);
      });
      await emit(worker, null);
      await until(async () => (await stuckOf(worker)) === null);
      expect((await readMap(project, workId)).messages, lifecycle).toHaveLength(before);
      stoppers.pop()?.();
      listeners = [];
    }
  });

  it('другой вид внутри эпизода (лимит → вход): новый доклад без «back» о прежнем', async () => {
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot({ alternatives: async () => [] });
    await emit(worker, needOf('limit'));
    await until(async () => (await stuckOf(worker)) != null);

    const signedOut = needOf('sign-in', { detail: 'Not logged in', account: 'auth' });
    await emit(worker, signedOut);
    await until(async () => (await stuckOf(worker))?.kind === 'sign-in');
    const map = await readMap(project, workId);
    expect(lines(map).map((line) => line.text)).toEqual([
      stuckLine(whoOf(worker), needOf('limit'), after(0), false),
      stuckLine(whoOf(worker), signedOut, after(0), false),
    ]);
    expect(lines(map).some((line) => line.text.includes('is back'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Сверка после старта хоста
// ---------------------------------------------------------------------------------------------

describe('служба «застрял» — сверка по первому onChange сессии (спека застрявших 4.4, 8.3)', () => {
  /** Карта, в которой хост до перезапуска уже доложил о `stuck` (строка и письмо лежат в ленте). */
  async function reported(stuck: SessionNeed) {
    const ids = await makeWork((map, all) => inRoom(all[0], all[1])(map));
    await updateMap(project, workId, (map) => {
      sessionOf(map, ids[1]).stuck = stuck;
    });
    await refresh();
    return ids;
  }

  it('в карте stuck и та же need: ни одного нового сообщения', async () => {
    const need = needOf('limit', { resetsAt: after(3_600_000).toISOString() });
    const [, worker] = await reported(need);
    const before = (await readMap(project, workId)).messages.length;
    boot({ alternatives: async () => [] });
    await emit(worker, need);
    await advance(STUCK_REPORT_MS * 2);
    const map = await readMap(project, workId);
    expect(map.messages).toHaveLength(before);
    expect(sessionOf(map, worker).stuck).toEqual(need);
  });

  it('эпизод принимается по виду, не по since: since сдвинулся — писем нет, stuck обновлён', async () => {
    const [, worker] = await reported(needOf('approval', { detail: 'старая команда' }));
    const before = (await readMap(project, workId)).messages.length;
    boot();
    const shifted = needOf('approval', { detail: 'старая команда', since: after(-600_000).toISOString() });
    await emit(worker, shifted);
    await advance(STUCK_REPORT_MS * 2);
    await until(async () => (await stuckOf(worker))?.since === shifted.since);
    expect((await readMap(project, workId)).messages).toHaveLength(before);
  });

  it('stuck есть, need нет у живой на первой сверке: stuck снят молча — ни строки, ни письма (решение 12)', async () => {
    for (const kind of ['limit', 'sign-in', 'approval'] as const) {
      const [, worker] = await reported(needOf(kind));
      const before = (await readMap(project, workId)).messages.length;
      boot();
      await emit(worker, null);
      await until(async () => (await stuckOf(worker)) === null);
      await quiet();
      const map = await readMap(project, workId);
      expect(map.messages, kind).toHaveLength(before);
      expect(lines(map), kind).toHaveLength(0);
      expect(letters(map), kind).toHaveLength(0);
      stoppers.pop()?.();
      listeners = [];
    }
  });

  it('stuck есть, need нет у спящей или закрытой: stuck снят молча', async () => {
    for (const lifecycle of ['sleeping', 'closed'] as const) {
      const [, worker] = await reported(needOf('limit'));
      await updateMap(project, workId, (map) => {
        transitionSession(map, worker, lifecycle);
      });
      const before = (await readMap(project, workId)).messages.length;
      boot();
      await emit(worker, null);
      await until(async () => (await stuckOf(worker)) === null);
      expect((await readMap(project, workId)).messages, lifecycle).toHaveLength(before);
      stoppers.pop()?.();
      listeners = [];
    }
  });

  it('need есть, а stuck нет: новый эпизод по порогам', async () => {
    const [, worker] = await makeWork((map, [a, b]) => inRoom(a, b)(map));
    boot();
    await emit(worker, needOf('approval', { since: after(-30_000).toISOString() }));
    await advance(STUCK_REPORT_MS - 1_000);
    expect((await stuckOf(worker)) ?? null).toBeNull();
    await advance(2_000);
    await until(async () => (await stuckOf(worker)) != null);
  });

  it('сверка — один раз на сессию: следующая активность идёт по обычным правилам', async () => {
    const need = needOf('limit');
    const [, worker] = await reported(need);
    boot({ alternatives: async () => [] });
    await emit(worker, need);
    await emit(worker, null);
    await until(async () => (await stuckOf(worker)) === null);
    expect(lines(await readMap(project, workId)).at(-1)?.text).toBe(backLine(worker, 'limit'));
  });
});

// ---------------------------------------------------------------------------------------------
// Рычаг E2E
// ---------------------------------------------------------------------------------------------

describe('stuckReportFromEnv — рычаг E2E', () => {
  it('целое от 100 мс до десяти минут принимается', () => {
    expect(stuckReportFromEnv({ PARLEY_STUCK_REPORT_MS: '1500' })).toBe(1500);
    expect(stuckReportFromEnv({ PARLEY_STUCK_REPORT_MS: ' 100 ' })).toBe(100);
    expect(stuckReportFromEnv({ PARLEY_STUCK_REPORT_MS: '600000' })).toBe(600_000);
  });

  it('прежнее имя HARNAS_STUCK_REPORT_MS читается как запасное; PARLEY_* главнее', () => {
    expect(stuckReportFromEnv({ HARNAS_STUCK_REPORT_MS: '1500' })).toBe(1500);
    expect(stuckReportFromEnv({ PARLEY_STUCK_REPORT_MS: '200', HARNAS_STUCK_REPORT_MS: '1500' })).toBe(200);
  });

  it('нет переменной, пустая, не число, дробная, слишком малая или большая — игнорируется', () => {
    for (const value of [undefined, '', ' ', 'много', '1.5', '99', '600001', '-5']) {
      expect(stuckReportFromEnv(value === undefined ? {} : { PARLEY_STUCK_REPORT_MS: value }), String(value)).toBeUndefined();
    }
  });
});
