import { describe, expect, it, vi } from 'vitest';
import type { Plan } from './plan.js';
import { ConnectionLostError, type RemoteShell, type RunResult } from './shell.js';
import { createCancelHandle, requestCancel, runPlan } from './steps.js';

const cmd = (run: string) => ({ run, show: run });
const plan: Plan = {
  intent: 'install',
  notes: [],
  blocked: null,
  mode: 'caddy',
  address: 'x',
  proxy: null,
  steps: [
    { id: 'a', title: 'A', check: 'check-a', checkShow: 'check-a', commands: [cmd('do-a')] },
    { id: 'b', title: 'B', check: 'check-b', checkShow: 'check-b', commands: [cmd('do-b1'), cmd('do-b2')] },
    { id: 'c', title: 'C', check: 'check-c', checkShow: 'check-c', commands: [cmd('do-c')], rerunOnChange: true },
  ],
};

function shell(codes: Record<string, number>) {
  const ran: string[] = [];
  const s: RemoteShell = {
    async run(command): Promise<RunResult> {
      ran.push(command);
      return { code: codes[command] ?? 0, stdout: '', stderr: '' };
    },
  };
  return { s, ran };
}
const events = { step: () => undefined, line: () => undefined };

describe('runPlan', () => {
  it('a re-run with everything in place runs only the checks', async () => {
    const { s, ran } = shell({});
    const outcome = await runPlan(plan, s, events);
    expect(outcome).toEqual({ ok: true, failedStep: null, changed: false });
    expect(ran).toEqual(['check-a', 'check-b', 'check-c']);
  });

  it('does what a failed check asks and restarts after a change', async () => {
    const { s, ran } = shell({ 'check-b': 1 });
    const outcome = await runPlan(plan, s, events);
    expect(outcome.changed).toBe(true);
    expect(ran).toEqual(['check-a', 'check-b', 'do-b1', 'do-b2', 'check-c', 'do-c']);
  });

  it('stops at the first failing command', async () => {
    const { s, ran } = shell({ 'check-a': 1, 'do-a': 5 });
    const outcome = await runPlan(plan, s, events);
    expect(outcome).toEqual({ ok: false, failedStep: 'a', changed: false });
    expect(ran).toEqual(['check-a', 'do-a']);
  });

  it('treats a lost connection as a failed step', async () => {
    const lost: RemoteShell = { run: () => Promise.reject(new Error('gone')) };
    expect((await runPlan(plan, lost, events)).ok).toBe(false);
  });
});

describe('runPlan: commands run apart from the channel, checks do not', () => {
  it('every command gets an id from the step id and its number; checks have none', async () => {
    const seen: Array<{ command: string; detach: string | undefined }> = [];
    const s: RemoteShell = {
      async run(command, options) {
        seen.push({ command, detach: options?.detach });
        return { code: command.startsWith('check') ? 1 : 0, stdout: '', stderr: '' };
      },
    };
    await runPlan(plan, s, events);
    expect(seen.filter((c) => c.command.startsWith('check')).every((c) => c.detach === undefined)).toBe(true);
    expect(seen.filter((c) => !c.command.startsWith('check')).map((c) => [c.command, c.detach])).toEqual([
      ['do-a', 'a-1'],
      ['do-b1', 'b-1'],
      ['do-b2', 'b-2'],
      ['do-c', 'c-1'],
    ]);
  });
});

