/**
 * Durable-хранилище карточек Assistant Core (спека 2026-11-03, C2): то, что раньше жило в переменной `pending`
 * сервиса. Карточка переживает рестарт хоста, у неё есть срок (`expiresAt` → терминальное `expired`) и след решения
 * (`decidedAt`, `decidedVia`, `outcome`). Источник (`source`) разделяет карточки каналов: новая карточка вытесняет
 * только карточку своего источника, карточка голоса не затирает карточку острова.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ActionOutcome } from './run-plan.js';

export type CardState = 'active' | 'decided' | 'expired' | 'superseded';
export type CardVia = 'island' | 'telegram' | 'mobile' | 'auto';
/**
 * Ход исполнения автономной карточки (спека автономии §5.3), durable: есть строка — допуск записан (`recorded`);
 * `started` — шаги, чей эффект начат, `confirmed` — чей эффект подтверждён. Одиночное действие — план из одного шага.
 */
export interface CardProgress {
  steps: number;
  started: number[];
  confirmed: number[];
}
/** Кому достался итог автономного действия: ещё никому, запуску, что создал карточку, или служебному сообщению. */
export type ResultState = 'pending' | 'taken_by_run' | 'sent_as_message';

export interface CardRow {
  proposalId: string;
  kind: string;
  view: unknown;
  /** Всё, что хост знает о действии помимо вида для окна. */
  payload: unknown;
  source: string;
  state: CardState;
  revision: number;
  expiresAt: number;
  createdAt: number;
  decidedAt: number | null;
  decidedVia: CardVia | null;
  outcome: string | null;
  /** `null` — карточка решается кликом. */
  progress: CardProgress | null;
  /** Структурный итог автономного действия; пишется вместе с исходом (`settleAuto`). */
  result: ActionOutcome | null;
  resultState: ResultState | null;
}

export interface NewCard {
  proposalId: string;
  kind: string;
  view: unknown;
  payload: unknown;
  source: string;
  expiresAt: number;
}

export type Claim = { ok: true; card: CardRow } | { ok: false; reason: 'expired' | 'gone' };

interface Raw {
  proposal_id: string;
  kind: string;
  view_json: string;
  payload_json: string;
  source: string;
  state: CardState;
  revision: number;
  expires_at: number;
  created_at: number;
  decided_at: number | null;
  decided_via: CardVia | null;
  outcome: string | null;
  progress_json: string | null;
  result_json: string | null;
  result_state: ResultState | null;
}

const fromRaw = (row: Raw): CardRow => ({
  proposalId: row.proposal_id,
  kind: row.kind,
  view: JSON.parse(row.view_json) as unknown,
  payload: JSON.parse(row.payload_json) as unknown,
  source: row.source,
  state: row.state,
  revision: row.revision,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
  decidedVia: row.decided_via,
  outcome: row.outcome,
  progress: row.progress_json === null ? null : (JSON.parse(row.progress_json) as CardProgress),
  result: row.result_json === null ? null : (JSON.parse(row.result_json) as ActionOutcome),
  resultState: row.result_state,
});

export interface CardStore {
  /** Новая активная карточка; активная карточка того же источника становится `superseded`. */
  put(card: NewCard, now: number): CardRow;
  /**
   * Автономная карточка (спека автономии §5.3): одна транзакция вытесняет активные карточки источника и вставляет строку
   * сразу `decided` с `decided_via`, ходом `recorded` на `steps` шагов и `result_state = 'pending'`. Активной она не бывает.
   */
  putDecided(card: NewCard & { steps: number }, via: CardVia, now: number): CardRow;
  /** Запись хода: `started` — перед эффектом шага `step`, `confirmed` — после его успешного возврата. */
  recordStep(proposalId: string, mark: 'started' | 'confirmed', step: number): void;
  /** Условный переход `result_state` из `pending`; `true` — переход сделал этот вызов. */
  takeResult(proposalId: string, to: Exclude<ResultState, 'pending'>): boolean;
  /** Автономные карточки без итога (хост умер посреди действия): их исход определяет ход исполнения. */
  unsettledAuto(): CardRow[];
  /** Итог автономной карточки: исход для журнала и структурный итог для получателя — одним UPDATE, один раз. */
  settleAuto(proposalId: string, outcome: string, result: ActionOutcome, now: number): void;
  /** Закрытые автономные карточки, чей итог ещё никому не достался (`result_state = 'pending'`); `source` — только этого источника. */
  pendingResults(source?: string): CardRow[];
  get(proposalId: string): CardRow | null;
  /** Активные карточки, новые последними. Срок не проверяется: сначала `expireDue`. */
  active(): CardRow[];
  /** Просроченные активные карточки → `expired`; возвращает их. */
  expireDue(now: number): CardRow[];
  /** Захват карточки до первого `await`: только один вызов получит `ok`; просроченная становится `expired`. */
  claim(proposalId: string, now: number): Claim;
  /** Итог захваченной карточки. */
  settle(proposalId: string, via: CardVia, outcome: string, now: number): void;
  /** Захват не удался как действие: карточка снова активна, если её источник не занят новой. */
  release(proposalId: string): boolean;
  /** Активные карточки → `superseded` (после `reset`). */
  supersedeAll(): void;
  /** Все карточки источника (любое состояние); для job источник — `job:<jobId>`. */
  bySource(source: string): CardRow[];
  /**
   * Активные карточки источника → `superseded` (отзыв при вытеснении Request, T5). Один условный UPDATE: захваченная
   * (`decided`) карточка не отзывается. Не открывает транзакцию — зовётся и внутри чужой; возвращает отозванные.
   */
  withdrawBySource(source: string): CardRow[];
  /** Новая карточка с тем же содержимым вместо просроченной («Запросить заново»); старая остаётся как была. */
  reissue(proposalId: string, newId: string, expiresAt: number, now: number): CardRow | null;
  /**
   * Старт хоста: захваченная кликом карточка без итога (хост умер посреди действия) получает исход `unknown` и остаётся
   * неисполнимой. Автономные не трогает: их закрывает сервис по ходу исполнения (`unsettledAuto`).
   */
  closeUnsettled(now: number): CardRow[];
  /** Наибольший номер `pN` среди выданных id: счётчик сервиса продолжается после рестарта. */
  lastNumber(): number;
}

