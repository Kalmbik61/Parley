/**
 * OpenCode sign-in hint (spec 2026-11-12 §4.12, DO2): the number of connected integrations that
 * `opencode auth list --format json --standalone` reports. It is a hint for the provider card, never a verdict.
 *
 * Secrets: the output is parsed in memory and dropped; it is never stored, logged or returned. Only a count leaves
 * this module. `auth export` prints secrets and is never run. `--standalone` keeps OpenCode from starting a background
 * service (mock lab FINDINGS 1). The process runs like the catalog probe: own process group, timeout, output cap.
 */

import { runOpencodeCli, type ProbeOptions } from './opencode-catalog.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Integrations with at least one connection (an env key or a stored credential); `null`: not the expected JSON array. */
export function parseOpencodeAuthCount(output: unknown): number | null {
  if (typeof output !== 'string') return null;
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  return data.filter((entry) => isRecord(entry) && Array.isArray(entry['connections']) && entry['connections'].length > 0).length;
}

/** `null`: the probe failed or printed something else, so the card shows no number. */
export async function probeOpencodeAuthCount(command: string, options: ProbeOptions = {}): Promise<number | null> {
  return parseOpencodeAuthCount(await runOpencodeCli(command, ['auth', 'list', '--format', 'json', '--standalone'], options));
}

/** One probe: the number of connected integrations; `null` is any failure. */
export type OpencodeAuthProbe = (command: string) => Promise<number | null>;

export interface OpencodeAuthHint {
  /** The last good count; `null` until there is one or after a failed probe. */
  current(): number | null;
  /** The count is older than the age and no probe runs: a new probe in the background. `providers.list` does not wait for it. */
  refreshIfStale(): void;
  /** Probe now (one at a time). Never rejects. */
  refresh(): Promise<void>;
}

export const OPENCODE_AUTH_MAX_AGE_MS = 30_000;

/**
 * The hint behind the OpenCode card. Only the count is kept, in memory; `onChange` fires when it changes, so the window
 * reloads the card after the person signs in inside OpenCode. No probe at start: the card asks (`refreshIfStale`) when it is
 * shown for an installed OpenCode 2.x.
 */
export function startOpencodeAuthHint(
  probe: OpencodeAuthProbe | undefined,
  onChange: () => void,
  options: { command?: string; maxAgeMs?: number; now?: () => number } = {},
): OpencodeAuthHint {
  const maxAgeMs = options.maxAgeMs ?? OPENCODE_AUTH_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  let count: number | null = null;
  let probedAt = 0;
  let asked = false;
  let inflight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (probe === undefined) return Promise.resolve();
    if (inflight === null) {
      probedAt = now();
      asked = true;
      const current: Promise<void> = probe(options.command ?? 'opencode')
        .catch(() => null)
        .then((next) => {
          if (next === count) return;
          count = next;
          onChange();
        })
        .finally(() => {
          if (inflight === current) inflight = null;
        });
      inflight = current;
    }
    return inflight;
  };

  return {
    current: () => count,
    refreshIfStale() {
      if (probe === undefined || inflight !== null || (asked && now() - probedAt < maxAgeMs)) return;
      void refresh();
    },
    refresh,
  };
}
