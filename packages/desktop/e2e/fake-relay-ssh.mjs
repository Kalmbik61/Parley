// A scripted server for the relay setup window e2e (`PARLEY_RELAY_SETUP_FAKE_SSH`, spec 10): the real wizard service runs
// against it instead of `ssh2`. The probe is answered with the fixtures of the course VPS (a Caddy of the person in
// Docker with an import directory, a manual relay file of the previous run), the image step streams Engine API JSON
// slowly, the start step is held until the test creates the file named by `PARLEY_RELAY_SETUP_FAKE_RELEASE`.
// Every command it does not know is appended to `PARLEY_RELAY_SETUP_FAKE_LOG` and answered with exit code 1.
import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/main/relay-setup/fixtures/course-vps');
const read = (name) => readFileSync(path.join(fixtures, name), 'utf8');
const releaseFile = process.env['PARLEY_RELAY_SETUP_FAKE_RELEASE'];
const logFile = process.env['PARLEY_RELAY_SETUP_FAKE_LOG'];
const note = (text) => {
  if (logFile !== undefined) appendFileSync(logFile, `${text}\n`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEY = { type: 'ssh-ed25519', fingerprint: `SHA256:${'k'.repeat(43)}` };
const CADDY_ID = 'c1'.repeat(32);
const FILES = {
  '/opt/course-platform/deploy/Caddyfile': 'Caddyfile',
  '/opt/evdev-site/caddy/parley-relay.caddy': 'parley-relay.caddy',
};

/** What the «server» remembers between runs. */
const server = { imagePulled: false, started: false, webDone: false, killed: false };

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (code = 1) => ({ code, stdout: '', stderr: '' });

/** `[sudo …] sh -c '<command>'` as `createShell` builds it → the command. */
function unwrap(line) {
  const match = /^(?:sudo -n |sudo -S -p '' )?sh -c '(.*)'$/s.exec(line);
  if (match === null) return line;
  return match[1].replace(/'\\''/g, "'").replace(/^exec <\/dev\/null; /, '');
}

const LAYERS = [
  { id: '4f4fb700ef54', total: 31_400_000 },
  { id: '7c06d09d8244', total: 18_900_000 },
  { id: '45f0829a46db', total: 9_200_000 },
  { id: 'eae0290468fa', total: 14_700_000 },
  { id: '5e9b4a97f639', total: 7_800_000 },
];

async function streamImage(onLine) {
  const send = (value) => onLine?.(JSON.stringify(value));
  send({ status: 'Pulling from kalmbik61/parley-relay', id: 'sha256:aaaaaaaa' });
  for (const layer of LAYERS) send({ status: 'Pulling fs layer', progressDetail: {}, id: layer.id });
  const steps = 14;
  for (let tick = 1; tick <= steps; tick += 1) {
    if (server.killed) return 143;
    for (const [index, layer] of LAYERS.entries()) {
      // The layers finish one after another; each tick moves the ones still going.
      const finishedAt = 6 + index * 2;
      const share = Math.min(1, tick / finishedAt);
      send({ status: 'Downloading', progressDetail: { current: Math.round(layer.total * share), total: layer.total }, id: layer.id });
      if (share === 1 && tick === finishedAt) send({ status: 'Pull complete', progressDetail: {}, id: layer.id });
    }
    await sleep(600);
  }
  send({ status: 'Digest: sha256:' + 'a'.repeat(64) });
  send({ status: 'Status: Downloaded newer image for ghcr.io/kalmbik61/parley-relay' });
  server.imagePulled = true;
  return 0;
}

async function holdStart(onLine) {
  onLine?.(' Container parley-relay-relay-1  Recreate');
  while (releaseFile === undefined || !existsSync(releaseFile)) {
    if (server.killed) return 143;
    await sleep(100);
  }
  onLine?.(' Container parley-relay-relay-1  Started');
  server.started = true;
  return 0;
}

async function exec(line, options) {
  const command = unwrap(line);
  if (command.includes('setsid flock')) {
    if (command.includes('images/create')) return { code: await streamImage(options.onLine), stdout: '', stderr: '' };
    if (command.includes('--quiet-pull')) return { code: await holdStart(options.onLine), stdout: '', stderr: '' };
    options.onLine?.('ok');
    await sleep(300);
    server.webDone = true;
    return ok();
  }
  if (command.includes('kill -s TERM')) {
    // The test asserts on this line: a cancel that reaches the server must leave a trace.
    note(`kill: ${command.slice(0, 80)}`);
    server.killed = true;
    await sleep(50);
    server.killed = false;
    return ok();
  }
  if (command === 'cat /etc/os-release') return ok('ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n');
  if (command === 'uname -m') return ok('x86_64\n');
  if (command === 'id -u') return ok('0\n');
  if (command === 'ss -ltnp') return ok(read('ss-ltnp.txt'));
  if (command === 'ufw status') return fail();
  if (command === 'docker --version') return ok('Docker version 27.3.1, build ce12230\n');
  if (command === 'docker compose version') return ok('Docker Compose version v2.29.7\n');
  if (command.startsWith('docker ps -aq | xargs')) return ok(read('containers.jsonl'));
  if (command === 'cat /opt/parley-relay/.env') return ok(read('env.txt'));
  if (command === 'cat /opt/parley-relay/previous/.env') return ok(read('previous-env.txt'));
  if (command === `docker exec '${CADDY_ID}' caddy version`) return ok('v2.11.4 h1:abc\n');
  if (command.startsWith('docker exec ') && (command.endsWith(' caddy version') || command.endsWith(' nginx -v'))) return fail();
  if (command.startsWith('systemctl is-active')) return { code: 3, stdout: 'inactive\ninactive\ninactive\ninactive\n', stderr: '' };
  const file = /^base64 -w0 '(.*)'$/.exec(command);
  if (file !== null) {
    const name = FILES[file[1]];
    return name === undefined ? fail() : ok(Buffer.from(read(name), 'utf8').toString('base64'));
  }
  if (command.startsWith('[ ! -d /var/lib/parley-relay-setup ]')) return ok();
  if (command.startsWith('cat /var/lib/parley-relay-setup/active')) return fail();
  // Checks of the plan: «already done» once the step has run.
  if (command.startsWith('docker --version && ') || command.startsWith('test -d ') || command.startsWith('cd /opt/parley-relay && printf')) return ok();
  if (command.startsWith('docker image inspect ')) return server.imagePulled ? ok() : fail();
  if (command.includes('ps --status running --services')) return server.started ? ok() : fail();
  // The check of the `web` step (the edit of the person's Caddy is in place).
  if (command.includes('sha256sum') && command.includes('2019/config')) return server.webDone ? ok() : fail();
  note(`unknown: ${command.slice(0, 300)}`);
  return fail();
}

const connection = {
  exec,
  close: () => undefined,
};

export async function connect(request, knownHosts) {
  const verdict = await knownHosts.verdict(request.host, request.port, KEY);
  if (verdict.kind === 'changed') return { kind: 'hostkey-changed', key: KEY, known: verdict.known };
  if (verdict.kind === 'unknown' && request.trusted !== KEY.fingerprint) return { kind: 'hostkey-unknown', key: KEY };
  return { kind: 'ok', connection };
}

export const health = async () => ({ status: 200 });
export const healthAttempts = 1;
export const healthDelayMs = 0;
export const resolver = { resolve4: async () => ['82.146.37.224'], resolve6: async () => [] };
export const image = { ref: `ghcr.io/kalmbik61/parley-relay@sha256:${'a'.repeat(64)}`, published: true };
export const configureBridge = async () => undefined;
