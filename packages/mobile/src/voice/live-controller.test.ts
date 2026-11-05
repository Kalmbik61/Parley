import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhoneJob } from '@parley/protocol/remote';
import {
  createLiveController,
  idempotencyKeyOf,
  type LiveChannel,
  type LiveController,
  type LiveControllerDeps,
  type LiveMic,
  type LivePeer,
  type PhoneCallMap,
  type PhoneHostEvents,
} from './live-controller.js';
import type { VoiceEvent } from './voice-model.js';

const SESSION = 'sess_1';
const REMOTE_ID_RE = /^[\w.:-]{1,64}$/;

/** Все методы, которые контроллер звал за тест: по ним проверяется, что `cards.decide` и `jobs.cancel` не зовутся никогда. */
const called: string[] = [];
afterEach(() => {
  expect(called).not.toContain('cards.decide');
  expect(called).not.toContain('jobs.cancel');
  called.length = 0;
});

interface Harness {
  controller: LiveController;
  events: VoiceEvent[];
  channel: LiveChannel & { sent: Array<Record<string, unknown>>; open(): void };
  peer: LivePeer;
  mic: LiveMic & { stopped: boolean };
  calls: Array<{ method: string; params: unknown }>;
  call: ReturnType<typeof vi.fn>;
  hostEmit<E extends keyof PhoneHostEvents>(event: E, data: PhoneHostEvents[E]): void;
  /** Сообщение канала данных от Live. */
  live(message: Record<string, unknown>): void;
  advance(ms: number): void;
  clock(): number;
}

interface Options {
  prepare?: PhoneCallMap['voice.session.prepare']['result'];
  micFails?: boolean;
  /** Канал не открывается (проверка таймаута подключения). */
  neverOpens?: boolean;
}

