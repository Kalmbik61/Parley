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
