import type { RelayPullProgress } from '../../shared/relay-setup-types.js';
import type { Plan, PlanStep } from './plan.js';
import { createPullProgress } from './pull-progress.js';
import { ConnectionLostError, type RemoteShell } from './shell.js';

export type StepStatus = 'running' | 'skipped' | 'done' | 'failed' | 'stopped';

export interface RunEvents {
  step(id: string, title: string, status: StepStatus): void;
  line(stepId: string, text: string): void;
  progress?(stepId: string, progress: RelayPullProgress): void;
  /** A cancel arrived during a step that cannot be interrupted: the run stops after it. */
  cancelling?(): void;
}

export interface RunOutcome {
  ok: boolean;
  failedStep: string | null;
  /** The person cancelled: `failedStep` is the step that was stopped. */
  stopped?: boolean;
  /** The running command was ended by the cancel (second channel), not allowed to finish. */
  interrupted?: boolean;
  /** The connection dropped during a step; the command goes on on the server (spec 7.3). */
  lost?: boolean;
  /** Some step ran its commands (not only checks). */
  changed: boolean;
}

/** Owned by the caller of `runPlan`: lets a cancel reach the step that is running. */
export interface CancelHandle {
  requested: boolean;
  /** Set by `runPlan` while it runs. */
  trigger: (() => Promise<void>) | null;
}

export const createCancelHandle = (): CancelHandle => ({ requested: false, trigger: null });

export async function requestCancel(handle: CancelHandle): Promise<void> {
  if (handle.requested) return;
  handle.requested = true;
  await handle.trigger?.();
}

interface Live {
  /** The step being run. */
  step: PlanStep | null;
  /** Id of the command of an interruptible step that is on the server now (not a check); `null` otherwise. */
  command: string | null;
  interrupted: boolean;
}

/** Runs one step: «check → do». Everything runs as root. */
async function runStep(
  step: PlanStep,
  shell: RemoteShell,
  events: RunEvents,
  changedBefore: boolean,
  cancel: CancelHandle,
  live: Live,
): Promise<'skipped' | 'done' | 'failed' | 'stopped'> {
  if (step.check !== null) {
    events.line(step.id, `check: ${step.checkShow ?? step.check}`);
    const result = await shell.run(step.check, { sudo: true });
    if (result.code === 0 && !(step.rerunOnChange === true && changedBefore)) return 'skipped';
  }
  // A cancel during the check: nothing has been changed yet, the step does not start.
  if (cancel.requested) return 'stopped';
  for (const [index, command] of step.commands.entries()) {
    events.line(step.id, `$ ${command.show.split('\n')[0] ?? ''}`);
    // The image step turns the download stream into progress events instead of a wall of JSON lines.
    const pull =
      step.id === 'image'
        ? createPullProgress({
            onProgress: (p) => events.progress?.(step.id, p),
            onLog: (text) => events.line(step.id, text),
          })
        : null;
    const id = `${step.id}-${index + 1}`;
    live.command = step.interruptible === true ? id : null;
    let result;
    try {
      result = await shell.run(command.run, {
        sudo: true,
        onLine: pull !== null ? pull.feed : (text) => events.line(step.id, text),
        detach: id,
      });
    } finally {
      live.command = null;
      pull?.finish();
    }
    if (result.code !== 0) {
      if (live.interrupted) return 'stopped';
      events.line(step.id, `exit code ${result.code}`);
      return 'failed';
    }
    // An interruptible step stops between commands; the others are finished (a half-done apt run is worse).
    if (cancel.requested && step.interruptible === true && index + 1 < step.commands.length) return 'stopped';
  }
  return 'done';
}

export async function runPlan(plan: Plan, shell: RemoteShell, events: RunEvents, cancel: CancelHandle = createCancelHandle()): Promise<RunOutcome> {
  let changed = false;
  const live: Live = { step: null, command: null, interrupted: false };
  cancel.trigger = async () => {
    const id = live.command;
    if (id !== null) {
      live.interrupted = true;
      // The command may just be starting (the interrupt itself waits for it for a few seconds); one more try if the
      // second channel failed while the command is still there.
      for (let attempt = 0; attempt < 2 && live.command === id; attempt += 1) {
        try {
          if ((await shell.interrupt?.(id))?.code === 0) return;
        } catch {
          // the second channel failed
        }
      }
      // Nothing was killed: the command ends on its own and the run stops after it, as for a step that cannot be interrupted.
      live.interrupted = false;
      events.cancelling?.();
    } else if (live.step?.interruptible !== true) events.cancelling?.();
    // An interruptible step between its commands (or in its check) stops by itself at the next check.
  };

  const stopFrom = (index: number): RunOutcome => {
    for (const rest of plan.steps.slice(index)) events.step(rest.id, rest.title, 'stopped');
    return { ok: false, failedStep: plan.steps[index]?.id ?? null, changed, stopped: true, ...(live.interrupted ? { interrupted: true } : {}) };
  };

  try {
    for (const [index, step] of plan.steps.entries()) {
      if (cancel.requested) return stopFrom(index);
      events.step(step.id, step.title, 'running');
      live.step = step;
      let status: 'skipped' | 'done' | 'failed' | 'stopped';
      try {
        status = await runStep(step, shell, events, changed, cancel, live);
      } catch (error) {
        if (!(error instanceof ConnectionLostError)) {
          // The command did not start (the channel could not be opened, ...): a plain failure.
          events.line(step.id, 'the command could not be started on the server');
          events.step(step.id, step.title, 'failed');
          return { ok: false, failedStep: step.id, changed };
        }
        // The command goes on on the server: the row is not red.
        events.step(step.id, step.title, 'stopped');
        return { ok: false, failedStep: step.id, changed, lost: true };
      }
      if (status === 'stopped') {
        // The stopped step itself is reported here, the ones after it by `stopFrom`.
        events.step(step.id, step.title, 'stopped');
        for (const rest of plan.steps.slice(index + 1)) events.step(rest.id, rest.title, 'stopped');
        return { ok: false, failedStep: step.id, changed: changed || live.interrupted, stopped: true, ...(live.interrupted ? { interrupted: true } : {}) };
      }
      events.step(step.id, step.title, status);
      if (status === 'failed') return { ok: false, failedStep: step.id, changed };
      if (status === 'done') changed = true;
    }
    return { ok: true, failedStep: null, changed };
  } finally {
    cancel.trigger = null;
  }
}
