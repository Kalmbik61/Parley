import { describe, expect, it, vi } from 'vitest';
import type { PhoneCard } from '@parley/protocol/remote';
import { canDecide, sheetVisible, sheetWaiting, sheetMode, applyCardChanged, cardsFromSnapshot, currentCard, decideCard, dropCard, STALE_CARD_MESSAGE, type DecideDeps } from './cards-model.js';

const card = (patch: Partial<PhoneCard> = {}): PhoneCard => ({
  cardId: 'p1',
  revision: 1,
  kind: 'message',
  state: 'needs_confirmation',
  title: 'Send to Claude',
  text: 'hello',
  dangerous: false,
  expiresAt: 100,
  ...patch,
});

describe('список карточек', () => {
  it('снимок оставляет только ждущие решения', () => {
    expect(cardsFromSnapshot([card(), card({ cardId: 'p2', state: 'decided' })]).map((c) => c.cardId)).toEqual(['p1']);
  });
  it('cards.changed добавляет ждущую и убирает терминальную', () => {
    const added = applyCardChanged([], card());
    expect(added).toHaveLength(1);
    expect(applyCardChanged(added, card({ revision: 2, state: 'decided' }))).toEqual([]);
    expect(applyCardChanged(added, card({ revision: 2, state: 'expired' }))).toEqual([]);
    expect(applyCardChanged(added, card({ revision: 2, state: 'superseded' }))).toEqual([]);
  });
  it('новая ревизия заменяет, старая не затирает', () => {
    const list = applyCardChanged([], card({ revision: 3, text: 'new' }));
    expect(applyCardChanged(list, card({ revision: 2, text: 'old' }))[0]?.text).toBe('new');
    expect(applyCardChanged(list, card({ revision: 4, text: 'newer' }))[0]?.text).toBe('newer');
  });
  it('первой идёт карточка с ближним сроком', () => {
    const list = applyCardChanged(applyCardChanged([], card({ cardId: 'late', expiresAt: 500 })), card({ cardId: 'soon', expiresAt: 50 }));
    expect(currentCard(list)?.cardId).toBe('soon');
    expect(currentCard(dropCard(list, 'soon'))?.cardId).toBe('late');
    expect(currentCard([])).toBeNull();
  });
});

const deps = (decide: DecideDeps['call'], confirm: DecideDeps['confirmOwner'] = async () => 'ok'): DecideDeps => ({ call: decide, confirmOwner: confirm });
const applied = { applied: true, error: null, reason: 'applied' } as const;

describe('decideCard (R06)', () => {
  it('Send обычной карточки: cards.decide с cardId, ревизией и выбором, Face ID не нужен', async () => {
    const call = vi.fn(async () => applied);
    const confirm = vi.fn(async () => 'ok' as const);
    expect(await decideCard(deps(call, confirm), card({ revision: 7 }), 'send')).toEqual({ kind: 'applied' });
    expect(call).toHaveBeenCalledWith('cards.decide', { cardId: 'p1', revision: 7, choice: 'send' });
    expect(confirm).not.toHaveBeenCalled();
  });
  it('опасная карточка: Face ID до вызова', async () => {
    const order: string[] = [];
    const out = await decideCard(
      deps(async () => (order.push('call'), applied), async () => (order.push('faceid'), 'ok')),
      card({ dangerous: true }),
      'send',
    );
    expect(out.kind).toBe('applied');
    expect(order).toEqual(['faceid', 'call']);
  });
  it.each(['cancelled', 'unavailable'] as const)('опасная карточка, Face ID %s: ничего не отправлено', async (answer) => {
    const call = vi.fn(async () => applied);
    const out = await decideCard(deps(call, async () => answer), card({ dangerous: true }), 'send');
    expect(out.kind).toBe('not_confirmed');
    expect(call).not.toHaveBeenCalled();
  });
  it('Cancel опасной карточки Face ID не просит', async () => {
    const confirm = vi.fn(async () => 'cancelled' as const);
    const call = vi.fn(async () => applied);
    expect((await decideCard(deps(call, confirm), card({ dangerous: true }), 'cancel')).kind).toBe('applied');
    expect(confirm).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith('cards.decide', { cardId: 'p1', revision: 1, choice: 'cancel' });
  });
  it.each(['already_handled', 'expired', 'not_found'] as const)('результат %s: «This card is no longer current»', async (reason) => {
    const out = await decideCard(deps(async () => ({ applied: false, error: 'x', reason })), card(), 'send');
    expect(out).toEqual({ kind: 'stale', message: STALE_CARD_MESSAGE });
  });
  it('вызов не дошёл до Mac: карточка остаётся (unreachable)', async () => {
    const out = await decideCard(deps(async () => { throw new Error('offline'); }), card(), 'send');
    expect(out.kind).toBe('unreachable');
  });
});

describe('sheetMode', () => {
  it('cards.decide в hello.methods — Send/Cancel, иначе «Confirm on Mac»', () => {
    expect(sheetMode(['cards.list', 'cards.decide'])).toBe('decide');
    expect(sheetMode(['cards.list'])).toBe('confirm_on_mac');
    expect(sheetMode(null)).toBe('confirm_on_mac');
  });
});

describe('decideCard: failed', () => {
  it('failed: «Could not send — try again», карточка остаётся (не stale)', async () => {
    const out = await decideCard(deps(async () => ({ applied: false, error: 'x', reason: 'failed' })), card(), 'send');
    expect(out).toEqual({ kind: 'failed', message: 'Could not send — try again' });
  });
});

describe('лист карточки: замок, фокус, Later (B1, M4)', () => {
  const base = { card: card(), covered: false, focused: true, dismissed: new Set<string>() };
  it('виден при открытом приложении на вкладке Voice', () => {
    expect(sheetVisible(base)).toBe(true);
  });
  it('под обложкой замка не виден и не ждёт', () => {
    expect(sheetVisible({ ...base, covered: true })).toBe(false);
    expect(sheetWaiting({ ...base, covered: true, dismissed: new Set(['p1']) })).toBe(false);
  });
  it('вне вкладки Voice не виден', () => {
    expect(sheetVisible({ ...base, focused: false })).toBe(false);
  });
  it('без карточки не виден', () => {
    expect(sheetVisible({ ...base, card: null })).toBe(false);
  });
  it('Later: лист скрыт, карточка ждёт, значок возвращает лист', () => {
    const later = { ...base, dismissed: new Set(['p1']) };
    expect(sheetVisible(later)).toBe(false);
    expect(sheetWaiting(later)).toBe(true);
    expect(sheetVisible({ ...later, dismissed: new Set<string>() })).toBe(true);
  });
  it('решение под замком, при занятом вызове и без карточки не принимается', () => {
    expect(canDecide({ card: card(), covered: false, busy: false })).toBe(true);
    expect(canDecide({ card: card(), covered: true, busy: false })).toBe(false);
    expect(canDecide({ card: card(), covered: false, busy: true })).toBe(false);
    expect(canDecide({ card: null, covered: false, busy: false })).toBe(false);
  });
});
