/**
 * Токены job Assistant Core (план голоса, T1): у каждого job свой токен MCP помощника, привязанный к `jobId`.
 * Токен разговора job не получает и не наследует. Токен живёт только в памяти и только пока идёт прогон: после
 * `revoke` маршруты помощника отвечают ему 401. Здесь же хост сам записывает, что job делал (вызовы инструментов и
 * карточки): модель этих записей не пишет и не правит, поэтому `JobResult.cards` и `toolRefs` ей не верить не нужно.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { JOB_TOKEN_PREFIX } from '@parley/core';

/** Вызов инструмента job, как его увидел хост. Аргументов (текст человека) здесь нет. */
export interface JobToolRef {
  tool: string;
  /** Хост ответил 2xx. */
  ok: boolean;
  at: number;
}

/** Карточка, что job подготовил; подтверждает её человек. */
export interface JobCardRef {
  cardId: string;
  kind: string;
}

export interface JobRecord {
  cards: JobCardRef[];
  toolRefs: JobToolRef[];
}

export interface JobTokens {
  /** Новый токен job; прежний токен того же job перестаёт действовать. */
  issue(jobId: string): string;
  /** Токен перестаёт действовать; записи о job остаются до `take`. */
  revoke(jobId: string): void;
  /** `jobId` по токену; `null` — это не токен действующего job. Сравнение в постоянное время. */
  jobOf(token: string): string | null;
  recordTool(jobId: string, tool: string, ok: boolean): void;
  recordCard(jobId: string, card: JobCardRef): void;
  /** Записи о job без изъятия (для отмены, которая снимает итог до конца прогона). */
  peek(jobId: string): JobRecord;
  /** Записи о job; забирает их: повторный вызов вернёт пусто. */
  take(jobId: string): JobRecord;
}

export function createJobTokens(now: () => number = Date.now): JobTokens {
  const byJob = new Map<string, Buffer>();
  const records = new Map<string, JobRecord>();
  const recordOf = (jobId: string): JobRecord => {
    let record = records.get(jobId);
    if (record === undefined) {
      record = { cards: [], toolRefs: [] };
      records.set(jobId, record);
    }
    return record;
  };
  return {
    issue(jobId) {
      const token = `${JOB_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
      byJob.set(jobId, Buffer.from(token));
      return token;
    },
    revoke(jobId) {
      byJob.delete(jobId);
    },
    jobOf(token) {
      const given = Buffer.from(token);
      let found: string | null = null;
      // Перебор без раннего выхода: время не зависит от того, чей токен подошёл.
      for (const [jobId, expected] of byJob) {
        if (given.length === expected.length && timingSafeEqual(given, expected)) found = jobId;
      }
      return found;
    },
    recordTool(jobId, tool, ok) {
      if (!byJob.has(jobId)) return; // отозванный токен ничего не пишет
      recordOf(jobId).toolRefs.push({ tool, ok, at: now() });
    },
    recordCard(jobId, card) {
      if (!byJob.has(jobId)) return;
      recordOf(jobId).cards.push(card);
    },
    peek(jobId) {
      const record = records.get(jobId);
      return record === undefined ? { cards: [], toolRefs: [] } : { cards: [...record.cards], toolRefs: [...record.toolRefs] };
    },
    take(jobId) {
      const record = records.get(jobId) ?? { cards: [], toolRefs: [] };
      records.delete(jobId);
      return record;
    },
  };
}
