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
import { cutCodePoints } from '../../shared/code-points.js';
import { DEVTOOLS_LIMITS, isFailed } from '../../shared/browser-devtools.js';
import type { ConsoleEntry, DevtoolsSnapshot, NetworkEntry, StackFrame } from '../../shared/browser-devtools.js';
import { redactBody, redactHeaders, redactSecretsInText, redactUrl, redactUrlsInText, unmaskableJson } from '../../shared/redact.js';
import { AgentOpError } from './agent-errors.js';
import type { PageRecord } from './agent-pages.js';
import { clipUrl, urlForAgent } from './agent-url.js';
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

const frameText = (frame: StackFrame): string => `${frame.fn === '' ? '(anonymous)' : frame.fn} (${urlForAgent(frame.url)}:${frame.line}:${frame.column})`;

/** Кадр библиотеки, а не кода страницы: в стеке из пятидесяти кадров ошибку находят по своим. */
const VENDOR_FRAME = /\/node_modules\/|^node:|^chrome-extension:|\/@vite\/|\/\.vite\/deps\/|^webpack-internal:/;

/** До `listStackFrames` своих кадров; своих нет — первый кадр, чтобы стек не пропал совсем. */
function compactStack(stack: readonly StackFrame[]): string[] {
  const own = stack.filter((frame) => !VENDOR_FRAME.test(frame.url)).slice(0, AGENT_LIMITS.listStackFrames);
  const shown = own.length > 0 ? own : stack.slice(0, 1);
  return shown.map(frameText);
}

/** Текст записи с маской (до обрезки); обрезка по кодовым точкам — в `toAgentConsole`. */
const maskedText = (entry: ConsoleEntry): string => redactSecretsInText(redactUrlsInText(entry.text));

export function toAgentConsole(entry: ConsoleEntry, masked: string = maskedText(entry)): BrowserAgentConsoleEntry {
  const head = cutCodePoints(masked, AGENT_LIMITS.listEntryText);
  return {
    id: entry.id,
    level: entry.level,
    origin: entry.origin,
    text: head.cut ? `${head.text}…` : masked,
    source: entry.location === null ? null : `${urlForAgent(entry.location.url)}:${entry.location.line}:${entry.location.column}`,
    stack: compactStack(entry.stack),
    count: entry.count,
    at: new Date(entry.ts).toISOString(),
  };
}

/** Свёртка похожих (тексты различаются числами: id, время, номер строки): остаётся новейшая запись группы, `count` — сумма, `similar` — размер группы. */
function foldSimilar(items: ReadonlyArray<{ entry: BrowserAgentConsoleEntry; key: string }>): BrowserAgentConsoleEntry[] {
  const groups = new Map<string, { newest: BrowserAgentConsoleEntry; count: number; size: number }>();
  for (const { entry, key } of items) {
    const group = groups.get(key);
    groups.set(key, { newest: entry, count: (group?.count ?? 0) + entry.count, size: (group?.size ?? 0) + 1 });
  }
  const folded = [...groups.values()].map(({ newest, count, size }): BrowserAgentConsoleEntry => ({ ...newest, count, ...(size > 1 ? { similar: size } : {}) }));
  // Порядок — по новейшей записи группы, старые первыми.
  return folded.sort((a, b) => a.id - b.id);
}

export function summaryOf(entry: NetworkEntry): BrowserAgentRequestSummary {
  return { id: entry.id, method: entry.method, url: urlForAgent(entry.url), kind: entry.kind, status: entry.status, statusText: entry.statusText, failure: entry.failure, durationMs: entry.durationMs, mimeType: entry.mimeType };
}

/** Список сети: query и фрагмент адреса (после маски) — не длиннее `AGENT_LIMITS.listQuery` знаков; полный адрес — в деталях. */
function shortUrl(url: string): string {
  const at = url.indexOf('?');
  if (at === -1) return url;
  const head = cutCodePoints(url.slice(at + 1), AGENT_LIMITS.listQuery);
  return `${url.slice(0, at + 1)}${head.text}${head.cut ? '…' : ''}`;
}

