import { describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { createIngest } from '../notifications/ingest.js';
import { createNotificationStore } from '../notifications/store.js';
import { createRequestHandlers } from '../methods/requests.js';
import { createJobs, type Job, type JobEnd, type JobResult, type JobRun } from './jobs.js';
import { createRequests, LIVE_CONSUMER, originKeyOf, REQUEST_CONTEXT_LIMIT, type SubmitRequestInput } from './requests.js';
import type { RequestInfo } from '../context.js';
import { assistantMethodSchemas } from '@parley/protocol';

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
const done = (answer: string): JobResult => ({ answer, capturedAt: 1, cards: [], toolRefs: [] });
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
    runs[0]!.end({ ok: true, summary: 'answer 1', result: done('answer 1'), outcome: 'completed' });
    await settled();
    const listed = requests.list('conv-1', 'island-voice');
    expect(listed.map((r) => [r.requestId, r.job.state])).toEqual([
      [a.requestId, 'completed'],
      [b.requestId, 'running'],
    ]);
    expect(listed[0]!.job.resultSummary).toBe('answer 1');
    // Итог job (JobResult) виден в Request целиком; у ещё идущего job его нет.
    expect(listed[0]!.job.result).toEqual(done('answer 1'));
    expect(listed[1]!.job.result).toBeNull();
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
    runs[0]!.end({ ok: true, summary: 'unsure', result: done('unsure'), outcome: 'needs_confirmation' }); // needs_confirmation
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
    runs[0]!.end({ ok: true, summary: 'answer', result: done('answer'), outcome: 'completed' }); // клиент отключён
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
    runs[0]!.end({ ok: true, summary: 'late answer', result: done('late answer'), outcome: 'completed' });
    await settled();

    expect(execute).toHaveBeenCalledTimes(1);
    const pending = requests.list('conv-1', 'island-voice');
    expect(pending.map((r) => [r.requestId, r.job.state, r.job.resultSummary])).toEqual([[request.requestId, 'completed', 'late answer']]);
  });

  it('рестарт хоста между submit и завершением: Request и задание те же, итог — «исход неизвестен», повтор submit ничего не запускает', async () => {
    const before = setup();
    const { request } = before.requests.submit(input('d1'));
    const second = before.requests.submit(input('d2')).request;
    before.runs[1]!.end({ ok: true, summary: 'done before restart', result: done('done before restart'), outcome: 'completed' });
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
    before.runs[0]!.end({ ok: true, summary: 'answer', result: done('answer'), outcome: 'completed' });
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
    runs[0]!.end({ ok: true, summary: 'answer', result: done('answer'), outcome: 'completed' });
    await settled();
    const listed = await call(handlers, 'requests.list', { conversationId: 'conv-1', consumer: 'island-voice' });
    expect(listed.requests).toHaveLength(1);
    const revision = listed.requests[0].job.revision;
    expect(await call(handlers, 'requests.ack', { requestId: submitted.request.requestId, consumer: 'island-voice', revision })).toEqual({ ok: true, reason: 'acked' });
  });
});

