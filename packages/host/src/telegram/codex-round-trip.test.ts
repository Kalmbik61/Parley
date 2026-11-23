import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grantTrust } from '@parley/core';
import type { MethodName, Params, Result } from '@parley/protocol';
import { expect, it, vi } from 'vitest';
// @ts-expect-error — shared .mjs fixture has no declaration.
import { startFakeTelegram } from '../../../desktop/e2e/fake-telegram.mjs';
import { connectRaw, hello, removeHome, tempHome, waitConnected } from '../../test/helpers.js';
import { startHost } from '../host.js';
import { hostPaths } from '../paths.js';

interface FakeTelegram {
  url: string;
  push(update: Record<string, unknown>): void;
  requests(): Array<{
    method: string;
    messageId: number | null;
    body: {
      chat_id?: number;
      text?: string;
      timeout?: number;
      reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
  }>;
  close(): Promise<void>;
}

const STUB_CODEX = fileURLToPath(new URL('../../../desktop/e2e/stub-codex-agent.mjs', import.meta.url));
const VERSION = '0.166.0';
const OWNER = { id: 777, username: 'owner', first_name: 'Owner' };
const CHAT = { id: OWNER.id, type: 'private' };
const QUESTION = 'Which color do you prefer?';
const SESSION = 'Telegram Codex question';
const POLL = { timeout: 15_000 };

it('routes a Telegram option and typed Other to the same Codex PTY', async () => {
  const home = await tempHome();
  let fake: FakeTelegram | undefined;
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let client: ReturnType<typeof connectRaw> | undefined;
  try {
    const projectPath = path.join(home, 'project');
    const codexSessions = path.join(home, 'codex-sessions');
    const codexHome = path.join(home, 'codex');
    await mkdir(projectPath);
    await mkdir(codexSessions);
    await mkdir(codexHome);
    await grantTrust(projectPath, 'window', home);
    const bot = (await startFakeTelegram()) as FakeTelegram;
    fake = bot;
    vi.stubEnv('PARLEY_TELEGRAM_API', bot.url);
    vi.stubEnv('PARLEY_CODEX_BIN', STUB_CODEX);
    vi.stubEnv('PARLEY_CODEX_SESSIONS_DIR', codexSessions);
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('STUB_CODEX_SESSIONS', codexSessions);
    vi.stubEnv('STUB_CODEX_VERSION', VERSION);
    host = await startHost({ home, probeVersion: async (command) => command === STUB_CODEX ? VERSION : null });
    const paths = hostPaths(home);
    const connection = connectRaw(paths.socket);
    client = connection;
    await waitConnected(connection.socket);
    expect((await hello(connection, await readFile(paths.token, 'utf8'))).error).toBeUndefined();

    let requestId = 100;
    async function call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
      const id = ++requestId;
      connection.send({ id, method, params });
      for (;;) {
        const response = await connection.next();
        if (response.id !== id) continue;
        if (response.error !== undefined) throw new Error(`${method}: ${response.error.message}`);
        return response.result as Result<M>;
      }
    }

    let updateId = 1000;
    function ownerMessage(text: string): void {
      const id = ++updateId;
      bot.push({ update_id: id, message: { message_id: id, from: OWNER, chat: CHAT, date: Math.floor(Date.now() / 1000), text } });
    }

    expect(await call('telegram.setToken', { token: `123456:${'A'.repeat(35)}` })).toMatchObject({
      botUsername: 'parley_fake_bot',
    });
    const { code } = await call('telegram.link', {});
    await expect.poll(() => bot.requests().some(({ method, body }) =>
      method === 'getUpdates' && (body.timeout ?? 0) > 0), POLL).toBe(true);
    ownerMessage(`/start ${code}`);
    await expect.poll(() => call('telegram.status', {}), POLL).toMatchObject({ owner: { username: OWNER.username } });

    const { workId } = await call('works.create', { projectPath, title: 'Telegram question round trip', goal: '' });
    const { ref } = await call('sessions.create', {
      projectPath, workId, provider: 'codex', label: SESSION, task: '', parent: null,
    });
    const screen = async () => (await call('pty.screenText', { ref })).lines.join('\n');
    await expect.poll(screen, POLL).toContain('stub-codex');

    const messages = () => bot.requests().filter(({ method, body }) => method === 'sendMessage' && body.chat_id === CHAT.id);
    const questionMessages = () => messages().filter(({ body }) => body.text?.includes(QUESTION) && body.text.includes(SESSION));
    const answers = async () => (await call('feed.snapshot', { ref })).items.flatMap((item) =>
      item.kind === 'question' && item.state === 'answered' ? Object.values(item.answers ?? {}) : []);

    async function choose(buttonLabel: string): Promise<void> {
      const count = questionMessages().length;
      await expect.poll(async () =>
        (await call('pty.send', { ref, text: 'STUB_QUESTION_SCREEN', submit: true })).submitted, POLL).toBe(true);
      await expect.poll(questionMessages, POLL).toHaveLength(count + 1);
      const { messageId, body } = questionMessages()[count]!;
      const buttons = body.reply_markup?.inline_keyboard.flat();
      const button = buttons?.find(({ text }) => text === buttonLabel);
      if (messageId === null || button === undefined) {
        throw new Error(`Missing Telegram message ID or ${buttonLabel} button: ${JSON.stringify(buttons)}`);
      }
      const id = ++updateId;
      bot.push({
        update_id: id,
        callback_query: {
          id: `callback-${id}`, from: OWNER, data: button.callback_data, message: { message_id: messageId, chat: CHAT },
        },
      });
    }

    await choose('Blue');
    await expect.poll(screen, POLL).toContain('answer: Blue');
    await expect.poll(answers, POLL).toEqual(['Blue']);
    await choose('Other…');
    await expect.poll(() => messages().some(({ body }) =>
      body.text === 'Send your answer within 10 minutes, or /skip'), POLL).toBe(true);
    ownerMessage('purple please');
    await expect.poll(answers, POLL).toEqual(['Blue', 'purple please']);
    await expect.poll(screen, POLL).toContain('answer: purple please');
  } finally {
    client?.close();
    await host?.context.shutdown('test');
    await host?.closed;
    await fake?.close();
    await removeHome(home);
    vi.unstubAllEnvs();
  }
}, 70_000);
