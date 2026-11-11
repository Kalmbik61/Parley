// FIXTURE ONLY (plan T5b1). A synthetic `/agent/tools` host for transport tests of the Code Mode remote-only caller. It
// lives at the repository root, outside every workspace package, so no package build or deploy contains it. It has no
// session store and no authority: each request gets the next scripted reply, and every request is logged raw.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export const FIXTURE_TOKEN = 'f'.repeat(64);

/** One scripted reply. Omitted `status` is 200; `chunks` are written one by one with `chunkDelayMs` between them. */
export interface ScriptedReply {
  readonly status?: number;
  readonly body?: string | Buffer;
  readonly chunks?: readonly (string | Buffer)[];
  readonly chunkDelayMs?: number;
  /** Wait before the status line. */
  readonly delayMs?: number;
  /** Never answer (the connection stays open until the client or `close` ends it). */
  readonly hang?: boolean;
  /** Destroy the socket: before any response, or after the given body bytes were written (an incomplete answer). */
  readonly drop?: 'before-headers' | { readonly afterBytes: number };
}

export interface RecordedRequest {
  readonly n: number;
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  /** The request body exactly as received. */
  readonly raw: string;
  readonly bytes: number;
}

export type Script = (request: RecordedRequest) => ScriptedReply | Promise<ScriptedReply>;

export interface AgentHost {
  readonly agent: { readonly url: string; readonly token: string };
  readonly log: RecordedRequest[];
  /** Replace the script (for example between attempts). */
  setScript(script: Script): void;
  /** Bytes of response body actually written to clients, per request number. */
  readonly written: Map<number, number>;
  /** Close and forget everything (a host restart loses its replay memory); `reopen` listens again on the same port. */
  close(): Promise<void>;
  reopen(): Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startAgentHost(script: Script): Promise<AgentHost> {
  let current = script;
  const log: RecordedRequest[] = [];
  const written = new Map<number, number>();
  const sockets = new Set<Socket>();
  let port = 0;
  let server: Server;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const rec: RecordedRequest = Object.freeze({
        n: log.length + 1, method: req.method, url: req.url, authorization: req.headers.authorization, raw: body.toString('utf8'), bytes: body.length,
      });
      log.push(rec);
      void (async () => {
        const reply = await current(rec);
        if (reply.delayMs) await wait(reply.delayMs);
        if (reply.hang) return;
        if (reply.drop === 'before-headers') { req.socket.destroy(); return; }
        const parts = reply.chunks ?? [reply.body ?? ''];
        const total = parts.reduce((s, p) => s + Buffer.byteLength(p), 0);
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', 'Content-Length': total });
        let sent = 0;
        for (const part of parts) {
          const buf = Buffer.isBuffer(part) ? part : Buffer.from(part, 'utf8');
          if (typeof reply.drop === 'object' && sent + buf.length > reply.drop.afterBytes) {
            const head = buf.subarray(0, Math.max(0, reply.drop.afterBytes - sent));
            if (head.length > 0) res.write(head);
            written.set(rec.n, sent + head.length);
            setImmediate(() => req.socket.destroy());
            return;
          }
          if (res.destroyed) return;
          res.write(buf);
          sent += buf.length;
          written.set(rec.n, sent);
          if (reply.chunkDelayMs) await wait(reply.chunkDelayMs);
        }
        res.end();
      })();
    });
  };

  const listen = (): Promise<void> => new Promise((resolve) => {
    server = createServer(handle);
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.listen(port, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; resolve(); });
  });
  await listen();

  return {
    agent: Object.freeze({ url: `http://127.0.0.1:${port}`, token: FIXTURE_TOKEN }),
    log,
    written,
    setScript: (s) => { current = s; },
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
    reopen: listen,
  };
}

/** A host envelope as the real endpoint writes it. */
export const okEnvelope = (result: unknown): string => JSON.stringify({ ok: true, result });
