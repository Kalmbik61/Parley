import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBridge, type RunningBridge } from './bridge.js';
import { RemoteConfigError } from './config.js';
import { createLog } from './log.js';
import { BridgeAlreadyRunning, acquirePidLock, releasePidLock } from './pid-lock.js';

let home: string;
let started: RunningBridge[];
const pidFile = () => path.join(home, 'remote', 'bridge.pid');
const options = () => ({ home, host: { socketPath: path.join(home, 'host', 'host.sock'), tokenPath: path.join(home, 'host', 'host.token') } });

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'bs-'));
  mkdirSync(path.join(home, 'remote'), { recursive: true });
  started = [];
});
afterEach(async () => {
  for (const b of started) await b.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('single instance (critic wave 4, m1)', () => {
  it('two starts at once: exactly one wins, the other is refused and leaves the winner alone', async () => {
    const results = await Promise.allSettled([startBridge(options()), startBridge(options())]);
    const winners = results.filter((r): r is PromiseFulfilledResult<RunningBridge> => r.status === 'fulfilled');
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toBeInstanceOf(BridgeAlreadyRunning);
    started.push(winners[0]!.value);
    expect(readFileSync(pidFile(), 'utf8')).toBe(String(process.pid));
    expect(existsSync(path.join(home, 'remote', 'control.sock'))).toBe(true);
    await winners[0]!.value.stop();
    expect(existsSync(pidFile())).toBe(false);
  });

  it('a stale pid file of a dead process is reclaimed; garbage too', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
    writeFileSync(pidFile(), dead);
    const first = await startBridge(options());
    await first.stop();
    writeFileSync(pidFile(), 'not a pid');
    started.push(await startBridge(options()));
    expect(readFileSync(pidFile(), 'utf8')).toBe(String(process.pid));
  });

  it('release only removes our own lock', async () => {
    await acquirePidLock(pidFile(), 111_111, () => false);
    await releasePidLock(pidFile(), process.pid);
    expect(existsSync(pidFile())).toBe(true);
    await releasePidLock(pidFile(), 111_111);
    expect(existsSync(pidFile())).toBe(false);
  });
});

describe('remote.json errors are loud (critic wave 4, m4)', () => {
  it.each(['not a url', 'ftp://push.example.com', 'http://push.example.com', 'https://u:p@push.example.com', 'https://push.example.com/?x=1'])(
    'pushGatewayUrl %s refuses to start, names the field in bridge.log and frees the lock',
    async (pushGatewayUrl) => {
      writeFileSync(path.join(home, 'remote', 'remote.json'), JSON.stringify({ v: 1, relay: null, pushGatewayUrl }));
      const error = await startBridge(options()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RemoteConfigError);
      expect((error as RemoteConfigError).fields).toEqual(['pushGatewayUrl']);
      expect(readFileSync(path.join(home, 'remote', 'bridge.log'), 'utf8')).toContain('"event":"remote_json.invalid"');
      expect(readFileSync(path.join(home, 'remote', 'bridge.log'), 'utf8')).toContain('"fields":"pushGatewayUrl"');
      expect(existsSync(pidFile())).toBe(false);
    },
  );

  it('a gateway under a path keeps the path; a clean address starts', async () => {
    writeFileSync(path.join(home, 'remote', 'remote.json'), JSON.stringify({ v: 1, relay: null, pushGatewayUrl: 'https://push.example.com/parley/' }));
    started.push(await startBridge(options()));
  });
});

describe('bridge.log rotation (critic wave 4, m3)', () => {
  it('the log becomes one archive when it grows past the limit', () => {
    const file = path.join(home, 'remote', 'bridge.log');
    const log = createLog({ file, maxBytes: 600 });
    for (let i = 0; i < 12; i++) log.info('line', { n: i, pad: 'x'.repeat(40) });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, 'utf8').length).toBeLessThanOrEqual(600);
    expect(readFileSync(`${file}.1`, 'utf8').length).toBeLessThanOrEqual(600);
    expect(readFileSync(file, 'utf8')).toContain('"n":11');
  });
});

describe('light imports (critic wave 4, m2)', () => {
  it('loading the bridge modules prints no ExperimentalWarning (no node:sqlite via @parley/core)', () => {
    const dist = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
    const script = `const w=[];process.on('warning',x=>w.push(x.name));await import(${JSON.stringify(path.join(dist, 'bridge.js'))});await import(${JSON.stringify(path.join(dist, 'paths.js'))});await new Promise(r=>setTimeout(r,50));process.stdout.write(JSON.stringify(w))`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PARLEY_HOME: home } });
    expect(run.stderr.toString()).not.toContain('SQLite');
    expect(run.stdout.toString()).toBe('[]');
  });
});
