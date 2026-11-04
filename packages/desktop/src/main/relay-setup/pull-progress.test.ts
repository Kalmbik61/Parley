import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RelayPullProgress } from '../../shared/relay-setup-types.js';
import { shQuote } from './input.js';
import { createPullProgress, describeProgress, engineApiQuery, pullCommand } from './pull-progress.js';

const fixture = (name: string): string[] => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n');

function collect(stepMs: number) {
  let clock = 0;
  const events: RelayPullProgress[] = [];
  const log: string[] = [];
  const parser = createPullProgress({
    onProgress: (p) => events.push(p),
    onLog: (line) => log.push(line),
    now: () => (clock += stepMs),
  });
  return { parser, events, log };
}

describe('engineApiQuery', () => {
  it('a digest wins over the text tag: no empty and no text tag', () => {
    expect(engineApiQuery('caddy:2.11.7@sha256:' + 'a'.repeat(64))).toBe('fromImage=caddy&tag=sha256:' + 'a'.repeat(64));
    expect(engineApiQuery('ghcr.io/kalmbik61/parley-relay@sha256:' + 'b'.repeat(64))).toBe('fromImage=ghcr.io/kalmbik61/parley-relay&tag=sha256:' + 'b'.repeat(64));
  });

  it('a tag, or latest when there is none; a registry port is not a tag', () => {
    expect(engineApiQuery('parley-relay:stand')).toBe('fromImage=parley-relay&tag=stand');
    expect(engineApiQuery('busybox')).toBe('fromImage=busybox&tag=latest');
    expect(engineApiQuery('localhost:5000/relay')).toBe('fromImage=localhost:5000/relay&tag=latest');
    expect(engineApiQuery('localhost:5000/relay:1.2')).toBe('fromImage=localhost:5000/relay&tag=1.2');
    for (const ref of ['a', 'a:b', 'h:1/a', 'a@sha256:' + 'c'.repeat(64)]) expect(engineApiQuery(ref)).not.toMatch(/tag=(&|$)/);
  });
});

describe('createPullProgress: Engine API lines', () => {
  it('follows layers and bytes of a real stream and logs a summary instead of the JSON lines', () => {
    const { parser, events, log } = collect(300);
    for (const line of fixture('engine-pull-busybox.ndjson')) parser.feed(line);
    parser.finish();
    expect(events.find((p) => p.bytesDone === 1048576)).toEqual({ layersDone: 0, layersTotal: 1, bytesDone: 1048576, bytesTotal: 1896265 });
    expect(events.at(-1)).toEqual({ layersDone: 1, layersTotal: 1, bytesDone: 1896265, bytesTotal: 1896265 });
    expect(log.some((l) => l.startsWith('Status: Downloaded newer image for busybox'))).toBe(true);
    expect(log.join('\n')).not.toContain('{');
  });

  it('an extraction unit is not a byte count', () => {
    const { parser, events } = collect(300);
    parser.feed('{"status":"Pulling fs layer","progressDetail":{},"id":"821d9dafb26d"}');
    parser.feed('{"status":"Extracting","progressDetail":{"current":1,"units":"s"},"id":"821d9dafb26d"}');
    expect(events.at(-1)).toMatchObject({ bytesDone: null, bytesTotal: null });
  });

  it('an error line goes to the log whole', () => {
    const { parser, log } = collect(300);
    parser.feed('{"errorDetail":{"message":"denied"},"error":"denied: requested access to the resource is denied"}');
    parser.feed('{"message":"pull access denied for x, repository does not exist"}');
    expect(log).toEqual(['error: denied: requested access to the resource is denied', 'error: pull access denied for x, repository does not exist']);
  });

  it('unknown statuses, unknown fields and broken lines are tolerated', () => {
    const { parser, events, log } = collect(300);
    for (const line of ['', '{"status":"Brand new status","id":"821d9dafb26d","extra":[1]}', '{"status":', '[1,2]', '{"x":1}', '42']) parser.feed(line);
    parser.finish();
    expect(events).toEqual([]);
    expect(log).toEqual(['{"status":', '[1,2]', '42']);
  });

  it('events come at most 4 times per second; the last state is flushed by finish', () => {
    const { parser, events } = collect(10);
    parser.feed('{"status":"Pulling fs layer","id":"821d9dafb26d"}');
    for (let i = 1; i <= 20; i += 1) parser.feed(`{"status":"Downloading","progressDetail":{"current":${i},"total":100},"id":"821d9dafb26d"}`);
    expect(events.length).toBeLessThanOrEqual(2);
    parser.finish();
    expect(events.at(-1)?.bytesDone).toBe(20);
  });

  it('logs every 10 % and not on every line', () => {
    const { parser, log } = collect(300);
    parser.feed('{"status":"Pulling fs layer","id":"821d9dafb26d"}');
    for (let i = 1; i <= 100; i += 1) parser.feed(`{"status":"Downloading","progressDetail":{"current":${i},"total":100},"id":"821d9dafb26d"}`);
    parser.finish();
    const summaries = log.filter((l) => l.startsWith('downloading:'));
    expect(summaries.length).toBeGreaterThanOrEqual(9);
    expect(summaries.length).toBeLessThanOrEqual(11);
  });
});

