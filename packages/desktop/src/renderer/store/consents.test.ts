/**
 * Согласия в главном окне (спека 2026-10-21, 4.4): карточки, которые хост держит за запуски Codex, — только ждущие;
 * начальный `consents.list`, события `consents.changed`, решение `consents.decide`, «кого спрашиваем сейчас» (`asking`).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ConsentCard } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { consentRequester, trustCardFor, useConsentsStore } from './consents.js';

const card = (id: string, patch: Partial<ConsentCard> = {}): ConsentCard => ({
  id,
  kind: 'folder-trust',
  folder: '/tmp/p',
  projectPath: '/tmp/p',
  requestedBy: { source: 'agent', sessionId: 's-03', workId: 'w-01', label: 'Ruslan' },
  at: '2026-10-21T10:00:00.000Z',
  state: 'pending',
  ...patch,
});

/** Ответы моста приходят через несколько микрозадач: ждём таймер, а не считаем их. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useConsentsStore.setState({ cards: [], asking: null });
});

describe('useConsentsStore', () => {
  it('init берёт ждущие карточки из consents.list', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('consents.list', async () => ({ items: [card('c-01'), card('c-02', { state: 'allowed' })] }));
    const dispose = useConsentsStore.getState().init(bridge);
    await flush();
    expect(useConsentsStore.getState().cards.map((item) => item.id)).toEqual(['c-01']);
    dispose();
  });

  it('consents.changed: ждущая карточка добавляется, решённая и removed — убираются', () => {
    const bridge = createFakeBridge();
    const dispose = useConsentsStore.getState().init(bridge);
    bridge.emit('consents.changed', { upsert: [card('c-01'), card('c-02', { folder: '/tmp/q', projectPath: '/tmp/q' })], removed: [] });
    expect(useConsentsStore.getState().cards.map((item) => item.id)).toEqual(['c-01', 'c-02']);
    bridge.emit('consents.changed', { upsert: [card('c-01', { state: 'allowed' })], removed: ['c-02'] });
    expect(useConsentsStore.getState().cards).toEqual([]);
    dispose();
  });

  it('событие, пришедшее раньше ответа consents.list, ответом не откатывается', async () => {
    const bridge = createFakeBridge();
    let answer: (value: { items: ConsentCard[] }) => void = () => {};
    bridge.setHandler('consents.list', () => new Promise((resolve) => (answer = resolve)));
    const dispose = useConsentsStore.getState().init(bridge);
    bridge.emit('consents.changed', { upsert: [], removed: ['c-01'] });
    answer({ items: [card('c-01'), card('c-02')] });
    await flush();
    expect(useConsentsStore.getState().cards.map((item) => item.id)).toEqual(['c-02']);
    dispose();
  });

  it('хост без consents.list — карточек нет, ошибки не вылетает', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('consents.list', async () => {
      throw new Error('unknown method');
    });
    const dispose = useConsentsStore.getState().init(bridge);
    await flush();
    expect(useConsentsStore.getState().cards).toEqual([]);
    dispose();
  });

  it('decide зовёт consents.decide и отдаёт applied хоста', async () => {
    const bridge = createFakeBridge();
    bridge.setConsentCards([card('c-01')]);
    const dispose = useConsentsStore.getState().init(bridge);
    await expect(useConsentsStore.getState().decide('c-01', 'allow')).resolves.toEqual({ applied: true });
    expect(bridge.calls).toContainEqual({ method: 'consents.decide', params: { id: 'c-01', decision: 'allow' } });
    await expect(useConsentsStore.getState().decide('c-01', 'allow')).resolves.toEqual({ applied: false });
    dispose();
  });

  it('отписка снимает событие; повторный init начинает с пустого списка', () => {
    const bridge = createFakeBridge();
    const dispose = useConsentsStore.getState().init(bridge);
    bridge.emit('consents.changed', { upsert: [card('c-01')], removed: [] });
    dispose();
    bridge.emit('consents.changed', { upsert: [card('c-02')], removed: [] });
    expect(useConsentsStore.getState().cards.map((item) => item.id)).toEqual(['c-01']);
    useConsentsStore.getState().init(bridge)();
    expect(useConsentsStore.getState().cards).toEqual([]);
  });

  it('ask и stopAsking — выбор карточки, которую показывает диалог', () => {
    useConsentsStore.getState().ask('c-01');
    expect(useConsentsStore.getState().asking).toBe('c-01');
    useConsentsStore.getState().stopAsking();
    expect(useConsentsStore.getState().asking).toBeNull();
  });
});

describe('trustCardFor', () => {
  const cards = [card('c-01', { projectPath: '/tmp/q' }), card('c-02')];

  it('карточка того же проекта у сессии Codex без процесса (pending и sleeping)', () => {
    expect(trustCardFor(cards, '/tmp/p', 'pending', 'codex')?.id).toBe('c-02');
    expect(trustCardFor(cards, '/tmp/p', 'sleeping', 'codex')?.id).toBe('c-02');
  });

  it('живая, закрытая, чужой проект, не Codex — карточки нет', () => {
    expect(trustCardFor(cards, '/tmp/p', 'active', 'codex')).toBeUndefined();
    expect(trustCardFor(cards, '/tmp/p', 'closed', 'codex')).toBeUndefined();
    expect(trustCardFor(cards, '/tmp/none', 'pending', 'codex')).toBeUndefined();
    expect(trustCardFor(cards, '/tmp/p', 'pending', 'claude')).toBeUndefined();
    expect(trustCardFor(cards, '/tmp/p', undefined, 'codex')).toBeUndefined();
  });
});

describe('consentRequester', () => {
  const entries = [makeWork('w-01', { projectPath: '/tmp/p', sessions: [makeSession('s-03', 'Ruslan')] })];

  it('агент: просившая сессия из карты и create_session', () => {
    expect(consentRequester(card('c-01'), entries)).toBe('S03 Ruslan · create_session');
  });

  it('просившей сессии нет в карте — берётся ярлык карточки; нет и его — только источник', () => {
    expect(consentRequester(card('c-01', { requestedBy: { source: 'resume', workId: 'w-01', label: 'Ruslan' } }), entries)).toBe('Ruslan · resume');
    expect(consentRequester(card('c-01', { requestedBy: { source: 'launch' } }), entries)).toBe('launch');
  });
});
