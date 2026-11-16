/**
 * Мост пакета состояния комнаты (спека 2026-11-16, 3.5): командный хук `SessionStart` в файле настроек сессии Claude.
 * Запускается как `parley-packet-hook <адрес пути пакета> <имя переменной с токеном>`: адреса в окружении процесса Claude нет,
 * поэтому он едет аргументом команды; токен берётся из переменной запуска, сессия — `PARLEY_SESSION_ID`.
 *
 * Не сжатие (`source` не `compact`) — выход с кодом 0 сразу, ничего не печатая и не запрашивая: старт и возобновление не
 * ждут хост. Сжатие — запрос хосту, ответ не дольше `BRIDGE_WAIT_MS`. Печатается только
 * `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<пакет>"}}`, иначе — пустота. Код выхода всегда 0.
 *
 * Своя запись моста в `events/<сессия>.jsonl` — одна строка на событие сжатия: исход и время запроса к хосту (`requestMs`, не
 * вся длительность хука). Ответ печатается первым, запись идёт после и ждёт не дольше `JOURNAL_GRACE_MS`: зависшая запись не
 * задерживает ни вывод, ни выход с кодом 0. Запись не доказывает получение пакета сессией: его подтверждает только транскрипт.
 */

import { spawn } from 'node:child_process';
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
  /** Дописывает строку в файл журнала; по умолчанию — отдельный процесс (`appendDetached`). */
  append?: (file: string, line: string) => Promise<void>;
  waitMs?: number;
}

/** Предел жизни процесса-писателя: зависшая запись (том не отвечает, канал без читателя) не оставляет его навсегда. */
const WRITER_LIFETIME_MS = 3000;

/** Код писателя: дописать строку и выйти; не успел за срок — убить себя (заблокированный вызов ОС иначе не прервать). */
const WRITER_SOURCE =
  `setTimeout(()=>process.kill(process.pid,'SIGKILL'),${WRITER_LIFETIME_MS});` +
  `require('node:fs').appendFile(process.argv[1],process.argv[2],()=>process.exit(0));`;

/**
 * Запись в журнал отдельным отсоединённым процессом. Запись в этом же процессе вешала бы и выход: `process.exit` ждёт
 * заблокированный вызов ОС в пуле потоков (проверено на именованном канале без читателя), а выход с кодом 0 после печати
 * ответа — условие моста. Процесс-писатель ни с чем связан не остаётся: без каналов ввода-вывода, не удерживает мост.
 */
export function appendDetached(file: string, line: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const child = spawn(process.execPath, ['-e', WRITER_SOURCE, file, line], { detached: true, stdio: 'ignore' });
      child.on('error', () => resolve());
      child.unref();
      // Запущен — запись дальше идёт без нас.
      child.on('spawn', () => resolve());
    } catch {
      resolve();
    }
  });
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

/**
 * Итог запуска: `out` — что печатать в stdout; `journal` — отложенная запись моста: пока её не вызвали, ничего не начато, в том
 * числе и сам запуск писателя. Вызывающий печатает `out`, и только когда вывод записан, запускает `journal` и ограничивает
 * ожидание им (`finish`). Возвращаемое обещание не отклоняется.
 */
export interface BridgeResult {
  out: string;
  journal: () => Promise<void>;
}

/** Не сжатие: ни запроса, ни записи. */
const IDLE: BridgeResult = { out: '', journal: async () => {} };

/** Ничего не бросает; записи журнала здесь не начинается — её запускает вызывающий после вывода. */
export async function runPacketBridge(
  input: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: BridgeDeps = {},
): Promise<BridgeResult> {
  let event: unknown;
  try {
    event = JSON.parse(input);
  } catch {
    return IDLE;
  }
  if (
    typeof event !== 'object' || event === null ||
    (event as Record<string, unknown>)['hook_event_name'] !== 'SessionStart' ||
    (event as Record<string, unknown>)['source'] !== 'compact'
  ) return IDLE;

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

  // Запись моста: каталога `events/` нет — не создаём; сбой записи ничего не меняет. `requestMs` — время запроса к хосту, а не
  // всего хука: строка собирается здесь, сама запись откладывается до конца вывода.
  const workDir = fromEnv(env, 'WORK_DIR');
  if (workDir === undefined || session === undefined) return { out, journal: async () => {} };
  const line = `${JSON.stringify({ hook_event_name: BRIDGE_EVENT, outcome, requestMs: now() - startedAt })}\n`;
  const file = path.join(workDir, 'events', `${session}.jsonl`);
  const append = deps.append ?? appendDetached;
  return {
    out,
    journal: async () => {
      try {
        await append(file, line);
      } catch {
        /* журнал — подсказка, не условие */
      }
    },
  };
}

/** Сколько после вывода мост ещё ждёт запись журнала: дальше — выход с кодом 0, как бы ни шла запись. */
export const JOURNAL_GRACE_MS = 300;

/**
 * Печатает ответ; когда вывод записан, запускает запись журнала (и сам запуск писателя) и ждёт её не дольше `JOURNAL_GRACE_MS`.
 * Печать — первая и от записи не зависит; зависшая запись (медленный или недоступный том) ни задерживает вывод, ни мешает выходу.
 */
export async function finish(result: BridgeResult, write: (out: string, done: () => void) => void, graceMs = JOURNAL_GRACE_MS): Promise<void> {
  await new Promise<void>((printed) => write(result.out, printed));
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    result.journal().catch(() => {}),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); }),
  ]);
  clearTimeout(timer);
}

async function main(): Promise<void> {
  // Предохранитель выхода: на любой путь завершения не больше срока ожидания хоста плюс льготы записи; сам по себе таймер
  // выход не откладывает.
  let result: BridgeResult = IDLE;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    result = await runPacketBridge(Buffer.concat(chunks).toString('utf8'), process.argv.slice(2), process.env);
  } catch {
    result = IDLE;
  }
  // Печать первая; код 0 в любом исходе. Явный выход: ни соединение в пуле, ни зависшая запись не держат процесс.
  const hardStop = setTimeout(() => process.exit(0), JOURNAL_GRACE_MS * 2);
  hardStop.unref();
  await finish(result, (out, done) => (out === '' ? done() : void process.stdout.write(out, () => done())));
  process.exit(0);
}

// Запускается как файл; при импорте из теста ничего не делает (сравнение по realpath, как у моста Codex).
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) void main();
