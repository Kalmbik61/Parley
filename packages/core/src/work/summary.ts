/**
 * Дозаказ резюме для сессии, вышедшей без отчёта (спецификация координации,
 * разделы 6 и 11; дизайн TUI, 4.5).
 *
 * Транскрипт извлекает адаптер логов провайдера, а само резюме считает стоковый
 * `claude -p` — тот же немодифицированный бинарь из PATH под логином
 * пользователя, что и обычная сессия. Команда и аргументы берутся из реестра:
 * подменить их можно `providers.json`, а не правкой кода.
 */

import { spawn } from 'node:child_process';
import { adapterV1 } from '../adapter-v1.js';
import { defaultCodexRoot, discoverCodexSessions } from '../codex/discover.js';
import { defaultRoot, discoverSessions } from '../discover.js';
import { forEachJsonlRecord, type RawRecord } from '../jsonl.js';
import { agentEnv, commandBinary, loadProviders, printCommand } from '../providers.js';
import type { MetricsRoots } from './metrics.js';
import { readMap, updateMap } from './store.js';
import type { WorkMap, WorkProvider, WorkSession } from './types.js';

/** Кто считает дозаказанное резюме: стоковый `claude -p` (решение №7). */
export const SUMMARIZER: WorkProvider = 'claude';

/** Сколько знаков транскрипта уезжает в промпт: остальное — хвост разговора. */
export const TRANSCRIPT_LIMIT = 40_000;

/** Длиннее этого одна реплика в транскрипт не едет: дальше начинаются простыни. */
const MESSAGE_LIMIT = 2_000;

/** Сколько ждём ответа суммаризатора, прежде чем оборвать вызов. */
export const SUMMARY_TIMEOUT_MS = 180_000;

export interface TranscriptOptions extends MetricsRoots {
  /** Предел длины транскрипта в знаках; по умолчанию `TRANSCRIPT_LIMIT`. */
  limit?: number;
}

/** Одна реплика разговора: роль и текст. */
interface Line {
  role: string;
  text: string;
}

const asRecord = (value: unknown): RawRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : null;

