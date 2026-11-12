/**
 * OpenCode model catalog from the CLI itself (spec 2026-11-12 §4.7, task O11): `opencode models` prints one
 * `provider/model` per line, works offline and needs no sign-in (spike §12). The probe runs at host start, in the
 * background, when `providers.list` finds the catalog older than six hours, and after sign-in. A new list atomically
 * rewrites Parley's file `opencode-models.json` (`opencodeModelsFile` in core; `loadProviders` reads it) and calls `onChange`; a failed probe leaves the file alone. One probe at a time, and nothing waits on it.
 *
 * Secrets: Parley opens no file except its own temporary `cwd` and the catalog file, and passes the CLI no key, no
 * auth path and no server password. The CLI reads its own state as in any session a human starts. What runs is what is on
 * PATH (or the override `PARLEY_OPENCODE_BIN`).
 *
 * The probe process leads its own process group; in `finally` the group gets SIGTERM and, after `killGraceMs`, SIGKILL.
 * `--standalone` is always passed: without it OpenCode starts a detached background service that writes its password to
 * `XDG_CONFIG_HOME/opencode/service.json` (mock lab FINDINGS 1). `models` takes no other flags.
 * Effort is `null` for every model: the variants (`#high`) come only from `GET /api/model` (FINDINGS 4).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commandBinary, MODEL_LABEL_MAX, opencodeModelsFile, type ModelOption } from '@parley/core';
import type { Log } from '../log.js';

/** One probe: the stdout of `opencode models`; `null` is any failure. */
export type OpencodeModelsProbe = (command: string) => Promise<string | null>;

export interface OpencodeCatalog {
  /** First probe finished, successfully or not; never rejects. */
  ready: Promise<void>;
  /** Models of the last good probe in CLI order; `null` until there is one. */
  current(): ModelOption[] | null;
  /** Catalog older than the age and no probe running: a new probe in the background. */
  refreshIfStale(): void;
  /** Probe now: a running one is shared, else a new one starts. Never rejects. */
  refresh(): Promise<void>;
}

export const OPENCODE_CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const OPENCODE_CATALOG_TIMEOUT_MS = 10_000;
export const OPENCODE_CATALOG_MAX_BYTES = 1024 * 1024;
export const OPENCODE_PROBE_KILL_GRACE_MS = 2000;
const OPENCODE_COMMAND = 'opencode';

/** `provider/model`: no spaces, no `#` (a variant is not a model), the provider is the part before the first slash. */
const MODEL_LINE = /^[^\s/#]+\/[^\s#]+$/;
const MODEL_ID_MAX_LENGTH = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Models from the output of `opencode models`: blank lines skipped, repeats and lines of another shape dropped. `null`: none. */
export function parseOpencodeModels(output: unknown, log?: Pick<Log, 'warn'>): ModelOption[] | null {
  if (typeof output !== 'string') return null;
  const models: ModelOption[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const id = raw.trim();
    if (id === '') continue;
    if (id.length <= MODEL_ID_MAX_LENGTH && MODEL_LINE.test(id) && !models.some((known) => known.id === id)) {
      models.push({ id, label: id.slice(0, MODEL_LABEL_MAX), efforts: null });
      continue;
    }
    log?.warn('OpenCode catalog line skipped: not provider/model or a repeat');
  }
  return models.length === 0 ? null : models;
}

async function storedModels(file: string): Promise<unknown> {
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isRecord(data) ? (data['models'] ?? null) : null;
  } catch {
    return null;
  }
}

/** Atomic write: a temporary file beside it and `rename`; a reader sees the old or the new one. A failure keeps the old file. */
async function writeCatalog(file: string, models: ModelOption[], at: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ fetchedAt: new Date(at).toISOString(), models }, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Starts the catalog: the first probe at once, in the background. Without a probe (`undefined`: tests,
 * `PARLEY_SKIP_VERSION_PROBE`) nothing runs. A list that differs from the file rewrites it and calls `onChange`.
 * The age counts from the start of the last probe.
 */
