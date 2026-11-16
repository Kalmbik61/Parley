/**
 * Мост пакета состояния комнаты (спека 2026-11-16, 3.5): командный хук `SessionStart` в файле настроек сессии Claude.
 * Запускается как `parley-packet-hook <адрес пути пакета> <имя переменной с токеном>`: адреса в окружении процесса Claude нет,
 * поэтому он едет аргументом команды; токен берётся из переменной запуска, сессия — `PARLEY_SESSION_ID`.
 *
 * Не сжатие (`source` не `compact`) — выход с кодом 0 сразу, ничего не печатая и не запрашивая: старт и возобновление не
 * ждут хост. Сжатие — запрос хосту, ответ не дольше `BRIDGE_WAIT_MS`. Печатается только
 * `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<пакет>"}}`, иначе — пустота. Код выхода всегда 0.
 *
 * Своя запись моста в `events/<сессия>.jsonl` — одна строка на событие сжатия: исход и время работы. Она не доказывает
 * получение пакета сессией: его подтверждает только транскрипт.
 */

import { appendFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Сколько мост ждёт хост: меньше предела хука в файле настроек (2 с). */
export const BRIDGE_WAIT_MS = 1500;

/** Имя события записи моста; совпадает с `PACKET_BRIDGE_EVENT` core (тест сверяет), core мост не грузит ради скорости старта. */
const BRIDGE_EVENT = 'ParleyRoomPacketBridge';

export type BridgeOutcome = 'printed' | 'empty' | 'timeout' | 'refused' | 'unreachable';

export interface BridgeDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Дописывает строку в файл журнала; по умолчанию `appendFile`. */
  append?: (file: string, line: string) => Promise<void>;
  waitMs?: number;
}

/** Окружение: новое имя, а нет его — прежнее `HARNAS_*`, как у журнального хука. */
const fromEnv = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[`PARLEY_${key}`] ?? env[`HARNAS_${key}`];
  return value === undefined || value === '' ? undefined : value;
};

async function ask(
  url: string | undefined,
  token: string | undefined,
  session: string | undefined,
  input: string,
  fetchImpl: typeof fetch,
  waitMs: number,
): Promise<{ outcome: BridgeOutcome; out: string }> {
  if (!url || !token || !session) return { outcome: 'unreachable', out: '' };
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-parley-session': session, 'content-type': 'application/json' },
      body: input,
      signal: AbortSignal.timeout(waitMs),
    });
    if (response.status !== 200) return { outcome: 'refused', out: '' };
    let context: unknown;
    try {
      const parsed = JSON.parse(await response.text()) as { hookSpecificOutput?: { additionalContext?: unknown } } | null;
      context = parsed?.hookSpecificOutput?.additionalContext;
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw error;
      return { outcome: 'empty', out: '' };
    }
    if (typeof context !== 'string' || context === '') return { outcome: 'empty', out: '' };
    return {
      outcome: 'printed',
      out: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }),
    };
  } catch (error) {
    return { outcome: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable', out: '' };
  }
}

/** Что печатать в stdout. Ничего не бросает. */
export async function runPacketBridge(
  input: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: BridgeDeps = {},
): Promise<string> {
  let event: unknown;
  try {
    event = JSON.parse(input);
  } catch {
    return '';
  }
  if (
    typeof event !== 'object' || event === null ||
    (event as Record<string, unknown>)['hook_event_name'] !== 'SessionStart' ||
    (event as Record<string, unknown>)['source'] !== 'compact'
  ) return '';

  const now = deps.now ?? Date.now;
  const startedAt = now();
  const [url, tokenEnv] = args;
  const session = fromEnv(env, 'SESSION_ID');
  const { outcome, out } = await ask(
    url,
    tokenEnv === undefined ? undefined : env[tokenEnv],
    session,
    input,
    deps.fetchImpl ?? fetch,
    deps.waitMs ?? BRIDGE_WAIT_MS,
  );

  // Запись моста: каталога `events/` нет — не создаём; сбой записи ничего не меняет.
  const workDir = fromEnv(env, 'WORK_DIR');
  if (workDir !== undefined && session !== undefined) {
    const line = `${JSON.stringify({ hook_event_name: BRIDGE_EVENT, outcome, ms: now() - startedAt })}\n`;
    try {
      await (deps.append ?? ((file, text) => appendFile(file, text, 'utf8')))(path.join(workDir, 'events', `${session}.jsonl`), line);
    } catch {
      /* журнал — подсказка, не условие */
    }
  }
  return out;
}

async function main(): Promise<void> {
  let out = '';
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    out = await runPacketBridge(Buffer.concat(chunks).toString('utf8'), process.argv.slice(2), process.env);
  } catch {
    out = '';
  }
  // Код 0 в любом исходе; выход явный, чтобы соединение в пуле не держало процесс.
  process.stdout.write(out, () => process.exit(0));
}

// Запускается как файл; при импорте из теста ничего не делает (сравнение по realpath, как у моста Codex).
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) void main();
