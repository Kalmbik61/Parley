/**
 * Durable-хранилище карточек Assistant Core (спека 2026-11-03, C2): то, что раньше жило в переменной `pending`
 * сервиса. Карточка переживает рестарт хоста, у неё есть срок (`expiresAt` → терминальное `expired`) и след решения
 * (`decidedAt`, `decidedVia`, `outcome`). Источник (`source`) разделяет карточки каналов: новая карточка вытесняет
 * только карточку своего источника, карточка голоса не затирает карточку острова.
 */

import type { DatabaseSync } from 'node:sqlite';

export type CardState = 'active' | 'decided' | 'expired' | 'superseded';
export type CardVia = 'island' | 'telegram' | 'mobile';

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
});

export interface CardStore {
  /** Новая активная карточка; активная карточка того же источника становится `superseded`. */
  put(card: NewCard, now: number): CardRow;
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
  /** Новая карточка с тем же содержимым вместо просроченной («Запросить заново»); старая остаётся как была. */
  reissue(proposalId: string, newId: string, expiresAt: number, now: number): CardRow | null;
  /** Старт хоста: захваченная карточка без итога (хост умер посреди действия) получает исход `unknown` и остаётся неисполнимой. */
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
      if (card === null || card.state !== 'decided' || card.outcome !== null) return false;
      const busy = db.prepare(`SELECT 1 FROM assistant_cards WHERE state = 'active' AND source = ?`).get(card.source);
      if (busy !== undefined) return false;
      db.prepare(`UPDATE assistant_cards SET state = 'active', revision = revision + 1 WHERE proposal_id = ?`).run(proposalId);
      return true;
    },
    supersedeAll() {
      db.prepare(`UPDATE assistant_cards SET state = 'superseded', revision = revision + 1 WHERE state = 'active'`).run();
    },
    reissue(proposalId, newId, expiresAt, now) {
      const old = one(proposalId);
      if (old === null || old.state !== 'expired') return null;
      const view = { ...(old.view as Record<string, unknown>), id: newId };
      return this.put({ proposalId: newId, kind: old.kind, view, payload: old.payload, source: old.source, expiresAt }, now);
    },
    closeUnsettled(now) {
      const rows = (db.prepare(`SELECT * FROM assistant_cards WHERE state = 'decided' AND outcome IS NULL`).all() as unknown as Raw[]).map(fromRaw);
      if (rows.length > 0) db.prepare(`UPDATE assistant_cards SET outcome = 'unknown', decided_at = COALESCE(decided_at, ?), revision = revision + 1 WHERE state = 'decided' AND outcome IS NULL`).run(now);
      return rows;
    },
    lastNumber() {
      const row = db.prepare(`SELECT MAX(CAST(SUBSTR(proposal_id, 2) AS INTEGER)) AS n FROM assistant_cards WHERE proposal_id GLOB 'p[0-9]*'`).get() as { n: number | null } | undefined;
      return row?.n ?? 0;
    },
  };
}
