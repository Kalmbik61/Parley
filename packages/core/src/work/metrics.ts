import { stat } from 'node:fs/promises';
import path from 'node:path';
import { defaultCodexRoot, discoverCodexSessions } from '../codex/discover.js';
import { indexCodexSession } from '../codex/index-session.js';
import { defaultRoot, discoverSessions } from '../discover.js';
import type { ProviderEntry } from '../providers.js';
import { indexSessionFile, type SessionIndex } from '../session-index.js';
import { setResult, transitionSession } from './map.js';
import { freezeUsage, type UsageSummary } from './usage-ledger.js';
import type { TransitionOptions } from './map.js';
import { readMap, updateMap } from './store.js';
import type { SessionMetrics, SessionResult, WorkMap, WorkProvider } from './types.js';

/** Корни истории провайдеров. Переопределяются тестами; в бою — значения по умолчанию. */
export interface MetricsRoots {
  claudeRoot?: string;
  codexRoot?: string;
}

/** Метрики живой сессии: в карту не пишутся, пересчитываются при чтении (спецификация, раздел 6). */
export interface LiveSessionMetrics {
  metrics: SessionMetrics;
  /**
   * Время последней записи лога. От него считается страховочная `activity` и
   * время с последнего события в деталях (дизайн TUI v2, раздел 4.3).
   */
  lastRecordAt: string | null;
  /**
   * Время последней записи пользователя: ею страховка снимает `blocked`, когда
   * разрешение выдано, а хук про это не приходит (дизайн TUI v2, раздел 4.3).
   */
  lastUserRecordAt: string | null;
  /** Токены с происхождением; `null` — индекс собран без них. */
  usage: UsageSummary | null;
}

/** Один файл лога провайдера: id, под которым его знает карта, и путь. */
interface ProviderLog {
  id: string;
  file: string;
}

/**
 * Логи провайдера и способ их разобрать. Провайдера без адаптера здесь нет:
 * реестр открыт (`providers.json`), но читать чужой формат мы не умеем, и
 * метрики для него честно отсутствуют.
 */
function adapterFor(provider: WorkProvider, roots: MetricsRoots) {
  if (provider === 'claude') {
    const root = roots.claudeRoot ?? defaultRoot();
    return {
      list: async (): Promise<ProviderLog[]> =>
        (await discoverSessions(root)).map((session) => ({ id: session.id, file: session.file })),
      // Для Claude id сессии в карте — uuid jsonl-файла (спецификация, раздел 3).
      index: (file: string): Promise<SessionIndex> => indexSessionFile(file, root),
    };
  }
  if (provider === 'codex') {
    const root = roots.codexRoot ?? defaultCodexRoot();
    return {
      list: async (): Promise<ProviderLog[]> =>
        (await discoverCodexSessions(root)).map((session) => ({
          id: session.id,
          file: session.file,
        })),
      index: indexCodexSession,
    };
  }
  return null;
}

/** Индекс сессии в метрики карты: длительность, четыре счётчика, вызовы по именам. */
function metricsOf(index: SessionIndex): SessionMetrics {
  return {
    durationMs: index.durationMs ?? 0,
    // `null` — в логе нет ни одной записи с usage; нулями это не подменяется.
    tokens: index.tokens,
    toolCalls: index.tools,
  };
}

/**
 * Метрики сессии по её id у провайдера. `null` — логов такого провайдера мы не
 * читаем или файла с таким id нет (его могли почистить).
 */
export async function readSessionMetrics(
  provider: WorkProvider,
  providerSessionId: string,
  roots: MetricsRoots = {},
): Promise<LiveSessionMetrics | null> {
  const adapter = adapterFor(provider, roots);
  if (adapter === null) return null;

  const log = (await adapter.list()).find((candidate) => candidate.id === providerSessionId);
  if (log === undefined) return null;

  const index = await adapter.index(log.file);
  return {
    metrics: metricsOf(index),
    lastRecordAt: index.endedAt,
    lastUserRecordAt: index.lastUserRecordAt,
    usage: index.usage ?? null,
  };
}

/** Чем запущен процесс: по этой паре ищется его сессия у провайдера без внешнего id. */
export interface LinkQuery {
  cwd: string;
  /** Момент запуска процесса: сессия, начавшаяся раньше него, — чужая. */
  startedAt: string;
}

/** Допуск на расхождение часов записи лога и момента запуска процесса. */
export const LINK_TOLERANCE_MS = 5000;

export interface LinkOptions extends MetricsRoots {
  toleranceMs?: number;
  /**
   * Id логов, уже привязанных к другим сессиям карты: своим их не берём. Две сессии в одном каталоге,
   * запущенные с разницей в несколько секунд, иначе получали бы один и тот же — самый ранний — лог: лог
   * первой лежит в допуске времени второй.
   */
  exclude?: ReadonlySet<string>;
}

