/**
 * The OpenCode event bridge (spec 2026-11-12, §4.4; plan O6). One subscription to `GET /api/event` (Basic auth) per
 * live OpenCode session. Each event of the session's own id goes through the O4 mapper (`mapOpencodeEvent`); every
 * record is written the way the hook route writes for the other families: a line in `events/<session>.jsonl` (what
 * the activity fold reads) and a hook request through the host's hook handler chain.
 *
 * - **Reconnect.** The stream reconnects with a doubling backoff while the session is attached (the server lives).
 * - **No duplicates.** The stream has no `id:` lines and no replay contract, so every event id is remembered (bounded)
 *   and an event seen before a reconnect is not written again.
 * - **Readiness.** `/api/info` answered (the supervisor's start), the `parley` MCP server is `connected`
 *   (`GET /api/mcp`, read again on each `mcp.status.changed`) and the TUI is alive. Only then the bridge writes the
 *   session's `SessionStart`: before it the session shows no hook of this process, so nothing is typed into it.
 *   Records mapped before readiness wait and follow it (a mapped `SessionStart` is replaced by the readiness one).
 *
 * Secrets: the password stays in memory; the address is never logged.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { emptyOpencodeBridgeState, mapOpencodeEvent, workPaths, type OpencodeBridgeState, type OpencodeJournalRecord, type OpencodeUsageFact } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import type { HookRequest } from '../hooks/hook-server.js';
import type { Log } from '../log.js';

export const OPENCODE_BACKOFF_INITIAL_MS = 200;
export const OPENCODE_BACKOFF_MAX_MS = 5000;
export const OPENCODE_MCP_POLL_MS = 500;
/** Event ids remembered per session for the dedupe after a reconnect. */
const SEEN_LIMIT = 4096;
/** A single SSE event larger than this is dropped (and the buffer reset), never parsed. */
const EVENT_LIMIT = 8 * 1024 * 1024;

export interface OpencodeAttach {
  url: string;
  password: string;
  /** The OpenCode session id (`ses_…`): events of other ids on the same server are ignored. */
  sessionId: string;
  /** Whether the TUI of this server is alive (readiness). */
  tuiAlive: () => boolean;
  /** `SessionStart.source` of the readiness record. */
  source: 'startup' | 'resume';
}

export interface OpencodeBridgeOptions {
  log: Log;
  /** The host's hook handler chain (the same one the hook server calls). */
  hook: (request: HookRequest) => void;
  /** Appends one journal record; default: a line in `events/<session>.jsonl` of the work. */
  journal?: (ref: SessionRef, record: OpencodeJournalRecord) => Promise<void>;
  onUsage?: (ref: SessionRef, usage: OpencodeUsageFact) => void;
  onReady?: (ref: SessionRef) => void;
  /** Any event of the session's own id: the Chat feed polls early (spec §4.11, `FeedService.opencodePoll`). */
  onSessionEvent?: (ref: SessionRef) => void;
  fetchImpl?: typeof fetch;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  mcpPollMs?: number;
}

export interface OpencodeBridge {
  attach(ref: SessionRef, attach: OpencodeAttach): void;
  /** Stops the stream and the polls; the session's state is forgotten. Idempotent. */
  detach(ref: SessionRef): void;
  ready(ref: SessionRef): boolean;
  /** Connections made so far (tests and diagnostics). */
  connections(ref: SessionRef): number;
  stopAll(): void;
}

interface Bridge {
  ref: SessionRef;
  attach: OpencodeAttach;
  auth: string;
  state: OpencodeBridgeState;
  seen: Set<string>;
  ready: boolean;
  /** Records mapped before readiness. */
  pending: OpencodeJournalRecord[];
  mcpFailed: boolean;
  abort: AbortController;
  detached: boolean;
  connections: number;
  /** Journal writes of this session, in order. */
  writes: Promise<void>;
  pollTimer: NodeJS.Timeout | undefined;
  polling: boolean;
}