export function startOpencodeCatalog(
  probe: OpencodeModelsProbe | undefined,
  log: Log,
  onChange: () => void,
  options: { file?: string; command?: string; maxAgeMs?: number; now?: () => number } = {},
): OpencodeCatalog {
  const maxAgeMs = options.maxAgeMs ?? OPENCODE_CATALOG_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  // The home is known at host start: the file does not move even if the environment changes later.
  const file = options.file ?? opencodeModelsFile();
  let models: ModelOption[] | null = null;
  let written: string | undefined;
  let probedAt = 0;
  let inflight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    if (probe === undefined) return;
    probedAt = now();
    try {
      const raw = await probe(options.command ?? OPENCODE_COMMAND).catch(() => null);
      const next = raw === null ? null : parseOpencodeModels(raw, log);
      if (next === null) {
        log.info('OpenCode catalog not received: the probe failed or listed no models');
        return;
      }
      models = next;
      written ??= JSON.stringify(await storedModels(file));
      const text = JSON.stringify(next);
      if (text === written) return;
      await writeCatalog(file, next, now());
      written = text;
      onChange();
    } catch (error) {
      log.error('OpenCode catalog not written', { error: String(error) });
    }
  };

  const refresh = (): Promise<void> => {
    if (probe === undefined) return Promise.resolve();
    if (inflight === null) {
      const current: Promise<void> = run().finally(() => {
        if (inflight === current) inflight = null;
      });
      inflight = current;
    }
    return inflight;
  };

  return {
    ready: refresh(),
    current: () => models,
    refreshIfStale() {
      if (probe === undefined || inflight !== null || now() - probedAt < maxAgeMs) return;
      void refresh();
    },
    refresh,
  };
}

export interface ProbeOptions {
  timeoutMs?: number;
  maxBytes?: number;
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Where the temporary `cwd` is made; the system directory by default. */
  tmpRoot?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitGroupGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= until) return false;
    await sleep(25);
  }
  return true;
}

/** End of a probe: SIGTERM to the group, SIGKILL after `graceMs`, pipes destroyed. Never throws. */
async function stopGroup(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (pid !== undefined) {
    signalGroup(pid, 'SIGTERM');
    if (!(await waitGroupGone(pid, graceMs))) {
      signalGroup(pid, 'SIGKILL');
      await waitGroupGone(pid, 1000);
    }
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

/** Collects stdout until the process exits with code 0; a timeout, an overflow, a non-zero exit or an error gives `null`. */
function collect(child: ChildProcess, timeoutMs: number, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    let received = 0;
    const chunks: Buffer[] = [];
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.once('error', () => finish(null));
    child.stdin?.on('error', () => {});
    child.stderr?.on('data', () => {});
    child.stdout?.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) return finish(null);
      chunks.push(chunk);
    });
    // `close` comes after stdout has ended, so the whole output is in.
    child.once('close', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : null));
  });
}

/**
 * Runs `<command> <args>` as the leader of its own process group, in an empty temporary `cwd`, and returns its stdout.
 * Never throws: any failure is `null`. The process and the temporary directory are always cleaned up, in `finally`.
 * Shared by the catalog probe and the sign-in hint (`opencode-auth-hint.ts`).
 */
export async function runOpencodeCli(command: string, args: string[], options: ProbeOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  let cwd: string;
  try {
    cwd = await mkdtemp(path.join(options.tmpRoot ?? tmpdir(), 'parley-opencode-probe-'));
  } catch {
    return null;
  }
  let child: ChildProcess | undefined;
  try {
    child = spawn(commandBinary(command, env), args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return await collect(child, options.timeoutMs ?? OPENCODE_CATALOG_TIMEOUT_MS, options.maxBytes ?? OPENCODE_CATALOG_MAX_BYTES);
  } catch {
    return null;
  } finally {
    if (child !== undefined) await stopGroup(child, options.killGraceMs ?? OPENCODE_PROBE_KILL_GRACE_MS);
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

/** The real catalog probe: `<command> models --standalone`. */
export const probeOpencodeModels = (command: string, options: ProbeOptions = {}): Promise<string | null> =>
  runOpencodeCli(command, ['models', '--standalone'], options);
