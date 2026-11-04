import { describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { createJobs, type Job, type JobEnd, type JobResult, type JobRun, type JobsDeps } from './jobs.js';

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
});
