import { observedCount, type UsageCounters } from './work/usage-ledger.js';
import type { RawRecord } from './jsonl.js';

/**
 * Типизированная запись сессии. Все поля опциональны: формат .jsonl недокументирован
 * и меняется между релизами Claude Code, поэтому ничего не считаем обязательным.
 * Исходная запись целиком лежит в `raw` — неизвестные поля не теряются.
 */
export interface SessionRecord {
  type: string | null;
  uuid: string | null;
  parentUuid: string | null;
  timestamp: string | null;
  sessionId: string | null;
  /** Идентификатор субагента; есть только в файлах подсессий. */
  agentId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  isSidechain: boolean;
  /**
   * Служебная реплика Claude Code (`isMeta`): вставка вроде `<local-command-caveat>` перед выводом
   * слеш-команды. Пишется с ролью `user`, но запросом человека не является.
   */
  isMeta: boolean;
  /**
   * message.id — идентификатор ОТВЕТА модели. Один ответ Claude Code пишет
   * несколькими записями (по одной на блок content), и у всех он общий.
   */
  messageId: string | null;
  /** message.role */
  role: string | null;
  /** message.model — по нему считается бейдж модели. */
  model: string | null;
  /** Имена инструментов из блоков message.content[].type === 'tool_use'. */
  toolUses: string[];
  /** Первый текстовый блок реплики — используется как название задачи подсессии. */
  text: string | null;
  /** customTitle / aiTitle записей-заголовков. */
  title: string | null;
  /** lastPrompt записи last-prompt. */
  lastPrompt: string | null;
  /**
   * message.usage — четыре счётчика токенов; null, если usage в записи нет. Поля, которых в записи нет
   * (или они не числа), — `null`, а не 0: «не сообщено» и «ноль» разные наблюдения. Подставить 0 для
   * показа — дело потребителя.
   */
  usage: Omit<UsageCounters, 'totalInput'> | null;
  leafUuid: string | null;
  raw: RawRecord;
}

export interface SchemaAdapter {
  /** Версия схемы, которую понимает адаптер. Ломается формат — заводится новый. */
  readonly version: string;
  toSessionRecord(raw: RawRecord): SessionRecord;
}

/** Первое непустое значение из перечисленных ключей — формат местами непоследователен. */
function pickString(source: RawRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function asRecord(value: unknown): RawRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RawRecord)
    : null;
}

function extractContent(message: RawRecord | null): { toolUses: string[]; text: string | null } {
  const toolUses: string[] = [];
  let text: string | null = null;
  if (!message) return { toolUses, text };

  const content = message['content'];
  if (typeof content === 'string') return { toolUses, text: content || null };
  if (!Array.isArray(content)) return { toolUses, text };

  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    if (block['type'] === 'tool_use') {
      const name = block['name'];
      if (typeof name === 'string') toolUses.push(name);
    } else if (text === null && block['type'] === 'text') {
      const value = block['text'];
      if (typeof value === 'string' && value !== '') text = value;
    }
  }
  return { toolUses, text };
}

/**
 * message.usage записи ассистента: вход, выход и две половины кэша.
 * Отсутствие блока — не ошибка: usage есть далеко не у каждой записи.
 */
function extractUsage(message: RawRecord | null): SessionRecord['usage'] {
  const usage = message === null ? null : asRecord(message['usage']);
  if (usage === null) return null;
  return {
    input: observedCount(usage, 'input_tokens'),
    output: observedCount(usage, 'output_tokens'),
    cacheRead: observedCount(usage, 'cache_read_input_tokens'),
    cacheWrite: observedCount(usage, 'cache_creation_input_tokens'),
  };
}

/**
 * Адаптер наблюдаемой схемы Claude Code 2.1.x (см. specs/data-layer.md и docs/schema/).
 * Заголовок сессии живёт в записях custom-title / ai-title; записей type:"summary"
 * в этой версии не существует.
 */
export const adapterV1: SchemaAdapter = {
  version: 'v1',

  toSessionRecord(raw: RawRecord): SessionRecord {
    const message = asRecord(raw['message']);
    const { toolUses, text } = extractContent(message);

    return {
      type: pickString(raw, 'type'),
      uuid: pickString(raw, 'uuid'),
      parentUuid: pickString(raw, 'parentUuid'),
      timestamp: pickString(raw, 'timestamp'),
      // session_id встречается в 6% записей наравне с sessionId
      sessionId: pickString(raw, 'sessionId', 'session_id'),
      agentId: pickString(raw, 'agentId'),
      cwd: pickString(raw, 'cwd'),
      gitBranch: pickString(raw, 'gitBranch'),
      version: pickString(raw, 'version'),
      isSidechain: raw['isSidechain'] === true,
      isMeta: raw['isMeta'] === true,
      messageId: message ? pickString(message, 'id') : null,
      role: message ? pickString(message, 'role') : null,
      model: message ? pickString(message, 'model') : null,
      toolUses,
      text,
      title: pickString(raw, 'customTitle', 'aiTitle'),
      lastPrompt: pickString(raw, 'lastPrompt'),
      usage: extractUsage(message),
      leafUuid: pickString(raw, 'leafUuid'),
      raw,
    };
  },
};