describe('createPullProgress: docker pull output', () => {
  it('counts layers from the output of a real pull (no bytes)', () => {
    const { parser, events, log } = collect(300);
    for (const line of fixture('docker-pull-output.txt')) parser.feed(line);
    parser.finish();
    expect(events.at(-1)).toEqual({ layersDone: 8, layersTotal: 8, bytesDone: null, bytesTotal: null });
    expect(events.find((p) => p.layersDone === 2)).toBeDefined();
    expect(log.at(-1)).toMatch(/^Status: Downloaded newer image for ghcr\.io\/kalmbik61\/parley-relay@sha256:/);
    expect(log.some((l) => l.includes('Pull complete'))).toBe(false);
  });

  it('describeProgress: bytes when known, layers always', () => {
    expect(describeProgress({ layersDone: 3, layersTotal: 8, bytesDone: 41_200_000, bytesTotal: 82_000_000 })).toBe('41.2 of 82.0 MB · 3 of 8 layers');
    expect(describeProgress({ layersDone: 3, layersTotal: 8, bytesDone: null, bytesTotal: null })).toBe('3 of 8 layers');
  });
});

describe('pullCommand on a shell with stub curl and docker', () => {
  /** A real unix socket (so `[ -S ]` is true) and stubs for `curl` and `docker` on PATH. */
  async function bench(curlBody: string, inspectCode: number) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pull-'));
    const socket = path.join(dir, 's.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const calls = path.join(dir, 'calls');
    writeFileSync(path.join(dir, 'curl'), `#!/bin/sh\necho "curl $*" >> ${calls}\n${curlBody}\n`);
    writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\necho "docker $*" >> ${calls}\n[ "$1" = image ] && exit ${inspectCode}\nexit 0\n`);
    chmodSync(path.join(dir, 'curl'), 0o755);
    chmodSync(path.join(dir, 'docker'), 0o755);
    const run = (command: string): { code: number; out: string } => {
      try {
        const out = execFileSync('/bin/sh', ['-c', command], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8' });
        return { code: 0, out };
      } catch (error) {
        return { code: (error as { status: number }).status, out: '' };
      }
    };
    const log = (): string => { try { return readFileSync(calls, 'utf8'); } catch { return ''; } };
    return { socket, run, log, close: () => server.close() };
  }

  const ref = 'caddy:2.11.7@sha256:' + 'd'.repeat(64);

  it('uses the Engine API with the digest as tag, and the verdict is docker image inspect', async () => {
    const b = await bench('echo \'{"status":"Status: ok"}\'', 0);
    expect(b.run(pullCommand(ref, shQuote, b.socket)).code).toBe(0);
    expect(b.log()).toContain(`curl -sS --no-buffer --unix-socket ${b.socket} -X POST http://localhost/images/create?fromImage=caddy&tag=sha256:${'d'.repeat(64)}`);
    expect(b.log()).toContain('docker image inspect');
    expect(b.log()).not.toContain('docker pull');
    b.close();
  });

  it('an error inside a stream that curl delivered with exit 0 fails the step through docker image inspect', async () => {
    const b = await bench('echo \'{"error":"manifest unknown"}\'; exit 0', 1);
    expect(b.run(pullCommand(ref, shQuote, b.socket)).code).toBe(1);
    b.close();
  });

  it('without the socket it falls back to docker pull', async () => {
    const b = await bench('exit 0', 0);
    expect(b.run(pullCommand(ref, shQuote, path.join(path.dirname(b.socket), 'missing.sock'))).code).toBe(0);
    expect(b.log()).toContain(`docker pull ${ref}`);
    expect(b.log()).not.toContain('curl');
    b.close();
  });
});