export function createCardStore(db: DatabaseSync): CardStore {
  const one = (id: string): CardRow | null => {
    const row = db.prepare('SELECT * FROM assistant_cards WHERE proposal_id = ?').get(id) as unknown as Raw | undefined;
    return row === undefined ? null : fromRaw(row);
  };
  return {
    put(card, now) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`UPDATE assistant_cards SET state = 'superseded', revision = revision + 1 WHERE state = 'active' AND source = ?`).run(card.source);
        db.prepare(
          `INSERT INTO assistant_cards (proposal_id, kind, view_json, payload_json, source, state, revision, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        ).run(card.proposalId, card.kind, JSON.stringify(card.view), JSON.stringify(card.payload), card.source, card.expiresAt, now);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return one(card.proposalId) as CardRow;
    },
    putDecided(card, via, now) {
      const progress: CardProgress = { steps: card.steps, started: [], confirmed: [] };
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`UPDATE assistant_cards SET state = 'superseded', revision = revision + 1 WHERE state = 'active' AND source = ?`).run(card.source);
        db.prepare(
          `INSERT INTO assistant_cards (proposal_id, kind, view_json, payload_json, source, state, revision, expires_at, created_at, decided_via, progress_json, result_state) VALUES (?, ?, ?, ?, ?, 'decided', 1, ?, ?, ?, ?, 'pending')`,
        ).run(card.proposalId, card.kind, JSON.stringify(card.view), JSON.stringify(card.payload), card.source, card.expiresAt, now, via, JSON.stringify(progress));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return one(card.proposalId) as CardRow;
    },
    recordStep(proposalId, mark, step) {
      const progress = one(proposalId)?.progress;
      if (progress === null || progress === undefined || progress[mark].includes(step)) return;
      const next: CardProgress = { ...progress, [mark]: [...progress[mark], step] };
      db.prepare('UPDATE assistant_cards SET progress_json = ? WHERE proposal_id = ?').run(JSON.stringify(next), proposalId);
    },
    takeResult(proposalId, to) {
      return Number(db.prepare(`UPDATE assistant_cards SET result_state = ? WHERE proposal_id = ? AND result_state = 'pending'`).run(to, proposalId).changes) === 1;
    },
    settleAuto(proposalId, outcome, result, now) {
      db.prepare(
        `UPDATE assistant_cards SET decided_at = ?, decided_via = 'auto', outcome = ?, result_json = ?, revision = revision + 1 WHERE proposal_id = ? AND state = 'decided' AND outcome IS NULL AND progress_json IS NOT NULL`,
      ).run(now, outcome, JSON.stringify(result), proposalId);
    },
    pendingResults(source) {
      const where = `state = 'decided' AND outcome IS NOT NULL AND progress_json IS NOT NULL AND result_state = 'pending'`;
      const rows = source === undefined ? db.prepare(`SELECT * FROM assistant_cards WHERE ${where} ORDER BY created_at, rowid`).all() : db.prepare(`SELECT * FROM assistant_cards WHERE ${where} AND source = ? ORDER BY created_at, rowid`).all(source);
      return (rows as unknown as Raw[]).map(fromRaw);
    },
    unsettledAuto() {
      return (db.prepare(`SELECT * FROM assistant_cards WHERE state = 'decided' AND outcome IS NULL AND progress_json IS NOT NULL ORDER BY created_at, rowid`).all() as unknown as Raw[]).map(fromRaw);
    },
    get: one,
    active() {
      return (db.prepare(`SELECT * FROM assistant_cards WHERE state = 'active' ORDER BY created_at, rowid`).all() as unknown as Raw[]).map(fromRaw);
    },
    expireDue(now) {
      const due = (db.prepare(`SELECT * FROM assistant_cards WHERE state = 'active' AND expires_at <= ?`).all(now) as unknown as Raw[]).map(fromRaw);
      if (due.length > 0) db.prepare(`UPDATE assistant_cards SET state = 'expired', revision = revision + 1 WHERE state = 'active' AND expires_at <= ?`).run(now);
      return due.map((card) => ({ ...card, state: 'expired' as const, revision: card.revision + 1 }));
    },
    claim(proposalId, now) {
      const card = one(proposalId);
      if (card === null) return { ok: false, reason: 'gone' };
      if (card.state === 'expired') return { ok: false, reason: 'expired' };
      if (card.state !== 'active') return { ok: false, reason: 'gone' };
      if (card.expiresAt <= now) {
        db.prepare(`UPDATE assistant_cards SET state = 'expired', revision = revision + 1 WHERE proposal_id = ? AND state = 'active'`).run(proposalId);
        return { ok: false, reason: 'expired' };
      }
      // Условный UPDATE: даже два соединения одной базы не захватят карточку дважды.
      const changed = db.prepare(`UPDATE assistant_cards SET state = 'decided', revision = revision + 1 WHERE proposal_id = ? AND state = 'active'`).run(proposalId).changes;
      return Number(changed) === 1 ? { ok: true, card: { ...card, state: 'decided', revision: card.revision + 1 } } : { ok: false, reason: 'gone' };
    },
    settle(proposalId, via, outcome, now) {
      db.prepare(`UPDATE assistant_cards SET decided_at = ?, decided_via = ?, outcome = ?, revision = revision + 1 WHERE proposal_id = ? AND state = 'decided'`).run(now, via, outcome, proposalId);
    },
    release(proposalId) {
      const card = one(proposalId);
      if (card === null || card.state !== 'decided' || card.outcome !== null || card.progress !== null) return false;
      const busy = db.prepare(`SELECT 1 FROM assistant_cards WHERE state = 'active' AND source = ?`).get(card.source);
      if (busy !== undefined) return false;
      db.prepare(`UPDATE assistant_cards SET state = 'active', revision = revision + 1 WHERE proposal_id = ?`).run(proposalId);
      return true;
    },
    supersedeAll() {
      db.prepare(`UPDATE assistant_cards SET state = 'superseded', revision = revision + 1 WHERE state = 'active'`).run();
    },
    bySource(source) {
      return (db.prepare(`SELECT * FROM assistant_cards WHERE source = ? ORDER BY created_at, rowid`).all(source) as unknown as Raw[]).map(fromRaw);
    },
    withdrawBySource(source) {
      const rows = (db.prepare(`SELECT * FROM assistant_cards WHERE state = 'active' AND source = ?`).all(source) as unknown as Raw[]).map(fromRaw);
      if (rows.length > 0) db.prepare(`UPDATE assistant_cards SET state = 'superseded', revision = revision + 1 WHERE state = 'active' AND source = ?`).run(source);
      return rows.map((card) => ({ ...card, state: 'superseded' as const, revision: card.revision + 1 }));
    },
    reissue(proposalId, newId, expiresAt, now) {
      const old = one(proposalId);
      if (old === null || old.state !== 'expired') return null;
      const view = { ...(old.view as Record<string, unknown>), id: newId };
      return this.put({ proposalId: newId, kind: old.kind, view, payload: old.payload, source: old.source, expiresAt }, now);
    },
    closeUnsettled(now) {
      const rows = (db.prepare(`SELECT * FROM assistant_cards WHERE state = 'decided' AND outcome IS NULL AND progress_json IS NULL`).all() as unknown as Raw[]).map(fromRaw);
      if (rows.length > 0) db.prepare(`UPDATE assistant_cards SET outcome = 'unknown', decided_at = COALESCE(decided_at, ?), revision = revision + 1 WHERE state = 'decided' AND outcome IS NULL AND progress_json IS NULL`).run(now);
      return rows;
    },
    lastNumber() {
      const row = db.prepare(`SELECT MAX(CAST(SUBSTR(proposal_id, 2) AS INTEGER)) AS n FROM assistant_cards WHERE proposal_id GLOB 'p[0-9]*'`).get() as { n: number | null } | undefined;
      return row?.n ?? 0;
    },
  };
}
