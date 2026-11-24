#!/usr/bin/env node
// Stub standing in for the real `opencode` (OpenCode 2.2.7) in host tests. The real CLI never runs in automated tests.
// Shapes follow tools/opencode-mock-lab/FINDINGS.md; content is invented.
//
// Modes:
// - `--version`: prints `opencode v2.2.7`;
// - `serve --hostname <h> --port <p>`: an HTTP server on <h>:<p> (0 = random) that prints
//   `server listening on http://<h>:<port>`; HTTP Basic (user `opencode`, password OPENCODE_SERVER_PASSWORD) on `/api/*`;
//   `/health` and `/doc` answer a static page without auth; `GET /api/info`; `GET /api/event` (SSE, events from
//   STUB_OPENCODE_EVENTS_FILE, one JSON per line, sent to every subscriber);
// - otherwise the TUI: `--server <url> -s <id> [--auto]`; checks the password against `/api/info`, then reads stdin
//   (the line STUB_EXIT exits).
//
// Environment (serve):
//   STUB_OPENCODE_PID_FILE=<path>     append "<role> <pid>" lines (role: serve, child)
//   STUB_OPENCODE_SERVE_MODE=<mode>   never-ready: listens, never answers /api/info; crash-after=<ms>: exits 3 after <ms>
//                                     once ready; addr-in-use-once=<file>: the first run (no <file> yet) prints an
//                                     EADDRINUSE error and exits 1
//   STUB_OPENCODE_CHILD=1             spawn a differently named child (/bin/sleep 600) in the server's group, like a tool
//   STUB_OPENCODE_IGNORE_TERM=1       ignore SIGTERM (only SIGKILL ends it)
//   STUB_OPENCODE_ENV_FILE=<path>     write the names of the env vars the server got, and whether the password is set
//   STUB_OPENCODE_EVENTS_FILE=<path>  SSE events, one JSON per line, sent as appended; the line {"stub":"drop"} closes every
//                                     open stream instead (a dropped connection)
//   STUB_OPENCODE_SSE_REPLAY=1        a new subscriber first gets every event sent so far (a server that replays)
//   STUB_OPENCODE_MCP_FILE=<path>     `GET /api/mcp` status of `parley`: the file's text (connected, failed); no file =
//                                     pending (empty list); variable unset = connected
//   STUB_OPENCODE_ACTIVE_FILE=<path>  `GET /api/session/active`: a session id per line is running; no file = none
//   STUB_OPENCODE_PERMISSIONS_FILE=<path>  `GET /api/session/<id>/permission`: JSON list of pending requests; no file = []
//   STUB_OPENCODE_SESSIONS_FILE=<path>     `POST /api/session {id}`: the id is appended; STUB_OPENCODE_CREATE_STATUS (default 200) is the answer
// Environment (TUI):
//   STUB_OPENCODE_ARGS_FILE=<path>    write JSON { argv, cwd, server, session, passwordSet, passwordDigest, configSet,
//                                     infoStatus }

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { setInterval, setTimeout } from 'node:timers';
import { URL } from 'node:url';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('opencode v2.2.7');
  process.exit(0);
}
const flag = (...names) => {
  const i = argv.findIndex((a) => names.includes(a));
  return i >= 0 ? argv[i + 1] : undefined;
};
const password = process.env.OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD;
const record = (role, pid) => {
  if (process.env.STUB_OPENCODE_PID_FILE) appendFileSync(process.env.STUB_OPENCODE_PID_FILE, `${role} ${pid}\n`);
};

if (argv[0] === 'serve') serve();
else tui();

