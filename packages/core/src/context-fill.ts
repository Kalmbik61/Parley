/**
 * Заполненность контекста сессии (спека 2026-10-15, 4): сколько окна модели занято сейчас. Лист: из пакета тянет
 * только `limits.js` (`isFileSafeId`) — его импортирует скрипт строки статуса, а тот зовётся часто и должен быть быстрым.
 *
 * Claude Code и GLM: скрипт строки статуса кладёт `context/<сессия>.json` из `context_window` своего входа
 * (`claudeContextFill`). Codex: разбор rollout-лога берёт последнюю запись `token_count` (`codexContextFill`).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isFileSafeId } from './limits.js';

export const CONTEXT_DIR = 'context';

export interface ContextFill {
  /** Занято, 0–100. */
  usedPercent: number;
  /** Размер окна модели в токенах; `null` — CLI не сообщил. */
  windowTokens: number | null;
  /** Занято токенов; `null` — CLI не сообщил. */
  usedTokens: number | null;
  /** ISO-время наблюдения. */
  at: string;
}

export const contextFile = (workDir: string, sessionId: string): string =>
  path.join(workDir, CONTEXT_DIR, `${sessionId}.json`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** `context_window` входа строки статуса Claude Code → наблюдение; нет числового `used_percentage` — `null`. */
export function claudeContextFill(contextWindow: unknown, at: string): ContextFill | null {
  if (!isRecord(contextWindow)) return null;
  const used = contextWindow['used_percentage'];
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  // Сразу после `/compact` Claude Code зовёт строку статуса с нулями (спека 9, п. 4) — это не наблюдение: прежний
  // файл остаётся, и окно показывает `compacted` до первой настоящей цифры. Живая сессия ровно 0 % не занимает.
  if (used === 0) return null;
  const current = isRecord(contextWindow['current_usage']) ? contextWindow['current_usage'] : null;
  const parts =
    current === null
      ? []
      : [count(current['input_tokens']), count(current['cache_creation_input_tokens']), count(current['cache_read_input_tokens'])];
  const usedTokens = parts.every((part) => part === null) ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
  return { usedPercent: clampPercent(used), windowTokens: count(contextWindow['context_window_size']), usedTokens, at };
}

/** Базовые токены окна, которые Codex TUI не считает занятыми (`percent_of_context_window_remaining`). */
export const CODEX_BASELINE_TOKENS = 12_000;

/** `info` записи `token_count` Codex → наблюдение; нет окна или `last_token_usage` — `null`. */
export function codexContextFill(info: unknown, at: string): ContextFill | null {
  if (!isRecord(info)) return null;
  const windowTokens = count(info['model_context_window']);
  const last = isRecord(info['last_token_usage']) ? info['last_token_usage'] : null;
  if (windowTokens === null || last === null) return null;
  const input = count(last['input_tokens']);
  const output = count(last['output_tokens']);
  const usedTokens = count(last['total_tokens']) ?? (input === null && output === null ? null : (input ?? 0) + (output ?? 0));
  if (usedTokens === null) return null;
  if (windowTokens <= CODEX_BASELINE_TOKENS) return { usedPercent: 100, windowTokens, usedTokens, at };
  const effective = windowTokens - CODEX_BASELINE_TOKENS;
  const used = Math.max(0, usedTokens - CODEX_BASELINE_TOKENS);
  const remaining = Math.round(clampPercent((Math.max(0, effective - used) / effective) * 100));
  return { usedPercent: 100 - remaining, windowTokens, usedTokens, at };
}

/** Текст файла `context/<сессия>.json` → наблюдение; битый JSON или не та форма — `null`. */
export function parseContextFill(raw: string): ContextFill | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const usedPercent = data['usedPercent'];
  const at = data['at'];
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  return { usedPercent: clampPercent(usedPercent), windowTokens: count(data['windowTokens']), usedTokens: count(data['usedTokens']), at };
}

/** Файл сессии в каталоге работы; нет файла или плохой id — `null`. */
export async function readContextFill(workDir: string, sessionId: string): Promise<ContextFill | null> {
  if (!isFileSafeId(sessionId)) return null;
  try {
    return parseContextFill(await readFile(contextFile(workDir, sessionId), 'utf8'));
  } catch {
    return null;
  }
}
