/**
 * Закрытие завершённых сессий на настоящем `startHost` (план 4, задача 6). Юнит-тесты core проверяют правило лида и письмо
 * человеку на отдельном MCP-сервере; здесь то же самое идёт собранной дорогой: вместо `claude` стоит `test/stub-agent.mjs`,
 * сессии создаются через сокет, как это делает окно, инструменты зовутся через `POST /agent/tools` с токеном своей сессии,
 * а флаг разрешения человек ставит методом `works.setCloseFinished`.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_TOOLS_PATH, createWork, readStoredMap } from '@parley/core';
import { humanUnreadLetters } from '@parley/core/attention';
import type { SessionRef } from '@parley/protocol';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import type { RawMessage, TestClient } from '../../test/helpers.js';
import { startHost } from '../host.js';
import type { RunningHost } from '../host.js';
import { hostPaths } from '../paths.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));

let hosts: RunningHost[] = [];
let homes: string[] = [];
let projects: string[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.context.shutdown('test-cleanup').catch(() => {})));
  hosts = [];
  await Promise.all(homes.map((home) => removeHome(home)));
  homes = [];
  await Promise.all(projects.map((dir) => rm(dir, { recursive: true, force: true })));
  projects = [];
});

/** Ответ на запрос с этим номером; рассылки хоста по дороге пропускаются. */
async function responseTo(client: TestClient, id: number): Promise<RawMessage> {
  for (;;) {
    const message = await client.next();
    if (message.id === id) return message;
  }
}

interface ToolReply {
  isError: boolean;
  text: string;
}

describe('хост: агенты закрывают завершённые сессии по разрешению человека (план 4, задача 6)', () => {
  it('участник отчитался и написал человеку без комнаты; лид без флага получает отказ, с флагом закрывает его', async () => {
    const home = await tempHome();
    homes.push(home);
    const running = await startHost({ home });
    hosts.push(running);
    const hostToken = await readFile(hostPaths(home).token, 'utf8');
    const project = await mkdtemp(path.join(tmpdir(), 'parley-close-finished-'));
    projects.push(project);
    const argsFile = path.join(project, 'args.json');
    process.env['PARLEY_CLAUDE_BIN'] = STUB;
    process.env['STUB_ARGS_FILE'] = argsFile;
    try {
      const map = await createWork(project, { title: 'Работа' });
      const workId = map.work.id;
      const client = connectRaw(hostPaths(home).socket);
      await waitConnected(client.socket);
      await hello(client, hostToken, { client: 'desktop' });

      let nextId = 900;
      const call = async (method: string, params: unknown): Promise<unknown> => {
        nextId += 1;
        client.send({ id: nextId, method, params });
        const response = await responseTo(client, nextId);
        expect(response.error).toBeUndefined();
        return response.result;
      };

      /** Сессия человека и её токен канала агента: заглушка пишет argv в общий файл, поэтому сессии заводятся по одной. */
      const createSession = async (label: string): Promise<{ ref: SessionRef; call: (name: string, args: Record<string, unknown>) => Promise<ToolReply> }> => {
        const { ref } = (await call('sessions.create', {
          projectPath: project,
          workId,
          provider: 'claude',
          label,
          task: '',
          parent: null,
        })) as { ref: SessionRef };
        let argv: string[] = [];
        await vi.waitFor(async () => {
          const written = JSON.parse(await readFile(argsFile, 'utf8')) as { argv: string[]; env: { PARLEY_SESSION_ID: string | null } };
          expect(written.env.PARLEY_SESSION_ID).toBe(ref.sessionId);
          argv = written.argv;
        }, { timeout: 10_000, interval: 20 });
        const config = JSON.parse(await readFile(argv[argv.indexOf('--mcp-config') + 1] as string, 'utf8')) as {
          mcpServers: { parley: { env: Record<string, string> } };
        };
        const { PARLEY_AGENT_URL: agentUrl, PARLEY_AGENT_TOKEN: agentToken } = config.mcpServers.parley.env;
        const toolsUrl = new URL(AGENT_TOOLS_PATH, agentUrl);
        const tool = async (name: string, args: Record<string, unknown>): Promise<ToolReply> => {
          const response = await fetch(toolsUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'call', launch: {}, name, args, callId: randomUUID() }),
          });
          expect(response.status).toBe(200);
          const body = (await response.json()) as { ok: boolean; result: { isError?: boolean; content: { text: string }[] } };
          expect(body.ok).toBe(true);
          return { isError: body.result.isError === true, text: body.result.content[0]?.text ?? '' };
        };
        return { ref, call: tool };
      };

      const leader = await createSession('Лид');
      const member = await createSession('Участник');
      const { roomId } = (await call('rooms.create', {
        projectPath: project,
        workId,
        title: 'Комната',
        members: [leader.ref.sessionId, member.ref.sessionId],
        lead: leader.ref.sessionId,
        quiet: true,
      })) as { roomId: string };
      expect(roomId).toBeTruthy();

      // Участник сдал итог и написал человеку без комнаты: письмо лежит в карте и непрочитано у человека.
      const reported = await member.call('report', { status: 'done', summary: 'готово' });
      expect(reported.isError, reported.text).toBe(false);
      const letter = await member.call('send_message', { to: 'human', text: 'готово, глянь', kind: 'note' });
      expect(letter.isError, letter.text).toBe(false);
      const stored = readStoredMap(project, workId);
      const unread = humanUnreadLetters(stored);
      expect(unread).toHaveLength(1);
      expect(unread[0]).toMatchObject({ roomId: null, from: member.ref.sessionId, to: ['human'] });
      expect(stored.sessions.find((session) => session.id === member.ref.sessionId)?.result).toBe('done');

      // Флаг выключен: лид закрыть участника не может.
      const refused = await leader.call('close_session', { target: member.ref.sessionId });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('a finished member of the room it leads');
      expect(readStoredMap(project, workId).sessions.find((session) => session.id === member.ref.sessionId)?.lifecycle).not.toBe('closed');

      // Человек включил флаг по сокету: тот же вызов закрывает участника.
      await call('works.setCloseFinished', { projectPath: project, workId, closeFinished: true });
      const closed = await leader.call('close_session', { target: member.ref.sessionId });
      expect(closed.isError, closed.text).toBe(false);
      const after = readStoredMap(project, workId);
      expect(after.work.closeFinished).toBe(true);
      expect(after.sessions.find((session) => session.id === member.ref.sessionId)?.lifecycle).toBe('closed');
      expect(after.sessions.find((session) => session.id === leader.ref.sessionId)?.lifecycle).not.toBe('closed');

      // Хост за всё это время не записал в журнал ни одной строки уровня error.
      const lines = (await readFile(hostPaths(home).log, 'utf8')).split('\n').filter((line) => line.trim() !== '');
      const errors = lines.filter((line) => (JSON.parse(line) as { level: string }).level === 'error');
      expect(errors).toEqual([]);
      client.close();
    } finally {
      delete process.env['PARLEY_CLAUDE_BIN'];
      delete process.env['STUB_ARGS_FILE'];
    }
  }, 60_000);
});
