import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_TTL_MS, createTelegramState, emptyState, SEEN_RING } from './state.js';
import type { CardRecord } from './types.js';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
let home = '';
let clock = T0;
const log = vi.fn();
const dir = (): string => path.join(home, 'telegram');
const make = () => createTelegramState({ home, now: () => clock, log });
const card = (at: number): CardRecord => ({ kind: 'assistant', proposalId: 'p1', chatId: 1, messageId: 2, at: new Date(at).toISOString() });

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-telegram-'));
  clock = T0;
  log.mockClear();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('createTelegramState', () => {
  it('без файла get() отдаёт пустое состояние', () => {
    expect(make().get()).toEqual(emptyState());
  });

  it('update пишет файл 0600 в каталоге 0700 и переживает перечитывание', async () => {
    const store = make();
    store.update({ botUsername: 'parley_bot', offset: 42 });
    expect((await stat(path.join(dir(), 'state.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(dir())).mode & 0o777).toBe(0o700);
    const again = make().get();
    expect(again.botUsername).toBe('parley_bot');
    expect(again.offset).toBe(42);
  });

  it('remove удаляет файл и сбрасывает память', async () => {
    const store = make();
    store.update({ offset: 1 });
    store.remove();
    expect(store.get()).toEqual(emptyState());
    await expect(stat(path.join(dir(), 'state.json'))).rejects.toThrow();
  });

  it('applyToken: первый бот, тот же, новый токен, новый бот', () => {
    const store = make();
    expect(store.applyToken('b1', 'f1')).toBe('new-bot'); // состояние было пустым
    store.update({ owner: { userId: 1, chatId: 1, username: null, linkedAt: 'x' }, offset: 5 });
    store.putCard('c1', card(T0));
    store.putLetter(9, { projectPath: '/p', workId: 'w', roomId: null, from: 'a', at: 'x' });
    expect(store.applyToken('b1', 'f1')).toBe('same');
    expect(store.get().offset).toBe(5);
    expect(store.applyToken('b1', 'f2')).toBe('new-token');
    expect(store.get().offset).toBeNull();
    expect(store.get().owner).not.toBeNull();
    expect(Object.keys(store.get().cards)).toEqual(['c1']);
    expect(store.applyToken('b2', 'f3')).toBe('new-bot');
    const after = store.get();
    expect(after.owner).toBeNull();
    expect(after.pendingLink).toBeNull();
    expect(after.cards).toEqual({});
    expect(after.letters).toEqual({});
    expect(after.botId).toBe('b2');
    expect(after.tokenFingerprint).toBe('f3');
  });

  it('seen: повтор → true, после 101 id первый забыт', () => {
    const store = make();
    expect(store.seen(1)).toBe(false);
    expect(store.seen(1)).toBe(true);
    for (let id = 2; id <= SEEN_RING + 1; id += 1) store.seen(id);
    expect(store.seen(1)).toBe(false);
  });

  it('newShortId: 8 знаков base62, не повторяет существующий', () => {
    const store = make();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const id = store.newShortId();
      expect(id).toMatch(/^[0-9A-Za-z]{8}$/);
      expect(store.get().cards[id]).toBeUndefined();
      store.putCard(id, card(T0));
      ids.add(id);
    }
    expect(ids.size).toBe(50);
  });

  it('putCard, cardsFor, dropCard', () => {
    const store = make();
    store.putCard('a', card(T0));
    store.putCard('b', { ...card(T0), messageId: 7 });
    expect(store.cardsFor((c) => c.messageId === 7).map(([id]) => id)).toEqual(['b']);
    store.dropCard('a');
    expect(Object.keys(store.get().cards)).toEqual(['b']);
  });

  it('pruneCards удаляет запись 8-дневной давности и оставляет свежую', () => {
    const store = make();
    store.putCard('old', card(T0 - 8 * 24 * 3_600_000));
    store.putCard('fresh', card(T0 - CARD_TTL_MS + 3_600_000));
    store.pruneCards();
    expect(Object.keys(store.get().cards)).toEqual(['fresh']);
  });

  it('putLetter и letter', () => {
    const store = make();
    const letter = { projectPath: '/p', workId: 'w', roomId: 'r', from: 'a', at: 'x' };
    store.putLetter(11, letter);
    expect(store.letter(11)).toEqual(letter);
    expect(store.letter(12)).toBeNull();
  });

  it('audit дописывает JSON-строку с at и обрезанным text', async () => {
    const store = make();
    store.audit({ kind: 'reply', text: 'q'.repeat(500), result: 'ok' });
    store.audit({ kind: 'link', result: 'linked' });
    const lines = (await readFile(path.join(dir(), 'audit.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? '') as { at: string; text: string; result: string };
    expect(first.at).toBe(new Date(T0).toISOString());
    expect(first.text).toHaveLength(200);
    expect(first.result).toBe('ok');
  });

  it('битый JSON → пустое состояние и строка в логе', async () => {
    await mkdir(dir(), { recursive: true });
    await writeFile(path.join(dir(), 'state.json'), '{not json');
    expect(make().get()).toEqual(emptyState());
    expect(log).toHaveBeenCalledTimes(1);
  });
});
