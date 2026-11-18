// packages/desktop/src/main/browser/agent-settle.test.ts
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_LIMITS } from '@parley/protocol';
import { changeOf, createAgentSettle } from './agent-settle.js';
import type { PageProbe } from './agent-settle.js';
import { PROBE_FN } from './page-fns.js';

const contents = { id: 7 } as unknown as WebContents;

interface Raw {
  n?: number;
  idle: number;
  ready?: string;
}

/**
 * Подставная страница: пробы отдаются по очереди (последняя повторяется), часы идут только от `sleep`.
 * `network` — записи журнала инспектора, `epoch` — его эпоха.
 */
function setup(options: { probes: Raw[]; network?: Array<{ epoch: number; ts: number; status?: number | null; failure?: unknown }>; epoch?: number; createFails?: boolean; callFailsOnce?: boolean }) {
  let clock = 10_000;
  let epoch = options.epoch ?? 1;
  const queue = [...options.probes];
  let callFailed = false;
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) throw signal.reason;
    sleeps.push(ms);
    clock += ms;
  });
  const send = vi.fn(async (_id: number, method: string): Promise<unknown> => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Page.createIsolatedWorld') {
      if (options.createFails === true) throw new Error('No frame');
      return { executionContextId: 40 + send.mock.calls.filter(([, name]) => name === 'Page.createIsolatedWorld').length };
    }
    if (method === 'Runtime.callFunctionOn') {
      if (options.callFailsOnce === true && !callFailed) {
        callFailed = true;
        throw new Error('Cannot find context with specified id');
      }
      const raw = queue.length > 1 ? (queue.shift() as Raw) : (queue[0] as Raw);
      return { result: { value: { n: raw.n ?? 0, idle: raw.idle, ready: raw.ready ?? 'complete' } } };
    }
    return {};
  });
  const snapshot = vi.fn(() => ({
    epoch,
    capture: 'on',
    console: [],
    network: (options.network ?? []).map((entry) => ({ status: null, failure: null, ...entry })),
  }));
  const settle = createAgentSettle({ inspector: { send, snapshot } as never, now: () => clock, sleep });
  return { settle, send, sleeps, sleep, setEpoch: (next: number) => { epoch = next; }, now: () => clock };
}

