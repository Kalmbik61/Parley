import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig, roleFromId } from '@parley/core';
import { AGENT_LIMITS, type SessionRef } from '@parley/protocol';
import type { CreateSessionInput } from '../sessions/sessions-service.js';

export const AGENT_SESSIONS_PATH = '/agent/sessions';

export function createSessionEndpoint(options: {
  authenticate(req: IncomingMessage): SessionRef | undefined;
  create(input: CreateSessionInput): Promise<SessionRef>;
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
            if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Expected session arguments.');
            const args = body as Record<string, unknown>;
            const allowed = ['provider', 'label', 'task', 'role', 'agent', 'worktree', 'model', 'effort'];
            if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unknown session argument.');
            for (const key of ['provider', 'label', 'task']) if (typeof args[key] !== 'string' || !args[key].trim()) throw new Error(`${key} must be a nonempty string.`);
            for (const key of ['role', 'agent']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) throw new Error(`${key} must be a nonempty string.`);
            for (const key of ['model', 'effort']) if (args[key] !== undefined && args[key] !== null && typeof args[key] !== 'string') throw new Error(`${key} must be a string or null.`);
            if (args['worktree'] !== undefined && typeof args['worktree'] !== 'boolean') throw new Error('worktree must be a boolean.');
            if (args['role'] !== undefined && args['agent'] !== undefined) throw new Error('agent-and-role-conflict');
            const { config } = await loadConfig();
            const created = await options.create({
              projectPath: ref.projectPath, workId: ref.workId, requestedBy: ref.sessionId, parent: null,
              provider: args['provider'] as string, label: args['label'] as string, task: args['task'] as string,
              lean: config.leanAgents,
              ...(args['role'] === undefined ? {} : { role: roleFromId(args['role'] as string) }),
              ...(args['agent'] === undefined ? {} : { agent: args['agent'] as string }),
              ...(args['model'] === undefined ? {} : { model: args['model'] as string | null }),
              ...(args['effort'] === undefined ? {} : { effort: args['effort'] as string | null }),
              ...(args['worktree'] === undefined ? {} : { worktree: args['worktree'] as boolean }),
            });
            reply({ ok: true, result: { sessionId: created.sessionId, provider: args['provider'] } });
          } catch (error) {
            reply({ ok: false, error: { code: error instanceof Error && 'code' in error ? String(error.code) : 'bad_request', message: error instanceof Error ? error.message : String(error) } });
          }
        })();
      });
    },
  };
}
