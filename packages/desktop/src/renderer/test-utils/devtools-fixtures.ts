/**
 * Записи журнала консоли и сети для тестов окна (спека 2026-10-07-browser-devtools-agent-design.md, 3.4): по умолчанию —
 * обычное сообщение и удачный запрос, тест правит нужные поля.
 */
import type { ConsoleEntry, DevtoolsBatch, NetworkEntry } from '../../shared/browser-devtools.js';

export function consoleEntry(id: number, patch: Partial<ConsoleEntry> = {}): ConsoleEntry {
  return { id, epoch: 0, ts: id, level: 'info', origin: 'console', text: `message ${id}`, location: null, stack: [], count: 1, ...patch };
}

export function networkEntry(id: string, patch: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    id,
    epoch: 0,
    ts: 0,
    method: 'GET',
    url: `http://localhost:5173/api/${id}`,
    kind: 'fetch',
    status: 200,
    statusText: 'OK',
    failure: null,
    mimeType: 'application/json',
    encodedBytes: 120,
    durationMs: 15,
    fromCache: false,
    remoteAddress: '127.0.0.1:5173',
    requestHeaders: [['Accept', '*/*']],
    responseHeaders: [['content-type', 'application/json']],
    hasPostData: false,
    postData: null,
    ...patch,
  };
}

export function devtoolsBatch(patch: Partial<DevtoolsBatch> = {}): DevtoolsBatch {
  return { webContentsId: 7, epoch: 0, capture: 'on', reset: false, console: [], network: [], ...patch };
}
