import type { IncomingMessage, ServerResponse } from 'node:http';
import { isSwarmTag, loadConfig, roleFromId, SWARM_OBJECTIVE_MAX } from '@parley/core';
import type { SwarmRole } from '@parley/core';
import { AGENT_LIMITS, type SessionRef } from '@parley/protocol';
import type { CreatedSession, CreateSessionInput } from '../sessions/sessions-service.js';
import { memberName } from '../swarms/spawn.js';

export const AGENT_SWARMS_PATH = '/agent/swarms';

/**
 * Канал агента к рою (спека роя v1, 4): `{op: 'create', tag, objective, provider, role?, model?, effort?}` заводит рой и
 * королеву, `{op: 'add', role, task, provider, label?, agentRole?, model?, effort?}` — трутня или проверяющего в рой
 * королевы-вызывающего. Работу и вызывающего хост берёт из токена, рой — из карты; `swarm` в `CreateSessionInput` ставит
 * только этот маршрут.
 */
export function createSwarmEndpoint(options: {
  authenticate(req: IncomingMessage): SessionRef | undefined;
  create(input: CreateSessionInput): Promise<CreatedSession>;
  /** Рой и номер созданного участника — по карте, которую только что записала та же операция. */
  memberOf(ref: SessionRef): Promise<{ swarmId: string; role: SwarmRole; n: number } | undefined>;
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
            if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Expected swarm arguments.');
            const args = body as Record<string, unknown>;
            const op = args['op'];
            if (op !== 'create' && op !== 'add') throw new Error('op must be "create" or "add".');
            const allowed = op === 'create'
              ? ['op', 'tag', 'objective', 'provider', 'role', 'model', 'effort']
              : ['op', 'role', 'task', 'provider', 'label', 'agentRole', 'model', 'effort'];
            if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unknown swarm argument.');
            const text = op === 'create' ? ['provider', 'objective'] : ['provider', 'task'];
            for (const key of text) if (typeof args[key] !== 'string' || !args[key].trim()) throw new Error(`${key} must be a nonempty string.`);
            for (const key of ['role', 'agentRole', 'label']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) throw new Error(`${key} must be a nonempty string.`);
            for (const key of ['model', 'effort']) if (args[key] !== undefined && args[key] !== null && typeof args[key] !== 'string') throw new Error(`${key} must be a string or null.`);
            if (op === 'create') {
              if (!isSwarmTag(args['tag'])) throw new Error('tag must be 1-24 characters without line breaks.');
              if ((args['objective'] as string).length > SWARM_OBJECTIVE_MAX) throw new Error(`objective must be at most ${SWARM_OBJECTIVE_MAX} characters.`);
            } else if (args['role'] !== 'drone' && args['role'] !== 'verifier') throw new Error('role must be "drone" or "verifier".');
            const { config } = await loadConfig();
            // Роль участника по умолчанию — исследователь для трутня и проверяющий для проверяющего (спека роя, 4).
            const roleOf = op === 'create' ? args['role'] : args['agentRole'] ?? (args['role'] === 'verifier' ? 'builtin:verifier' : 'builtin:researcher');
            const created = await options.create({
              projectPath: ref.projectPath, workId: ref.workId, requestedBy: ref.sessionId, parent: null,
              provider: args['provider'] as string, label: op === 'add' ? args['label'] as string | undefined ?? '' : '',
              task: (op === 'create' ? args['objective'] : args['task']) as string,
              // Королева всегда облегчённая: она только координирует, MCP человека ей не нужны, а диалог «new MCP servers found»
              // держал её до ответа человека (b-013). Участники из `swarm_add` — по настройке `leanAgents`.
              lean: op === 'create' ? true : config.leanAgents,
              swarm: op === 'create' ? { kind: 'create', tag: args['tag'] as string, objective: args['objective'] as string } : { kind: 'add', role: args['role'] as 'drone' | 'verifier' },
              ...(roleOf === undefined ? {} : { role: roleFromId(roleOf as string) }),
              ...(args['model'] === undefined ? {} : { model: args['model'] as string | null }),
              ...(args['effort'] === undefined ? {} : { effort: args['effort'] as string | null }),
            });
            const member = await options.memberOf(created);
            if (member === undefined) throw new Error(`Session ${created.sessionId} was created but is not in a swarm. Check get_map.`);
            const held = created.held === undefined ? {} : { held: created.held };
            const queued = created.queued === undefined ? {} : { queued: created.queued };
            reply({
              ok: true,
              result: op === 'create'
                ? { swarmId: member.swarmId, queenSessionId: created.sessionId, ...held, ...queued }
                : { sessionId: created.sessionId, member: memberName(member.role, member.n), ...held, ...queued },
            });
          } catch (error) {
            const data = error instanceof Error && 'data' in error && typeof error.data === 'object' && error.data !== null ? error.data as Record<string, unknown> : {};
            // `resource-budget` и причины роя (`not-queen`, `swarm-closed`, `swarms`, …) — код ответа агенту, как в таблице спеки.
            const code = [data['code'], data['reason']].find((value): value is string => typeof value === 'string')
              ?? (error instanceof Error && 'code' in error ? String(error.code) : 'bad_request');
            reply({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
          }
        })();
      });
    },
  };
}
