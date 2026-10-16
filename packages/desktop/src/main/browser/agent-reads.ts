/**
 * Чтения агента: консоль и сеть страницы (спека 2026-10-07-browser-devtools-agent-design.md, 6, 8). Маска — до обрезки,
 * фильтры смотрят на текст с маской, как и ответ.
 */
import type { WebContents } from 'electron';
import { AGENT_LIMITS } from '@parley/protocol';
import type {
  BrowserAgentArgs,
  BrowserAgentConsoleEntry,
  BrowserAgentConsoleResult,
  BrowserAgentNetworkResult,
  BrowserAgentRequestDetail,
  BrowserAgentRequestSummary,
} from '@parley/protocol';
import { DEVTOOLS_LIMITS, isFailed } from '../../shared/browser-devtools.js';
import type { ConsoleEntry, DevtoolsSnapshot, NetworkEntry, StackFrame } from '../../shared/browser-devtools.js';
import { redactBody, redactHeaders, redactUrl, redactUrlsInText, unmaskableJson } from '../../shared/redact.js';
import { AgentOpError } from './agent-errors.js';
import type { PageRecord } from './agent-pages.js';
import type { Inspector } from './inspector.js';

/** Записей в ответе по умолчанию — то же число, что `default` в схемах инструментов MCP. */
const DEFAULT_LIST = 50;

/** Новейшие записи в пределах `limit` и `AGENT_LIMITS.listBytes` (по JSON), старые — первыми. Одна длинная запись проходит. */
export function newest<T>(items: readonly T[], limit: number): T[] {
  const picked: T[] = [];
  let bytes = 0;
  for (let index = items.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const item = items[index] as T;
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > AGENT_LIMITS.listBytes && picked.length > 0) break;
    picked.push(item);
  }
  return picked.reverse();
}

const frameText = (frame: StackFrame): string => `${frame.fn === '' ? '(anonymous)' : frame.fn} (${redactUrl(frame.url)}:${frame.line}:${frame.column})`;

export function toAgentConsole(entry: ConsoleEntry): BrowserAgentConsoleEntry {
  return {
    level: entry.level,
    origin: entry.origin,
    text: redactUrlsInText(entry.text),
    source: entry.location === null ? null : `${redactUrl(entry.location.url)}:${entry.location.line}:${entry.location.column}`,
    stack: entry.stack.map(frameText),
    count: entry.count,
    at: new Date(entry.ts).toISOString(),
  };
}

export function summaryOf(entry: NetworkEntry): BrowserAgentRequestSummary {
  return { id: entry.id, method: entry.method, url: redactUrl(entry.url), kind: entry.kind, status: entry.status, statusText: entry.statusText, failure: entry.failure, durationMs: entry.durationMs, mimeType: entry.mimeType };
}

const headerValue = (headers: ReadonlyArray<[string, string]>, name: string): string | null => headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;

/**
 * Тело для агента (спека 6): маска — до обрезки, `redactBody` режет уже замаскированное. JSON, который нельзя разобрать
 * целиком (обрезан источником или битый), не отдаётся совсем — маска его не видит (Фокус ревью этапа C, п. 2); вместо
 * тела — заметка. `mimeType` запроса — его Content-Type целиком (у multipart в нём граница).
 */
export function bodyForAgent(text: string | null, mimeType: string | null, which: 'request' | 'response', notes: string[]): string | null {
  if (text === null || text === '') return null;
  if (unmaskableJson(text, mimeType)) {
    notes.push(`The ${which} body is JSON that cannot be parsed in full (cut by the capture limit or malformed), so it is not shown: it cannot be masked.`);
    return null;
  }
  return redactBody(text, mimeType, AGENT_LIMITS.detailBody);
}

export interface AgentReads {
  consoleOf(contents: WebContents, record: PageRecord, args: BrowserAgentArgs<'console'>): BrowserAgentConsoleResult;
  networkOf(contents: WebContents, record: PageRecord, args: BrowserAgentArgs<'network'>): Promise<BrowserAgentNetworkResult>;
}

