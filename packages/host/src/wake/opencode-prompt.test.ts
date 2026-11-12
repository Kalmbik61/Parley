/**
 * Delivery of host prompts to OpenCode through the server API (spec 2026-11-12, 4.5, plan O7): a fake `opencode serve`
 * answers the prompt route, the inbox and the message list; a spy stands in for typing into the terminal.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import type { Attempt, AttemptOutcome } from '../pty/type-and-submit.js';
import { sendOpencodePrompt, type OpencodePromptDeps } from './opencode-prompt.js';

const REF: SessionRef = { projectPath: '/p', workId: 'w-1', sessionId: 's-1' };
const ID = 'ses_parley000000000000000001';
const PASSWORD = 'lab-secret-not-real';
const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
const POINTER = 'New messages (1). Call check_inbox.';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve())));
  server = undefined;
});

/** What the fake server does with each POST of the prompt route, in order; the last behaviour repeats. */
type Behaviour = 'accept' | 'busy-accept' | 'reject' | 'error' | 'queue-then-error' | 'queue-then-drop' | 'queue-then-hang' | 'error-unqueued' | 'drop';

interface Fake {
  address: { url: string; password: string };
  posts: string[];
  inbox: Array<{ text: string; created: number }>;
  messages: Array<{ text: string; created: number }>;
  requests: Array<{ method: string; url: string; auth: string | undefined }>;
}

async function listen(behaviours: Behaviour[]): Promise<Fake> {
  const fake: Fake = { address: { url: '', password: PASSWORD }, posts: [], inbox: [], messages: [], requests: [] };
  let posted = 0;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    fake.requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
    if (req.headers.authorization !== AUTH) return void res.writeHead(401).end();
    const url = new URL(req.url ?? '', 'http://x');
    if (req.method === 'GET' && url.pathname.endsWith('/inbox')) {
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify({ data: fake.inbox.map((item) => ({ id: 'msg_i', time: { created: item.created }, type: 'user', payload: { text: item.text }, delivery: 'steer' })) }));
    }
    if (req.method === 'GET' && url.pathname.endsWith('/message')) {
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify({ data: fake.messages.map((item) => ({ id: 'msg_m', time: { created: item.created }, type: 'user', text: item.text })) }));
    }
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const text = (JSON.parse(body) as { text: string }).text;
      fake.posts.push(text);
      const behaviour = behaviours[Math.min(posted, behaviours.length - 1)]!;
      posted += 1;
      const queue = (): void => void fake.inbox.push({ text, created: Date.now() });
      switch (behaviour) {
        case 'accept':
        case 'busy-accept':
          queue();
          return void res.writeHead(202).end('{}');
        case 'reject':
          return void res.writeHead(400).end('{"error":"bad"}');
        case 'error':
        case 'error-unqueued':
          return void res.writeHead(500).end();
        case 'queue-then-error':
          queue();
          return void res.writeHead(500).end();
        case 'queue-then-drop':
          queue();
          return void req.socket.destroy();
        case 'queue-then-hang':
          queue();
          return; // never answers: the client times out
        case 'drop':
          return void req.socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  fake.address.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return fake;
}

function typing(outcome: AttemptOutcome = 'submitted') {
  const cancel = vi.fn();
  const fallback = vi.fn<(text: string) => Attempt>(() => ({ cancel, done: Promise.resolve(outcome) }));
  return { fallback, cancel };
}

const deps = (fake: Fake | null, over: Partial<OpencodePromptDeps> = {}): OpencodePromptDeps => ({
  server: () => fake?.address,
  sessionId: () => ID,
  timeoutMs: 400,
  ...over,
});