describe('agent-settle: проба в изолированном мире и ожидание затишья (спека 2026-11-18, 3.2)', () => {
  it('проба: мир создаётся по главному кадру, вызов — по executionContextId с PROBE_FN', async () => {
    const t = setup({ probes: [{ n: 3, idle: 40, ready: 'interactive' }] });
    expect(await t.settle.probe(contents)).toEqual({ n: 3, idle: 40, ready: 'interactive', world: 1 });
    expect(t.send).toHaveBeenCalledWith(7, 'Page.createIsolatedWorld', { frameId: 'main-frame', worldName: 'parley-agent' });
    expect(t.send).toHaveBeenCalledWith(7, 'Runtime.callFunctionOn', { functionDeclaration: PROBE_FN, executionContextId: 41, returnByValue: true });
  });

  it('мир запоминается по вкладке и эпохе: вторая проба его не создаёт, другая эпоха — создаёт заново', async () => {
    const t = setup({ probes: [{ idle: 0 }] });
    await t.settle.probe(contents);
    await t.settle.probe(contents);
    expect(t.send.mock.calls.filter(([, method]) => method === 'Page.createIsolatedWorld')).toHaveLength(1);
    t.setEpoch(2);
    const next = await t.settle.probe(contents);
    expect(t.send.mock.calls.filter(([, method]) => method === 'Page.createIsolatedWorld')).toHaveLength(2);
    expect(next?.world).toBe(2);
  });

  it('тихая страница (idle 150, запросов нет) — quiet отдаёт пробу сразу, sleep не зовётся', async () => {
    const t = setup({ probes: [{ n: 1, idle: 150 }] });
    expect(await t.settle.quiet(contents, new AbortController().signal)).toMatchObject({ n: 1, idle: 150 });
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('idle 10, затем 120 — один сон на остаток тишины (100 − 10 = 90 мс)', async () => {
    const t = setup({ probes: [{ idle: 10 }, { idle: 120 }] });
    const probe = await t.settle.quiet(contents, new AbortController().signal);
    expect(t.sleeps).toEqual([AGENT_LIMITS.settleQuietMs - 10]);
    expect(probe?.idle).toBe(120);
  });

  it('запрос текущей эпохи без ответа и моложе 1500 мс держит ожидание до потолка settleCapMs', async () => {
    const t = setup({ probes: [{ idle: 500 }], network: [{ epoch: 1, ts: 10_000 }] });
    const probe = await t.settle.quiet(contents, new AbortController().signal);
    expect(probe).not.toBeNull();
    const total = t.sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(AGENT_LIMITS.settleCapMs);
    expect(total).toBeLessThanOrEqual(AGENT_LIMITS.settleCapMs + 100);
  });

  it('запрос старше settleFreshRequestMs, прошлой эпохи, с ответом или с отказом — не держит', async () => {
    const stale = AGENT_LIMITS.settleFreshRequestMs + 1;
    const t = setup({
      probes: [{ idle: 500 }],
      network: [
        { epoch: 1, ts: 10_000 - stale },
        { epoch: 0, ts: 10_000 },
        { epoch: 1, ts: 10_000, status: 200 },
        { epoch: 1, ts: 10_000, failure: { reason: 'net::ERR_FAILED' } },
      ],
    });
    await t.settle.quiet(contents, new AbortController().signal);
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it("readyState 'loading' держит ожидание до смены", async () => {
    const t = setup({ probes: [{ idle: 500, ready: 'loading' }, { idle: 500, ready: 'complete' }] });
    const probe = await t.settle.quiet(contents, new AbortController().signal);
    expect(probe?.ready).toBe('complete');
    expect(t.sleeps).toHaveLength(1);
  });

  it('Page.createIsolatedWorld отказал — проба null, quiet тоже null и без сна', async () => {
    const t = setup({ probes: [{ idle: 0 }], createFails: true });
    expect(await t.settle.probe(contents)).toBeNull();
    expect(await t.settle.quiet(contents, new AbortController().signal)).toBeNull();
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('Runtime.callFunctionOn упал один раз — мир пересоздан, проба с новым номером мира', async () => {
    const t = setup({ probes: [{ n: 2, idle: 30 }], callFailsOnce: true });
    const probe = await t.settle.probe(contents);
    expect(probe).toMatchObject({ n: 2, world: 2 });
    expect(t.send.mock.calls.filter(([, method]) => method === 'Page.createIsolatedWorld')).toHaveLength(2);
  });

  it('обрыв signal во время сна — отказ с причиной сигнала', async () => {
    const t = setup({ probes: [{ idle: 10 }] });
    const abort = new AbortController();
    const reason = new Error('stopped');
    abort.abort(reason);
    await expect(t.settle.quiet(contents, abort.signal)).rejects.toBe(reason);
  });
});

describe('changeOf', () => {
  const probe = (n: number, world = 1): PageProbe => ({ n, idle: 0, ready: 'complete', world });

  it('переход главного фрейма — navigated, даже если пробы потеряны', () => {
    expect(changeOf(null, null, true)).toBe('navigated');
    expect(changeOf(probe(1), probe(1), true)).toBe('navigated');
  });

  it('любая проба потеряна — unknown, а не none', () => {
    expect(changeOf(null, probe(1), false)).toBe('unknown');
    expect(changeOf(probe(1), null, false)).toBe('unknown');
  });

  it('другой мир или другой счёт изменений — changed', () => {
    expect(changeOf(probe(1, 1), probe(1, 2), false)).toBe('changed');
    expect(changeOf(probe(1), probe(4), false)).toBe('changed');
  });

  it('тот же мир и тот же счёт — none', () => {
    expect(changeOf(probe(5), probe(5), false)).toBe('none');
  });
});