describe('runPlan: cancel', () => {
  const imagePlan: Plan = {
    ...plan,
    steps: [
      { id: 'dir', title: 'Dir', check: null, checkShow: null, commands: [cmd('mkdir')] },
      { id: 'image', title: 'Image', check: null, checkShow: null, commands: [cmd('pull-1'), cmd('pull-2')], interruptible: true },
      { id: 'start', title: 'Start', check: null, checkShow: null, commands: [cmd('up')] },
    ],
  };

  /** A shell whose command `hold` waits until `release()` and ends with `code`. */
  function gated(hold: string, code: () => number) {
    const ran: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const wait = new Promise<void>((r) => (release = r));
    const s: RemoteShell = {
      async run(command): Promise<RunResult> {
        ran.push(command);
        if (command === hold) {
          entered();
          await wait;
          return { code: code(), stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      async interrupt(id): Promise<RunResult> {
        ran.push(`<interrupt ${id}>`);
        release();
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    return { s, ran, inside, release };
  }

  it('an interruptible step is ended by a second command: stopped, not failed, nothing after it runs', async () => {
    const g = gated('pull-1', () => 143);
    const log: string[] = [];
    const handle = createCancelHandle();
    const running = runPlan(imagePlan, g.s, { step: (id, _t, status) => log.push(`${id}:${status}`), line: () => undefined }, handle);
    await g.inside;
    await requestCancel(handle);
    const outcome = await running;
    expect(outcome).toMatchObject({ ok: false, stopped: true, interrupted: true, failedStep: 'image' });
    expect(g.ran).toEqual(['mkdir', 'pull-1', '<interrupt image-1>']);
    expect(log).toContain('image:stopped');
    expect(log).toContain('start:stopped');
    expect(log).not.toContain('image:failed');
  });

  it('a step that cannot be interrupted announces «cancelling», finishes, and the rest is stopped', async () => {
    const g = gated('mkdir', () => 0);
    const cancelling = vi.fn();
    const log: string[] = [];
    const handle = createCancelHandle();
    const running = runPlan(imagePlan, g.s, { step: (id, _t, status) => log.push(`${id}:${status}`), line: () => undefined, cancelling }, handle);
    await g.inside;
    await requestCancel(handle);
    expect(cancelling).toHaveBeenCalledTimes(1);
    g.release();
    const outcome = await running;
    expect(outcome).toMatchObject({ ok: false, stopped: true, failedStep: 'image', changed: true });
    expect(outcome.interrupted).toBeUndefined();
    expect(g.ran).toEqual(['mkdir']);
    expect(log).toEqual(['dir:running', 'dir:done', 'image:stopped', 'start:stopped']);
  });

  it('when both interrupt attempts fail the window is told to wait for the step, and the stop is not reported as an interrupt', async () => {
    const g = gated('pull-1', () => 0);
    const tries: string[] = [];
    g.s.interrupt = async (id) => {
      tries.push(id);
      return { code: 1, stdout: '', stderr: '' };
    };
    const cancelling = vi.fn();
    const handle = createCancelHandle();
    const running = runPlan(imagePlan, g.s, { step: () => undefined, line: () => undefined, cancelling }, handle);
    await g.inside;
    await requestCancel(handle);
    expect(tries).toEqual(['image-1', 'image-1']);
    expect(cancelling).toHaveBeenCalledTimes(1);
    g.release();
    const outcome = await running;
    expect(outcome).toMatchObject({ stopped: true, failedStep: 'image' });
    expect(outcome.interrupted).toBeUndefined();
  });

  it('«cancelling» is not announced for a command that has already ended when the interrupt reports failure', async () => {
    const g = gated('pull-1', () => 143);
    g.s.interrupt = async () => {
      g.release();
      await new Promise((r) => setTimeout(r, 5));
      return { code: 1, stdout: '', stderr: '' };
    };
    const cancelling = vi.fn();
    const handle = createCancelHandle();
    const running = runPlan(imagePlan, g.s, { step: () => undefined, line: () => undefined, cancelling }, handle);
    await g.inside;
    await requestCancel(handle);
    await running;
    expect(cancelling).not.toHaveBeenCalled();
  });

  it('a cancel during a check starts no commands', async () => {
    const handle = createCancelHandle();
    const ran: string[] = [];
    const s: RemoteShell = {
      async run(command) {
        ran.push(command);
        await requestCancel(handle);
        return { code: 1, stdout: '', stderr: '' };
      },
    };
    const outcome = await runPlan(plan, s, events, handle);
    expect(outcome).toMatchObject({ stopped: true, failedStep: 'a' });
    expect(ran).toEqual(['check-a']);
  });

  it('a lost connection is reported as lost, the step row is not red; the command goes on on the server', async () => {
    const lost: RemoteShell = { run: () => Promise.reject(new ConnectionLostError()) };
    const log: string[] = [];
    expect(await runPlan(plan, lost, { step: (id, _t, status) => log.push(`${id}:${status}`), line: () => undefined })).toMatchObject({ ok: false, lost: true, failedStep: 'a' });
    expect(log).toEqual(['a:running', 'a:stopped']);
  });

  it('any other error (the command could not even be started) is an ordinary failure, not «lost»', async () => {
    const broken: RemoteShell = { run: () => Promise.reject(new Error('channel open failure')) };
    const log: string[] = [];
    const outcome = await runPlan(plan, broken, { step: (id, _t, status) => log.push(`${id}:${status}`), line: () => undefined });
    expect(outcome).toEqual({ ok: false, failedStep: 'a', changed: false });
    expect(log).toEqual(['a:running', 'a:failed']);
  });

  it('cancel during the check or between the commands of an interruptible step announces nothing: the step stops by itself', async () => {
    const cancelling = vi.fn();
    const handle = createCancelHandle();
    const s: RemoteShell = {
      async run(command) {
        if (command === 'pull-1') await requestCancel(handle);
        return { code: command === 'chk' ? 1 : 0, stdout: '', stderr: '' };
      },
      interrupt: async () => ({ code: 0, stdout: '', stderr: '' }),
    };
    const imagePlan: Plan = {
      ...plan,
      steps: [{ id: 'image', title: 'Image', check: 'chk', checkShow: 'chk', commands: [cmd('pull-1'), cmd('pull-2')], interruptible: true }],
    };
    const outcome = await runPlan(imagePlan, s, { step: () => undefined, line: () => undefined, cancelling }, handle);
    expect(outcome).toMatchObject({ stopped: true, failedStep: 'image' });
    expect(cancelling).not.toHaveBeenCalled();
  });
});

describe('runPlan: the image step turns the stream into progress', () => {
  it('JSON lines become progress events and a short log, never raw lines', async () => {
    const imagePlan: Plan = { ...plan, steps: [{ id: 'image', title: 'Image', check: null, checkShow: null, commands: [cmd('pull')], interruptible: true }] };
    const s: RemoteShell = {
      async run(_command, options) {
        options?.onLine?.('{"status":"Pulling fs layer","id":"821d9dafb26d"}');
        options?.onLine?.('{"status":"Downloading","progressDetail":{"current":5,"total":10},"id":"821d9dafb26d"}');
        options?.onLine?.('{"status":"Pull complete","id":"821d9dafb26d"}');
        options?.onLine?.('{"status":"Status: Downloaded newer image for x"}');
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const progress: unknown[] = [];
    const lines: string[] = [];
    await runPlan(imagePlan, s, { step: () => undefined, line: (_id, text) => lines.push(text), progress: (_id, p) => progress.push(p) });
    expect(progress.at(-1)).toMatchObject({ layersDone: 1, layersTotal: 1 });
    expect(lines.join('\n')).not.toContain('{"status"');
    expect(lines).toContain('Status: Downloaded newer image for x');
  });
});
