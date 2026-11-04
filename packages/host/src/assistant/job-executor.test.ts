import { describe, expect, it, vi } from 'vitest';
import type { ProviderEntry } from '@parley/core';
import { createJobExecutor, type JobExecutorDeps } from './job-executor.js';
import type { Job } from './jobs.js';
import type { TurnEnd, TurnHandle, TurnSpec } from './turn.js';

const job = { jobId: 'job-1', provider: 'claude', requestText: 'close the tab', correlation: { mode: 'text' } } as unknown as Job;
const entry = { id: 'claude', label: 'Claude', runner: { command: 'claude', assistantArgs: ['-p', '{prompt}'] } } as unknown as ProviderEntry;

function setup(end: TurnEnd, extra: Partial<JobExecutorDeps> = {}) {
  const specs: TurnSpec[] = [];
  const cancel = vi.fn();
  const run = vi.fn((spec: TurnSpec, onEvent: (event: never) => void): TurnHandle => {
    specs.push(spec);
    (onEvent as (event: { type: 'text'; delta: string }) => void)({ type: 'text', delta: 'Closed it.' });
    return { cancel, done: Promise.resolve(end) };
  });
  const execute = createJobExecutor({
    providers: async () => ({ claude: entry }),
    ready: async () => null,
    launchEnv: async () => ({}),
    binary: async (command) => `/bin/${command}`,
    cwd: '/tmp/assistant',
    ensureDir: async () => {},
    run: run as unknown as JobExecutorDeps['run'],
    ...extra,
  });
  return { execute, specs, run, cancel };
}

describe('job executor', () => {
  it('отдельный прогон с текстом job; без подтверждения хоста исход не confirmed', async () => {
    const { execute, specs } = setup({ ok: true });
    await expect(execute(job).done).resolves.toEqual({ ok: true, summary: 'Closed it.', confirmed: false });
    expect(specs[0]).toMatchObject({ command: '/bin/claude', cwd: '/tmp/assistant' });
    expect(specs[0]!.args).toContain('close the tab');
  });

  it('confirm хоста даёт confirmed', async () => {
    const { execute } = setup({ ok: true }, { confirm: () => true });
    await expect(execute(job).done).resolves.toMatchObject({ ok: true, confirmed: true });
  });

  it("текст лимита в kind 'other' классифицируется как limit", async () => {
    const { execute } = setup({ ok: false, kind: 'other', message: 'You hit your limit, resets at 5pm' });
    await expect(execute(job).done).resolves.toEqual({ ok: false, kind: 'limit', message: 'You hit your limit, resets at 5pm' });
  });

  it('провайдер не готов или неизвестен — start, прогон не запускается', async () => {
    const notReady = setup({ ok: true }, { ready: async () => 'sign in first' });
    await expect(notReady.execute(job).done).resolves.toEqual({ ok: false, kind: 'start', message: 'sign in first' });
    expect(notReady.run).not.toHaveBeenCalled();
    const unknown = setup({ ok: true }, { providers: async () => ({}) });
    await expect(unknown.execute(job).done).resolves.toMatchObject({ ok: false, kind: 'start' });
  });

  it('cancel гасит идущий прогон', async () => {
    const noop = () => {};
    let release: (end: TurnEnd) => void = noop;
    const cancel = vi.fn(() => release({ ok: false, kind: 'cancelled', message: 'cancelled' }));
    const execute = createJobExecutor({
      providers: async () => ({ claude: entry }),
      ready: async () => null,
      launchEnv: async () => ({}),
      binary: async (command) => command,
      cwd: '/tmp',
      ensureDir: async () => {},
      run: (() => ({ cancel, done: new Promise<TurnEnd>((resolve) => (release = resolve)) })) as unknown as JobExecutorDeps['run'],
    });
    const run = execute(job);
    // Ждём, пока прогон дойдёт до run(): cancel до этого отменил бы старт, а не процесс.
    await vi.waitFor(() => expect(release).not.toBe(noop));
    run.cancel();
    await expect(run.done).resolves.toMatchObject({ ok: false, kind: 'cancelled' });
    expect(cancel).toHaveBeenCalled();
  });

  it('рабочая папка создаётся до запуска процесса', async () => {
    const order: string[] = [];
    const { execute, run } = setup({ ok: true }, { ensureDir: async (dir) => void order.push(`mkdir ${dir}`) });
    run.mockImplementationOnce(() => {
      order.push('run');
      return { cancel: vi.fn(), done: Promise.resolve({ ok: true }) } as TurnHandle;
    });
    await execute(job).done;
    expect(order).toEqual(['mkdir /tmp/assistant', 'run']);
  });
});