describe('sendOpencodePrompt', () => {
  it('sends the prompt once through the API with Basic auth and does not type', async () => {
    const fake = await listen(['accept']);
    const { fallback } = typing();
    expect(await sendOpencodePrompt(deps(fake), REF, POINTER, fallback).done).toBe('submitted');
    expect(fake.posts).toEqual([POINTER]);
    expect(fake.requests.map((request) => request.url)).toEqual([`/api/session/${ID}/prompt`]);
    expect(fake.requests.every((request) => request.auth === AUTH)).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a pointer sent while a turn runs is simply queued by the server: still one POST, no typing', async () => {
    const fake = await listen(['busy-accept']);
    const { fallback } = typing();
    await sendOpencodePrompt(deps(fake), REF, POINTER, fallback).done;
    expect(fake.posts).toHaveLength(1);
    expect(fake.inbox.map((item) => item.text)).toEqual([POINTER]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a 202 whose answer was lost (the server queued it, the connection dropped): the inbox shows it, no second delivery, no typing', async () => {
    const fake = await listen(['queue-then-drop']);
    const { fallback } = typing();
    expect(await sendOpencodePrompt(deps(fake), REF, POINTER, fallback).done).toBe('submitted');
    expect(fake.posts).toHaveLength(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a timeout after the server queued the prompt: the inbox shows it, no retry, no typing', async () => {
    const fake = await listen(['queue-then-hang']);
    const { fallback } = typing();
    expect(await sendOpencodePrompt(deps(fake, { timeoutMs: 150 }), REF, POINTER, fallback).done).toBe('submitted');
    expect(fake.posts).toHaveLength(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a 500 with the text already in the inbox: no typing and no retry', async () => {
    const fake = await listen(['queue-then-error']);
    const { fallback } = typing();
    expect(await sendOpencodePrompt(deps(fake), REF, POINTER, fallback).done).toBe('submitted');
    expect(fake.posts).toHaveLength(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('the text may already be among the latest messages instead of the inbox', async () => {
    const fake = await listen(['error-unqueued']);
    fake.messages.push({ text: POINTER, created: Date.now() });
    const { fallback } = typing();
    expect(await sendOpencodePrompt(deps(fake), REF, POINTER, fallback).done).toBe('submitted');
    expect(fake.posts).toHaveLength(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a 500 with nothing queued: the API is retried once, and a retry that works ends it without typing', async () => {
    const fake = await listen(['error-unqueued', 'accept']);
    const { fallback } = typing();
    expect(await sendOpencodePrompt(deps(fake), REF, POINTER, fallback).done).toBe('submitted');
    expect(fake.posts).toEqual([POINTER, POINTER]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('an older identical pointer in the inbox or the messages is not taken for ours', async () => {
    const fake = await listen(['error-unqueued', 'accept']);
    fake.inbox.push({ text: POINTER, created: Date.now() - 60_000 });
    fake.messages.push({ text: POINTER, created: Date.now() - 60_000 });
    const { fallback } = typing();
    await sendOpencodePrompt(deps(fake), REF, POINTER, fallback).done;
    expect(fake.posts).toHaveLength(2);
  });

  it('ambiguous twice and nothing queued while the server answers: nothing is typed (typing could double it)', async () => {
    const fake = await listen(['error-unqueued']);
    const { fallback } = typing();
    expect(await sendOpencodePrompt(deps(fake), REF, POINTER, fallback).done).toBe('cancelled');
    expect(fake.posts).toHaveLength(2);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a refused connection is a definite rejection: the text is typed, once', async () => {
    const fake = await listen(['accept']);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const { fallback } = typing('submitted');
    expect(await sendOpencodePrompt(deps(fake), REF, POINTER, fallback).done).toBe('submitted');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(POINTER);
  });

  it('a 4xx answer is a definite rejection: the text is typed after exactly one POST', async () => {
    const fake = await listen(['reject']);
    const { fallback } = typing();
    await sendOpencodePrompt(deps(fake), REF, POINTER, fallback).done;
    expect(fake.posts).toHaveLength(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('the server dying between the ambiguous answer and the check: typed once', async () => {
    const fake = await listen(['drop']);
    let calls = 0;
    const { fallback } = typing();
    // The supervisor's address disappears after the first answer: the server is gone.
    const gone = deps(fake, { server: () => (calls++ === 0 ? fake.address : undefined) });
    await sendOpencodePrompt(gone, REF, POINTER, fallback).done;
    expect(fake.posts).toHaveLength(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('no server and no session id: typed, no request', async () => {
    const fake = await listen(['accept']);
    const a = typing();
    await sendOpencodePrompt(deps(fake, { server: () => undefined }), REF, POINTER, a.fallback).done;
    const b = typing();
    await sendOpencodePrompt(deps(fake, { sessionId: () => null }), REF, POINTER, b.fallback).done;
    expect(a.fallback).toHaveBeenCalledTimes(1);
    expect(b.fallback).toHaveBeenCalledTimes(1);
    expect(fake.requests).toEqual([]);
  });

  it('cancel during the flight stops the delivery: no retry and no typing; the password is only in the header', async () => {
    const fake = await listen(['queue-then-hang']);
    const logged: unknown[] = [];
    const { fallback } = typing();
    const attempt = sendOpencodePrompt(deps(fake, { timeoutMs: 300, log: { info: (...a: unknown[]) => void logged.push(a), warn: (...a: unknown[]) => void logged.push(a) } as never }), REF, POINTER, fallback);
    attempt.cancel();
    expect(await attempt.done).toBe('cancelled');
    expect(fallback).not.toHaveBeenCalled();
    expect(JSON.stringify(logged)).not.toContain(PASSWORD);
  });

  it('multi-paragraph text goes as one prompt with its paragraphs', async () => {
    const fake = await listen(['accept']);
    const brief = '# Workspace\n\nTask: run the suite\n\nCall `get_map` first.';
    await sendOpencodePrompt(deps(fake), REF, brief, typing().fallback).done;
    expect(fake.posts).toEqual([brief]);
  });
});
