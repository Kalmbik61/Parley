/**
 * Состояние канала Telegram: `<home>/telegram/state.json` (владелец, смещение апдейтов, карточки, письма) и журнал
 * `<home>/telegram/audit.jsonl`. Запись атомарная: `<file>.<uuid>.tmp` с 0600, затем `rename`.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuditEntry, CardRecord, LetterRecord, TelegramStateFile } from './types.js';

export const SEEN_RING = 100;
export const CARD_TTL_MS = 7 * 24 * 3_600_000;
const AUDIT_TEXT_MAX = 200;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function emptyState(): TelegramStateFile {
  return { version: 1, botId: null, tokenFingerprint: null, botUsername: null, owner: null, pendingLink: null, offset: null, seen: [], cards: {}, letters: {} };
}

export interface TelegramStateStore {
  /** Загружает при первом обращении; битый файл → пустое состояние и строка в лог. */
  get(): TelegramStateFile;
  /** Слияние и атомарная запись. */
  update(patch: Partial<TelegramStateFile>): void;
  /** state.json удалён, память — `emptyState()`. */
  remove(): void;
  /** `new-bot` — owner/offset/cards/letters/pendingLink сброшены; `new-token` — только offset. */
  applyToken(botId: string, fingerprint: string): 'same' | 'new-bot' | 'new-token';
  /** `true` — апдейт уже был; иначе кладёт id в кольцо. */
  seen(updateId: number): boolean;
  newShortId(): string;
  putCard(shortId: string, card: CardRecord): void;
  dropCard(shortId: string): void;
  cardsFor(predicate: (card: CardRecord) => boolean): Array<[string, CardRecord]>;
  /** Удаляет карточки старше `CARD_TTL_MS`. */
  pruneCards(): void;
  putLetter(messageId: number, letter: LetterRecord): void;
  letter(messageId: number): LetterRecord | null;
  /** Дописывает строку в audit.jsonl; `text` обрезан до 200 знаков. */
  audit(entry: Omit<AuditEntry, 'at'>): void;
}

export function createTelegramState(deps: { home: string; now?(): number; log(line: string): void }): TelegramStateStore {
  const now = deps.now ?? Date.now;
  const dir = path.join(deps.home, 'telegram');
  const file = path.join(dir, 'state.json');
  const auditFile = path.join(dir, 'audit.jsonl');
  let state: TelegramStateFile | null = null;

  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  };

  function save(): void {
    if (state === null) return;
    try {
      ensureDir();
      const tmp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (error) {
      deps.log(`telegram: state not saved: ${(error as Error).message}`);
    }
  }

  function get(): TelegramStateFile {
    if (state !== null) return state;
    let text: string | null = null;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // файла нет — начинаем с пустого
    }
    if (text === null) {
      state = emptyState();
      return state;
    }
    try {
      const parsed = JSON.parse(text) as Partial<TelegramStateFile> | null;
      if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1) throw new Error('unexpected shape');
      state = { ...emptyState(), ...parsed };
    } catch (error) {
      deps.log(`telegram: state file is damaged, starting empty: ${(error as Error).message}`);
      state = emptyState();
    }
    return state;
  }

  return {
    get,
    update(patch) {
      state = { ...get(), ...patch };
      save();
    },
    remove() {
      try {
        rmSync(file, { force: true });
      } catch (error) {
        deps.log(`telegram: state file not removed: ${(error as Error).message}`);
      }
      state = emptyState();
    },
    applyToken(botId, fingerprint) {
      const current = get();
      if (current.botId !== botId) {
        state = { ...emptyState(), botId, tokenFingerprint: fingerprint };
        save();
        return 'new-bot';
      }
      if (current.tokenFingerprint !== fingerprint) {
        state = { ...current, tokenFingerprint: fingerprint, offset: null };
        save();
        return 'new-token';
      }
      return 'same';
    },
    seen(updateId) {
      const current = get();
      if (current.seen.includes(updateId)) return true;
      state = { ...current, seen: [...current.seen, updateId].slice(-SEEN_RING) };
      save();
      return false;
    },
    newShortId() {
      const cards = get().cards;
      for (;;) {
        const bytes = randomBytes(8);
        let id = '';
        for (const byte of bytes) id += BASE62[byte % BASE62.length];
        if (!(id in cards)) return id;
      }
    },
    putCard(shortId, card) {
      state = { ...get(), cards: { ...get().cards, [shortId]: card } };
      save();
    },
    dropCard(shortId) {
      const rest = { ...get().cards };
      delete rest[shortId];
      state = { ...get(), cards: rest };
      save();
    },
    cardsFor(predicate) {
      return Object.entries(get().cards).filter(([, card]) => predicate(card));
    },
    pruneCards() {
      const cards = get().cards;
      const kept = Object.fromEntries(Object.entries(cards).filter(([, card]) => now() - Date.parse(card.at) <= CARD_TTL_MS));
      if (Object.keys(kept).length === Object.keys(cards).length) return;
      state = { ...get(), cards: kept };
      save();
    },
    putLetter(messageId, letter) {
      state = { ...get(), letters: { ...get().letters, [String(messageId)]: letter } };
      save();
    },
    letter(messageId) {
      return get().letters[String(messageId)] ?? null;
    },
    audit(entry) {
      try {
        ensureDir();
        const line: AuditEntry = { at: new Date(now()).toISOString(), ...entry };
        if (line.text !== undefined) line.text = line.text.slice(0, AUDIT_TEXT_MAX);
        appendFileSync(auditFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      } catch (error) {
        deps.log(`telegram: audit not written: ${(error as Error).message}`);
      }
    },
  };
}
