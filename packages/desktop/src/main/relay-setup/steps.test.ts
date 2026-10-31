import { describe, expect, it } from 'vitest';
import type { Plan } from './plan.js';
import type { RemoteShell, RunResult } from './shell.js';
import { runPlan } from './steps.js';

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
