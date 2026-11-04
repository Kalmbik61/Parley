import { describe, expect, it, vi } from 'vitest';
import type { AssistantRequestView } from '@parley/protocol';
import type { LiveCallPhase, LiveControllerEvent } from './controller.js';
import { createLiveDelegation, LIVE_CONSUMER_ID, toResultInput } from './delegation.js';

const PHRASES = { detailsOnScreen: 'Details are on the screen.', clarifying: 'Say you are clarifying.' };

function view(patch: Partial<AssistantRequestView> & { job?: Partial<AssistantRequestView['job']> } = {}): AssistantRequestView {
  const { job, ...rest } = patch;
  return {
    requestId: 'req-1',
    originKey: '["vs-1","d1"]',
    conversationId: 'island',
    seq: 1,
    version: 1,
    text: 'what is in the rooms',
    context: null,
    jobId: 'job-1',
    supersededBy: null,
    transcriptPartial: false,
    delivery: {},
    link: null,
    gate: 'open',
    heldSince: null,
    heldBy: null,
    stale: false,
    createdAt: 0,
    updatedAt: 0,
    job: { jobId: 'job-1', state: 'running', revision: 1, resultSummary: null, result: null, ...job },
    ...rest,
  };
}

const done = (answer = 'Two rooms are waiting for you: Design review and Billing migration.'): Partial<AssistantRequestView['job']> => ({
  state: 'completed',
  revision: 4,
  result: { answer, capturedAt: 1, cards: [], toolRefs: [] },
});