const defaultJournal = async (ref: SessionRef, record: OpencodeJournalRecord): Promise<void> => {
  const dir = workPaths(ref.projectPath, ref.workId).events;
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${ref.sessionId}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/** The `parley` entry of `GET /api/mcp` (`{data:[{name,status:{status}}]}`, observed on 2.2.7). */
export function parleyMcpStatus(body: unknown): string | null {
  const data = isRecord(body) ? body['data'] : null;
  if (!Array.isArray(data)) return null;
  const entry = data.find((item) => isRecord(item) && item['name'] === 'parley');
  const status = isRecord(entry) && isRecord(entry['status']) ? entry['status']['status'] : null;
  return typeof status === 'string' ? status : null;
}

export function createOpencodeBridge(options: OpencodeBridgeOptions): OpencodeBridge {
  const fetchImpl = options.fetchImpl ?? fetch;
  const journal = options.journal ?? defaultJournal;
  const initialMs = options.backoffInitialMs ?? OPENCODE_BACKOFF_INITIAL_MS;
  const maxMs = options.backoffMaxMs ?? OPENCODE_BACKOFF_MAX_MS;
  const pollMs = options.mcpPollMs ?? OPENCODE_MCP_POLL_MS;
  const bridges = new Map<string, Bridge>();

  /** Journal line, then the hook chain, in event order. */
  function emit(bridge: Bridge, record: OpencodeJournalRecord): void {
    bridge.writes = bridge.writes.then(async () => {
      if (bridge.detached) return;
      try {
        await journal(bridge.ref, record);
      } catch (error) {
        options.log.warn('opencode journal record was not written', { ref: bridge.ref, event: record.hook_event_name, error: String(error) });
      }
      const request: HookRequest = {
        ref: bridge.ref,
        body: { ...record },
        // A bridged record has no HTTP request to answer.
        respond: () => {},
        answered: () => false,
        onAbandon: () => {},
      };
      try {
        options.hook(request);
      } catch (error) {
        options.log.warn('opencode hook dispatch failed', { ref: bridge.ref, event: record.hook_event_name, error: String(error) });
      }
    });
  }

  function becomeReady(bridge: Bridge): void {
    if (bridge.ready || bridge.detached) return;
    bridge.ready = true;
    if (bridge.pollTimer !== undefined) clearTimeout(bridge.pollTimer);
    emit(bridge, {
      session_id: bridge.attach.sessionId,
      hook_event_name: 'SessionStart',
      timestamp: new Date().toISOString(),
      source: bridge.attach.source,
    });
    for (const record of bridge.pending) emit(bridge, record);
    bridge.pending = [];
    options.log.info('opencode session ready', { ref: bridge.ref });
    options.onReady?.(bridge.ref);
  }

  /** Readiness check: the MCP status of `parley` and the TUI. Schedules itself again until ready. */
  async function checkReady(bridge: Bridge): Promise<void> {
    if (bridge.ready || bridge.detached || bridge.polling) return;
    bridge.polling = true;
    try {
      const response = await fetchImpl(`${bridge.attach.url}/api/mcp`, {
        headers: { authorization: bridge.auth },
        signal: AbortSignal.any([bridge.abort.signal, AbortSignal.timeout(5000)]),
      });
      const status = response.ok ? parleyMcpStatus(await response.json()) : null;
      if (status === 'failed' && !bridge.mcpFailed) {
        bridge.mcpFailed = true;
        options.log.warn('opencode: the parley MCP server failed to connect', { ref: bridge.ref });
      }
      if (status === 'connected' && bridge.attach.tuiAlive()) {
        becomeReady(bridge);
        return;
      }
    } catch {
      /* the server is starting or gone; the next poll or the stream decides */
    } finally {
      bridge.polling = false;
    }
    if (!bridge.ready && !bridge.detached) {
      if (bridge.pollTimer !== undefined) clearTimeout(bridge.pollTimer);
      bridge.pollTimer = setTimeout(() => void checkReady(bridge), bridge.mcpFailed ? Math.max(pollMs, 5000) : pollMs);
      bridge.pollTimer.unref?.();
    }
  }

  function onEvent(bridge: Bridge, raw: unknown): void {
    if (!isRecord(raw)) return;
    const id = typeof raw['id'] === 'string' ? raw['id'] : null;
    if (id !== null) {
      if (bridge.seen.has(id)) return;
      bridge.seen.add(id);
      if (bridge.seen.size > SEEN_LIMIT) bridge.seen.delete(bridge.seen.values().next().value as string);
    }
    if (raw['type'] === 'mcp.status.changed' && isRecord(raw['data']) && raw['data']['server'] === 'parley') {
      void checkReady(bridge);
    }
    if (isRecord(raw['data']) && raw['data']['sessionID'] === bridge.attach.sessionId) {
      try {
        options.onSessionEvent?.(bridge.ref);
      } catch (error) {
        options.log.warn('opencode early poll failed', { ref: bridge.ref, error: String(error) });
      }
    }
    const mapped = mapOpencodeEvent(raw, bridge.attach.sessionId, bridge.state);
    bridge.state = mapped.state;
    if (mapped.usage !== null) options.onUsage?.(bridge.ref, mapped.usage);
    for (const record of mapped.records) {
      if (bridge.ready) emit(bridge, record);
      // Before readiness the readiness record is this process's `SessionStart`; other records wait for it.
      else if (record.hook_event_name !== 'SessionStart') bridge.pending.push(record);
    }
  }

  /** Reads one connection to its end. Returns whether it delivered anything (a successful connection). */
  async function readStream(bridge: Bridge): Promise<boolean> {
    const response = await fetchImpl(`${bridge.attach.url}/api/event`, {
      headers: { authorization: bridge.auth, accept: 'text/event-stream' },
      signal: bridge.abort.signal,
    });
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => {});
      return false;
    }
    bridge.connections += 1;
    // A reconnect may have missed a `mcp.status.changed`: read the status again.
    void checkReady(bridge);
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let delivered = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        delivered = true;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
          if (data === '') continue;
          try {
            onEvent(bridge, JSON.parse(data));
          } catch {
            /* not JSON: skipped */
          }
        }
        if (buffer.length > EVENT_LIMIT) buffer = '';
      }
    } finally {
      reader.releaseLock();
    }
    return delivered;
  }

  async function run(bridge: Bridge): Promise<void> {
    let delay = initialMs;
    while (!bridge.detached) {
      let delivered = false;
      try {
        delivered = await readStream(bridge);
      } catch {
        /* refused, reset or aborted */
      }
      if (bridge.detached) return;
      if (delivered) delay = initialMs;
      await sleep(delay, bridge.abort.signal);
      if (!delivered) delay = Math.min(maxMs, delay * 2);
    }
  }

  return {
    attach(ref, attach) {
      const key = refKey(ref);
      bridges.get(key)?.abort.abort();
      const bridge: Bridge = {
        ref,
        attach,
        auth: `Basic ${Buffer.from(`opencode:${attach.password}`).toString('base64')}`,
        state: emptyOpencodeBridgeState(),
        seen: new Set(),
        ready: false,
        pending: [],
        mcpFailed: false,
        abort: new AbortController(),
        detached: false,
        connections: 0,
        writes: Promise.resolve(),
        pollTimer: undefined,
        polling: false,
      };
      bridges.set(key, bridge);
      void run(bridge);
      void checkReady(bridge);
    },
    detach(ref) {
      const key = refKey(ref);
      const bridge = bridges.get(key);
      if (bridge === undefined) return;
      bridges.delete(key);
      bridge.detached = true;
      if (bridge.pollTimer !== undefined) clearTimeout(bridge.pollTimer);
      bridge.abort.abort();
    },
    ready(ref) {
      return bridges.get(refKey(ref))?.ready === true;
    },
    connections(ref) {
      return bridges.get(refKey(ref))?.connections ?? 0;
    },
    stopAll() {
      for (const key of [...bridges.keys()]) {
        const bridge = bridges.get(key)!;
        this.detach(bridge.ref);
      }
    },
  };
}