function makeHarness(options: Options = {}): Harness {
  let at = 1_000_000;
  let eventCounter = 0;
  const timers: Array<{ id: number; due: number; callback: () => void }> = [];
  let timerId = 0;
  let tickCallback: () => void = () => {};
  const listeners: Record<string, Array<(data: never) => void>> = {};
  const calls: Harness['calls'] = [];
  const events: VoiceEvent[] = [];

  const channel = {
    readyState: 'open',
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    sent: [] as Array<Record<string, unknown>>,
    send(data: string) {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    },
    close: vi.fn(),
    open() {
      this.onopen?.();
    },
  };
  const peer: LivePeer = {
    connectionState: 'new',
    localDescription: { sdp: 'OFFER' },
    onconnectionstatechange: null,
    addTrack: vi.fn(),
    createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer', sdp: 'OFFER' }),
    setLocalDescription: async () => {},
    // Ответ SDP принят: канал открывается, как в живой сессии.
    setRemoteDescription: async () => {
      if (options.neverOpens !== true) queueMicrotask(() => channel.open());
    },
    close: vi.fn(),
  };
  const mic = { stopped: false, addTo: vi.fn(), stop() { this.stopped = true; } };

  const call = vi.fn(async (method: string, params: unknown) => {
    called.push(method);
    calls.push({ method, params });
    if (method === 'voice.session.prepare') return options.prepare ?? { ok: true, voiceSessionId: SESSION, sdpAnswer: 'ANSWER' };
    if (method === 'jobs.submit') return { jobId: 'job_1', revision: 1 };
    if (method === 'voice.session.close') return { closed: true };
    return { ok: true, deliveredInline: true, reason: 'acked' };
  });

  const deps: LiveControllerDeps = {
    call: call as unknown as LiveControllerDeps['call'],
    onHostEvent: ((event: string, listener: (data: never) => void) => {
      (listeners[event] ??= []).push(listener);
      return () => {
        listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
      };
    }) as unknown as LiveControllerDeps['onHostEvent'],
    openMic: async () => {
      if (options.micFails === true) throw new Error('denied');
      return mic;
    },
    createPeer: () => peer,
    now: () => at,
    setTimer: (callback, ms) => {
      timerId += 1;
      const id = timerId;
      timers.push({ id, due: at + ms, callback });
      return () => {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index !== -1) timers.splice(index, 1);
      };
    },
    setTick: (callback) => {
      tickCallback = callback;
      return () => {
        tickCallback = () => {};
      };
    },
    phrases: { detailsOnScreen: 'Details are on screen.', clarifying: 'Clarifying.' },
    fallbackText: '(not transcribed)',
    connectTimeoutMs: 15_000,
  };
  const controller = createLiveController(deps);
  controller.subscribe((event) => events.push(event));

  const advance = (ms: number): void => {
    // По шагам 250 мс: таймеры и тик идут в том порядке, в каком шли бы в приложении.
    for (let left = ms; left > 0; left -= 250) {
      at += Math.min(250, left);
      for (const timer of timers.filter((t) => t.due <= at)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
      }
      tickCallback();
    }
  };

  return {
    controller,
    events,
    channel,
    peer,
    mic,
    calls,
    call,
    hostEmit: (event, data) => {
      for (const listener of listeners[event] ?? []) listener(data as never);
    },
    live: (message) => {
      eventCounter += 1;
      channel.onmessage?.({ data: JSON.stringify({ event_id: `ev_${eventCounter}`, ...message }) });
    },
    advance,
    clock: () => at,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const delegationCreated = (id: string, offsetMs = 900) => ({ type: 'session.delegation.created', delegation: { id }, offset_ms: offsetMs });
const inputText = (delta: string, startMs = 0, endMs = 800) => ({ type: 'session.input_transcript.delta', delta, start_ms: startMs, end_ms: endMs });

function job(over: Partial<PhoneJob> & { delegationId?: string; voiceSessionId?: string } = {}): PhoneJob {
  const { delegationId = 'd1', voiceSessionId = SESSION, ...rest } = over;
  return {
    jobId: 'job_1',
    origin: 'mobile' as PhoneJob['origin'],
    state: 'completed',
    revision: 2,
    requestText: 'run tests',
    resultSummary: 'All tests passed.',
    provider: 'claude',
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    deliveredInline: false,
    correlation: { voiceSessionId, delegationId, turnId: delegationId },
    ...rest,
  };
}

async function started(options: Options = {}): Promise<Harness> {
  const h = makeHarness(options);
  const result = await h.controller.start();
  expect(result).toEqual({ ok: true, voiceSessionId: SESSION });
  return h;
}

const commentaries = (h: Harness): Array<Record<string, unknown>> => h.channel.sent.filter((m) => m['type'] === 'session.commentary.append');
const acks = (h: Harness): unknown[] => h.calls.filter((c) => c.method === 'jobs.ackInline').map((c) => c.params);

/** Подаёт делегацию с репликой и ждёт, пока мост отправит `jobs.submit`. */
async function delegate(h: Harness, id = 'd1', text = 'run tests'): Promise<void> {
  h.live(inputText(text));
  h.live(delegationCreated(id));
  await flush();
}

describe('idempotencyKeyOf', () => {
  it('детерминирован, проходит REMOTE_ID_RE, не обрезка и различает пары', () => {
    const long = 'sess_' + 'x'.repeat(120);
    const key = idempotencyKeyOf(long, 'delegation_' + 'y'.repeat(50));
    expect(key).toMatch(REMOTE_ID_RE);
    expect(idempotencyKeyOf(long, 'delegation_' + 'y'.repeat(50))).toBe(key);
    expect(idempotencyKeyOf(long, 'delegation_' + 'y'.repeat(49) + 'z')).not.toBe(key);
    expect(idempotencyKeyOf('a', 'bc')).not.toBe(idempotencyKeyOf('ab', 'c'));
    expect(key).not.toContain('xxxx');
  });
});

describe('start / ошибки подключения (f)', () => {
  it('успех: start → connected, фаза live, микрофон подключён к peer', async () => {
    const h = await started();
    expect(h.events.map((e) => e.type)).toEqual(['start', 'connected']);
    expect(h.controller.snapshot()).toMatchObject({ phase: 'live', voiceSessionId: SESSION });
    expect(h.mic.addTo).toHaveBeenCalledWith(h.peer);
    expect(h.calls[0]).toEqual({ method: 'voice.session.prepare', params: { sdp: 'OFFER' } });
  });

  it.each([
    ['no_key', 'fail'],
    ['busy', 'fail'],
    ['failed', 'fail'],
    ['limit_reached', 'limitReached'],
  ] as const)('ok:false с кодом %s → событие модели %s, ресурсы закрыты', async (code, modelEvent) => {
    const h = makeHarness({ prepare: { ok: false, code, message: 'host technical text' } });
    const result = await h.controller.start();
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain('technical');
    expect(h.events.map((e) => e.type)).toEqual(['start', modelEvent]);
    expect(h.mic.stopped).toBe(true);
    expect(h.controller.snapshot().phase).toBe('idle');
  });

  it('ошибка микрофона → код mic и fail', async () => {
    const h = makeHarness({ micFails: true });
    expect(await h.controller.start()).toMatchObject({ ok: false, code: 'mic' });
    expect(h.events.map((e) => e.type)).toEqual(['start', 'fail']);
    expect(h.calls).toEqual([]);
  });

  it('канал не открылся за таймаут → failed, сессия закрыта на хосте', async () => {
    const h = makeHarness({ neverOpens: true });
    const pending = h.controller.start();
    await flush();
    h.advance(15_000);
    expect(await pending).toMatchObject({ ok: false, code: 'failed' });
    expect(h.calls.map((c) => c.method)).toEqual(['voice.session.prepare', 'voice.session.close']);
    expect(h.events.map((e) => e.type)).toEqual(['start', 'fail']);
    expect(h.mic.stopped).toBe(true);
  });

  it('второй start во время сессии отклоняется без событий модели', async () => {
    const h = await started();
    const before = h.events.length;
    expect(await h.controller.start()).toMatchObject({ ok: false, code: 'busy' });
    expect(h.events.length).toBe(before);
  });
});

describe('делегация (a)', () => {
  it('один jobs.submit с верной correlation и ключом; повтор того же delegationId — без второго submit', async () => {
    const h = await started();
    await delegate(h, 'dlg_1');
    h.live(delegationCreated('dlg_1'));
    await flush();
    h.advance(3000);
    const submits = h.calls.filter((c) => c.method === 'jobs.submit');
    expect(submits).toHaveLength(1);
    const params = submits[0]?.params as { text: string; idempotencyKey: string; correlation: unknown };
    expect(params.text).toBe('run tests');
    expect(params.correlation).toEqual({ voiceSessionId: SESSION, delegationId: 'dlg_1', turnId: 'dlg_1' });
    expect(params.idempotencyKey).toBe(idempotencyKeyOf(SESSION, 'dlg_1'));
    expect(params.idempotencyKey).toMatch(REMOTE_ID_RE);
    expect(Object.keys(params).sort()).toEqual(['correlation', 'idempotencyKey', 'text']);
    expect(h.events.filter((e) => e.type === 'delegateStart')).toHaveLength(1);
  });

  it('повтор после потери ответа идёт с тем же ключом', async () => {
    const h = makeHarness();
    let attempts = 0;
    h.call.mockImplementation(async (method: string, params: unknown) => {
      called.push(method);
      h.calls.push({ method, params });
      if (method === 'voice.session.prepare') return { ok: true, voiceSessionId: SESSION, sdpAnswer: 'A' };
      if (method === 'jobs.submit') {
        attempts += 1;
        if (attempts === 1) throw new Error('lost');
        return { jobId: 'job_1', revision: 1 };
      }
      return { closed: true };
    });
    await h.controller.start();
    await delegate(h, 'dlg_1');
    h.advance(1000);
    await flush();
    const keys = h.calls.filter((c) => c.method === 'jobs.submit').map((c) => (c.params as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('jobs.changed другой сессии игнорируется', async () => {
    const h = await started();
    await delegate(h);
    h.hostEmit('jobs.changed', { job: job({ voiceSessionId: 'other_session' }) });
    h.advance(4000);
    expect(commentaries(h)).toHaveLength(0);
    expect(h.controller.snapshot().jobs).toEqual([]);
  });
});

describe('итог job (b, c)', () => {
  it('completed → commentary.append один раз; повтор той же ревизии ничего не добавляет', async () => {
    const h = await started();
    await delegate(h);
    h.hostEmit('jobs.changed', { job: job() });
    h.advance(4000);
    expect(commentaries(h)).toHaveLength(1);
    expect(commentaries(h)[0]).toMatchObject({ delegation_id: 'd1', content: 'All tests passed.' });
    h.hostEmit('jobs.changed', { job: job() });
    h.advance(10_000);
    expect(commentaries(h)).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'delegateEnd')).toHaveLength(1);
  });

  it('смена состояния открытого job → thinking.append со статусом', async () => {
    const h = await started();
    await delegate(h);
    h.hostEmit('jobs.changed', { job: job({ state: 'running', revision: 1, resultSummary: null }) });
    h.advance(4000);
    expect(h.channel.sent.filter((m) => m['type'] === 'session.thinking.append')).toHaveLength(1);
    expect(h.controller.snapshot().jobs).toHaveLength(1);
  });

  it('cancelled не озвучивается, даже если итог уже ждал в очереди', async () => {
    const h = await started();
    await delegate(h);
    h.live(inputText('keep talking', 900, 1100));
    h.hostEmit('jobs.changed', { job: job({ revision: 2 }) });
    h.hostEmit('jobs.changed', { job: job({ state: 'cancelled', revision: 3, resultSummary: null }) });
    h.advance(10_000);
    expect(commentaries(h)).toHaveLength(0);
    expect(h.events.filter((e) => e.type === 'delegateEnd')).toHaveLength(1);
  });

  it('событие с устаревшей ревизией не озвучивается', async () => {
    const h = await started();
    await delegate(h);
    h.hostEmit('jobs.changed', { job: job({ state: 'running', revision: 3, resultSummary: null }) });
    h.hostEmit('jobs.changed', { job: job({ state: 'completed', revision: 2, resultSummary: 'Old result.' }) });
    h.advance(10_000);
    expect(commentaries(h)).toHaveLength(0);
  });

  it('итог делегации, перекрытой новой в той же сессии, не озвучивается (stale)', async () => {
    const h = await started();
    await delegate(h, 'd1');
    h.live(inputText('now do another thing', 1000, 1800));
    h.live(delegationCreated('d2', 1900));
    await flush();
    h.hostEmit('jobs.changed', { job: job({ jobId: 'job_1', delegationId: 'd1' }) });
    h.advance(10_000);
    expect(commentaries(h)).toHaveLength(0);
    h.hostEmit('jobs.changed', { job: job({ jobId: 'job_2', delegationId: 'd2', resultSummary: 'Second done.' }) });
    h.advance(10_000);
    expect(commentaries(h)).toHaveLength(1);
    expect(commentaries(h)[0]).toMatchObject({ delegation_id: 'd2', content: 'Second done.' });
  });

  it('уже доставленный inline итог не озвучивается', async () => {
    const h = await started();
    await delegate(h);
    h.hostEmit('jobs.changed', { job: job({ deliveredInline: true }) });
    h.advance(10_000);
    expect(commentaries(h)).toHaveLength(0);
  });
});

describe('ackInline (d)', () => {
  async function spoken(h: Harness): Promise<void> {
    await delegate(h);
    h.hostEmit('jobs.changed', { job: job() });
    h.advance(4000);
    expect(commentaries(h)).toHaveLength(1);
    h.live({ type: 'session.commentary.appended', client_event_id: commentaries(h)[0]?.['event_id'] });
    await flush();
  }

  it('foreground и не mute → один ackInline с jobId и ревизией', async () => {
    const h = await started();
    await spoken(h);
    expect(acks(h)).toEqual([{ jobId: 'job_1', revision: 2 }]);
  });

  it('в фоне ackInline не уходит', async () => {
    const h = await started();
    h.controller.setForeground(false);
    await spoken(h);
    expect(acks(h)).toEqual([]);
  });

  it('при mute ackInline не уходит', async () => {
    const h = await started();
    h.controller.setMuted(true);
    await spoken(h);
    expect(acks(h)).toEqual([]);
  });

  it('appended для thinking ackInline не вызывает', async () => {
    const h = await started();
    h.live({ type: 'session.thinking.appended', client_event_id: 'x' });
    await flush();
    expect(acks(h)).toEqual([]);
  });
});

describe('stop и закрытие (e)', () => {
  it('stop() закрывает сессию на хосте, освобождает микрофон и peer, job не отменяет', async () => {
    const h = await started();
    await delegate(h);
    h.hostEmit('jobs.changed', { job: job({ state: 'running', revision: 1, resultSummary: null }) });
    await h.controller.stop();
    const methods = h.calls.map((c) => c.method);
    expect(methods).toContain('voice.session.close');
    expect(methods).not.toContain('jobs.cancel');
    expect(h.calls.find((c) => c.method === 'voice.session.close')?.params).toEqual({ voiceSessionId: SESSION });
    expect(h.mic.stopped).toBe(true);
    expect(h.peer.close).toHaveBeenCalled();
    expect(h.channel.close).toHaveBeenCalled();
    expect(h.events.at(-1)).toEqual({ type: 'stop' });
    expect(h.controller.snapshot()).toMatchObject({ phase: 'idle', voiceSessionId: null, jobs: [] });
  });

  it('voice.session.closed от хоста завершает сессию без повторного close', async () => {
    const h = await started();
    h.hostEmit('voice.session.closed', { voiceSessionId: SESSION, reason: 'idle_timeout' });
    expect(h.calls.map((c) => c.method)).not.toContain('voice.session.close');
    expect(h.events.at(-1)).toEqual({ type: 'stop' });
    expect(h.mic.stopped).toBe(true);
    // Событие чужой сессии ничего не делает.
    const other = await started();
    other.hostEmit('voice.session.closed', { voiceSessionId: 'other', reason: 'x' });
    expect(other.controller.snapshot().phase).toBe('live');
  });

  it('каждый конец сессии зовёт voice.session.close ровно один раз, кроме закрытия хостом', async () => {
    const closes = (h: Harness): number => h.calls.filter((c) => c.method === 'voice.session.close').length;
    const byChannel = await started();
    byChannel.channel.onclose?.();
    await flush();
    expect(closes(byChannel)).toBe(1);
    expect(byChannel.events.at(-1)).toEqual({ type: 'fail' });

    const byEvent = await started();
    byEvent.live({ type: 'session.closed', reason: 'limit' });
    byEvent.channel.onclose?.();
    await flush();
    expect(closes(byEvent)).toBe(1);

    const byHost = await started();
    byHost.hostEmit('voice.session.closed', { voiceSessionId: SESSION, reason: 'x' });
    byHost.channel.onclose?.();
    await flush();
    expect(closes(byHost)).toBe(0);

    const byStop = await started();
    await byStop.controller.stop();
    byStop.channel.onclose?.();
    expect(closes(byStop)).toBe(1);

    const byPeer = await started();
    byPeer.peer.connectionState = 'closed';
    byPeer.peer.onconnectionstatechange?.();
    await flush();
    expect(closes(byPeer)).toBe(1);
  });

  it('обрыв peer → fail; session.closed по каналу → stop', async () => {
    const lost = await started();
    lost.peer.connectionState = 'failed';
    lost.peer.onconnectionstatechange?.();
    expect(lost.events.at(-1)).toEqual({ type: 'fail' });
    expect(lost.calls.map((c) => c.method)).toContain('voice.session.close');

    const closed = await started();
    closed.live({ type: 'session.closed', reason: 'limit' });
    expect(closed.events.at(-1)).toEqual({ type: 'stop' });
  });

  it('stop() во время подключения: start завершается без сессии, микрофон освобождён', async () => {
    const h = makeHarness({ neverOpens: true });
    const pending = h.controller.start();
    await flush();
    await h.controller.stop();
    h.advance(15_000);
    expect(await pending).toMatchObject({ ok: false });
    expect(h.mic.stopped).toBe(true);
    expect(h.calls.map((c) => c.method)).toContain('voice.session.close');
    expect(h.events.filter((e) => e.type === 'stop')).toHaveLength(1);
  });
});

describe('сигналы речи', () => {
  it('транскрипт модели → speechStart, затем speechEnd после паузы; конец речи человека → thinking', async () => {
    const h = await started();
    h.live(inputText('hello'));
    h.advance(1000);
    expect(h.events.at(-1)).toEqual({ type: 'thinking' });
    h.live({ type: 'session.output_transcript.delta', delta: 'Hi', start_ms: 1000, end_ms: 1200 });
    expect(h.events.at(-1)).toEqual({ type: 'speechStart' });
    expect(h.controller.snapshot().modelPlaying).toBe(true);
    h.advance(1000);
    expect(h.events.at(-1)).toEqual({ type: 'speechEnd' });
    expect(h.controller.snapshot().modelPlaying).toBe(false);
  });
});

describe('приватность и (g) cards.decide', () => {
  it('ничего не пишет в консоль: ни SDP, ни тексты', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    const h = await started();
    await delegate(h);
    h.hostEmit('jobs.changed', { job: job() });
    h.advance(4000);
    await h.controller.stop();
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('полный сценарий (needs_confirmation, failed, итоги): cards.decide не зовётся (проверяет afterEach)', async () => {
    const h = await started();
    await delegate(h);
    h.hostEmit('jobs.changed', { job: job({ state: 'needs_confirmation', revision: 2, resultSummary: 'Send the message?' }) });
    h.advance(4000);
    h.hostEmit('jobs.changed', { job: job({ state: 'failed', revision: 3, resultSummary: 'Failed.' }) });
    h.advance(10_000);
    await h.controller.stop();
    expect(h.calls.every((c) => ['voice.session.prepare', 'jobs.submit', 'jobs.ackInline', 'voice.session.close'].includes(c.method))).toBe(true);
  });
});

describe('автозакрытие по тишине (M3)', () => {
  const closes = (h: Harness): number => h.calls.filter((c) => c.method === 'voice.session.close').length;
  const MIN = 60_000;

  it('3 минуты тишины без jobs → сессия закрыта один раз, событие stop', async () => {
    const h = await started();
    h.advance(3 * MIN - 1000);
    expect(closes(h)).toBe(0);
    h.advance(2000);
    await flush();
    expect(closes(h)).toBe(1);
    expect(h.events.at(-1)).toEqual({ type: 'stop' });
    expect(h.controller.snapshot().phase).toBe('idle');
    h.advance(5 * MIN);
    expect(closes(h)).toBe(1);
  });

  it('открытый job не даёт закрыть сессию; после итога и речи отсчёт идёт заново', async () => {
    const h = await started();
    await delegate(h);
    h.hostEmit('jobs.changed', { job: job({ state: 'running', revision: 1, resultSummary: null }) });
    h.advance(10 * MIN);
    expect(closes(h)).toBe(0);
    h.hostEmit('jobs.changed', { job: job({ state: 'completed', revision: 2 }) });
    h.advance(MIN);
    expect(closes(h)).toBe(0);
    h.advance(3 * MIN);
    await flush();
    expect(closes(h)).toBe(1);
  });

  it('недавняя речь сбрасывает отсчёт', async () => {
    const h = await started();
    h.advance(2 * MIN + 30_000);
    h.live(inputText('still here'));
    h.advance(2 * MIN + 30_000);
    expect(closes(h)).toBe(0);
    h.advance(MIN);
    await flush();
    expect(closes(h)).toBe(1);
  });
});

describe('причины закрытия (m1)', () => {
  it('daily_limit от хоста → limitReached, а не stop', async () => {
    const h = await started();
    h.hostEmit('voice.session.closed', { voiceSessionId: SESSION, reason: 'daily_limit' });
    expect(h.events.at(-1)).toEqual({ type: 'limitReached' });
  });

  it('daily_limit по каналу → limitReached', async () => {
    const h = await started();
    h.live({ type: 'session.closed', reason: 'daily_limit' });
    expect(h.events.at(-1)).toEqual({ type: 'limitReached' });
  });

  it('закрытие хостом во время подключения даёт ровно одно событие модели', async () => {
    const h = makeHarness({ neverOpens: true });
    const pending = h.controller.start();
    await flush();
    h.hostEmit('voice.session.closed', { voiceSessionId: SESSION, reason: 'daily_limit' });
    expect(await pending).toMatchObject({ ok: false });
    expect(h.events.map((e) => e.type)).toEqual(['start', 'limitReached']);
  });
});

describe('гонка двух start (m2)', () => {
  it('поздний отказ prepare первого start не разбирает сессию второго', async () => {
    const h = makeHarness();
    let rejectFirst: (error: Error) => void = () => {};
    let prepares = 0;
    h.call.mockImplementation(async (method: string, params: unknown) => {
      called.push(method);
      h.calls.push({ method, params });
      if (method === 'voice.session.prepare') {
        prepares += 1;
        if (prepares === 1) return new Promise((_, reject) => (rejectFirst = reject));
        return { ok: true, voiceSessionId: 'S2', sdpAnswer: 'A' };
      }
      return { closed: true };
    });
    const first = h.controller.start();
    await flush();
    await h.controller.stop();
    expect(await h.controller.start()).toEqual({ ok: true, voiceSessionId: 'S2' });
    rejectFirst(new Error('timeout'));
    expect(await first).toMatchObject({ ok: false });
    expect(h.controller.snapshot()).toMatchObject({ phase: 'live', voiceSessionId: 'S2' });
    expect(h.calls.filter((c) => c.method === 'voice.session.close')).toEqual([]);
  });

  it('поздний ok первого start после stop закрывается на хосте и не затирает сессию второго', async () => {
    const h = makeHarness();
    let resolveFirst: (value: unknown) => void = () => {};
    let prepares = 0;
    h.call.mockImplementation(async (method: string, params: unknown) => {
      called.push(method);
      h.calls.push({ method, params });
      if (method === 'voice.session.prepare') {
        prepares += 1;
        if (prepares === 1) return new Promise((resolve) => (resolveFirst = resolve));
        return { ok: true, voiceSessionId: 'S2', sdpAnswer: 'A' };
      }
      return { closed: true };
    });
    const first = h.controller.start();
    await flush();
    await h.controller.stop();
    await h.controller.start();
    resolveFirst({ ok: true, voiceSessionId: 'S1', sdpAnswer: 'A' });
    expect(await first).toMatchObject({ ok: false });
    expect(h.controller.snapshot()).toMatchObject({ phase: 'live', voiceSessionId: 'S2' });
    expect(h.calls.filter((c) => c.method === 'voice.session.close').map((c) => c.params)).toEqual([{ voiceSessionId: 'S1' }]);
  });
});

describe('stop() освобождает ресурсы до ответа хоста', () => {
  it('close без ответа: микрофон и peer закрыты сразу, close вызван один раз', async () => {
    const h = await started();
    h.call.mockImplementation(async (method: string, params: unknown) => {
      called.push(method);
      h.calls.push({ method, params });
      return new Promise(() => {});
    });
    await h.controller.stop();
    expect(h.mic.stopped).toBe(true);
    expect(h.peer.close).toHaveBeenCalled();
    expect(h.calls.filter((c) => c.method === 'voice.session.close')).toEqual([{ method: 'voice.session.close', params: { voiceSessionId: SESSION } }]);
    expect(h.events.at(-1)).toEqual({ type: 'stop' });
    expect(h.controller.snapshot().phase).toBe('idle');
  });
});
