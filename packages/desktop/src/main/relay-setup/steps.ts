import type { Plan, PlanStep } from './plan.js';
import type { RemoteShell } from './shell.js';

export type StepStatus = 'running' | 'skipped' | 'done' | 'failed' | 'stopped';

export interface RunEvents {
  step(id: string, title: string, status: StepStatus): void;
  line(stepId: string, text: string): void;
}

export interface RunOutcome {
  ok: boolean;
  failedStep: string | null;
  /** The person cancelled: the run ended between two steps. */
  stopped?: boolean;
  /** Some step ran its commands (not only checks). */
  changed: boolean;
}

/** Runs one step: «check → do». Everything runs as root. */
async function runStep(step: PlanStep, shell: RemoteShell, events: RunEvents, changedBefore: boolean): Promise<'skipped' | 'done' | 'failed'> {
  const onLine = (text: string): void => events.line(step.id, text);
  if (step.check !== null) {
    events.line(step.id, `check: ${step.checkShow ?? step.check}`);
    const result = await shell.run(step.check, { sudo: true });
    if (result.code === 0 && !(step.rerunOnChange === true && changedBefore)) return 'skipped';
  }
  for (const command of step.commands) {
    events.line(step.id, `$ ${command.show.split('\n')[0] ?? ''}`);
    const result = await shell.run(command.run, { sudo: true, onLine });
    if (result.code !== 0) {
      events.line(step.id, `exit code ${result.code}`);
      return 'failed';
    }
  }
  return 'done';
}

export async function runPlan(plan: Plan, shell: RemoteShell, events: RunEvents, shouldStop: () => boolean = () => false): Promise<RunOutcome> {
  let changed = false;
  for (const step of plan.steps) {
    // A cancel never cuts a step in half (apt, compose): it takes effect before the next one.
    if (shouldStop()) {
      events.step(step.id, step.title, 'stopped');
      return { ok: false, failedStep: step.id, changed, stopped: true };
    }
    events.step(step.id, step.title, 'running');
    let status: 'skipped' | 'done' | 'failed';
    try {
      status = await runStep(step, shell, events, changed);
    } catch {
      events.line(step.id, 'the connection to the server was lost');
      status = 'failed';
    }
    events.step(step.id, step.title, status);
    if (status === 'failed') return { ok: false, failedStep: step.id, changed };
    if (status === 'done') changed = true;
  }
  return { ok: true, failedStep: null, changed };
}
