import { describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { createJobs, type Job, type JobEnd, type JobRun } from './jobs.js';
import { createRequests, type RequestView, type SubmitRequestInput } from './requests.js';
import { createRequestStatus } from './request-status.js';

const NOON = new Date(2026, 10, 4, 14, 5, 0).getTime();

function setup() {
  const db = openMemoryDb();
  const finish = new Map<string, (end: JobEnd) => void>();
  const execute = vi.fn((job: Job): JobRun => {
    let settle: (end: JobEnd) => void = () => {};
    const done = new Promise<JobEnd>((resolve) => {
      settle = resolve;
    });
    finish.set(job.jobId, settle);
    return { cancel: () => settle({ ok: false, kind: 'cancelled', message: 'cancelled' }), done };
  });
  let clock = NOON - 120_000;
  const jobs = createJobs({ db, execute, defaultProvider: () => 'claude', capPerProvider: 50 });
  const requests = createRequests({ db, jobs, now: () => clock });
  const status = createRequestStatus({ requests, now: () => NOON });
  const submit = (id: string, extra: Partial<SubmitRequestInput> = {}): RequestView => {
    const { request } = requests.submit({ conversationId: 'conv-1', voiceSessionId: 'live_1', delegationId: id, text: `question ${id}`, ...extra });
    clock += 30_000;
    return request;
  };
  const complete = (request: RequestView, answer: string): void => {
    finish.get(request.jobId)?.({ ok: true, summary: answer, result: { answer, capturedAt: 1, cards: [], toolRefs: [] }, outcome: 'completed' });
  };
  return { db, jobs, requests, status, submit, complete, execute };
}
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('request_status', () => {
  it('VA-06: возвращает открытые Request разговора со состоянием, версией, возрастом и резюме; новых job нет', async () => {
    const h = setup();
    const first = h.submit('d1', { text: 'what is waiting for me in the rooms' });
    const second = h.submit('d2', { text: 'any news from Billing?' });
    const asker = h.submit('d3', { text: 'so what is the status?' });
    h.complete(first, 'Two rooms are waiting: Design review and Billing migration.');
    await settled();
    const before = h.execute.mock.calls.length;

    const outcome = h.status.status(asker.jobId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain('14:05');
    expect(outcome.text).toContain('completed, not yet spoken');
    expect(outcome.text).toContain('Design review and Billing migration');
    expect(outcome.text).toMatch(/asked 2 minutes ago/);
    expect(outcome.text).toContain('version 1');
    expect(outcome.text).toContain('any news from Billing?');
    // собственный Request job в список не входит, id нет
    expect(outcome.text).not.toContain('so what is the status');
    expect(outcome.text).not.toContain(first.requestId);
    expect(outcome.text).not.toContain(second.requestId);
    expect(outcome.text).not.toMatch(/\bjob-|req-/);
    // работа не повторялась: ни одного нового запуска, число job и Request прежнее
    expect(h.execute.mock.calls.length).toBe(before);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM assistant_jobs').get()).toEqual({ n: 3 });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM assistant_requests').get()).toEqual({ n: 3 });
  });

  it('виден только свой разговор: Request другого разговора в ответ не попадает', () => {
    const h = setup();
    h.submit('d1', { conversationId: 'conv-other', text: 'secret topic of another conversation' });
    const mine = h.submit('d2', { text: 'my question' });
    const outcome = h.status.status(mine.jobId);
    expect(outcome).toMatchObject({ ok: true });
    expect(JSON.stringify(outcome)).not.toContain('secret topic');
    expect(JSON.stringify(outcome)).toContain('no other open requests');
  });

  it('вытесненный Request в статус не входит', () => {
    const h = setup();
    const old = h.submit('d1', { text: 'old question' });
    const asker = h.submit('d2', { text: 'status?' });
    h.db.prepare('UPDATE assistant_requests SET superseded_by = ? WHERE request_id = ?').run(asker.requestId, old.requestId);
    expect(JSON.stringify(h.status.status(asker.jobId))).not.toContain('old question');
  });

  it('job без Request (не голосовой) получает отказ', () => {
    const h = setup();
    const job = h.jobs.submitJob({ origin: 'island', text: 'plain job', idempotencyKey: 'plain', correlation: { voiceSessionId: 'live_x', delegationId: 'dx', turnId: 'dx' } });
    expect(h.status.status(job.jobId)).toEqual({ ok: false, status: 409, error: 'request_status is only available to voice requests' });
  });

  it('список ограничен последними открытыми', () => {
    const h = setup();
    for (let i = 0; i < 12; i += 1) h.submit(`d${i}`, { text: `question number ${i}` });
    const asker = h.submit('asker', { text: 'status?' });
    const outcome = h.status.status(asker.jobId);
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.text.split('\n').filter((row) => row.startsWith('- '))).toHaveLength(8);
    expect(outcome.text).toContain('question number 11');
    expect(outcome.text).not.toContain('question number 3"');
  });
});