export function createAgentReads(deps: { inspector: Pick<Inspector, 'snapshot' | 'responseBody'> }): AgentReads {
  function captured(id: number): DevtoolsSnapshot {
    const snapshot = deps.inspector.snapshot(id);
    if (snapshot === null || snapshot.capture === 'unavailable') {
      throw new AgentOpError('unsupported', 'Console and network capture is unavailable for this page: ask the human to reload it.');
    }
    return snapshot;
  }

  async function detailOf(contents: WebContents, record: PageRecord, entry: NetworkEntry): Promise<BrowserAgentRequestDetail> {
    const notes: string[] = [];
    if (entry.hasPostData && entry.postData === null) notes.push('The request body was not captured.');
    const requestBody = bodyForAgent(entry.postData, headerValue(entry.requestHeaders, 'content-type'), 'request', notes);
    // Тело целиком, до предела панели: маска разбирает весь JSON, режется уже результат.
    const response = await deps.inspector.responseBody(contents.id, entry.id, DEVTOOLS_LIMITS.panelBody).catch(() => {
      // Тела нет — это не ошибка, но если гость ушёл посреди чтения, агенту нужен тот же отказ, что и у любой страницы без гостя.
      if (contents.isDestroyed()) throw new AgentOpError('tab_not_loaded', `Page ${record.agentId} went away while its request was being read.`);
      return null;
    });
    let responseBody: string | null = null;
    if (response !== null) {
      if (response.base64) notes.push('The response body is binary and is not shown.');
      else responseBody = bodyForAgent(response.text, entry.mimeType, 'response', notes);
    }
    return { ...summaryOf(entry), remoteAddress: entry.remoteAddress, fromCache: entry.fromCache, requestHeaders: redactHeaders(entry.requestHeaders), responseHeaders: redactHeaders(entry.responseHeaders), requestBody, responseBody, notes };
  }

  return {
    consoleOf(contents, record, args) {
      const snapshot = captured(contents.id);
      const level = args.level ?? 'error';
      const pattern = args.pattern?.toLowerCase();
      // Фильтр смотрит на текст с маской, как и ответ: по сырому подбирали бы значение секрета посимвольно через `matched`.
      const matching = snapshot.console
        .filter((entry) => entry.epoch === snapshot.epoch && (level === 'all' || entry.level === 'error' || (level === 'warning' && entry.level === 'warning')))
        .map(toAgentConsole)
        .filter((entry) => pattern === undefined || entry.text.toLowerCase().includes(pattern));
      return { tab: record.agentId, url: redactUrl(contents.getURL()), entries: newest(matching, args.limit ?? DEFAULT_LIST), matched: matching.length };
    },
    async networkOf(contents, record, args) {
      const snapshot = captured(contents.id);
      const url = redactUrl(contents.getURL());
      if (args.requestId !== undefined) {
        const entry = snapshot.network.find((candidate) => candidate.id === args.requestId);
        if (entry === undefined) throw new AgentOpError('bad_request', `There is no request ${args.requestId} in the log of page ${record.agentId}: list the requests first.`);
        return { tab: record.agentId, url, request: await detailOf(contents, record, entry) };
      }
      const pattern = args.urlPattern?.toLowerCase();
      // Фильтр смотрит на адрес с маской: подобрать им значение секрета нельзя.
      const matching = snapshot.network.filter(
        (entry) =>
          entry.epoch === snapshot.epoch &&
          (args.failedOnly !== false ? isFailed(entry) : true) &&
          (pattern === undefined || redactUrl(entry.url).toLowerCase().includes(pattern)),
      );
      return { tab: record.agentId, url, requests: newest(matching.map(summaryOf), args.limit ?? DEFAULT_LIST), matched: matching.length };
    },
  };
}