/** Заголовки для агента: маска до обрезки, значение — до `headerValue` знаков, не больше `headers` штук; лишнее — заметка. */
function headersForAgent(headers: ReadonlyArray<[string, string]>, side: 'request' | 'response', notes: string[]): Array<[string, string]> {
  const shown = redactHeaders(headers)
    .slice(0, AGENT_LIMITS.headers)
    .map(([name, value]): [string, string] => {
      const head = cutCodePoints(value, AGENT_LIMITS.headerValue);
      return [name, head.cut ? `${head.text}…` : value];
    });
  if (headers.length > shown.length) notes.push(`${headers.length - shown.length} more ${side} headers are not shown.`);
  return shown;
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
    const requestHeaders = headersForAgent(entry.requestHeaders, 'request', notes);
    const responseHeaders = headersForAgent(entry.responseHeaders, 'response', notes);
    return { ...summaryOf(entry), remoteAddress: entry.remoteAddress, fromCache: entry.fromCache, requestHeaders, responseHeaders, requestBody, responseBody, notes };
  }

  return {
    consoleOf(contents, record, args) {
      const snapshot = captured(contents.id);
      const level = args.level ?? 'error';
      const pattern = args.pattern?.toLowerCase();
      // Фильтр смотрит на текст с маской, как и ответ: по сырому подбирали бы значение секрета посимвольно через `matched`.
      const matching = snapshot.console
        .filter((entry) => entry.epoch === snapshot.epoch && (args.after === undefined || entry.id > args.after) && (level === 'all' || entry.level === 'error' || (level === 'warning' && entry.level === 'warning')))
        .map((entry) => ({ entry, masked: maskedText(entry) }))
        .filter(({ masked }) => pattern === undefined || masked.toLowerCase().includes(pattern));
      const folded = foldSimilar(matching.map(({ entry, masked }) => ({ entry: toAgentConsole(entry, masked), key: `${entry.level} ${masked.replace(/\d+/g, '#')}` })));
      const next = matching.reduce<number | null>((top, { entry }) => (top === null || entry.id > top ? entry.id : top), null);
      return { tab: record.agentId, url: urlForAgent(contents.getURL()), entries: newest(folded, args.limit ?? DEFAULT_LIST), matched: matching.length, next };
    },
    async networkOf(contents, record, args) {
      const snapshot = captured(contents.id);
      const url = urlForAgent(contents.getURL());
      if (args.requestId !== undefined) {
        // Запрос прошлой страницы (прошлая эпоха) для агента — как неизвестный: его уже нет в списках.
        const entry = snapshot.network.find((candidate) => candidate.id === args.requestId && candidate.epoch === snapshot.epoch);
        if (entry === undefined) throw new AgentOpError('bad_request', `There is no request ${args.requestId} in the log of page ${record.agentId}: list the requests first.`);
        return { tab: record.agentId, url, request: await detailOf(contents, record, entry) };
      }
      const pattern = args.urlPattern?.toLowerCase();
      const notes: string[] = [];
      const current = snapshot.network.filter((entry) => entry.epoch === snapshot.epoch);
      let from = 0;
      if (args.after !== undefined) {
        const at = current.findIndex((entry) => entry.id === args.after);
        if (at === -1) notes.push(`Request ${args.after} is no longer in the log; all matching requests are listed.`);
        else from = at + 1;
      }
      // Фильтр смотрит на адрес с маской: подобрать им значение секрета нельзя.
      const matching = current
        .slice(from)
        .filter((entry) => (args.failedOnly !== false ? isFailed(entry) : true) && (pattern === undefined || redactUrl(entry.url).toLowerCase().includes(pattern)));
      const requests = newest(
        matching.map((entry) => ({ ...summaryOf(entry), url: clipUrl(shortUrl(redactUrl(entry.url))) })),
        args.limit ?? DEFAULT_LIST,
      );
      return { tab: record.agentId, url, requests, matched: matching.length, notes, next: requests[requests.length - 1]?.id ?? null };
    },
  };
}