/**
 * Ищет сессию провайдера, которую только что запустил харнесс, по cwd и времени
 * запуска — так связываются провайдеры, которым id снаружи не задать
 * (спецификация, раздел 5). Провайдер с `linkBy: 'session-id'` сюда не попадает:
 * его id харнесс знает заранее, и гадать по времени — только вредить.
 */
export async function linkProviderSession(
  entry: ProviderEntry,
  query: LinkQuery,
  { toleranceMs = LINK_TOLERANCE_MS, exclude, ...roots }: LinkOptions = {},
): Promise<string | null> {
  if (entry.linkBy !== 'cwd+time') return null;
  const adapter = adapterFor(entry.id, roots);
  if (adapter === null) return null;

  const since = Date.parse(query.startedAt) - toleranceMs;
  if (Number.isNaN(since)) return null;
  const cwd = path.resolve(query.cwd);

  let best: { id: string; at: number } | null = null;
  for (const log of await adapter.list()) {
    if (exclude?.has(log.id) === true) continue;
    // Файл, не тронутый после запуска, разбирать незачем: сессий у провайдера
    // могут быть сотни, а свежих — единицы.
    const info = await stat(log.file).catch(() => null);
    if (info === null || info.mtimeMs < since) continue;

    const index = await adapter.index(log.file);
    // Подагент и внутренний тред Codex стартуют в том же cwd и часто раньше настоящей сессии:
    // без этого фильтра «ближайший к запуску» лог отдавал бы записи карты чужой тред.
    if (index.spawned === true) continue;
    // Занят под id из `session_meta`, а не из имени файла: в карту пишется он.
    if (exclude?.has(index.id) === true) continue;
    if (index.cwd === null || path.resolve(index.cwd) !== cwd) continue;
    if (index.startedAt === null) continue;
    const at = Date.parse(index.startedAt);
    if (Number.isNaN(at) || at < since) continue;
    if (best === null || at < best.at) best = { id: index.id, at };
  }
  return best?.id ?? null;
}

/**
 * Сколько лог молчит. `null` — записей нет, простой считать не от чего.
 *
 * Статуса `idle` в карте больше нет (дизайн TUI v2, раздел 4.3): молчание лога
 * читают страховочная `activity` и строка «молчит Nм» в деталях, а не
 * жизненный цикл.
 */
export function silenceMs(lastRecordAt: string | null, now: number = Date.now()): number | null {
  if (lastRecordAt === null) return null;
  const at = Date.parse(lastRecordAt);
  return Number.isNaN(at) ? null : Math.max(0, now - at);
}

/**
 * Когда метрики фиксируются в карте: итог из `report` или уход процесса в
 * `sleeping`. Итог ставится по своей оси и процесс не трогает (спецификация 7.1).
 */
export type FinalStatus = SessionResult | 'sleeping';

export interface FinishOptions extends MetricsRoots, TransitionOptions {
  /** Таймаут `map.lock` записи перехода (кусок 1.4 хоста: сверка живости работ). */
  lockTimeoutMs?: number;
}

/**
 * Ставит итог или усыпляет сессию и фиксирует в карте итоговые метрики из
 * логов провайдера: архив работы хранит их, даже если логи потом почистят
 * (спецификация, раздел 6). Метрик нет (сессия не привязана к логу, файла уже
 * нет) — в карте остаётся прежнее значение, статус меняется всё равно.
 */
export async function finishSession(
  projectPath: string,
  workId: string,
  sessionId: string,
  to: FinalStatus,
  options: FinishOptions = {},
): Promise<WorkMap> {
  const session = (await readMap(projectPath, workId)).sessions.find(
    (candidate) => candidate.id === sessionId,
  );
  if (session === undefined) throw new Error(`session ${sessionId} is not in the map`);

  const { providerSessionId } = session;
  const measured =
    providerSessionId === null
      ? null
      : await readSessionMetrics(session.provider, providerSessionId, options);

  return updateMap(
    projectPath,
    workId,
    (map) => {
      const target =
        to === 'sleeping'
          ? transitionSession(map, sessionId, to, options)
          : setResult(map, sessionId, to, options.at);
      // Лог читался до захвата блокировки: если сессию за это время перепривязали
      // к другому логу, чужие числа в карту не попадут.
      if (measured !== null && target.providerSessionId === providerSessionId) {
        target.metrics = {
          ...measured.metrics,
          // Снимок помнит, к какому разговору и запуску процесса он относится: по возобновлении
          // окно сравнит его с живым индексом, а не примет за цифры нового запуска.
          ...(measured.usage === null || providerSessionId === null
            ? {}
            : {
                usage: freezeUsage(measured.usage, {
                  binding: providerSessionId,
                  epoch: session.startedAtProcess,
                  // Сон — закрытый период; `report` снимает цифры посреди работы.
                  closed: to === 'sleeping',
                }),
              }),
        };
      }
    },
    options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs },
  );
}
