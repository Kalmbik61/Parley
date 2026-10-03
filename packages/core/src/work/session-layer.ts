import { execFile } from 'node:child_process';
import { truncateMarked, type LayerWarning } from './parley-md.js';
import { validMemoryText, validateMemoryProvenance, type MemoryItem } from './project-memory.js';

export const SESSION_ARGUMENT_MAX_BYTES = 98304;
export const MEMORY_MAX_BYTES = 12288;
export interface MemoryLayerWarning { code: 'memory-truncated' | 'memory-unreadable'; message: string }
export type SessionLayerWarning = LayerWarning | MemoryLayerWarning;
export const MEMORY_TRUNCATION_MARKER = '[Project memory is cut at 12 KiB; clean up memory.md to include the remaining facts.]';
const SPAWN_RESERVE_BYTES = 32768;

export interface SessionLayerInput {
  guidance: string;
  bridge?: string;
  role?: string;
  /** Native Claude roles use --agent; their prompt must not be duplicated. */
  nativeClaudeRole?: boolean;
  playbook?: string;
  isLead?: boolean;
  brief?: string;
  /** Already preprocessed by processParleyMd. */
  parleyMd?: string;
  memoryFacts?: string;
  /** Current parsed main-project phrases; formatter never includes details or local history. */
  memoryItems?: readonly MemoryItem[];
}

export type LayerBlockBytes = Record<
  'guidance' | 'bridge' | 'role' | 'playbook' | 'brief' | 'parleyMd' | 'memoryFacts',
  number
>;
export interface SessionLayer {
  text: string;
  warnings: SessionLayerWarning[];
  blockBytes: LayerBlockBytes;
}

export class SessionLayerTooLargeError extends Error {
  readonly code = 'session-layer-too-large';
  constructor(
    readonly details: {
      argumentBytes?: number;
      memoryBytes?: number;
      blockBytes?: LayerBlockBytes;
    },
  ) {
    super('session-layer-too-large: shorten the session rules or context before launching.');
    this.name = 'SessionLayerTooLargeError';
  }
}

/** UTF-8 bound includes header/sections/marker, and never splits a phrase or Unicode scalar. */
export function formatMemoryFactBlock(items: readonly MemoryItem[]): { text: string; truncated: boolean } {
  if (items.length > 10000) throw new Error('memory-invalid');
  for (const item of items) {
    if ((item.id !== null && (typeof item.id !== 'string' || !/^m-\d{3,}$/.test(item.id))) ||
        !['fact', 'lesson', 'agreement'].includes(item.kind) || !validMemoryText(item.fact, 1024 * 1024) || /[\r\n]/.test(item.fact)) throw new Error('memory-invalid');
    if (item.provenance !== undefined) validateMemoryProvenance(item.provenance);
  }
  const current = items.filter(item => item.state !== 'superseded' && item.provenance?.state !== 'superseded');
  if (!current.length) return { text: '', truncated: false };
  const lines = ['Project memory (.parley/memory.md):', 'Current human instructions and task constraints take precedence over memory claims.'];
  for (const [kind, title] of [['fact', 'Facts'], ['lesson', 'Lessons'], ['agreement', 'Agreements']] as const) {
    const rows = current.filter(item => item.kind === kind);
    if (!rows.length) continue;
    lines.push(`## ${title}`);
    for (const item of rows) {
      const provenance = item.provenance;
      const origin = provenance?.origin === 'human' ? 'human-authored' : provenance?.origin === 'agent' || item.by ? 'unverified agent claim' : item.human ? 'human authorship recorded' : 'source unverified';
      const labels = [origin, ...(provenance?.acceptedByHuman ? ['accepted by human'] : []),
        ...(provenance?.factAmendedByHuman || item.factAmendedByHuman ? ['current human fact amendment'] : provenance?.amendedByHuman || item.amendedByHuman ? ['details/state amended by human'] : []),
        ...(provenance?.claimedHumanRequest || item.onHumanRequest ? ['human request claimed'] : []),
        ...(provenance?.completeness === 'partial' ? ['partial'] : []),
        ...(provenance?.taskRevision === undefined ? [] : [`source task revision ${provenance.taskRevision}`])];
      lines.push(`- [${item.id ?? 'no-id'}] [${labels.join('; ')}] ${item.fact}`);
    }
  }
  const full = lines.join('\n');
  if (Buffer.byteLength(full, 'utf8') <= MEMORY_MAX_BYTES) return { text: full, truncated: false };
  const kept: string[] = [];
  for (const line of lines) {
    const candidate = [...kept, line, MEMORY_TRUNCATION_MARKER].join('\n');
    if (Buffer.byteLength(candidate, 'utf8') > MEMORY_MAX_BYTES) break;
    kept.push(line);
  }
  return { text: [...kept, MEMORY_TRUNCATION_MARKER].join('\n'), truncated: true };
}

