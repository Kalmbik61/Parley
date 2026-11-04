/**
 * Прогон CLI для job Assistant Core (спека 2026-11-03, C2): отдельный процесс на каждый job, на той же машинерии хода
 * (`runTurn`, `assistantCommand`), но не разговор помощника: `runAsk` и `stopTurn` не зовутся, сессия CLI не
 * сохраняется. Без подтверждения хоста или инструмента исход не «выполнено» (PA-15): `confirmed` решает `confirm`,
 * по умолчанию прогон только отвечает текстом и подтверждения у него нет.
 */

import { mkdir } from 'node:fs/promises';
import { assistantCommand, classifyAssistantError, parseClaudeLine, parseCodexLine, type ProviderEntry } from '@parley/core';
import type { Job, JobEnd, JobRun } from './jobs.js';
import { runTurn, type TurnHandle, type TurnSpec } from './turn.js';

export const JOB_TURN_MS = 10 * 60_000;
const JOB_PROMPT = 'You run a task for the person in the background. Do it, then reply with one or two plain sentences saying what you did or why you could not. Do not claim success you did not observe.';

export interface JobExecutorDeps {
  providers(): Promise<Record<string, ProviderEntry>>;
  /** `null` — провайдер готов; иначе причина. */
  ready(entry: ProviderEntry): Promise<string | null>;
  launchEnv(entry: ProviderEntry): Promise<NodeJS.ProcessEnv>;
  binary(command: string): Promise<string>;
  /** Рабочая папка прогона (папка помощника). */
  cwd: string;
  /** Создаёт рабочую папку перед запуском (без неё spawn падает с ENOENT); по умолчанию `mkdir -p`. */
  ensureDir?(dir: string): Promise<void>;
  /** Подтвердил ли хост исполнение; без него job уходит в `needs_confirmation`. */
  confirm?(job: Job, summary: string): boolean;
  run?(spec: TurnSpec, onEvent: Parameters<typeof runTurn>[1]): TurnHandle;
  timeoutMs?: number;
}

export function createJobExecutor(deps: JobExecutorDeps): (job: Job) => JobRun {
  const run = deps.run ?? runTurn;
  return (job) => {
    let handle: TurnHandle | null = null;
    let cancelled = false;
    const done = (async (): Promise<JobEnd> => {
      const failure = (kind: 'start' | 'cancelled', message: string): JobEnd => ({ ok: false, kind, message });
      const entry = (await deps.providers())[job.provider];
      if (entry === undefined) return failure('start', `Unknown provider ${job.provider}`);
      const problem = await deps.ready(entry);
      if (problem !== null) return failure('start', problem);
      const command = assistantCommand(entry, { prompt: job.requestText, systemPrompt: JOB_PROMPT }, false);
      if (command === null) return failure('start', `${entry.label} can't run the assistant`);
      const binary = await deps.binary(command.command);
      const env = await deps.launchEnv(entry);
      if (cancelled) return failure('cancelled', 'cancelled');
      await (deps.ensureDir ?? ((dir) => mkdir(dir, { recursive: true }).then(() => undefined)))(deps.cwd);
      if (cancelled) return failure('cancelled', 'cancelled');
      const codex = entry.runner.mcpConfig === 'codex-override';
      let text = '';
      handle = run(
        { command: binary, args: command.args, env, cwd: deps.cwd, parse: codex ? parseCodexLine : parseClaudeLine, timeoutMs: deps.timeoutMs ?? JOB_TURN_MS },
        (event) => {
          if (event.type === 'text') text += event.delta;
        },
      );
      const end = await handle.done;
      if (end.ok) {
        const summary = text.trim() === '' ? 'The run finished without a reply' : text.trim().slice(0, 2000);
        return { ok: true, summary, confirmed: deps.confirm?.(job, summary) ?? false };
      }
      // Лимит узнаётся и по тексту: job в этом случае возвращается в очередь, а не падает.
      const kind = end.kind === 'other' ? classifyAssistantError(end.message) : end.kind;
      return { ok: false, kind, message: end.message };
    })().catch((error: unknown): JobEnd => ({ ok: false, kind: 'start', message: (error as Error).message }));
    return {
      cancel: () => {
        cancelled = true;
        handle?.cancel();
      },
      done,
    };
  };
}
