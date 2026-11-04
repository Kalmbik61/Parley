/* eslint-disable @typescript-eslint/no-explicit-any -- ответы обработчиков в тестах разбираются как JSON */
import { describe, expect, it, vi } from 'vitest';
import { openMemoryDb } from '@parley/core';
import { METHODS } from '@parley/protocol';
import { createJobs, type JobRun } from '../assistant/jobs.js';
import type { RequestInfo } from '../context.js';
import type { VoiceSessionService } from '../voice/voice-session-service.js';
import { createVoiceHandlers } from './voice.js';

const requestFrom = (role?: 'remote'): RequestInfo => ({ client: { id: 'c', name: 'c', features: new Set(), ...(role === undefined ? {} : { role }) } }) as unknown as RequestInfo;
const request = requestFrom();
const call = (handlers: ReturnType<typeof createVoiceHandlers>, name: string, params: unknown, from: RequestInfo = request): Promise<any> =>
  (handlers[name] as unknown as (params: unknown, request: RequestInfo) => Promise<unknown>)(params, from) as Promise<any>;

function realJobs() {
  const execute = vi.fn((): JobRun => ({ cancel: () => {}, done: new Promise(() => {}) }));
  return { jobs: createJobs({ db: openMemoryDb(), execute, defaultProvider: () => 'claude' }), execute };
}

describe('методы телефона: jobs', () => {
  it('jobs.submit ставит origin mobile; повтор с тем же ключом — тот же jobId и один запуск', async () => {
    const { jobs, execute } = realJobs();
    const handlers = createVoiceHandlers(jobs, undefined);
    const params = METHODS['jobs.submit'].parse({ text: 'run tests', idempotencyKey: 'k-1', correlation: { mode: 'text' } });
    const first = await call(handlers, 'jobs.submit', params);
    const again = await call(handlers, 'jobs.submit', params);
    expect(again.jobId).toBe(first.jobId);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(jobs.getJob(first.jobId)?.origin).toBe('mobile');
  });

  it('jobs.get и jobs.cancel отдают проекцию без argv, логов и ключа; неизвестный job — null', async () => {
    const getJob = vi.fn().mockReturnValue({
      jobId: 'j-1', idempotencyKey: 'secret-key', origin: 'mobile', correlation: { mode: 'text' }, state: 'running', revision: 1, requestText: 'x',
      resultSummary: null, provider: 'claude', createdAt: 1, updatedAt: 1, deliveredInline: false, argv: ['--token'], log: 'LOG',
    });
    const cancelJob = vi.fn().mockReturnValue(null);
    const handlers = createVoiceHandlers({ getJob, cancelJob } as never, undefined);
    const got = await call(handlers, 'jobs.get', { jobId: 'j-1' });
    expect(got.job).toMatchObject({ jobId: 'j-1', origin: 'mobile', state: 'running' });
    expect(JSON.stringify(got)).not.toMatch(/argv|LOG|secret-key|--token/);
    expect(await call(handlers, 'jobs.cancel', { jobId: 'nope' })).toEqual({ job: null });
  });

  it('без jobs методов jobs.* нет, без голоса — voice.*', () => {
    expect(Object.keys(createVoiceHandlers(undefined, undefined))).toEqual([]);
    const { jobs } = realJobs();
    expect(Object.keys(createVoiceHandlers(jobs, undefined)).sort()).toEqual(['jobs.cancel', 'jobs.get', 'jobs.submit']);
  });
});

describe('методы телефона: голосовая сессия', () => {
  const service = (over: Partial<VoiceSessionService> = {}): VoiceSessionService => ({
    prepare: vi.fn(async () => ({ ok: true as const, voiceSessionId: 'sess_1', sdpAnswer: 'ANSWER-SDP' })),
    close: vi.fn(async () => true),
    activeSessionId: () => null,
    ...over,
  });

  it('prepare отдаёт результат сервиса как есть, включая отказ limit_reached; close и usage', async () => {
    const svc = service();
    const usage = { limitSeconds: 1800, usedSeconds: 60, remainingSeconds: 1740 };
    const handlers = createVoiceHandlers(undefined, { service: svc, usage: () => usage });
    expect(await call(handlers, 'voice.session.prepare', { sdp: 'OFFER' })).toEqual({ ok: true, voiceSessionId: 'sess_1', sdpAnswer: 'ANSWER-SDP' });
    expect(await call(handlers, 'voice.session.close', { voiceSessionId: 'sess_1' })).toEqual({ closed: true });
    expect(await call(handlers, 'voice.usage.get', {})).toEqual(usage);

    const limited = createVoiceHandlers(undefined, {
      service: service({ prepare: async () => ({ ok: false, code: 'limit_reached', message: 'Daily voice limit reached' }) }),
      usage: () => usage,
    });
    expect(await call(limited, 'voice.session.prepare', { sdp: 'OFFER' })).toMatchObject({ ok: false, code: 'limit_reached' });
  });

  it('остров получает инструкции и клиентскую делегацию, телефон (remote) — прежний конфиг без делегации', async () => {
    const svc = service();
    const handlers = createVoiceHandlers(undefined, { service: svc, usage: () => ({ limitSeconds: 0, usedSeconds: 0, remainingSeconds: 0 }) });
    await call(handlers, 'voice.session.prepare', { sdp: 'ISLAND' });
    await call(handlers, 'voice.session.prepare', { sdp: 'PHONE' }, requestFrom('remote'));
    const [island, phone] = (svc.prepare as ReturnType<typeof vi.fn>).mock.calls as Array<[string, Record<string, unknown> | undefined]>;
    expect(island?.[0]).toBe('ISLAND');
    expect(island?.[1]).toMatchObject({ model: 'gpt-live-1', delegation: { type: 'client' } });
    expect(typeof island?.[1]?.['instructions']).toBe('string');
    expect(phone).toEqual(['PHONE']);
  });

  it('ничего не пишет в консоль: ни SDP, ни ответ', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    const handlers = createVoiceHandlers(undefined, { service: service(), usage: () => ({ limitSeconds: 0, usedSeconds: 0, remainingSeconds: 0 }) });
    await call(handlers, 'voice.session.prepare', { sdp: 'OFFER-SDP' });
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
