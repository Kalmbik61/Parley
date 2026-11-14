import { describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { createJobs, SERVICE_TTL_MS, type Job, type JobEnd, type JobResult, type JobRun, type JobsDeps, type ServiceTag } from './jobs.js';

interface Fake {
  job: Job;
  end(end: JobEnd): void;
  cancelled: boolean;
}

function setup(extra: Partial<JobsDeps> = {}, db = openMemoryDb()) {
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
  const jobs = createJobs({ db, execute, defaultProvider: () => 'claude', ...extra });
  const submit = (key: string, provider = 'claude') => jobs.submitJob({ origin: 'island', text: key, idempotencyKey: key, correlation: { mode: 'text' }, provider });
  return { jobs, runs, execute, submit, db };
}
const result = (answer = 'done'): JobResult => ({ answer, capturedAt: 1, cards: [], toolRefs: [] });
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('assistant jobs', () => {
  it('двойной submit с одним ключом — один job и один запуск, в том числе после рестарта', async () => {
    const { jobs, runs, submit, db, execute } = setup();
    const a = submit('k1');
    const b = submit('k1');
    expect(b.jobId).toBe(a.jobId);
    expect(runs).toHaveLength(1);
    jobs.stop();
    // Рестарт: тот же ключ — тот же job, второго запуска нет, статус честный.
    const again = setup({}, db);
    expect(again.submit('k1').jobId).toBe(a.jobId);
    expect(again.execute).not.toHaveBeenCalled();
    await again.jobs.recover();
    expect(again.jobs.getJob(a.jobId)).toMatchObject({ state: 'needs_confirmation' });
    expect(again.execute).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('завершение виден один раз: финальное событие не повторяется после рестарта и повторного submit', async () => {
    const { jobs, runs, submit, db } = setup();
    const events: Job[] = [];
    jobs.onJobChanged((job) => events.push(job));
    const { jobId } = submit('k1');
    runs[0]!.end({ ok: true, summary: 'done', result: result('done'), outcome: 'completed' });
    await settled();
    expect(events.filter((job) => job.state === 'completed')).toHaveLength(1);
    const revisions = events.map((job) => job.revision);
    expect(revisions).toEqual([...revisions].sort((x, y) => x - y));
    expect(new Set(revisions).size).toBe(revisions.length);
    const again = setup({}, db);
    const seen: Job[] = [];
    again.jobs.onJobChanged((job) => seen.push(job));
    again.submit('k1');
    await again.jobs.recover();
    expect(seen).toEqual([]);
    expect(again.jobs.getJob(jobId)).toMatchObject({ state: 'completed', resultSummary: 'done' });
  });

  it('исход без подтверждения хоста не объявляется выполненным', async () => {
    const { jobs, runs, submit } = setup();
    const { jobId } = submit('k1');
    runs[0]!.end({ ok: true, summary: 'sent it', result: result('sent it'), outcome: 'needs_confirmation' });
    await settled();
    expect(jobs.getJob(jobId)?.state).toBe('needs_confirmation');
  });

  it('recover: сверка подтвердила — completed; не подтвердила или упала — неопределённость', async () => {
    const db = openMemoryDb();
    const first = setup({}, db);
    const a = first.submit('a');
    const b = first.submit('b');
    first.jobs.stop();
    const verify = vi.fn(async (job: Job) => (job.jobId === a.jobId ? ('confirmed' as const) : ('unconfirmed' as const)));
    const next = setup({ verify }, db);
    await next.jobs.recover();
    expect(next.jobs.getJob(a.jobId)?.state).toBe('completed');
    expect(next.jobs.getJob(b.jobId)?.state).toBe('needs_confirmation');
  });

  it('recover: резюме job, что шёл при остановке, получает строку restartNote (исходы автономных карточек)', async () => {
    const db = openMemoryDb();
    const first = setup({}, db);
    const a = first.submit('a');
    const b = first.submit('b');
    first.jobs.stop();
    const restartNote = vi.fn((job: Job) => (job.jobId === a.jobId ? 'Done (action p1).' : null));
    const next = setup({ restartNote }, db);
    await next.jobs.recover();
    expect(next.jobs.getJob(a.jobId)).toMatchObject({ state: 'needs_confirmation', resultSummary: 'The host restarted while this job was running; the outcome is unknown Done (action p1).' });
    expect(next.jobs.getJob(b.jobId)).toMatchObject({ state: 'needs_confirmation', resultSummary: 'The host restarted while this job was running; the outcome is unknown' });
    expect(restartNote).toHaveBeenCalledTimes(2);
  });

  it('кап: третий job провайдера ждёт в queued и стартует после освобождения слота; другой провайдер не ждёт', async () => {
    const { jobs, runs, submit } = setup();
    const j1 = submit('1');
    const j2 = submit('2');
    const j3 = submit('3');
    const other = submit('4', 'codex');
    expect(runs.map((run) => run.job.jobId)).toEqual([j1.jobId, j2.jobId, other.jobId]);
    expect(jobs.getJob(j3.jobId)?.state).toBe('queued');
    runs[0]!.end({ ok: true, summary: 's', result: result('s'), outcome: 'completed' });
    await settled();
    expect(jobs.getJob(j3.jobId)?.state).toBe('running');
    expect(runs).toHaveLength(4);
  });

  it("'limit' возвращает job в queued и повторяет после паузы, не в failed", async () => {
    vi.useFakeTimers();
    try {
      const { jobs, runs, submit } = setup({ limitRetryMs: 1000 });
      const { jobId } = submit('1');
      runs[0]!.end({ ok: false, kind: 'limit', message: "You've hit your usage limit" });
      await vi.advanceTimersByTimeAsync(0);
      expect(jobs.getJob(jobId)?.state).toBe('queued');
      expect(runs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1100);
      expect(jobs.getJob(jobId)?.state).toBe('running');
      expect(runs).toHaveLength(2);
      runs[1]!.end({ ok: false, kind: 'other', message: 'boom' });
      await vi.advanceTimersByTimeAsync(0);
      expect(jobs.getJob(jobId)).toMatchObject({ state: 'failed', resultSummary: 'boom' });
      jobs.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelJob гасит прогон и снимает job из очереди', async () => {
    const { jobs, runs, submit } = setup({ capPerProvider: 1 });
    const running = submit('1');
    const queued = submit('2');
    expect(jobs.cancelJob(queued.jobId)?.state).toBe('cancelled');
    expect(jobs.cancelJob(running.jobId)?.state).toBe('cancelled');
    expect(runs[0]!.cancelled).toBe(true);
    await settled();
    expect(runs).toHaveLength(1);
  });

  it('слушатель, зовущий submitJob посреди события, не ломает кап и не запускает дважды', async () => {
    const { jobs, runs, submit, execute } = setup({ capPerProvider: 1 });
    let nested = 0;
    jobs.onJobChanged((job) => {
      if (job.state === 'running' && nested === 0) {
        nested += 1;
        submit('inner');
      }
    });
    submit('outer');
    expect(runs).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    runs[0]!.end({ ok: true, summary: 'x', result: result('x'), outcome: 'completed' });
    await settled();
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.job.requestText)).toEqual(['outer', 'inner']);
  });

  it('cancelJob из события queued→running: job отменён и не запускается', () => {
    const { jobs, runs, execute, submit } = setup();
    let id = '';
    jobs.onJobChanged((job) => {
      if (job.state === 'running') jobs.cancelJob(job.jobId);
      id = job.jobId;
    });
    submit('k1');
    expect(execute).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
    expect(jobs.getJob(id)).toMatchObject({ state: 'cancelled' });
  });

  it('ackInline: флаг ставится один раз, повтор — no-op без нового события и ревизии', async () => {
    const { jobs, runs, submit } = setup();
    const events: Job[] = [];
    jobs.onJobChanged((job) => events.push(job));
    const { jobId } = submit('k1');
    runs[0]!.end({ ok: true, summary: 'done', result: result('done'), outcome: 'completed' });
    await settled();
    const final = jobs.getJob(jobId)!;
    expect(final.deliveredInline).toBe(false);
    const count = events.length;
    expect(jobs.ackInline(jobId, final.revision)).toEqual({ ok: true, deliveredInline: true, reason: 'acked' });
    expect(jobs.ackInline(jobId, final.revision)).toEqual({ ok: true, deliveredInline: true, reason: 'already_acked' });
    expect(events).toHaveLength(count);
    expect(jobs.getJob(jobId)).toMatchObject({ deliveredInline: true, revision: final.revision, state: 'completed' });
  });

  it('ackInline: живой job, устаревшая ревизия и чужой id флаг не ставят', async () => {
    const { jobs, runs, submit } = setup();
    const { jobId, revision } = submit('k1');
    expect(jobs.ackInline(jobId, jobs.getJob(jobId)!.revision)).toMatchObject({ ok: false, reason: 'stale' });
    runs[0]!.end({ ok: true, summary: 'done', result: result('done'), outcome: 'completed' });
    await settled();
    expect(jobs.ackInline(jobId, revision)).toMatchObject({ ok: false, reason: 'stale' });
    expect(jobs.getJob(jobId)!.deliveredInline).toBe(false);
    expect(jobs.ackInline('job-none', 1)).toEqual({ ok: false, deliveredInline: false, reason: 'not_found' });
  });

  it('ackInline: флаг лежит в колонке delivered_inline и переживает рестарт; не терминальный job не принимается', async () => {
    const first = setup();
    const { jobId } = first.submit('k1');
    first.runs[0]!.end({ ok: true, summary: 'done', result: result('done'), outcome: 'completed' });
    await settled();
    const revision = first.jobs.getJob(jobId)!.revision;
    expect(first.jobs.ackInline(jobId, revision)).toMatchObject({ ok: true, reason: 'acked' });
    expect(first.db.prepare('SELECT delivered_inline AS d, outcome FROM assistant_jobs WHERE job_id = ?').get(jobId)).toEqual({ d: 1, outcome: null });
    first.jobs.stop();
    const second = setup({}, first.db);
    expect(second.jobs.getJob(jobId)).toMatchObject({ deliveredInline: true, revision });
    expect(second.jobs.ackInline(jobId, revision)).toEqual({ ok: true, deliveredInline: true, reason: 'already_acked' });
    const live = second.submit('k2');
    expect(second.jobs.ackInline(live.jobId, second.jobs.getJob(live.jobId)!.revision)).toMatchObject({ ok: false, reason: 'stale' });
    expect(second.db.prepare('SELECT delivered_inline AS d FROM assistant_jobs WHERE job_id = ?').get(live.jobId)).toEqual({ d: 0 });
    second.jobs.stop();
  });

  it('JobResult сохраняется с job: completed хранит ответ, карточки и toolRefs хоста, переживает рестарт', async () => {
    const { jobs, runs, submit, db } = setup();
    const { jobId } = submit('k-result');
    const full: JobResult = { answer: 'Anna works in Auth.', capturedAt: 42, cards: [{ cardId: 'p1', kind: 'message' }], toolRefs: [{ tool: 'parley_overview', ok: true, at: 41 }] };
    runs[0]!.end({ ok: true, summary: full.answer, result: full, outcome: 'completed' });
    await settled();
    expect(jobs.getJob(jobId)).toMatchObject({ state: 'completed', resultSummary: full.answer, result: full });
    jobs.stop();
    expect(setup({}, db).jobs.getJob(jobId)?.result).toEqual(full);
  });

  it('read-only без подтверждения хоста не уходит в needs_confirmation: completed — это «ответ готов»', async () => {
    const { jobs, runs, submit } = setup();
    const { jobId } = submit('k-read');
    runs[0]!.end({ ok: true, summary: 'Nobody is waiting for you.', result: result('Nobody is waiting for you.'), outcome: 'completed' });
    await settled();
    expect(jobs.getJob(jobId)?.state).toBe('completed');
  });

  it('заявленное без карточки — needs_confirmation с результатом; такой job повторно не запускается', async () => {
    const { jobs, runs, submit, execute } = setup();
    const { jobId } = submit('k-claim');
    runs[0]!.end({ ok: true, summary: 'I sent it', result: result('I sent it'), outcome: 'needs_confirmation' });
    await settled();
    expect(jobs.getJob(jobId)).toMatchObject({ state: 'needs_confirmation', result: { answer: 'I sent it' } });
    await jobs.recover();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('job без итога (failed, cancelled, неизвестный исход после рестарта) имеет result = null', async () => {
    const { jobs, runs, submit } = setup();
    const { jobId } = submit('k-fail');
    runs[0]!.end({ ok: false, kind: 'other', message: 'boom' });
    await settled();
    expect(jobs.getJob(jobId)?.result).toBeNull();
  });

  it('cancel идущего job сохраняет карточки, что он успел подготовить: состояние cancelled, result с карточками', async () => {
    const partial: JobResult = { answer: '', capturedAt: 3, cards: [{ cardId: 'p9', kind: 'message' }], toolRefs: [] };
    const { jobs, submit, execute } = setup();
    execute.mockImplementationOnce(() => ({ cancel: () => {}, partial: () => partial, done: new Promise<JobEnd>(() => {}) }));
    const { jobId } = submit('k-cancel');
    expect(jobs.cancelJob(jobId)).toMatchObject({ state: 'cancelled', result: partial });
  });

  it('beginCancel: запись сразу, событие, остановка прогона и очередь — в settle; откат транзакции его отменяет', () => {
    const { jobs, runs, submit, db } = setup({ capPerProvider: 1 });
    const running = submit('k1');
    const queued = submit('k2');
    const events: string[] = [];
    jobs.onJobChanged((job) => events.push(`${job.jobId === running.jobId ? 'r' : 'q'}:${job.state}`));

    db.exec('BEGIN IMMEDIATE');
    const first = jobs.beginCancel(running.jobId)!;
    expect(first.job.state).toBe('cancelled');
    expect(events).toEqual([]);
    expect(runs[0]!.cancelled).toBe(false);
    db.exec('ROLLBACK');
    expect(jobs.getJob(running.jobId)?.state).toBe('running');
    expect(runs[0]!.cancelled).toBe(false);

    db.exec('BEGIN IMMEDIATE');
    const second = jobs.beginCancel(running.jobId)!;
    const third = jobs.beginCancel(queued.jobId)!;
    db.exec('COMMIT');
    expect(events).toEqual([]);
    second.settle();
    third.settle();
    expect(events).toContain('r:cancelled');
    expect(events).toContain('q:cancelled');
    expect(runs[0]!.cancelled).toBe(true);
    expect(jobs.getJob(queued.jobId)?.state).toBe('cancelled');
    // Терминальный и неизвестный job отменять нечем.
    expect(jobs.beginCancel(running.jobId)).toBeNull();
    expect(jobs.beginCancel('nope')).toBeNull();
  });

  it('beginCancel идущего job сохраняет подготовленные карточки в результате', () => {
    const { jobs, submit, execute } = setup();
    const partial = { answer: '', capturedAt: 1, cards: [{ cardId: 'p1', kind: 'message' }], toolRefs: [] } as JobResult;
    execute.mockImplementationOnce(() => ({ cancel: () => {}, partial: () => partial, done: new Promise<JobEnd>(() => {}) }));
    const { jobId } = submit('k-cancel');
    jobs.beginCancel(jobId)?.settle();
    expect(jobs.getJob(jobId)).toMatchObject({ state: 'cancelled', result: partial });
  });
});

describe('служебные job (автономия, W2): очередь и пределы', () => {
  const tag = (kind: ServiceTag['kind'], group: string | null = null, fallback = 'not ready'): ServiceTag => ({ kind, group, fallback });
  const service = (jobs: ReturnType<typeof setup>['jobs'], key: string, extra: ServiceTag = tag('outcome')) =>
    jobs.submitJob({ origin: 'system', text: key, idempotencyKey: key, correlation: { voiceSessionId: 'host', delegationId: key, turnId: key }, service: extra });
  const submit2 = (jobs: ReturnType<typeof setup>['jobs'], key: string) => jobs.submitJob({ origin: 'island', text: key, idempotencyKey: key, correlation: { mode: 'text' } });
  const stateOf = (jobs: ReturnType<typeof setup>['jobs'], ids: Array<{ jobId: string }>) => ids.map((item) => jobs.getJob(item.jobId)?.state);

  it('служебный job хранит свой вид и готовый текст и переживает рестарт; у человеческого его нет', () => {
    const { jobs, submit, db } = setup();
    const human = submit('h1');
    const own = service(jobs, 's1', tag('watch', 'g1', 'S03 replied; the summary is not ready.'));
    jobs.stop();
    const again = setup({}, db);
    expect(again.jobs.getJob(own.jobId)).toMatchObject({ origin: 'system', context: null, service: { kind: 'watch', group: 'g1', fallback: 'S03 replied; the summary is not ready.' } });
    expect(again.jobs.getJob(human.jobId)?.service).toBeNull();
  });

  it('RW-11: человеческий job запускается раньше служебного, стоявшего в очереди первым', async () => {
    const { jobs, runs, submit } = setup();
    submit('h1');
    submit('h2');
    const early = service(jobs, 's1');
    const human = submit('h3');
    expect(stateOf(jobs, [early, human])).toEqual(['queued', 'queued']);
    runs[0]!.end({ ok: true, summary: 'x', result: result('x'), outcome: 'completed' });
    await settled();
    expect(stateOf(jobs, [early, human])).toEqual(['queued', 'running']);
    runs[1]!.end({ ok: true, summary: 'x', result: result('x'), outcome: 'completed' });
    await settled();
    expect(stateOf(jobs, [early, human])).toEqual(['running', 'running']);
    expect(runs.map((run) => run.job.requestText)).toEqual(['h1', 'h2', 'h3', 's1']);
  });

  it('RW-11: одновременно идёт один служебный job; следующий — после его конца', async () => {
    const { jobs, runs } = setup({ capPerProvider: 50 });
    const a = service(jobs, 's1');
    const b = service(jobs, 's2');
    expect(stateOf(jobs, [a, b])).toEqual(['running', 'queued']);
    runs[0]!.end({ ok: true, summary: 'x', result: result('x'), outcome: 'completed' });
    await settled();
    expect(stateOf(jobs, [a, b])).toEqual(['completed', 'running']);
    expect(runs).toHaveLength(2);
  });

  it('RW-11: в очереди не больше пяти событий слежения — старейшие сняты; итоги действий не снимаются; сообщено, что снято', () => {
    const { jobs, db } = setup({ capPerProvider: 50 });
    const busy = service(jobs, 'busy');
    const outcome = service(jobs, 'outcome-1');
    const watches = Array.from({ length: 6 }, (_, index) => service(jobs, `w${index}`, tag('watch', `g${index}`)));
    expect(stateOf(jobs, [busy, outcome])).toEqual(['running', 'queued']);
    expect(stateOf(jobs, watches)).toEqual(['cancelled', 'queued', 'queued', 'queued', 'queued', 'queued']);
    db.exec('BEGIN IMMEDIATE');
    const seventh = jobs.beginSubmit({ origin: 'system', text: 'w6', idempotencyKey: 'w6', correlation: { mode: 'text' }, service: tag('watch', 'g6') });
    db.exec('COMMIT');
    seventh.settle();
    expect(seventh.dropped).toEqual([{ jobId: watches[1]!.jobId, reason: 'overflow' }]);
    expect(jobs.getJob(watches[1]!.jobId)).toMatchObject({ state: 'cancelled', result: null });
    expect(jobs.getJob(outcome.jobId)?.state).toBe('queued');
  });

  it('RW-11: новое событие той же сессии заменяет ждущее; другой сессии — нет; идущий не трогается', () => {
    const { jobs } = setup({ capPerProvider: 50 });
    const running = service(jobs, 'w0', tag('watch', 'g1'));
    const first = service(jobs, 'w1', tag('watch', 'g1'));
    const other = service(jobs, 'w2', tag('watch', 'g2'));
    const next = jobs.beginSubmit({ origin: 'system', text: 'w3', idempotencyKey: 'w3', correlation: { mode: 'text' }, service: tag('watch', 'g1') });
    next.settle();
    expect(next.dropped).toEqual([{ jobId: first.jobId, reason: 'replaced' }]);
    expect(stateOf(jobs, [running, first, other, next])).toEqual(['running', 'cancelled', 'queued', 'queued']);
  });

  it('beginSubmit: запись сразу, событие и запуск — в settle; повтор ключа ничего не создаёт', () => {
    const { jobs, runs, db } = setup();
    const events: string[] = [];
    jobs.onJobChanged((job) => events.push(job.state));
    db.exec('BEGIN IMMEDIATE');
    const begun = jobs.beginSubmit({ origin: 'system', text: 's1', idempotencyKey: 's1', correlation: { mode: 'text' }, service: tag('outcome') });
    expect(begun.created).toBe(true);
    db.exec('ROLLBACK');
    expect(jobs.getJob(begun.jobId)).toBeNull();
    expect(events).toEqual([]);
    expect(runs).toHaveLength(0);
    const second = jobs.beginSubmit({ origin: 'system', text: 's1', idempotencyKey: 's1', correlation: { mode: 'text' }, service: tag('outcome') });
    second.settle();
    expect(events).toEqual(['queued', 'running']);
    const repeat = jobs.beginSubmit({ origin: 'system', text: 's1', idempotencyKey: 's1', correlation: { mode: 'text' }, service: tag('outcome') });
    repeat.settle();
    expect(repeat).toMatchObject({ jobId: second.jobId, created: false, dropped: [] });
    expect(runs).toHaveLength(1);
  });

  it('RW-22: служебный job не начат за 5 минут — закрыт готовым текстом без прогона; человеческий не трогается', async () => {
    vi.useFakeTimers();
    try {
      const { jobs, runs, submit, execute } = setup({ capPerProvider: 1 });
      const human = submit('h1');
      const waiting = submit('h2');
      const own = service(jobs, 's1', tag('watch', 'g1', 'S03 replied; the summary is not ready.'));
      await vi.advanceTimersByTimeAsync(SERVICE_TTL_MS - 1000);
      expect(jobs.getJob(own.jobId)?.state).toBe('queued');
      await vi.advanceTimersByTimeAsync(1000);
      expect(jobs.getJob(own.jobId)).toMatchObject({
        state: 'completed',
        resultSummary: 'S03 replied; the summary is not ready.',
        result: { answer: 'S03 replied; the summary is not ready.', cards: [], toolRefs: [] },
      });
      expect(jobs.getJob(waiting.jobId)?.state).toBe('queued');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(runs.map((run) => run.job.jobId)).toEqual([human.jobId]);
      jobs.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('RW-22: после рестарта просроченный служебный job закрывается при первом же разборе очереди', async () => {
    const db = openMemoryDb();
    let at = 1_000;
    const first = setup({ now: () => at, capPerProvider: 1 }, db);
    first.submit('h1');
    const own = service(first.jobs, 's1', tag('outcome', null, 'Done (action p1). Do not repeat it.'));
    first.jobs.stop();
    at += SERVICE_TTL_MS;
    const next = setup({ now: () => at, capPerProvider: 1 }, db);
    await next.jobs.recover();
    expect(next.jobs.getJob(own.jobId)).toMatchObject({ state: 'completed', resultSummary: 'Done (action p1). Do not repeat it.' });
    expect(next.execute).not.toHaveBeenCalled();
    next.jobs.stop();
  });

  it('рестарт посреди пересказа: служебный job закрыт готовым текстом, а не «исход неизвестен»', async () => {
    const { jobs, db } = setup({ capPerProvider: 50 });
    const own = service(jobs, 's1', tag('watch', 'g1', 'S03 replied; the summary is not ready.'));
    const human = submit2(jobs, 'h1');
    jobs.stop();
    const next = setup({}, db);
    await next.jobs.recover();
    expect(next.jobs.getJob(own.jobId)).toMatchObject({ state: 'completed', resultSummary: 'S03 replied; the summary is not ready.', result: { answer: 'S03 replied; the summary is not ready.' } });
    expect(next.jobs.getJob(human.jobId)?.state).toBe('needs_confirmation');
  });

  it('job system без ServiceTag не крутит таймер срока', async () => {
    vi.useFakeTimers();
    try {
      const { jobs } = setup({ capPerProvider: 1 });
      submit2(jobs, 'h1');
      const bare = jobs.submitJob({ origin: 'system', text: 'bare', idempotencyKey: 'bare', correlation: { mode: 'text' } });
      await vi.advanceTimersByTimeAsync(SERVICE_TTL_MS + 1000);
      expect(vi.getTimerCount()).toBe(0);
      expect(jobs.getJob(bare.jobId)?.state).toBe('queued');
      jobs.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closeWithoutRun: только служебный job в очереди; человеческий и идущий — нет', () => {
    const { jobs, submit } = setup({ capPerProvider: 1 });
    submit('h1');
    const human = submit('h2');
    const own = service(jobs, 's1');
    expect(jobs.closeWithoutRun(human.jobId, 'x')).toBeNull();
    expect(jobs.getJob(human.jobId)?.state).toBe('queued');
    expect(jobs.closeWithoutRun(own.jobId, 'ready text')).toMatchObject({ state: 'completed', resultSummary: 'ready text' });
    expect(jobs.closeWithoutRun(own.jobId, 'again')).toBeNull();
  });

  it('cancelQueuedService: снимает ждущие события слежения; идущий пересказ и итоги действий остаются', () => {
    const { jobs } = setup({ capPerProvider: 50 });
    const running = service(jobs, 'w0', tag('watch', 'g0'));
    const watch = service(jobs, 'w1', tag('watch', 'g1'));
    const outcome = service(jobs, 'o1');
    expect(jobs.cancelQueuedService('watch').map((job) => job.jobId)).toEqual([watch.jobId]);
    expect(stateOf(jobs, [running, watch, outcome])).toEqual(['running', 'cancelled', 'queued']);
  });
});
