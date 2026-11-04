/**
 * Прогон CLI для job Assistant Core (спека 2026-11-03, C2; план голоса, T1): отдельный процесс на каждый job, на той же
 * машинерии хода (`runTurn`, `assistantCommand`), но не разговор помощника: `runAsk` и `stopTurn` не зовутся, сессия CLI
 * не сохраняется. У job свой MCP помощника с токеном, привязанным к `jobId` (`job-tokens.ts`); токен разговора ему не
 * отдаётся, а инструменты ограничены `JOB_TOOL_ALLOWLIST`: чтение плюс `propose_*`. Что job вызвал и какие карточки
 * подготовил, записывает хост; исход решает он же (PA-15): `completed` — ответ готов, `needs_confirmation` — модель
 * заявила действие, а карточки нет.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assistantCodexMcp,
  assistantCommand,
  assistantMcpJson,
  classifyAssistantError,
  codexInstructionsFile,
  parseClaudeLine,
  parseCodexLine,
  type ProviderEntry,
} from '@parley/core';
import type { JobTokens } from './job-tokens.js';
import type { Job, JobEnd, JobResult, JobRun } from './jobs.js';
import { runTurn, type TurnHandle, type TurnSpec } from './turn.js';

export const JOB_TURN_MS = 10 * 60_000;
export const JOB_PROMPT = [
  'You run one background task for the person; Parley reads your reply aloud later.',
  'Your first step is to call link_request, if that tool is available to you.',
  'Look things up with the Parley tools and never guess: if the tools do not show it, say "не знаю" (or the same in the language of the task).', // cyrillic-ok: фраза, которую спека требует вместо догадки
  'Reply with one to three short plain sentences, in the language of the task.',
  'Name people, rooms and agents by their names, never by ids such as s-12, r-3 or work:…, and never read tool data blocks aloud.',
  'You cannot do anything yourself. To send a message, create, start, stop or close something, or answer a request, only prepare a card with a propose_* tool: the person confirms it.',
  'Then say it is prepared and waits for the confirmation. Never say it was done, and do not claim anything you did not observe.',
].join('\n');

/**
 * Модель заявляет, что действие уже сделано: «я отправил», «создала», «I sent». Грубо и намеренно в сторону
 * осторожности: ложное срабатывание лишь переводит job в `needs_confirmation`, пропуск выдал бы выдумку за исполнение.
 */
const CLAIMED_ACTION = new RegExp(
  [
    String.raw`\bI(?:'ve| have)?\s+(?:just\s+)?(?:sent|created|started|woke|stopped|closed|interrupted|added|scheduled|cancel(?:l)?ed|approved|denied|answered|accepted|returned)\b`,
    String.raw`(?:^|[.!?…]\s+|(?<![\p{L}])я\s+)(?:отправил|создал|запустил|разбудил|остановил|закрыл|прервал|добавил|отменил|одобрил|подтвердил|ответил)[аи]?(?![\p{L}])`, // cyrillic-ok: русские формы заявленного действия
  ].join('|'),
  'iu',
);

export const claimsDoneAction = (answer: string): boolean => CLAIMED_ACTION.test(answer);

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
  /** Токены job и записи хоста о его вызовах и карточках. */
  tokens: Pick<JobTokens, 'issue' | 'revoke' | 'take'>;
  /** База маршрута помощника (`<origin>/assistant`); `null` — сервер хуков ещё не поднят. */
  endpointUrl(): string | null;
  run?(spec: TurnSpec, onEvent: Parameters<typeof runTurn>[1]): TurnHandle;
  timeoutMs?: number;
  now?(): number;
}

export function createJobExecutor(deps: JobExecutorDeps): (job: Job) => JobRun {
  const run = deps.run ?? runTurn;
  const now = deps.now ?? Date.now;
  return (job) => {
    let handle: TurnHandle | null = null;
    let cancelled = false;
    const done = (async (): Promise<JobEnd> => {
      const failure = (kind: 'start' | 'cancelled', message: string): JobEnd => ({ ok: false, kind, message });
      const entry = (await deps.providers())[job.provider];
      if (entry === undefined) return failure('start', `Unknown provider ${job.provider}`);
      const problem = await deps.ready(entry);
      if (problem !== null) return failure('start', problem);
      const url = deps.endpointUrl();
      if (url === null) return failure('start', 'Parley is still starting — try again');
      const token = deps.tokens.issue(job.jobId);
      let dir: string | null = null;
      try {
        const codex = entry.runner.mcpConfig === 'codex-override';
        await (deps.ensureDir ?? ((target) => mkdir(target, { recursive: true }).then(() => undefined)))(deps.cwd);
        // Файлы прогона (конфиг MCP с токеном, промпт Codex) — в папке только для владельца; после прогона она удаляется.
        dir = await mkdtemp(path.join(deps.cwd, 'job-'));
        const mcpFile = path.join(dir, 'mcp.json');
        const promptFile = path.join(dir, 'prompt.md');
        await writeFile(mcpFile, assistantMcpJson({ url, token }), { mode: 0o600 });
        await writeFile(promptFile, JOB_PROMPT, { mode: 0o600 });
        const command = assistantCommand(
          entry,
          {
            prompt: job.requestText,
            mcpConfig: codex ? assistantCodexMcp({ url, token }) : mcpFile,
            systemPrompt: JOB_PROMPT,
            developerInstructions: codexInstructionsFile(promptFile),
          },
          false,
        );
        if (command === null) return failure('start', `${entry.label} can't run the assistant`);
        const binary = await deps.binary(command.command);
        const env = await deps.launchEnv(entry);
        if (cancelled) return failure('cancelled', 'cancelled');
        let text = '';
        handle = run(
          { command: binary, args: command.args, env, cwd: deps.cwd, parse: codex ? parseCodexLine : parseClaudeLine, timeoutMs: deps.timeoutMs ?? JOB_TURN_MS },
          (event) => {
            if (event.type === 'text') text += event.delta;
          },
        );
        const end = await handle.done;
        if (end.ok) {
          const answer = text.trim().slice(0, 2000);
          if (answer === '') return { ok: false, kind: 'other', message: 'The run finished without a reply' };
          const record = deps.tokens.take(job.jobId);
          const result: JobResult = { answer, capturedAt: now(), cards: record.cards, toolRefs: record.toolRefs };
          // Карточки записал хост: заявленное без карточки действие — не исполнение.
          const outcome = result.cards.length === 0 && claimsDoneAction(answer) ? 'needs_confirmation' : 'completed';
          return { ok: true, summary: answer, result, outcome };
        }
        // Лимит узнаётся и по тексту: job в этом случае возвращается в очередь, а не падает.
        const kind = end.kind === 'other' ? classifyAssistantError(end.message) : end.kind;
        return { ok: false, kind, message: end.message };
      } finally {
        // Токен действует, пока идёт прогон: дальше маршруты помощника отвечают ему 401.
        deps.tokens.revoke(job.jobId);
        deps.tokens.take(job.jobId);
        if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    })().catch((error: unknown): JobEnd => ({ ok: false, kind: 'start', message: (error as Error).message }));
    return {
      cancel: () => {
        cancelled = true;
        deps.tokens.revoke(job.jobId);
        handle?.cancel();
      },
      done,
    };
  };
}
