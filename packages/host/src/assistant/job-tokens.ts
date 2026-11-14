/**
 * Токены job Assistant Core (план голоса, T1): у каждого job свой токен MCP помощника, привязанный к `jobId`.
 * Токен разговора job не получает и не наследует. Токен живёт только в памяти и только пока идёт прогон: после
 * `revoke` маршруты помощника отвечают ему 401. С токеном хранится неизменяемая запись допуска прогона (спека автономии §5.2). Здесь же хост сам записывает, что job делал (вызовы инструментов и
 * карточки): модель этих записей не пишет и не правит, поэтому `JobResult.cards` и `toolRefs` ей не верить не нужно.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { JOB_TOKEN_PREFIX, sessionMention, sessionTag } from '@parley/core';
import { normalizeHumanText } from '@parley/core/assistant';
import type { HumanOverviewV1 } from '@parley/protocol';
import type { JobAdmission } from './assistant-endpoint.js';

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
  /** Host-owned names from the last permitted overview, never part of JobResult. */
  humanRefs?: Record<string, string>;
  cards: JobCardRef[];
  toolRefs: JobToolRef[];
}

export interface JobTokens {
  /** Новый токен job с записью допуска этого прогона; прежний токен того же job перестаёт действовать. */
  issue(jobId: string, start: Pick<JobAdmission, 'origin' | 'autoAtStart'>): string;
  /** Токен перестаёт действовать; записи о job остаются до `take`. */
  revoke(jobId: string): void;
  /** Запись допуска по токену; `null` — это не токен действующего job. Сравнение в постоянное время. */
  admissionOf(token: string): JobAdmission | null;
  /** Запись допуска действующего прогона job; `null` — токен job отозван или не выдавался. */
  current(jobId: string): JobAdmission | null;
  /** `jobId` по токену (`admissionOf(token)?.jobId`). */
  jobOf(token: string): string | null;
  recordTool(jobId: string, tool: string, ok: boolean): void;
  recordCard(jobId: string, card: JobCardRef): void;
  recordOverview(jobId: string, overview: HumanOverviewV1): void;
  /** Записи о job без изъятия (для отмены, которая снимает итог до конца прогона). */
  peek(jobId: string): JobRecord;
  /** Записи о job; забирает их: повторный вызов вернёт пусто. */
  take(jobId: string): JobRecord;
}

export function createJobTokens(now: () => number = Date.now): JobTokens {
  const byJob = new Map<string, { token: Buffer; admission: JobAdmission }>();
  const records = new Map<string, JobRecord>();
  const recordOf = (jobId: string): JobRecord => {
    let record = records.get(jobId);
    if (record === undefined) {
      record = { cards: [], toolRefs: [] };
      records.set(jobId, record);
    }
    return record;
  };
  const admissionOf = (token: string): JobAdmission | null => {
    const given = Buffer.from(token);
    let found: JobAdmission | null = null;
    // Перебор без раннего выхода: время не зависит от того, чей токен подошёл.
    for (const { token: expected, admission } of byJob.values()) {
      if (given.length === expected.length && timingSafeEqual(given, expected)) found = admission;
    }
    return found;
  };
  return {
    issue(jobId, start) {
      const token = `${JOB_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
      const admission: JobAdmission = Object.freeze({ ...start, kind: 'job', runId: randomUUID(), jobId });
      byJob.set(jobId, { token: Buffer.from(token), admission });
      return token;
    },
    revoke(jobId) {
      byJob.delete(jobId);
    },
    admissionOf,
    current: (jobId) => byJob.get(jobId)?.admission ?? null,
    jobOf: (token) => admissionOf(token)?.jobId ?? null,
    recordTool(jobId, tool, ok) {
      if (!byJob.has(jobId)) return; // отозванный токен ничего не пишет
      recordOf(jobId).toolRefs.push({ tool, ok, at: now() });
    },
    recordCard(jobId, card) {
      if (!byJob.has(jobId)) return;
      recordOf(jobId).cards.push(card);
    },
    recordOverview(jobId, overview) {
      if (!byJob.has(jobId)) return;
      const aliases = new Map<string, Set<string>>();
      const add = (ref: string, name: string): void => {
        const names = aliases.get(ref) ?? new Set<string>();
        names.add(name);
        aliases.set(ref, names);
      };
      for (const room of overview.rooms) {
        add(room.ref, room.title);
        add(room.ref.slice(room.ref.lastIndexOf(':') + 1), room.title);
        const work = `work:${room.ref.slice(5, room.ref.lastIndexOf(':'))}`;
        add(work, room.workLabel);
        add(work.slice(work.lastIndexOf(':') + 1), room.workLabel);
      }
      for (const member of [...overview.rooms.flatMap((room) => room.members), ...overview.unassignedSessions]) {
        const id = member.ref.slice(member.ref.lastIndexOf(':') + 1);
        add(member.ref, member.displayName);
        add(id, member.displayName);
        add(sessionTag(id), member.displayName);
        add(sessionMention(id), member.displayName);
      }
      recordOf(jobId).humanRefs = Object.fromEntries([...aliases].map(([ref, names]) => [
        ref, names.size === 1 ? [...names][0]! : normalizeHumanText(ref.startsWith('S') ? 's-0' : ref, {}),
      ]));
    },
    peek(jobId) {
      const record = records.get(jobId);
      return record === undefined ? { cards: [], toolRefs: [] } : { cards: [...record.cards], toolRefs: [...record.toolRefs], ...(record.humanRefs === undefined ? {} : { humanRefs: { ...record.humanRefs } }) };
    },
    take(jobId) {
      const record = records.get(jobId) ?? { cards: [], toolRefs: [] };
      records.delete(jobId);
      return record;
    },
  };
}
