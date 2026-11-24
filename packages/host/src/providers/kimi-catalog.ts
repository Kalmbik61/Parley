/** Kimi's local CLI catalog. Only sanitized model metadata crosses the probe boundary. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EFFORT_TOKEN,
  MODEL_LABEL_MAX,
  effortLabel,
  findRunnerBinary,
  kimiModelsFile,
  loadProviders,
  type ModelOption,
} from '@parley/core';
import type { Log } from '../log.js';
import { runOpencodeCli } from './opencode-catalog.js';

export type KimiModelsProbe = (command: string) => Promise<unknown>;
export interface KimiCatalog {
  ready: Promise<void>;
  current(): ModelOption[] | null;
  refreshIfStale(): void;
  refresh(): Promise<void>;
  /** Refresh after any in-flight pre-login probe has completed. */
  invalidate(): Promise<void>;
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** CLI 2.7.3: {providers: {...}, models: {alias: {displayName, supportEfforts?}}}. Ignore providers entirely. */
export function parseKimiModels(raw: unknown): ModelOption[] | null {
  try {
    const data: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!isRecord(data) || !isRecord(data['models'])) return null;
    const models: ModelOption[] = [];
    for (const [id, row] of Object.entries(data['models'])) {
      if (models.length >= 500) break;
      if (id.length > 200 || !/^[^\s-]\S*$/.test(id) || !isRecord(row)) continue;
      const label = row['displayName'] ?? id;
      const efforts = row['supportEfforts'];
      if (typeof label !== 'string' || label.trim() === '') continue;
      if (
        efforts !== undefined &&
        (!Array.isArray(efforts) ||
          !efforts.every((value) => typeof value === 'string' && EFFORT_TOKEN.test(value)))
      )
        continue;
      models.push({
        id,
        label: label.slice(0, MODEL_LABEL_MAX),
        efforts:
          !Array.isArray(efforts) || efforts.length === 0
            ? null
            : [...new Set(efforts as string[])].map((level) => ({
                id: level,
                label: effortLabel(level),
              })),
      });
    }
    return models.length === 0 && Object.keys(data['models']).length > 0 ? null : models;
  } catch {
    // JSON parse errors can contain raw CLI text. Never log them.
    return null;
  }
}

/** Reuse the bounded process-group runner: no model session, prompt, or credential file inspection. */
export async function probeKimiModels(
  command: string,
  options: Parameters<typeof runOpencodeCli>[2] = {},
): Promise<string | null> {
  const env = { ...(options?.env ?? process.env), KIMI_CODE_NO_AUTO_UPDATE: '1' };
  try {
    const binary = await findRunnerBinary(command, env);
    return await runOpencodeCli(binary, ['provider', 'list', '--json'], {
      timeoutMs: 5000,
      maxBytes: 1024 * 1024,
      ...options,
      env,
    });
  } catch {
    return null;
  }
}

/** Registry lookups read the sanitized file; probes run only here, in the background, once per refresh. */
export function startKimiCatalog(
  probe: KimiModelsProbe | undefined,
  log: Log,
  onChange: () => void,
  options: { maxAgeMs?: number; now?: () => number } = {},
): KimiCatalog {
  const file = kimiModelsFile();
  const now = options.now ?? Date.now;
  let probedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;
  let models: ModelOption[] | null = null;
  const run = async (): Promise<void> => {
    if (probe === undefined) return;
    probedAt = now();
    let temporary: string | undefined;
    try {
      const command = (await loadProviders()).kimi?.runner.command ?? 'kimi';
      const next = parseKimiModels(await probe(command));
      if (next === null) return;
      let stored: unknown = null;
      try {
        stored = (JSON.parse(await readFile(file, 'utf8')) as { models?: unknown }).models;
      } catch {
        /* first probe */
      }
      models = next;
      if (JSON.stringify(stored) === JSON.stringify(next)) return;
      await mkdir(path.dirname(file), { recursive: true });
      temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ fetchedAt: new Date(now()).toISOString(), models: next })}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, file);
      onChange();
    } catch {
      // A rejected probe may include its stdout in the exception. Log a fixed message only.
      log.warn('Kimi catalog refresh failed');
    } finally {
      if (temporary !== undefined) await rm(temporary, { force: true }).catch(() => {});
    }
  };
  const refresh = (): Promise<void> => {
    if (inflight === null) {
      const current = run().finally(() => {
        if (inflight === current) inflight = null;
      });
      inflight = current;
    }
    return inflight;
  };
  return {
    ready: refresh(),
    current: () => models,
    refresh,
    invalidate: () => (inflight === null ? refresh() : inflight.then(() => refresh())),
    refreshIfStale() {
      if (inflight === null && now() - probedAt >= (options.maxAgeMs ?? 6 * 60 * 60 * 1000))
        void refresh();
    },
  };
}