function serve() {
  const mode = process.env.STUB_OPENCODE_SERVE_MODE ?? '';
  if (mode.startsWith('addr-in-use-once=')) {
    const marker = mode.slice('addr-in-use-once='.length);
    if (!existsSync(marker)) {
      writeFileSync(marker, 'x');
      process.stderr.write('error: listen EADDRINUSE: address already in use 127.0.0.1:4096\n');
      process.exit(1);
    }
  }
  if (process.env.STUB_OPENCODE_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
  if (process.env.STUB_OPENCODE_ENV_FILE) {
    writeFileSync(process.env.STUB_OPENCODE_ENV_FILE, JSON.stringify({
      names: Object.keys(process.env).sort(),
      passwordSet: typeof password === 'string' && password.length > 0,
      config: process.env.OPENCODE_CONFIG_CONTENT ?? null,
    }));
  }
  record('serve', process.pid);
  if (process.env.STUB_OPENCODE_CHILD === '1') {
    const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
    record('child', child.pid);
  }
  const hostname = flag('--hostname') ?? '127.0.0.1';
  const port = Number(flag('--port') ?? '4096');
  const expected = `Basic ${Buffer.from(`opencode:${password ?? ''}`).toString('base64')}`;
  const subscribers = new Set();
  /** Events sent so far (for the replay mode). */
  const history = [];
  const page = '<!doctype html><html lang="en"><head><title>OpenCode</title></head><body><div id="root"></div></body></html>';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (url.pathname === '/health' || url.pathname === '/doc') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page);
      return;
    }
    if (req.headers.authorization !== expected || !password) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"_tag":"UnauthorizedError","message":"Authentication required"}');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/session') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const status = Number(process.env.STUB_OPENCODE_CREATE_STATUS ?? '200');
        if (status < 300) {
          const id = JSON.parse(body || '{}').id;
          if (process.env.STUB_OPENCODE_SESSIONS_FILE && typeof id === 'string') appendFileSync(process.env.STUB_OPENCODE_SESSIONS_FILE, `${id}\n`);
        }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    if (url.pathname === '/api/info') {
      if (mode === 'never-ready') return; // hangs: the client times out
      const address = server.address();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '2.2.7', pid: process.pid, urls: [`http://${hostname}:${address.port}`], capabilities: { persistentPty: true } }));
      return;
    }
    if (url.pathname === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ id: `evt_conn${Date.now()}${Math.random()}`, type: 'server.connected', data: {} })}\n\n`);
      if (process.env.STUB_OPENCODE_SSE_REPLAY === '1') for (const line of history) res.write(`data: ${line}\n\n`);
      subscribers.add(res);
      req.on('close', () => subscribers.delete(res));
      return;
    }
    if (url.pathname === '/api/session/active') {
      const file = process.env.STUB_OPENCODE_ACTIVE_FILE;
      const ids = file !== undefined && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: Object.fromEntries(ids.map((id) => [id, { type: 'running' }])) }));
      return;
    }
    const permission = /^\/api\/session\/([^/]+)\/permission$/.exec(url.pathname);
    if (permission !== null) {
      const file = process.env.STUB_OPENCODE_PERMISSIONS_FILE;
      const list = file !== undefined && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: list.filter((item) => item.sessionID === decodeURIComponent(permission[1])) }));
      return;
    }
    if (url.pathname === '/api/mcp') {
      const file = process.env.STUB_OPENCODE_MCP_FILE;
      const status = file === undefined ? 'connected' : existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ location: { directory: '/stub' }, data: status === null ? [] : [{ name: 'parley', status: { status } }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"_tag":"NotFound"}');
  });
  server.on('error', (error) => {
    process.stderr.write(`error: ${error.code ?? ''} ${error.message}\n`);
    process.exit(1);
  });
  server.listen(port, hostname, () => {
    const address = server.address();
    process.stdout.write(`server listening on http://${hostname}:${address.port}\n`);
    if (mode.startsWith('crash-after=')) setTimeout(() => process.exit(3), Number(mode.slice('crash-after='.length)));
  });
  // Scripted events: every line appended to the file goes to every subscriber.
  const eventsFile = process.env.STUB_OPENCODE_EVENTS_FILE;
  if (eventsFile) {
    let sent = 0;
    setInterval(() => {
      if (!existsSync(eventsFile)) return;
      const lines = readFileSync(eventsFile, 'utf8').split('\n').filter((line) => line.trim() !== '');
      for (; sent < lines.length; sent += 1) {
        if (lines[sent].includes('"stub":"drop"')) {
          for (const res of subscribers) res.destroy();
          subscribers.clear();
          continue;
        }
        history.push(lines[sent]);
        for (const res of subscribers) res.write(`data: ${lines[sent]}\n\n`);
      }
    }, 20);
  }
}

async function tui() {
  const server = flag('--server');
  const session = flag('-s', '--session');
  let infoStatus = null;
  try {
    const auth = `Basic ${Buffer.from(`opencode:${password ?? ''}`).toString('base64')}`;
    infoStatus = (await globalThis.fetch(`${server}/api/info`, { headers: { authorization: auth } })).status;
  } catch {
    infoStatus = 'unreachable';
  }
  if (process.env.STUB_OPENCODE_ARGS_FILE) {
    writeFileSync(process.env.STUB_OPENCODE_ARGS_FILE, JSON.stringify({
      argv,
      cwd: process.cwd(),
      server,
      session,
      passwordSet: typeof password === 'string' && password.length > 0,
      // A digest, so a test can tell two passwords apart without the secret on disk.
      passwordDigest: password ? createHash('sha256').update(password).digest('hex').slice(0, 16) : null,
      configSet: process.env.OPENCODE_CONFIG_CONTENT !== undefined,
      infoStatus,
      // The sessions the server knew when this TUI started (STUB_OPENCODE_SESSIONS_FILE).
      sessionsAtStart: process.env.STUB_OPENCODE_SESSIONS_FILE && existsSync(process.env.STUB_OPENCODE_SESSIONS_FILE)
        ? readFileSync(process.env.STUB_OPENCODE_SESSIONS_FILE, 'utf8').split('\n').filter(Boolean)
        : [],
    }));
  }
  record('tui', process.pid);
  if (infoStatus !== 200) {
    process.stderr.write(`Error: Server at ${server} rejected the password\n`);
    process.exit(1);
  }
  process.stdout.write(`OpenCode stub TUI, session ${session}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (line.trim() === 'STUB_EXIT') process.exit(0);
  });
}