export function buildSessionLayer(input: SessionLayerInput): SessionLayer {
  const warnings: SessionLayerWarning[] = [];
  const role = truncateMarked(
    input.nativeClaudeRole ? '' : (input.role ?? ''),
    '[Role is cut at 32 KB by Parley]',
  );
  const playbook = truncateMarked(
    input.isLead === true ? (input.playbook ?? '') : '',
    '[Playbook is cut at 32 KB by Parley]',
  );
  if (role.truncated)
    warnings.push({
      code: 'role-truncated',
      message: 'Parley cut the role text at 32 KB; shorten the role to include the remainder.',
    });
  if (playbook.truncated)
    warnings.push({
      code: 'recipe-playbook-truncated',
      message:
        'Parley cut the recipe playbook at 32 KB; shorten the playbook to include the remainder.',
    });
  const memory = input.memoryItems === undefined ? null : formatMemoryFactBlock(input.memoryItems);
  if (memory?.truncated) warnings.push({ code: 'memory-truncated', message: 'Parley cut project memory at 12 KiB; clean up memory.md to include the remaining facts.' });
  const parts = {
    guidance: input.guidance,
    bridge: input.bridge ?? '',
    role: role.text,
    playbook: playbook.text,
    brief: input.brief ?? '',
    parleyMd: input.parleyMd ?? '',
    memoryFacts: memory?.text ?? input.memoryFacts ?? '',
  };
  const blockBytes = Object.fromEntries(
    Object.entries(parts).map(([key, value]) => [key, Buffer.byteLength(value, 'utf8')]),
  ) as LayerBlockBytes;
  if (blockBytes.memoryFacts > MEMORY_MAX_BYTES)
    throw new SessionLayerTooLargeError({ memoryBytes: blockBytes.memoryFacts, blockBytes });
  const text = [
    parts.guidance,
    parts.bridge,
    parts.role,
    parts.playbook,
    parts.brief,
    parts.parleyMd.trim() === ''
      ? ''
      : `Team rules of this project (PARLEY.md):\n${parts.parleyMd}`,
    parts.memoryFacts,
  ]
    .filter((part) => part.trim() !== '')
    .join('\n\n');
  return { text, warnings, blockBytes };
}

export function developerInstructions(text: string): string {
  // JSON.stringify escapes lone surrogates, but TOML requires Unicode scalars.
  if (/[\uD800-\uDFFF]/u.test(text)) throw new SpawnBudgetError('spawn-budget-invalid');
  // TOML also forbids raw DEL, which JSON.stringify leaves unescaped.
  return `developer_instructions=${JSON.stringify(text).replace(/\u007f/g, '\\u007f')}`;
}

/** Validate actual substituted arguments, including the serialized Codex key. */
export function validateLayerArguments(
  args: readonly string[],
  blockBytes?: LayerBlockBytes,
  systemLayerArgument?: string,
): void {
  for (const [index, arg] of args.entries()) {
    if (arg.includes('\0')) throw new SpawnBudgetError('spawn-budget-invalid');
    const argumentBytes = Buffer.byteLength(arg, 'utf8');
    if (argumentBytes <= SESSION_ARGUMENT_MAX_BYTES) continue;
    if (
      arg === systemLayerArgument ||
      arg.startsWith('developer_instructions=') ||
      args[index - 1] === '--append-system-prompt'
    ) {
      throw new SessionLayerTooLargeError({
        argumentBytes,
        ...(blockBytes === undefined ? {} : { blockBytes }),
      });
    }
    throw new SpawnBudgetError('spawn-budget-too-large', { argumentBytes });
  }
}

