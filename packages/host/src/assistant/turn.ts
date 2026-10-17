/**
 * Один ход помощника (спека 2026-10-14, 6.3): процесс CLI без терминала, строки stdout — в события через разборщик
 * провайдера. Конец — событие `done`/`error`, таймаут, отмена или выход без итога (тогда причина — по stderr).
 * Codex после `turn.completed` живёт ещё ~5 с — после итога процесс гасится, не дожидаясь (приложение A.2).
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { classifyAssistantError, type AssistantStreamEvent } from '@parley/core';

export type TurnEnd =
  | { ok: true }
  | { ok: false; kind: 'limit' | 'resume' | 'timeout' | 'cancelled' | 'start' | 'other'; message: string };

export interface TurnSpec {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  parse(line: string): AssistantStreamEvent[];
  timeoutMs: number;
}

export interface TurnHandle {
  cancel(): void;
  readonly done: Promise<TurnEnd>;
}

export const KILL_GRACE_MS = 2000;
const STDERR_TAIL = 4000;

export function runTurn(spec: TurnSpec, onEvent: (event: AssistantStreamEvent) => void, spawn: typeof nodeSpawn = nodeSpawn): TurnHandle {
  let settle: (end: TurnEnd) => void = () => {};
  const done = new Promise<TurnEnd>((resolve) => {
    settle = resolve;
  });
  let finished = false;
  let child: ChildProcess | undefined;
  let stdout = '';
  let stderr = '';

  const alive = (): boolean => child !== undefined && child.exitCode === null && child.signalCode === null;
  const finish = (end: TurnEnd): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (alive()) {
      child?.kill('SIGTERM');
      setTimeout(() => {
        if (alive()) child?.kill('SIGKILL');
      }, KILL_GRACE_MS).unref();
    }
    settle(end);
  };

  const timer = setTimeout(() => finish({ ok: false, kind: 'timeout', message: `no answer in ${Math.round(spec.timeoutMs / 1000)} s` }), spec.timeoutMs);
  try {
    child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    finish({ ok: false, kind: 'start', message: (error as Error).message });
    return { cancel: () => {}, done };
  }

  const feed = (line: string): void => {
    for (const event of spec.parse(line)) {
      if (finished) return;
      onEvent(event);
      if (event.type === 'done') finish({ ok: true });
      else if (event.type === 'error') finish({ ok: false, kind: event.kind, message: event.message });
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    let newline = stdout.indexOf('\n');
    while (newline !== -1) {
      feed(stdout.slice(0, newline));
      stdout = stdout.slice(newline + 1);
      newline = stdout.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  child.on('error', (error) => finish({ ok: false, kind: 'start', message: error.message }));
  child.on('close', (code) => {
    if (stdout.trim() !== '') feed(stdout);
    stdout = '';
    const message = stderr.trim() === '' ? `the CLI exited with code ${code ?? -1}` : stderr.trim();
    finish({ ok: false, kind: classifyAssistantError(message), message });
  });

  return { cancel: () => finish({ ok: false, kind: 'cancelled', message: 'cancelled' }), done };
}