describe('служебный Request (автономия, W2)', () => {
  const tag = (group: string | null = 'g1') => ({ kind: 'watch' as const, group, fallback: 'S03 replied; the summary is not ready.' });
  const service = (key: string, over: Partial<SubmitRequestInput> = {}): SubmitRequestInput & { origin: 'system'; service: ReturnType<typeof tag> } => ({
    conversationId: 'conv-1',
    voiceSessionId: 'host',
    delegationId: key,
    text: `Reply from S03 (${key})`,
    context: { service: 'watch', key },
    origin: 'system',
    service: tag(),
    ...over,
  });

  it('RW-04: повтор события — тот же Request; другое событие и та же сессия другой работы — новые', () => {
    const { requests, db } = setup();
    const first = requests.submit(service('watch:/p:w-1:s-01:turn:100'));
    const again = requests.submit(service('watch:/p:w-1:s-01:turn:100'));
    expect(again).toMatchObject({ created: false, request: { requestId: first.request.requestId, jobId: first.request.jobId } });
    expect(first.request.originKey).toBe(originKeyOf('host', 'watch:/p:w-1:s-01:turn:100'));
    const next = requests.submit(service('watch:/p:w-1:s-01:need:permission:2026-11-15T10:00:00.000Z', { service: tag('other') }));
    const otherWork = requests.submit(service('watch:/p:w-2:s-01:turn:100', { service: tag('w-2') }));
    expect(next.created).toBe(true);
    expect(otherWork.created).toBe(true);
    expect(new Set([first.request.requestId, next.request.requestId, otherWork.request.requestId]).size).toBe(3);
    expect(count(db, 'assistant_jobs')).toBe(3);
  });

  it('служебный Request: job system со своим видом, сразу связан как независимый, origin в виде; поручение острова — island', () => {
    const { requests, jobs } = setup();
    const own = requests.submit(service('watch:/p:w-1:s-01:turn:100')).request;
    expect(own).toMatchObject({ origin: 'system', link: { kind: 'independent', supersedes: [] }, gate: 'open', stale: false, context: { service: 'watch' } });
    expect(jobs.getJob(own.jobId)).toMatchObject({ origin: 'system', service: tag(), correlation: { voiceSessionId: 'host', delegationId: 'watch:/p:w-1:s-01:turn:100' } });
    expect(requests.submit(input('d1')).request.origin).toBe('island');
  });

  it('RW-10: служебный Request не держит ворота более старого итога', async () => {
    const { requests, runs } = setup();
    const older = requests.submit(input('d1')).request;
    runs[0]!.end({ ok: true, summary: 'answer', result: done('answer'), outcome: 'completed' });
    await settled();
    requests.submit(service('watch:/p:w-1:s-01:turn:100'));
    expect(requests.get(older.requestId)).toMatchObject({ gate: 'open', heldBy: null });
  });

  it('RW-10: девять невытесненных служебных не вытесняют более старое человеческое поручение из openBefore (отсечка до LIMIT)', () => {
    const { requests } = setup();
    const human = requests.submit(input('d1')).request;
    // Итоги действий не заменяются и не снимаются переполнением: все девять остаются открытыми и новее человеческого.
    for (let index = 0; index < 9; index += 1) requests.submit(service(`outcome:p${index}`, { service: { kind: 'outcome', group: null, fallback: 'x' } }));
    const newer = requests.submit(input('d2')).request;
    const open = requests.list('conv-1', LIVE_CONSUMER).filter((request) => request.origin === 'system' && !request.stale && request.seq > human.seq && request.seq < newer.seq);
    expect(open).toHaveLength(9);
    expect(requests.openBefore('conv-1', newer.seq, 8).map((request) => request.requestId)).toEqual([human.requestId]);
  });

  it('RPC requests.submit не принимает origin; ключ host зарезервирован за хостом', async () => {
    expect(assistantMethodSchemas['requests.submit'].safeParse({ ...input('d1'), origin: 'system' }).success).toBe(false);
    expect(assistantMethodSchemas['requests.submit'].safeParse(input('d1')).success).toBe(true);
    const { requests, db } = setup();
    expect(() => requests.submit(input('watch:/p:w-1:s-01:turn:100', { voiceSessionId: 'host' }))).toThrow(/reserved/);
    expect(count(db, 'assistant_jobs')).toBe(0);
  });

  it('замена по сессии: прежний Request неактуален, его job отменён; новый снимок знает, сколько ответов было', () => {
    const { requests, jobs } = setup();
    // Занят единственный служебный слот: события ждут в очереди.
    requests.submit(service('outcome:p1', { service: { kind: 'outcome', group: null, fallback: 'x' } }));
    const first = requests.submit(service('watch:/p:w-1:s-01:turn:1')).request;
    const second = requests.submit(service('watch:/p:w-1:s-01:turn:2')).request;
    const third = requests.submitService(service('watch:/p:w-1:s-01:turn:3'));
    expect(requests.get(first.requestId)).toMatchObject({ stale: true, supersededBy: second.requestId, version: 2 });
    expect(jobs.getJob(first.jobId)?.state).toBe('cancelled');
    expect(second.context).toMatchObject({ earlierReplies: 1 });
    expect(third?.request.context).toMatchObject({ earlierReplies: 2 });
    expect(third?.overflow).toEqual([]);
  });

  it('переполнение: старейшее ждущее событие снято, Request неактуален и возвращён для заметки', () => {
    const { requests, jobs } = setup();
    requests.submit(service('outcome:p1', { service: { kind: 'outcome', group: null, fallback: 'x' } }));
    const waiting = Array.from({ length: 5 }, (_, index) => requests.submit(service(`watch:/p:w-1:s-0${index}:turn:1`, { service: tag(`g${index}`) })).request);
    const sixth = requests.submitService(service('watch:/p:w-1:s-09:turn:1', { service: tag('g9') }));
    expect(sixth?.overflow.map((request) => request.requestId)).toEqual([waiting[0]!.requestId]);
    expect(sixth?.overflow[0]).toMatchObject({ stale: true, context: { key: 'watch:/p:w-1:s-00:turn:1' } });
    expect(jobs.getJob(waiting[0]!.jobId)?.state).toBe('cancelled');
    expect(waiting.slice(1).map((request) => jobs.getJob(request.jobId)?.state)).toEqual(['queued', 'queued', 'queued', 'queued']);
  });

  it('ключ служебного Request занят чужим job (телефон прислал тот же idempotencyKey) — отказ, guard откатан', () => {
    const { requests, jobs, db } = setup();
    db.exec('CREATE TABLE marks (id TEXT)');
    jobs.submitJob({ origin: 'mobile', text: 'x', idempotencyKey: `request:${originKeyOf('host', 'outcome:p1')}`, correlation: { mode: 'text' } });
    const guard = () => {
      db.prepare('INSERT INTO marks (id) VALUES (?)').run('m');
      return true;
    };
    expect(() => requests.submitService(service('outcome:p1'), guard)).toThrow(/taken/);
    expect(count(db, 'marks')).toBe(0);
    expect(count(db, 'assistant_requests')).toBe(0);
  });

  it('dropService (возврат после limit): снятые неактуальны, их считает более новое событие той же сессии; снятые переполнением — для заметки', () => {
    const { requests, jobs } = setup();
    const old = requests.submit(service('watch:/p:w-1:s-01:turn:1')).request;
    const newer = requests.submit(service('watch:/p:w-1:s-01:turn:2')).request;
    const other = requests.submit(service('watch:/p:w-1:s-02:turn:1', { service: tag('g2') })).request;
    expect(jobs.getJob(old.jobId)?.state).toBe('running');
    const overflow = requests.dropService([
      { jobId: old.jobId, reason: 'replaced', by: newer.jobId },
      { jobId: other.jobId, reason: 'overflow', by: newer.jobId },
    ]);
    expect(requests.get(old.requestId)).toMatchObject({ stale: true, supersededBy: newer.requestId });
    expect(requests.get(newer.requestId)?.context).toMatchObject({ earlierReplies: 1 });
    expect(overflow.map((request) => request.requestId)).toEqual([other.requestId]);
    expect(requests.dropService([{ jobId: other.jobId, reason: 'overflow', by: newer.jobId }])).toEqual([]);
  });

  it('submitService: guard в той же транзакции; false — ничего не создано; сбой вставки откатывает и guard', () => {
    const { requests, db } = setup();
    db.exec('CREATE TABLE marks (id TEXT)');
    const mark = () => {
      db.prepare('INSERT INTO marks (id) VALUES (?)').run('m');
      return true;
    };
    expect(requests.submitService(service('outcome:p1'), () => false)).toBeNull();
    expect(count(db, 'assistant_jobs')).toBe(0);
    db.exec(`CREATE TRIGGER fail_requests BEFORE INSERT ON assistant_requests BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    expect(() => requests.submitService(service('outcome:p1'), mark)).toThrow(/disk full/);
    expect(count(db, 'marks')).toBe(0);
    expect(count(db, 'assistant_jobs')).toBe(0);
    db.exec('DROP TRIGGER fail_requests');
    expect(requests.submitService(service('outcome:p1'), mark)?.created).toBe(true);
    expect(count(db, 'marks')).toBe(1);
  });
});