function setup(initial: { phase?: LiveCallPhase; list?: AssistantRequestView[] } = {}) {
  let now = 1_000_000;
  let phase: LiveCallPhase = initial.phase ?? 'idle';
  let voiceSessionId: string | null = phase === 'idle' ? null : 'vs-1';
  const signals = { humanSpeaking: false, modelPlaying: false };
  const listeners = new Set<(event: LiveControllerEvent) => void>();
  const appends: Array<{ kind: string; delegationId: string | null; content: string }> = [];
  const stops: Array<string | undefined> = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  let list = initial.list ?? [];
  const submitted: AssistantRequestView[] = [];
  const hostListeners = new Map<string, () => void>();
  const timers: Array<{ at: number; cb: () => void; live: boolean }> = [];
  let tickCallback: (() => void) | null = null;

  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === 'requests.list') return { requests: list };
    if (method === 'requests.submit') {
      const request = view({ requestId: `req-${submitted.length + 1}`, jobId: `job-${submitted.length + 1}`, text: (params as { text: string }).text });
      submitted.push(request);
      list = [...list, request];
      return { request, created: true };
    }
    if (method === 'requests.ack') return { ok: true, reason: 'acked' };
    return { ok: true };
  });
  const delegation = createLiveDelegation({
    controller: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      snapshot: () => ({ phase, voiceSessionId, ...signals }),
      sendAppend: (input) => {
        appends.push(input);
        return true;
      },
      stop: async (reason) => {
        stops.push(reason);
      },
    },
    call: call as never,
    onHostEvent: ((name: string, handler: () => void) => {
      hostListeners.set(name, handler);
      return () => void hostListeners.delete(name);
    }) as never,
    now: () => now,
    setTimer: (cb, ms) => {
      const timer = { at: now + ms, cb, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    setTick: (cb) => {
      tickCallback = cb;
      return () => void (tickCallback = null);
    },
    phrases: PHRASES,
    fallbackText: '(not transcribed)',
  });
  const emit = (event: LiveControllerEvent): void => {
    if (event.type === 'phase') phase = event.phase;
    if (event.type === 'humanSpeaking') signals.humanSpeaking = event.value;
    if (event.type === 'modelPlaying') signals.modelPlaying = event.value;
    for (const listener of [...listeners]) listener(event);
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  const advance = async (ms: number): Promise<void> => {
    const target = now + ms;
    while (now < target) {
      const step = Math.min(250, target - now);
      now += step;
      for (const timer of timers.filter((t) => t.live && t.at <= now)) {
        timer.live = false;
        timer.cb();
      }
      tickCallback?.();
      await flush();
    }
  };
  const open = (): void => {
    voiceSessionId = 'vs-1';
    emit({ type: 'phase', phase: 'connecting' });
    emit({ type: 'phase', phase: 'live' });
  };
  const human = (text: string, startMs: number, endMs: number): void => emit({ type: 'inputTranscript', text, startMs, endMs });
  return {
    delegation, appends, stops, calls, commentary: () => appends.filter((append) => append.kind === 'commentary'), statuses: () => appends.filter((append) => append.kind === 'thinking'), emit, advance, flush, open, human, submitted, hostListeners,
    setList: (next: AssistantRequestView[]) => void (list = next),
    callsOf: (method: string) => calls.filter((entry) => entry.method === method),
  };
}

describe('toResultInput', () => {
  it('берёт answer, иначе резюме; доставку в Live определяет по ревизии', () => {
    expect(toResultInput(view({ job: done('A.') }), 'd1')).toMatchObject({ text: 'A.', state: 'completed', revision: 4, deliveredLive: false, delegationId: 'd1' });
    expect(toResultInput(view({ job: { state: 'completed', revision: 4, resultSummary: 'S.' } }), null).text).toBe('S.');
    expect(toResultInput(view({ job: done(), delivery: { [LIVE_CONSUMER_ID]: 4 } }), null).deliveredLive).toBe(true);
    expect(toResultInput(view({ delivery: { [LIVE_CONSUMER_ID]: 4 } }), null).deliveredLive).toBe(false);
  });
});

describe('createLiveDelegation', () => {
  it('поручение уходит в requests.submit с разговором острова, id сессии и делегации, контекстом', async () => {
    const h = setup({ phase: 'live' });
    h.human('What is in the', 0, 1000);
    h.human(' rooms?', 1000, 2000);
    h.emit({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 2000 });
    await h.flush();
    const [submit] = h.callsOf('requests.submit');
    expect(submit?.params).toMatchObject({ conversationId: 'island', voiceSessionId: 'vs-1', delegationId: 'd1', text: 'What is in the rooms?', transcriptPartial: false });
    expect((submit?.params as { context: object }).context).toHaveProperty('recentTurns');
  });

  it('VA-01: подтверждение слышно, затем итог в паузе → commentary.append с delegation_id и requests.ack', async () => {
    const h = setup({ phase: 'live' });
    h.human('Check the rooms', 0, 1000);
    h.emit({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 1000 });
    await h.flush();
    h.emit({ type: 'modelPlaying', value: true }); // «Сейчас проверю»
    await h.advance(1200);
    h.emit({ type: 'modelPlaying', value: false });
    h.setList([view({ requestId: 'req-1', job: done() })]);
    h.hostListeners.get('assistant.job.changed')?.();
    await h.advance(1500);
    expect(h.commentary()).toEqual([{ kind: 'commentary', delegationId: 'd1', content: expect.stringContaining('Two rooms are waiting') }]);
    expect(h.callsOf('requests.ack')[0]?.params).toEqual({ requestId: 'req-1', consumer: 'live', revision: 4 });
  });

  it('подтверждение так и не прозвучало: append откладывается не дольше 2,5 с', async () => {
    const h = setup({ phase: 'live' });
    h.human('Check the rooms', 0, 1000);
    h.emit({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 1000 });
    await h.flush();
    h.setList([view({ requestId: 'req-1', job: done() })]);
    h.hostListeners.get('assistant.job.changed')?.();
    await h.advance(2000);
    expect(h.commentary()).toHaveLength(0);
    await h.advance(1500);
    expect(h.commentary()).toHaveLength(1);
  });

  it('VA-02: человек перебил озвучку → карточка на экране, jobs.ackInline, повторной отправки нет', async () => {
    const h = setup({ phase: 'live', list: [view({ job: done() })] });
    await h.flush();
    await h.advance(1000);
    expect(h.appends).toHaveLength(1);
    h.emit({ type: 'modelPlaying', value: true });
    h.emit({ type: 'outputTranscript', text: 'Two rooms', startMs: 0, endMs: 200 });
    await h.advance(500);
    h.emit({ type: 'humanSpeaking', value: true });
    await h.flush();
    expect(h.delegation.results()).toEqual([{ requestId: 'req-1', text: expect.stringContaining('Two rooms'), kind: 'card' }]);
    expect(h.callsOf('jobs.ackInline')[0]?.params).toEqual({ jobId: 'job-1', revision: 4 });
    h.delegation.dismiss('req-1');
    expect(h.delegation.results()).toEqual([]);
    await h.advance(5000);
    expect(h.appends).toHaveLength(1);
  });

  it('VA-03: stale и held — не озвучены; held показывается строкой, stale нет', async () => {
    const h = setup({ phase: 'live', list: [view({ gate: 'held', heldSince: 1_000_000, job: done() })] });
    await h.flush();
    await h.advance(3000);
    expect(h.appends).toHaveLength(0);
    expect(h.delegation.results()).toEqual([{ requestId: 'req-1', text: '', kind: 'held' }]);
    h.setList([view({ gate: 'open', stale: true, supersededBy: 'req-2', job: done() })]);
    await h.advance(2000);
    expect(h.appends).toHaveLength(0);
    expect(h.delegation.results()).toEqual([]);
    expect(h.delegation.items()[0]?.speech).toBe('dropped');
  });

  it('ворота держатся 15 с: одна реплика «уточняю», итог не выпускается', async () => {
    const h = setup({ phase: 'live', list: [view({ gate: 'held', heldSince: 1_000_000, job: done() })] });
    await h.flush();
    await h.advance(16_000);
    expect(h.appends).toEqual([{ kind: 'commentary', delegationId: null, content: PHRASES.clarifying }]);
    await h.advance(10_000);
    expect(h.appends).toHaveLength(1);
  });

  it('VA-04: два независимых Request — оба доставлены', async () => {
    const h = setup({ phase: 'live' });
    for (const [id, offset] of [['d1', 1000], ['d2', 5000]] as const) {
      h.human(`Question ${id}`, offset - 1000, offset);
      h.emit({ type: 'delegationCreated', delegationId: id, offsetMs: offset });
      await h.flush();
    }
    expect(h.submitted).toHaveLength(2);
    h.emit({ type: 'modelPlaying', value: true });
    await h.advance(500);
    h.emit({ type: 'modelPlaying', value: false });
    await h.advance(500);
    h.emit({ type: 'modelPlaying', value: true });
    await h.advance(500);
    h.emit({ type: 'modelPlaying', value: false });
    h.setList([
      view({ requestId: 'req-1', jobId: 'job-1', job: done('Rooms are quiet today.') }),
      view({ requestId: 'req-2', jobId: 'job-2', job: { ...done('Builds are green today.'), jobId: 'job-2' } }),
    ]);
    h.hostListeners.get('assistant.job.changed')?.();
    await h.advance(1500);
    expect(h.commentary().map((append) => append.delegationId)).toEqual(['d1']);
    h.emit({ type: 'modelPlaying', value: true });
    h.emit({ type: 'outputTranscript', text: 'Rooms are quiet today', startMs: 0, endMs: 200 });
    await h.advance(1500);
    h.emit({ type: 'modelPlaying', value: false });
    await h.advance(3000);
    expect(h.commentary().map((append) => append.delegationId)).toEqual(['d1', 'd2']);
    expect(h.callsOf('requests.ack').map((entry) => (entry.params as { requestId: string }).requestId)).toEqual(['req-1', 'req-2']);
  });

  it('VA-07: новая сессия получает недоставленные итоги с delegation_id = null', async () => {
    const h = setup({ list: [view({ job: done('Result from before the drop.') })] });
    await h.flush();
    h.open();
    await h.advance(1500);
    expect(h.callsOf('requests.list')[0]?.params).toEqual({ conversationId: 'island', consumer: 'live' });
    expect(h.appends).toEqual([{ kind: 'commentary', delegationId: null, content: 'Result from before the drop.' }]);
  });

  it('уже доставленный в Live итог не отправляется второй раз', async () => {
    const h = setup({ phase: 'live', list: [view({ delivery: { live: 4 }, job: done() })] });
    await h.flush();
    await h.advance(3000);
    expect(h.appends).toHaveLength(0);
  });

  it('закрытие голоса не отменяет job: итог остаётся карточкой', async () => {
    const h = setup({ phase: 'live', list: [view({ job: done() })] });
    await h.flush();
    await h.advance(1000);
    expect(h.appends).toHaveLength(1);
    h.emit({ type: 'sessionClosed', reason: 'close_requested' });
    h.emit({ type: 'phase', phase: 'idle' });
    await h.flush();
    expect(h.delegation.results()).toEqual([{ requestId: 'req-1', text: expect.any(String), kind: 'card' }]);
    expect(h.calls.map((entry) => entry.method).filter((method) => /cancel/.test(method))).toEqual([]);
  });

  it('dispose отписывается от всего', async () => {
    const h = setup({ phase: 'live' });
    h.delegation.dispose();
    expect(h.hostListeners.size).toBe(0);
    h.human('late', 0, 100);
    h.emit({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 100 });
    await h.advance(3000);
    expect(h.submitted).toHaveLength(0);
  });
});

describe('createLiveDelegation: статус (T6, VA-06)', () => {
  it('смена состояния открытого Request → thinking.append с delegation_id, временем и возрастом; job не запускается заново', async () => {
    const h = setup({ phase: 'live' });
    h.human('Check the rooms', 0, 1000);
    h.emit({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 1000 });
    await h.advance(500);
    // Прогресс своей делегации уходит сразу, не дожидаясь подтверждения.
    expect(h.statuses()).toEqual([{ kind: 'thinking', delegationId: 'd1', content: expect.stringMatching(/^Status as of \d\d:\d\d: still working on the request "Check the rooms", started \d+ (second|minute)s? ago\. No result yet\.$/) }]);
    expect(h.statuses()[0]?.content).not.toMatch(/\b(req|job|d)-?\d+\b/);
    // «Ну что там?» — делегации нет, значит и нового Request: статус уже у модели.
    await h.advance(5000);
    expect(h.callsOf('requests.submit')).toHaveLength(1);
    expect(h.submitted).toHaveLength(1);
  });

  it('дросселирование: повторные события job в том же состоянии статус не плодят; новое состояние — новый статус', async () => {
    const h = setup({ phase: 'live', list: [view({ job: { state: 'queued' } })] });
    await h.advance(500);
    expect(h.statuses()).toHaveLength(1);
    expect(h.statuses()[0]?.content).toContain('waiting in line');
    for (let i = 0; i < 3; i += 1) {
      h.hostListeners.get('assistant.job.changed')?.();
      await h.advance(500);
    }
    expect(h.statuses()).toHaveLength(1);
    h.setList([view({ job: { state: 'running', revision: 2 } })]);
    h.hostListeners.get('assistant.job.changed')?.();
    await h.advance(500);
    expect(h.statuses()).toHaveLength(2);
    expect(h.statuses()[1]?.content).toContain('still working');
    // Итог идёт очередью речи, а не статусом.
    h.setList([view({ job: done() })]);
    h.hostListeners.get('assistant.job.changed')?.();
    await h.advance(3000);
    expect(h.statuses()).toHaveLength(2);
    expect(h.commentary()).toHaveLength(1);
  });

  it('правило подтверждений: статус без привязки к делегации ждёт чужого подтверждения, но не дольше 2,5 с', async () => {
    const h = setup({ phase: 'live' });
    h.human('Check the rooms', 0, 1000);
    h.emit({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 1000 });
    await h.advance(250);
    expect(h.statuses().map((append) => append.delegationId)).toEqual(['d1']);
    // Request прежней сессии (делегации не знаем) появился, пока d1 ждёт подтверждения.
    h.setList([view({ requestId: 'req-old', jobId: 'job-old', text: 'earlier question', job: { jobId: 'job-old', state: 'running' } }), ...h.submitted]);
    h.hostListeners.get('assistant.job.changed')?.();
    await h.advance(1500);
    expect(h.statuses().map((append) => append.delegationId)).toEqual(['d1']);
    await h.advance(1500);
    expect(h.statuses().map((append) => append.delegationId)).toEqual(['d1', null]);
    expect(h.statuses()[1]?.content).toContain('earlier question');
  });

  it('вытесненный Request статуса не получает', async () => {
    const h = setup({ phase: 'live', list: [view({ stale: true, supersededBy: 'req-2' })] });
    await h.advance(3000);
    expect(h.statuses()).toEqual([]);
  });

  it('новая сессия получает статус открытого Request заново', async () => {
    const h = setup({ phase: 'live', list: [view()] });
    await h.advance(500);
    expect(h.statuses()).toHaveLength(1);
    h.emit({ type: 'sessionClosed', reason: 'close_requested' });
    h.emit({ type: 'phase', phase: 'idle' });
    await h.advance(500);
    h.open();
    await h.advance(1500);
    expect(h.statuses()).toHaveLength(2);
    expect(h.statuses()[1]?.delegationId).toBeNull();
  });
});

describe('createLiveDelegation: автозакрытие (T6, VA-12)', () => {
  const MIN = 60_000;

  it('3 минуты тишины без открытых Request и речи в очереди → закрытие один раз, причина idle_timeout', async () => {
    const h = setup({ phase: 'live' });
    await h.advance(3 * MIN - 1000);
    expect(h.stops).toEqual([]);
    await h.advance(2000);
    expect(h.stops).toEqual(['idle_timeout']);
    await h.advance(3 * MIN);
    expect(h.stops).toEqual(['idle_timeout']);
  });

  it('открытый Request держит сессию; после его завершения и озвучки отсчёт идёт заново', async () => {
    const h = setup({ phase: 'live', list: [view()] });
    await h.advance(5 * MIN);
    expect(h.stops).toEqual([]);
    h.setList([view({ delivery: { live: 4 }, job: done() })]);
    h.hostListeners.get('assistant.job.changed')?.();
    await h.advance(3 * MIN - 2000);
    expect(h.stops).toEqual([]);
    await h.advance(4000);
    expect(h.stops).toEqual(['idle_timeout']);
  });

  it('речь в очереди (итог ждёт паузу или ворота) держит сессию', async () => {
    const h = setup({ phase: 'live', list: [view({ gate: 'held', heldSince: 1_000_000, job: done() })] });
    await h.advance(5 * MIN);
    expect(h.delegation.items()[0]?.speech).toBe('queued');
    expect(h.stops).toEqual([]);
  });

  it('речь человека и воспроизведение модели сбрасывают отсчёт', async () => {
    const h = setup({ phase: 'live' });
    await h.advance(2 * MIN + 50_000);
    h.emit({ type: 'humanSpeaking', value: true });
    await h.advance(1000);
    h.emit({ type: 'humanSpeaking', value: false });
    await h.advance(2 * MIN + 50_000);
    h.emit({ type: 'modelPlaying', value: true });
    await h.advance(1000);
    h.emit({ type: 'modelPlaying', value: false });
    await h.advance(2 * MIN + 50_000);
    expect(h.stops).toEqual([]);
    await h.advance(15_000);
    expect(h.stops).toEqual(['idle_timeout']);
  });

  it('закрытие по тишине не отменяет job: отмены нет, итог остаётся', async () => {
    const h = setup({ phase: 'live' });
    await h.advance(3 * MIN + 1000);
    expect(h.stops).toEqual(['idle_timeout']);
    expect(h.calls.map((entry) => entry.method).filter((method) => /cancel/.test(method))).toEqual([]);
  });
});

describe('createLiveDelegation: телеметрия (T6)', () => {
  it('на хост уходят числа и перечисления: submit, подтверждение, удержание, состояние речи и запись сессии; текстов нет', async () => {
    const h = setup({ phase: 'live' });
    h.human('Check the rooms', 0, 1000);
    h.emit({ type: 'delegationCreated', delegationId: 'd1', offsetMs: 1000 });
    await h.flush();
    h.emit({ type: 'modelPlaying', value: true });
    await h.advance(1200);
    h.emit({ type: 'modelPlaying', value: false });
    h.setList([view({ requestId: 'req-1', job: done() })]);
    h.hostListeners.get('assistant.job.changed')?.();
    await h.advance(1500);
    h.emit({ type: 'modelPlaying', value: true });
    h.emit({ type: 'outputTranscript', text: 'Two rooms are waiting for you', startMs: 0, endMs: 200 });
    await h.advance(1500);
    h.emit({ type: 'modelPlaying', value: false });
    await h.advance(3000);
    h.emit({ type: 'sessionClosed', reason: 'close_requested' });
    h.emit({ type: 'phase', phase: 'idle' });
    await h.flush();

    const records = h.callsOf('voice.telemetry.record').map((entry) => entry.params as Record<string, unknown>);
    const merged = (key: string): unknown => records.find((record) => key in record)?.[key];
    expect(typeof merged('delegationToSubmitMs')).toBe('number');
    expect(typeof merged('transcriptWaitMs')).toBe('number');
    expect(merged('ackAudible')).toBe(true);
    expect(typeof merged('resultHoldMs')).toBe('number');
    expect(merged('speechState')).toBe('played');
    expect(records.at(-1)).toMatchObject({ voiceSessionId: 'vs-1', interrupts: 0, firstAudioMs: expect.any(Number) });
    // Тексты поручения и итога в телеметрию не попадают.
    const dump = JSON.stringify(records);
    expect(dump).not.toContain('Check the rooms');
    expect(dump).not.toContain('Two rooms');
    for (const record of records) {
      for (const [key, value] of Object.entries(record)) {
        if (typeof value === 'string') expect(['voiceSessionId', 'requestId', 'ackAudible', 'speechState']).toContain(key);
      }
    }
  });
});
