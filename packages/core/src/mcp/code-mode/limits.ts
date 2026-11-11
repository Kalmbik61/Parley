// Code Mode run limits (plan T4b, design §6). Parent-only: the sandboxed helper never imports this module.
//
// Every limit has a fixed maximum. A caller may only LOWER a limit; a raise, an unknown key, a non-integer, NaN, a
// getter or any other non-plain-JSON override is refused, never clamped. The resolved limits are an owned, frozen
// snapshot taken synchronously, so nothing the caller does afterwards changes a run.

import { type GuestLimits, PHYSICAL_MAXIMA } from './guest.js';
import { StrictJsonError, freezeJson } from './validation.js';

export interface RunLimits {
  /** Script size, UTF-8 bytes. */
  readonly codeBytes: number;
  /** Cumulative guest interpreter time; awaited host I/O does not count. */
  readonly activeMs: number;
  /** Total run wall from admission: preflights, launch probe, self-test, parent validation and every await. */
  readonly wallMs: number;
  /** Hard WASM linear-memory maximum. */
  readonly memoryBytes: number;
  /** Guest stack. */
  readonly stackBytes: number;
  /** Soft helper RSS limit (sampled; not a hard process cap). */
  readonly rssSoftKb: number;
  /** Calls admitted per run (refused ones count too). */
  readonly maxRpcs: number;
  /** Calls dispatched to the host and not yet settled. */
  readonly maxInFlight: number;
  /** Arguments of one call, UTF-8 bytes of the validated text. */
  readonly argBytes: number;
  /** All host responses of a run together, UTF-8 bytes. */
  readonly responseBytes: number;
  /** The final value, UTF-8 bytes of its JSON text. */
  readonly resultBytes: number;
  /** Opt-in guest logs; 0 means logs are off (the default). */
  readonly logBytes: number;
}

/** Design §6 starting limits; they are also the maxima. */
export const RUN_LIMITS: RunLimits = Object.freeze({
  codeBytes: 32 * 1024,
  activeMs: 1000,
  wallMs: 30_000,
  memoryBytes: PHYSICAL_MAXIMA.memoryBytes,
  stackBytes: PHYSICAL_MAXIMA.stackBytes,
  rssSoftKb: 256 * 1024,
  maxRpcs: 32,
  maxInFlight: 2,
  argBytes: 64 * 1024,
  responseBytes: 1024 * 1024,
  resultBytes: 16 * 1024,
  logBytes: 0,
});

/** The documented future ceiling for opt-in logs; logs are not supported now and any logBytes > 0 is refused. */
export const LOG_BYTES_MAX = 4 * 1024;

const KEYS = Object.keys(RUN_LIMITS) as (keyof RunLimits)[];
const PAGE = 65536;
const OVERRIDE_LIMITS = Object.freeze({ maxBytes: 4096, maxDepth: 2, maxNodes: 64 });

export type LimitsResolution = { readonly ok: true; readonly limits: RunLimits } | { readonly ok: false; readonly problem: string };

/**
 * The run limits for `overrides` (undefined: the defaults). Each override must be a known key holding a positive safe
 * integer no greater than its maximum (logBytes may be 0 and at most 4 KiB); memory must be whole WASM pages and at
 * least 16 MiB. The override object is first copied as strict plain JSON, so accessors and proxies never run twice.
 */
export function resolveRunLimits(overrides?: unknown): LimitsResolution {
  if (overrides === undefined) return { ok: true, limits: RUN_LIMITS };
  let copy: Record<string, unknown>;
  try {
    const owned = freezeJson(overrides, OVERRIDE_LIMITS).value;
    if (typeof owned !== 'object' || owned === null || Array.isArray(owned)) return { ok: false, problem: 'limits must be an object' };
    copy = owned as Record<string, unknown>;
  } catch (e) {
    return { ok: false, problem: `limits are not plain JSON (${e instanceof StrictJsonError ? e.code : 'error'})` };
  }
  const out: Record<string, number> = { ...RUN_LIMITS };
  for (const [key, value] of Object.entries(copy)) {
    if (!(KEYS as string[]).includes(key)) return { ok: false, problem: `unknown limit ${key}` };
    const k = key as keyof RunLimits;
    // Logs are not supported (decision m-4156): no opt-in channel exists, so any logBytes above 0 is refused.
    if (k === 'logBytes' && value !== 0) return { ok: false, problem: 'logs are not supported (logBytes must be 0)' };
    const max = k === 'logBytes' ? 0 : RUN_LIMITS[k];
    const min = k === 'logBytes' ? 0 : 1;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return { ok: false, problem: `${k} must be ${min === 0 ? 'a non-negative' : 'a positive'} safe integer` };
    if (value > max) return { ok: false, problem: `${k} above its maximum ${max}` };
    out[k] = value;
  }
  if (out.memoryBytes! % PAGE !== 0 || out.memoryBytes! < 256 * PAGE) return { ok: false, problem: 'memoryBytes must be whole WASM pages and at least 16 MiB' };
  return { ok: true, limits: Object.freeze(out as unknown as RunLimits) };
}

/** The guest's share of the run limits; `wallMs` is the wall left when the script is sent. */
export function guestLimitsFor(limits: RunLimits, wallLeftMs: number): GuestLimits {
  return Object.freeze({
    codeBytes: limits.codeBytes,
    activeMs: limits.activeMs,
    wallMs: Math.max(1, Math.floor(wallLeftMs)),
    memoryBytes: limits.memoryBytes,
    stackBytes: limits.stackBytes,
    maxRpcs: limits.maxRpcs,
    maxInFlight: limits.maxInFlight,
    argBytes: limits.argBytes,
    responseBytes: limits.responseBytes,
    resultBytes: limits.resultBytes,
  });
}
