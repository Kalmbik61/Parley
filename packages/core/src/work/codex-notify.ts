/**
 * Скрипт `notify` Codex (спека комнат Organic, 3.6, «Состояние без хуков»). У Codex есть хуки,
 * но неуправляемые из них запускаются только после разового ревью человеком в `/hooks`, а
 * харнесс их не включает и доверия себе не выдаёт. Остаётся `notify`: Codex запускает программу
 * из `-c notify=[…]` после каждого хода и отдаёт ей JSON события `agent-turn-complete` последним
 * аргументом (документация Codex, «Advanced Configuration → Notifications»; stdin, stdout и
 * stderr у программы закрыты).
 *
 * Скрипт превращает событие в строку `Stop` — ту же, что дописывает команда хуков Claude Code —
 * в `events/<сессия>.jsonl` каталога работы: читатель журнала и свёртка активности (`events.ts`,
 * `activity.ts`) не знают разницы. Адрес работы и сессии — из окружения процесса Codex, куда их
 * положил хост (`PARLEY_WORK_DIR`, `PARLEY_SESSION_ID`, а с ними и прежние `HARNAS_*`), как у хуков.
 *
 * Границы: в каталоги агентов ничего не пишется, сети нет, любая ошибка молча даёт «не записано»
 * и код выхода 0 — Codex про исход не спрашивает, а падение скрипта не должно его тревожить.
 * Модуль тянет только встроенные модули и лист `../limits.js`: скрипт запускается после каждого
 * хода, и лишний импорт там — лишние миллисекунды на каждый вызов.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFileSafeId } from '../limits.js';
import { envValue } from '../names.js';

/** Имя файла точки входа без расширения: `codex-notify-bin.js` лежит рядом с этим модулем. */
export const CODEX_NOTIFY_BIN = 'codex-notify-bin';

/**
 * Скрипт `notify` — абсолютный путь к собранному файлу рядом с этим модулем, в `work/`, тем же
 * способом, что сервер MCP и скрипт строки статуса: агент стартует из любого терминала, PATH ему
 * не подмога.
 */
export const CODEX_NOTIFY_ENTRY = fileURLToPath(
  new URL(`./${CODEX_NOTIFY_BIN}.js`, import.meta.url),
);

/**
 * Сколько знаков последнего ответа кладётся в журнал. Журнал читают целиком, а ответ агента бывает
 * в сотни килобайт; для состояния он не нужен, только для того, чтобы читатель мог его показать.
 */
export const NOTIFY_MESSAGE_MAX = 20_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Урезает по числу знаков UTF-16, не оставляя половинки парного суррогата на конце. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Строка журнала по JSON события Codex. `null` — не наше событие: битый JSON, не объект, тип не
 * `agent-turn-complete` (сегодня Codex шлёт только его, но список может вырасти, и незнакомое
 * событие конец хода не значит).
 */
export function stopEventOf(raw: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || data['type'] !== 'agent-turn-complete') return null;

  const message = data['last-assistant-message'];
  const event: Record<string, unknown> = {
    hook_event_name: 'Stop',
    last_assistant_message: typeof message === 'string' ? clip(message, NOTIFY_MESSAGE_MAX) : null,
  };
  // Поля Codex — kebab-case, как в самом событии: журнал хранит их под теми же именами.
  for (const name of ['thread-id', 'turn-id']) {
    const value = data[name];
    if (typeof value === 'string' && value !== '') event[name] = value;
  }
  return event;
}

/**
 * Одна отработка `notify`: JSON события → строка `Stop` в журнал сессии. `true` — строка
 * записана. Каталог `events/` заводится, а каталог работы — нет: работу, которую стёрли под живым
 * агентом, скрипт не воскрешает. Не бросает никогда.
 */
export async function runCodexNotify(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const event = stopEventOf(raw);
    if (event === null) return false;
    const workDir = envValue(env, 'WORK_DIR');
    const sessionId = envValue(env, 'SESSION_ID');
    if (workDir === undefined || !path.isAbsolute(workDir)) return false;
    if (sessionId === undefined || !isFileSafeId(sessionId)) return false;

    const dir = path.join(workDir, 'events');
    try {
      await mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    await appendFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
