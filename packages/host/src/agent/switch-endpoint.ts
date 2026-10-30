import type { IncomingMessage, ServerResponse } from 'node:http';
import { isMember, liveLead, type WorkMap } from '@parley/core';
import { AGENT_LIMITS, type AgentSwitchCard, type SessionRef } from '@parley/protocol';

export const AGENT_SWITCH_PATH = '/agent/switch';

/** Ответ агенту: человек спрошен, замена случится только после его ответа. */
export const SWITCH_ASKED = 'asked @human; the switch happens only after their answer';

const REASON_MAX = 500;

/**
 * Права на просьбу (спека замены агента, 5.5): родитель цели (`parent` или `createdBy`), живой ведущий или владелец
 * комнаты, где цель участник, и сама цель. Возвращает причину отказа или `null`.
 */
export function switchRequestDenial(map: WorkMap, requester: string, targetId: string): string | null {
  const target = map.sessions.find((session) => session.id === targetId);
  if (target === undefined) return `session ${targetId} is not in this workspace`;
  if (target.lifecycle === 'closed') return `session ${targetId} is closed`;
  // Сессии движка autonomous агента не меняют (спека 6.7): отказ сразу, а не после `allow` человека.
  if ((target.workspace ?? null) !== null) return `session ${targetId} belongs to the autonomous engine and cannot change agent`;
  if (requester === targetId || target.parent === requester || target.createdBy === requester) return null;
  for (const room of map.rooms) {
    if (!isMember(room, targetId)) continue;
    if (liveLead(map, room) === requester || room.ownerId === requester) return null;
  }
  return `only the parent, a live lead or the owner of a room it takes part in, or the session itself may ask to continue ${targetId} on another provider`;
}

export function createSwitchEndpoint(options: {
  authenticate(req: IncomingMessage): SessionRef | undefined;
  readMap(ref: SessionRef): Promise<WorkMap>;
  /** Имя провайдера для людей; `null` — такого провайдера в реестре нет. */
  providerLabel(provider: string): Promise<string | null>;
  request(input: Omit<AgentSwitchCard, 'id' | 'kind' | 'projectPath' | 'at' | 'state'>): Promise<void> | void;
}) {
  return {
    handle(req: IncomingMessage, res: ServerResponse): void {
      const refuse = (status: number): void => { res.writeHead(status, { Connection: 'close' }); res.end(); req.resume(); };
      const reply = (body: unknown): void => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
      };
      const ref = options.authenticate(req);
      if (ref === undefined) return refuse(401);
      if (Number(req.headers['content-length'] ?? 0) > AGENT_LIMITS.requestBytes) return refuse(413);
      const chunks: Buffer[] = [];
      let size = 0;
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        size += chunk.length;
        if (size > AGENT_LIMITS.requestBytes) { rejected = true; chunks.length = 0; refuse(413); return; }
        chunks.push(chunk);
      });
      req.on('error', () => { rejected = true; });
      req.on('end', () => {
        if (rejected) return;
        void (async () => {
          try {
            if (options.authenticate(req) === undefined) { refuse(401); return; }
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Expected switch arguments.');
            const args = body as Record<string, unknown>;
            if (Object.keys(args).some((key) => !['session', 'provider', 'model', 'reason'].includes(key))) throw new Error('Unknown switch argument.');
            for (const key of ['session', 'provider', 'reason']) {
              if (typeof args[key] !== 'string' || !args[key].trim()) throw new Error(`${key} must be a nonempty string.`);
            }
            if (args['model'] !== undefined && args['model'] !== null && typeof args['model'] !== 'string') throw new Error('model must be a string or null.');
            const reason = (args['reason'] as string).trim();
            if (reason.length > REASON_MAX) throw new Error(`reason must be at most ${REASON_MAX} characters.`);
            const targetId = (args['session'] as string).trim();
            const provider = args['provider'] as string;
            const map = await options.readMap(ref);
            const denial = switchRequestDenial(map, ref.sessionId, targetId);
            if (denial !== null) throw Object.assign(new Error(denial), { code: 'forbidden' });
            const label = await options.providerLabel(provider);
            if (label === null) throw new Error(`unknown provider ${provider}; take it from get_map {field: "providers"}`);
            const requester = map.sessions.find((session) => session.id === ref.sessionId);
            await options.request({
              ref: { ...ref, sessionId: targetId },
              provider,
              providerLabel: label,
              model: (args['model'] as string | null | undefined) ?? null,
              reason,
              requestedBy: { sessionId: ref.sessionId, label: requester?.label ?? ref.sessionId },
            });
            reply({ ok: true, result: { message: SWITCH_ASKED } });
          } catch (error) {
            reply({ ok: false, error: { code: error instanceof Error && 'code' in error ? String(error.code) : 'bad_request', message: error instanceof Error ? error.message : String(error) } });
          }
        })();
      });
    },
  };
}
