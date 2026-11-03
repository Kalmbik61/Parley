import { describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { createJobs, type Job, type JobEnd, type JobRun, type JobsDeps } from './jobs.js';

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
    runs[0]!.end({ ok: true, summary: 'done', confirmed: true });
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
    runs[0]!.end({ ok: true, summary: 'sent it', confirmed: false });
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
    runs[0]!.end({ ok: true, summary: 's', confirmed: true });
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
    runs[0]!.end({ ok: true, summary: 'x', confirmed: true });
    await settled();
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.job.requestText)).toEqual(['outer', 'inner']);
  });
});
