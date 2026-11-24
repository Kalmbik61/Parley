import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const STUB = join(import.meta.dirname, 'stub-qwen-agent.mjs');
const SID = '11111111-1111-4111-8111-111111111111';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Setup {
  dir: string;
  cwd: string;
  home: string;
  commandLog: string;
  settingsPath: string;
  httpPort: number;
  httpHits: Array<{ headers: IncomingHttpHeaders; body: { hook_event_name: string } }>;
}

async function withServer<T>(fn: (s: Setup) => Promise<T>): Promise<T> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stub-qwen-')));
  dirs.push(dir);
  const httpHits: Setup['httpHits'] = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      httpHits.push({ headers: req.headers, body: JSON.parse(b) });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const httpPort = (server.address() as { port: number }).port;
  const commandLog = join(dir, 'hooks.log');
  const hooks: Record<string, unknown> = {};
  for (const e of ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']) {
    hooks[e] = [{ hooks: [{ type: 'command', command: `cat >> '${commandLog}'; echo >> '${commandLog}'` }, { type: 'http', url: `http://127.0.0.1:${httpPort}/hook`, headers: { 'X-Test': 'tok' } }] }];
  }
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ hooks }));
  const cwd = join(dir, 'my project.1');
  mkdirSync(cwd);
  const home = join(dir, 'qwen-home');
  try {
    return await fn({ dir, cwd, home, commandLog, settingsPath, httpPort, httpHits });
  } finally {
    server.close();
  }
}

function run(s: Setup, args: string[], stdin: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STUB, ...args], {
      cwd: s.cwd,
      env: { ...process.env, QWEN_HOME: s.home, QWEN_CODE_SYSTEM_SETTINGS_PATH: s.settingsPath, ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(stdin);
  });
}

const events = (log: string) =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('stub-qwen-agent', () => {
  it('prints the version', async () => {
    const out = await new Promise<string>((resolve) => {
      const c = spawn(process.execPath, [STUB, '--version']);
      let o = '';
      c.stdout.on('data', (d) => (o += d));
      c.on('close', () => resolve(o));
    });
    expect(out.trim()).toBe('0.27.2');
  });

  it('fires command and http hooks in order and writes the transcript at the qwen path', async () => {
    await withServer(async (s) => {
      const r = await run(s, ['--session-id', SID, '-m', 'mock-model', '--approval-mode', 'yolo', '-i', 'first prompt'], 'second turn\n', { STUB_QWEN_EMPTY_PROMPT: '1' });
      expect(r.code).toBe(0);

      const ev = events(s.commandLog);
      expect(ev.map((e) => e.hook_event_name)).toEqual([
        'SessionStart',
        'UserPromptSubmit', 'UserPromptSubmit', 'Stop', 'Notification',
        'UserPromptSubmit', 'UserPromptSubmit', 'Stop', 'Notification',
        'SessionEnd',
      ]);
      expect(ev[0]).toMatchObject({ session_id: SID, source: 'startup', model: 'mock-model', permission_mode: 'yolo' });
      expect(ev[1]).toMatchObject({ prompt: 'first prompt', prompt_id: `${SID}########0` });
      expect(ev[2]).toMatchObject({ prompt: '' });
      expect(ev[3]).toMatchObject({ last_assistant_message: 'Hello from stub', stop_hook_active: false });
      expect(ev[4]).toMatchObject({ notification_type: 'idle_prompt' });
      expect(ev[5]).toMatchObject({ prompt: 'second turn', prompt_id: `${SID}########1` });

      expect(s.httpHits.map((h) => h.body.hook_event_name)).toEqual(ev.map((e) => e.hook_event_name));
      expect(s.httpHits[0]!.headers['x-test']).toBe('tok');

      const file = join(s.home, 'projects', s.cwd.replace(/[^A-Za-z0-9]/g, '-'), 'chats', `${SID}.jsonl`);
      expect(ev[0]!.transcript_path).toBe(file);
      const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(recs.filter((x) => x.type === 'user').map((x) => x.message.parts[0].text)).toEqual(['first prompt', 'second turn']);
      expect(recs.filter((x) => x.type === 'assistant')).toHaveLength(2);
      expect(recs[0]).toMatchObject({ sessionId: SID, parentUuid: null, version: '0.27.2', provenance: 'real_user' });
    });
  });

  it('--resume appends to the same transcript', async () => {
    await withServer(async (s) => {
      await run(s, ['--session-id', SID, '-i', 'one'], '');
      const file = join(s.home, 'projects', s.cwd.replace(/[^A-Za-z0-9]/g, '-'), 'chats', `${SID}.jsonl`);
      const before = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;

      await run(s, ['--resume', SID], 'two\n');
      const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(recs.length).toBeGreaterThan(before);
      expect(recs.filter((x) => x.type === 'user').map((x) => x.message.parts[0].text)).toEqual(['one', 'two']);
      expect(new Set(recs.map((x) => x.sessionId))).toEqual(new Set([SID]));
      const starts = events(s.commandLog).filter((e) => e.hook_event_name === 'SessionStart');
      expect(starts.map((e) => e.source)).toEqual(['startup', 'resume']);
      expect(events(s.commandLog).at(-4)).toMatchObject({ prompt_id: `${SID}########1` });
    });
  });
});