const str = (source: RawRecord | null, key: string): string | null => {
  if (source === null) return null;
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

/** Реплики человека и модели из лога Claude Code; субагенты сюда не идут. */
async function claudeLines(file: string): Promise<Line[]> {
  const lines: Line[] = [];
  await forEachJsonlRecord(file, (raw) => {
    const record = adapterV1.toSessionRecord(raw);
    // Ветка субагента — отдельный разговор: в резюме сессии от него шум.
    if (record.isSidechain) return;
    if (record.text === null) return;
    if (record.role !== 'user' && record.role !== 'assistant') return;
    lines.push({ role: record.role, text: record.text });
  });
  return lines;
}

/**
 * Реплики из rollout-лога Codex. Берутся события `user_message` и
 * `agent_message` — то, что видит человек; `response_item` не годится: там же
 * едут системные инструкции и AGENTS.md.
 */
async function codexLines(file: string): Promise<Line[]> {
  const lines: Line[] = [];
  await forEachJsonlRecord(file, (raw) => {
    if (str(raw, 'type') !== 'event_msg') return;
    const payload = asRecord(raw['payload']);
    const kind = str(payload, 'type');
    if (kind !== 'user_message' && kind !== 'agent_message') return;
    const text = str(payload, 'message');
    if (text === null) return;
    lines.push({ role: kind === 'user_message' ? 'user' : 'assistant', text });
  });
  return lines;
}

/** Лог провайдера по id сессии и способ разобрать его в реплики. */
async function transcriptSource(
  provider: WorkProvider,
  providerSessionId: string,
  roots: MetricsRoots,
): Promise<Promise<Line[]> | null> {
  if (provider === 'claude') {
    const root = roots.claudeRoot ?? defaultRoot();
    const found = (await discoverSessions(root)).find(
      (session) => session.id === providerSessionId,
    );
    return found === undefined ? null : claudeLines(found.file);
  }
  if (provider === 'codex') {
    const root = roots.codexRoot ?? defaultCodexRoot();
    const found = (await discoverCodexSessions(root)).find(
      (session) => session.id === providerSessionId,
    );
    return found === undefined ? null : codexLines(found.file);
  }
  return null;
}

/**
 * Текстовый транскрипт сессии провайдера. `null` — историю этого провайдера мы
 * не читаем (GLM и любой свой CLI) или лога с таким id нет.
 *
 * Длинный разговор режется с головы: для резюме важно, чем он закончился.
 */
export async function readTranscript(
  provider: WorkProvider,
  providerSessionId: string,
  options: TranscriptOptions = {},
): Promise<string | null> {
  const source = await transcriptSource(provider, providerSessionId, options);
  if (source === null) return null;

  const limit = options.limit ?? TRANSCRIPT_LIMIT;
  const lines = (await source).map(
    (line) =>
      `${line.role === 'user' ? 'human' : 'agent'}: ${
        line.text.length > MESSAGE_LIMIT ? `${line.text.slice(0, MESSAGE_LIMIT)}…` : line.text
      }`,
  );

  const text = lines.join('\n');
  if (text.length <= limit) return text;
  return `…start of the conversation omitted…\n${text.slice(text.length - limit)}`;
}

/** Промпт суммаризатору: что за сессия и её разговор. */
export function summaryPrompt(map: WorkMap, session: WorkSession, transcript: string): string {
  return [
    'Below is the transcript of an agent session from a Parley workspace.',
    `Workspace: "${map.work.title}". Workspace goal: ${map.work.goal || 'not recorded'}.`,
    // У тихой сессии задачи нет вовсе: пустое «Its task: .» суммаризатору
    // только мешает, как и пустая цель работы.
    session.task === ''
      ? `Session role: "${session.label}".`
      : `Session role: "${session.label}". Its task: ${session.task}.`,
    '',
    'Write, in English, a summary of the result of this session: what was done, how it ended,',
    'what was left undone. No more than three sentences, no preamble and no',
    'headings — only the text of the summary itself.',
    '',
    '--- transcript ---',
    transcript,
  ].join('\n');
}

/** Первая строка ошибки: в строку статуса помещается только она. */
const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/**
 * Один вызов провайдера-суммаризатора в режиме одного ответа. Оболочки нет:
 * запускается ровно бинарь из реестра с аргументами из реестра.
 */
function runSummarizer(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandBinary(command, env), [...args], {
      cwd,
      env: agentEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.stderr.on('data', (chunk: string) => (err += chunk));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} did not answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${command} failed to start: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${command} exited with code ${code ?? -1}: ${firstLine(err)}`));
    });
  });
}

export interface AutoSummaryOptions extends TranscriptOptions {
  /** Кем считать резюме; по умолчанию `claude` из реестра. */
  summarizer?: WorkProvider;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Дозаказ резюме: транскрипт сессии → один ответ суммаризатора → `summary` с
 * пометкой `summarySource: 'auto'` в карте. Статус сессии не меняется — резюме
 * дозаказано, а не отчёт агента (спецификация, раздел 6).
 */
export async function requestAutoSummary(
  projectPath: string,
  workId: string,
  sessionId: string,
  options: AutoSummaryOptions = {},
): Promise<string> {
  const map = await readMap(projectPath, workId);
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined)
    throw new Error(`session ${sessionId} is not in the map of workspace ${workId}`);

  const registry = await loadProviders();
  const provider = registry[session.provider];
  if (provider !== undefined && !provider.hasHistory) {
    throw new Error(
      `summary on demand is unavailable: provider ${provider.label} has no session history`,
    );
  }
  if (session.providerSessionId === null) {
    throw new Error(`session ${sessionId} has no provider log — nothing to build a summary from`);
  }

  const transcript = await readTranscript(session.provider, session.providerSessionId, options);
  if (transcript === null) {
    throw new Error(
      `log ${session.providerSessionId} does not exist — nothing to build a summary from`,
    );
  }
  if (transcript === '') throw new Error(`the transcript of session ${sessionId} is empty`);

  const summarizer = registry[options.summarizer ?? SUMMARIZER];
  if (summarizer === undefined || summarizer.runner.printArgs === undefined) {
    throw new Error(
      `summarizer ${options.summarizer ?? SUMMARIZER} cannot answer in one-shot mode`,
    );
  }

  const { command, args } = printCommand(summarizer, {
    prompt: summaryPrompt(map, session, transcript),
  });
  const output = await runSummarizer(
    command,
    args,
    projectPath,
    options.timeoutMs ?? SUMMARY_TIMEOUT_MS,
    options.env ?? process.env,
  );

  const summary = output.trim();
  if (summary === '') throw new Error(`${command} returned an empty summary`);

  await updateMap(projectPath, workId, (current) => {
    const target = current.sessions.find((candidate) => candidate.id === sessionId);
    if (target === undefined)
      throw new Error(`session ${sessionId} is not in the map of workspace ${workId}`);
    target.summary = summary;
    target.summarySource = 'auto';
  });
  return summary;
}