export interface SpawnLimits {
  argMax: number;
  pointerSize: number;
  /** Linux MAX_ARG_STRLEN including its terminating NUL. */
  maxStringBytes?: number;
}
export interface SpawnBudget {
  stringBytes: number;
  pointerBytes: number;
  estimatedBytes: number;
}
export type SpawnBudgetCode =
  'spawn-budget-too-large' | 'spawn-budget-invalid' | 'spawn-budget-unavailable';
export class SpawnBudgetError extends Error {
  constructor(
    readonly code: SpawnBudgetCode,
    readonly details: Record<string, number> = {},
  ) {
    super(`${code}: the process arguments or environment cannot be launched safely.`);
    this.name = 'SpawnBudgetError';
  }
}

export function validateSpawnBudget(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  limits: SpawnLimits | null,
): SpawnBudget {
  if (
    limits === null ||
    !Number.isSafeInteger(limits.argMax) ||
    limits.argMax <= SPAWN_RESERVE_BYTES ||
    ![4, 8].includes(limits.pointerSize) ||
    (limits.maxStringBytes !== undefined &&
      (!Number.isSafeInteger(limits.maxStringBytes) || limits.maxStringBytes <= 0))
  ) {
    throw new SpawnBudgetError('spawn-budget-unavailable');
  }
  validateLayerArguments(args);
  const argv = [command, ...args];
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (
    argv.some((value) => value.includes('\0')) ||
    entries.some(([key, value]) => key.includes('\0') || key.includes('=') || value.includes('\0'))
  ) {
    throw new SpawnBudgetError('spawn-budget-invalid');
  }
  const strings = [...argv, ...entries.map(([key, value]) => `${key}=${value}`)];
  const lengths = strings.map((value) => Buffer.byteLength(value, 'utf8') + 1);
  const largestStringBytes = lengths.reduce((largest, length) => Math.max(largest, length), 0);
  if (limits.maxStringBytes !== undefined && largestStringBytes > limits.maxStringBytes) {
    throw new SpawnBudgetError('spawn-budget-too-large', {
      largestStringBytes,
      maxStringBytes: limits.maxStringBytes,
    });
  }
  const stringBytes = lengths.reduce((total, length) => total + length, 0);
  const pointerBytes = limits.pointerSize * (argv.length + entries.length + 2);
  const estimatedBytes = stringBytes + pointerBytes + SPAWN_RESERVE_BYTES;
  if (estimatedBytes > limits.argMax)
    throw new SpawnBudgetError('spawn-budget-too-large', {
      stringBytes,
      pointerBytes,
      estimatedBytes,
      argMax: limits.argMax,
    });
  return { stringBytes, pointerBytes, estimatedBytes };
}

interface SpawnLimitQuery {
  platform?: NodeJS.Platform;
  pointerSize?: number;
  getconf?: (name: string) => Promise<number | null>;
}

function getconf(name: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/getconf',
      [name],
      { timeout: 1000, maxBuffer: 128, env: { PATH: '/usr/bin:/bin' } },
      (error, stdout) => {
        if (error !== null || !/^\s*\d+\s*$/.test(stdout)) {
          resolve(null);
          return;
        }
        const value = Number(stdout.trim());
        resolve(Number.isSafeInteger(value) && value > 0 ? value : null);
      },
    );
  });
}

/** Query the current runtime; missing native limits never become guessed success. */
export async function querySpawnLimits(options: SpawnLimitQuery = {}): Promise<SpawnLimits | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const query = options.getconf ?? getconf;
  const pointerSize =
    options.pointerSize ?? (process.arch === 'ia32' || process.arch === 'arm' ? 4 : 8);
  try {
    const argMax = await query('ARG_MAX');
    if (argMax === null || !Number.isSafeInteger(argMax) || argMax <= SPAWN_RESERVE_BYTES)
      return null;
    if (platform === 'darwin') return { argMax, pointerSize };
    const pageSize = await query('PAGESIZE');
    if (
      pageSize === null ||
      !Number.isSafeInteger(pageSize) ||
      pageSize <= 0 ||
      !Number.isSafeInteger(pageSize * 32)
    )
      return null;
    return { argMax, pointerSize, maxStringBytes: pageSize * 32 };
  } catch {
    return null;
  }
}
