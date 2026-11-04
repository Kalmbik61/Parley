import { describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { createIngest } from '../notifications/ingest.js';
import { createNotificationStore } from '../notifications/store.js';
import { createRequestHandlers } from '../methods/requests.js';
import { createJobs, type Job, type JobEnd, type JobRun } from './jobs.js';
import { createRequests, originKeyOf, REQUEST_CONTEXT_LIMIT, type SubmitRequestInput } from './requests.js';
import type { RequestInfo } from '../context.js';

interface Fake {
  job: Job;
  end(end: JobEnd): void;
  cancelled: boolean;
}

/** Хост на общей базе: «рестарт» — новый `setup` с той же `db`. */
function setup(db = openMemoryDb()) {
  const runs: Fake[] = [];
  const execute = vi.fn((job: Job): JobRun => {
    let settle: (end: JobEnd) => void = () => {};
    const fake: Fake = { job, end: (end) => settle(end), cancelled: false };
    runs.push(fake);
    return {
      cancel: () => {
        fake.cancelled = true;
        settle({ ok: false, kind: 'cancelled', message: 'cancelled' });
      },
      done: new Promise<JobEnd>((resolve) => {
        settle = resolve;
      }),
    };
  });
  const jobs = createJobs({ db, execute, defaultProvider: () => 'claude' });
  const requests = createRequests({ db, jobs });
  return { db, jobs, requests, runs, execute };
}
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const input = (delegationId: string, over: Partial<SubmitRequestInput> = {}): SubmitRequestInput => ({
  conversationId: 'conv-1',
  voiceSessionId: 'live_1',
  delegationId,
  text: `question ${delegationId}`,
  ...over,
});
const count = (db: ReturnType<typeof openMemoryDb>, table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe('Request: идемпотентный submit', () => {
  it('повтор с тем же originKey — тот же Request и тот же job, второй job и запуск не создаются', () => {
    const { requests, db, execute } = setup();
    const first = requests.submit(input('d1'));
    const again = requests.submit(input('d1', { text: 'другой текст повтора' }));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.request.requestId).toBe(first.request.requestId);
    expect(again.request.jobId).toBe(first.request.jobId);
    expect(again.request.text).toBe('question d1');
    expect(count(db, 'assistant_requests')).toBe(1);
    expect(count(db, 'assistant_jobs')).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('Request создан с доверенным origin island, связью голоса и зарезервированными полями', () => {
    const { requests, jobs } = setup();
    const { request } = requests.submit(input('d1', { context: { recent: ['hi'] }, transcriptPartial: true, turnId: 'turn-9' }));
    expect(request).toMatchObject({
      originKey: originKeyOf('live_1', 'd1'),
      conversationId: 'conv-1',
      seq: 1,
      version: 1,
      context: { recent: ['hi'] },
      supersededBy: null,
      transcriptPartial: true,
      delivery: {},
      job: { state: 'running', revision: 2 },
    });
    expect(jobs.getJob(request.jobId)).toMatchObject({
      origin: 'island',
      correlation: { voiceSessionId: 'live_1', delegationId: 'd1', turnId: 'turn-9' },
    });
    // Без turnId связь job берёт delegationId.
    const bare = requests.submit(input('d2')).request;
    expect(jobs.getJob(bare.jobId)?.correlation).toEqual({ voiceSessionId: 'live_1', delegationId: 'd2', turnId: 'd2' });
    expect(bare.context).toBeNull();
    expect(bare.transcriptPartial).toBe(false);
  });

  it('seq растёт в разговоре и независим между разговорами; originKey не склеивается через двоеточие в id', () => {
    const { requests } = setup();
    expect(requests.submit(input('d1')).request.seq).toBe(1);
    expect(requests.submit(input('d2')).request.seq).toBe(2);
    expect(requests.submit(input('d3', { conversationId: 'conv-2' })).request.seq).toBe(1);
    const a = requests.submit({ ...input('x'), voiceSessionId: 'a:b', delegationId: 'c' });
    const b = requests.submit({ ...input('x'), voiceSessionId: 'a', delegationId: 'b:c' });
    expect(b.created).toBe(true);
    expect(b.request.requestId).not.toBe(a.request.requestId);
  });

  it('слишком длинный контекст отвергается до создания job', () => {
    const { requests, db, execute } = setup();
    expect(() => requests.submit(input('d1', { context: { blob: 'x'.repeat(REQUEST_CONTEXT_LIMIT) } }))).toThrow(/context/);
    expect(count(db, 'assistant_jobs')).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('Request без job (нарушенный инвариант) — явная ошибка, а не пустой ответ', () => {
    const { requests, db } = setup();
    requests.submit(input('d1'));
    db.exec('DELETE FROM assistant_jobs');
    expect(() => requests.submit(input('d1'))).toThrow('request job missing');
  });

  it('упали между job и Request: повтор допишет Request к тому же job, второго запуска нет', () => {
    const { requests, jobs, db, execute } = setup();
    // Первый submit дошёл только до job (процесс убит до вставки Request).
    const orphan = jobs.submitJob({
      origin: 'island',
      text: 'question d1',
      idempotencyKey: `request:${originKeyOf('live_1', 'd1')}`,
      correlation: { voiceSessionId: 'live_1', delegationId: 'd1', turnId: 'd1' },
    });
    expect(count(db, 'assistant_requests')).toBe(0);
    const healed = requests.submit(input('d1'));
    expect(healed.created).toBe(true);
    expect(healed.request.jobId).toBe(orphan.jobId);
    expect(count(db, 'assistant_jobs')).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('requests.list и отметки доставки', () => {
  it('открытые Request приходят всегда; терминальные — пока потребитель их не получил; потребители независимы', async () => {
    const { requests, runs } = setup();
    const a = requests.submit(input('d1')).request;
    const b = requests.submit(input('d2')).request;
    expect(requests.list('conv-1', 'island-voice').map((r) => r.requestId)).toEqual([a.requestId, b.requestId]);
    runs[0]!.end({ ok: true, summary: 'answer 1', confirmed: true });
    await settled();
    const listed = requests.list('conv-1', 'island-voice');
    expect(listed.map((r) => [r.requestId, r.job.state])).toEqual([
      [a.requestId, 'completed'],
      [b.requestId, 'running'],
    ]);
    expect(listed[0]!.job.resultSummary).toBe('answer 1');
    // ack терминального: пропадает только у этого потребителя.
    expect(requests.ack(a.requestId, 'island-voice', listed[0]!.job.revision)).toEqual({ ok: true, reason: 'acked' });
    expect(requests.list('conv-1', 'island-voice').map((r) => r.requestId)).toEqual([b.requestId]);
    expect(requests.list('conv-1', 'phone-voice').map((r) => r.requestId)).toEqual([a.requestId, b.requestId]);
    expect(requests.get(a.requestId)?.delivery).toEqual({ 'island-voice': listed[0]!.job.revision });
    // Открытый Request отмечать нельзя; чужой разговор в список не попадает.
    expect(requests.ack(b.requestId, 'island-voice', 2)).toEqual({ ok: false, reason: 'not_terminal' });
    expect(requests.list('conv-other', 'island-voice')).toEqual([]);
  });

  it('ack идемпотентен, устаревшая и неизвестная отметки не принимаются, отметка не откатывается', async () => {
    const { requests, runs, jobs } = setup();
    const { request } = requests.submit(input('d1'));
    runs[0]!.end({ ok: true, summary: 'unsure', confirmed: false }); // needs_confirmation
    await settled();
    const first = jobs.getJob(request.jobId)!;
    expect(first.state).toBe('needs_confirmation');
    expect(requests.ack(request.requestId, 'c', first.revision - 1)).toEqual({ ok: false, reason: 'stale' });
    expect(requests.ack(request.requestId, 'c', first.revision)).toEqual({ ok: true, reason: 'acked' });
    expect(requests.ack(request.requestId, 'c', first.revision)).toEqual({ ok: true, reason: 'already_acked' });
    expect(requests.ack('nope', 'c', 1)).toEqual({ ok: false, reason: 'not_found' });
    expect(requests.list('conv-1', 'c')).toEqual([]);
    // Job позже отменён человеком: ревизия выросла — итог снова недоставлен, старая отметка его не гасит.
    jobs.cancelJob(request.jobId);
    const next = jobs.getJob(request.jobId)!;
    expect(next.revision).toBeGreaterThan(first.revision);
    expect(requests.list('conv-1', 'c').map((r) => r.job.state)).toEqual(['cancelled']);
    expect(requests.ack(request.requestId, 'c', first.revision)).toEqual({ ok: false, reason: 'stale' });
    expect(requests.ack(request.requestId, 'c', next.revision)).toEqual({ ok: true, reason: 'acked' });
    expect(requests.list('conv-1', 'c')).toEqual([]);
  });
});

describe('восстановление', () => {
  /** VA-07: job завершился при обрыве, ответ submit потерян, событие пришло повторно. */
  it('VA-07: итог при обрыве, потерянный submit и повтор события — один Request, одна запись и итог после reconnect', async () => {
    const { requests, jobs, runs, db, execute } = setup();
    const store = createNotificationStore(db);
    const ingest = createIngest({ store, hostId: 'local' });
    jobs.onJobChanged((job) => ingest.onJob(job));

    const lost = requests.submit(input('d1')); // ответ клиент не получил
    runs[0]!.end({ ok: true, summary: 'answer', confirmed: true }); // клиент отключён
    await settled();

    const replay = requests.submit(input('d1')); // событие делегации пришло повторно после reconnect
    expect(replay.created).toBe(false);
    expect(replay.request.requestId).toBe(lost.request.requestId);
    expect(count(db, 'assistant_requests')).toBe(1);
    expect(count(db, 'assistant_jobs')).toBe(1);
    expect(count(db, 'notifications')).toBe(1); // каноническая запись и карточка уведомления — одна
    expect(execute).toHaveBeenCalledTimes(1);

    const pending = requests.list('conv-1', 'island-voice');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId: lost.request.requestId, job: { state: 'completed', resultSummary: 'answer' } });
    expect(requests.ack(pending[0]!.requestId, 'island-voice', pending[0]!.job.revision).ok).toBe(true);
    expect(requests.list('conv-1', 'island-voice')).toEqual([]);
    // Ещё один повтор после доставки итога ничего не воскрешает.
    requests.submit(input('d1'));
    expect(requests.list('conv-1', 'island-voice')).toEqual([]);
    expect(count(db, 'notifications')).toBe(1);
  });

  /** VA-08: голос закрыт до итога; закрытие job не отменяет, повторы отсекаются по id события. */
  it('VA-08: закрытие голоса не отменяет job; повторы события отсечены, итог доставляется по requests.list', async () => {
    const { requests, jobs, runs, execute } = setup();
    const { request } = requests.submit(input('d1'));
    const close = vi.fn(async () => true);
    // Закрытие голосовой сессии — метод `voice.session.close`: он не знает о jobs.
    const { createVoiceHandlers } = await import('../methods/voice.js');
    const handlers = createVoiceHandlers(jobs, { service: { prepare: vi.fn(), close, activeSessionId: () => null } as never, usage: vi.fn() as never });
    await (handlers['voice.session.close'] as unknown as (params: unknown, info: RequestInfo) => Promise<unknown>)({ voiceSessionId: 'live_1' }, {} as RequestInfo);
    expect(close).toHaveBeenCalledTimes(1);
    expect(runs[0]!.cancelled).toBe(false);
    expect(jobs.getJob(request.jobId)?.state).toBe('running');

    for (let i = 0; i < 3; i++) expect(requests.submit(input('d1')).request.requestId).toBe(request.requestId);
    runs[0]!.end({ ok: true, summary: 'late answer', confirmed: true });
    await settled();

    expect(execute).toHaveBeenCalledTimes(1);
    const pending = requests.list('conv-1', 'island-voice');
    expect(pending.map((r) => [r.requestId, r.job.state, r.job.resultSummary])).toEqual([[request.requestId, 'completed', 'late answer']]);
  });

  it('рестарт хоста между submit и завершением: Request и задание те же, итог — «исход неизвестен», повтор submit ничего не запускает', async () => {
    const before = setup();
    const { request } = before.requests.submit(input('d1'));
    const second = before.requests.submit(input('d2')).request;
    before.runs[1]!.end({ ok: true, summary: 'done before restart', confirmed: true });
    await settled();
    before.jobs.stop();

    const after = setup(before.db);
    await after.jobs.recover();
    const listed = after.requests.list('conv-1', 'island-voice');
    expect(listed.map((r) => [r.requestId, r.job.state])).toEqual([
      [request.requestId, 'needs_confirmation'],
      [second.requestId, 'completed'],
    ]);
    expect(after.execute).not.toHaveBeenCalled();
    // Потерянный ответ submit и повтор события после рестарта: тот же Request и тот же job, запуска нет.
    const replay = after.requests.submit(input('d1'));
    expect(replay).toMatchObject({ created: false, request: { requestId: request.requestId, jobId: request.jobId } });
    expect(after.execute).not.toHaveBeenCalled();
    expect(count(after.db, 'assistant_requests')).toBe(2);
    expect(count(after.db, 'assistant_jobs')).toBe(2);
  });

  it('отметка доставки переживает рестарт; новый Request после рестарта получает следующий seq', async () => {
    const before = setup();
    const { request } = before.requests.submit(input('d1'));
    before.runs[0]!.end({ ok: true, summary: 'answer', confirmed: true });
    await settled();
    const revision = before.jobs.getJob(request.jobId)!.revision;
    expect(before.requests.ack(request.requestId, 'island-voice', revision).ok).toBe(true);
    before.jobs.stop();

    const after = setup(before.db);
    await after.jobs.recover();
    expect(after.requests.list('conv-1', 'island-voice')).toEqual([]);
    expect(after.requests.list('conv-1', 'phone-voice')).toHaveLength(1);
    expect(after.requests.ack(request.requestId, 'island-voice', revision)).toEqual({ ok: true, reason: 'already_acked' });
    expect(after.requests.submit(input('d2')).request.seq).toBe(2);
  });
});

describe('методы requests.* (локальный остров)', () => {
  const info = {} as RequestInfo;
  const call = (handlers: ReturnType<typeof createRequestHandlers>, name: string, params: unknown): Promise<any> => // eslint-disable-line @typescript-eslint/no-explicit-any
    (handlers[name] as unknown as (params: unknown, info: RequestInfo) => Promise<unknown>)(params, info) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it('без хранилища методов нет; submit/list/ack работают поверх Requests', async () => {
    expect(Object.keys(createRequestHandlers(undefined))).toEqual([]);
    const { requests, runs, jobs } = setup();
    const handlers = createRequestHandlers(requests);
    expect(Object.keys(handlers).sort()).toEqual(['requests.ack', 'requests.list', 'requests.submit']);
    const submitted = await call(handlers, 'requests.submit', input('d1'));
    expect(submitted.created).toBe(true);
    expect(jobs.getJob(submitted.request.jobId)?.origin).toBe('island');
    runs[0]!.end({ ok: true, summary: 'answer', confirmed: true });
    await settled();
    const listed = await call(handlers, 'requests.list', { conversationId: 'conv-1', consumer: 'island-voice' });
    expect(listed.requests).toHaveLength(1);
    const revision = listed.requests[0].job.revision;
    expect(await call(handlers, 'requests.ack', { requestId: submitted.request.requestId, consumer: 'island-voice', revision })).toEqual({ ok: true, reason: 'acked' });
  });
});
