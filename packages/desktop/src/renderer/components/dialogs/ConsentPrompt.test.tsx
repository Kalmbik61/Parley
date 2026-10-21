/**
 * Окно и карточка согласия (спека 2026-10-21, 4.2 п. 3): пришла ждущая карточка, а окно активно — диалог «Trust … for
 * agents?» с тем, кто просил; «Trust» — `consents.decide(allow)`, «Cancel» — диалог закрывается, карточка остаётся
 * (остров и Telegram показывают её дальше). Окно неактивно — диалога нет. Кнопка «Trust folder» в Chat открывает
 * диалог для уже отклонённой карточки; решение в другом месте закрывает диалог.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentCard } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { useConsentsStore } from '../../store/consents.js';
import { useUiStore } from '../../store/ui.js';
import { useWorksStore } from '../../store/works.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { ConsentPrompt } from './ConsentPrompt.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

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

let bridge: FakeBridge;
let dispose: () => void;

const flush = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const decideCalls = (): unknown[] => bridge.calls.filter((call) => call.method === 'consents.decide').map((call) => call.params);

beforeEach(() => {
  bridge = createFakeBridge();
  useConsentsStore.setState({ cards: [], asking: null });
  useUiStore.setState({ windowFocused: true, documentVisible: true });
  useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/tmp/p', sessions: [makeSession('s-03', 'Ruslan')] })] });
  dispose = useConsentsStore.getState().init(bridge);
});

afterEach(() => {
  dispose();
  cleanup();
  vi.mocked(toast.error).mockClear();
  useWorksStore.setState(useWorksStore.getInitialState(), true);
});

describe('ConsentPrompt', () => {
  it('ждущая карточка при активном окне — диалог с тем, кто просил; Trust решает allow', async () => {
    bridge.setConsentCards([card('c-01')]);
    render(<ConsentPrompt />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => bridge.emit('consents.changed', { upsert: [card('c-01')], removed: [] }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Trust /tmp/p for agents?');
    expect(dialog.textContent).toContain('Requested by S03 Ruslan · create_session.');
    fireEvent.click(screen.getByRole('button', { name: S.dialogs.trustFolder.confirm }));
    await flush();
    expect(decideCalls()).toEqual([{ id: 'c-01', decision: 'allow' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('карточка, жившая до открытия окна, тоже спрашивается', async () => {
    bridge.setConsentCards([card('c-01')]);
    dispose();
    dispose = useConsentsStore.getState().init(bridge);
    render(<ConsentPrompt />);
    await flush();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Cancel — диалог закрыт, решения нет, карточка остаётся; повторно сама не всплывает', async () => {
    render(<ConsentPrompt />);
    act(() => bridge.emit('consents.changed', { upsert: [card('c-01')], removed: [] }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: S.common.cancel }));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(decideCalls()).toEqual([]);
    expect(useConsentsStore.getState().cards.map((item) => item.id)).toEqual(['c-01']);
    act(() => bridge.emit('consents.changed', { upsert: [card('c-01', { at: '2026-10-21T10:01:00.000Z' })], removed: [] }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('окно неактивно — диалога нет, карточка в сторе есть', async () => {
    useUiStore.setState({ windowFocused: false });
    render(<ConsentPrompt />);
    act(() => bridge.emit('consents.changed', { upsert: [card('c-01')], removed: [] }));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useConsentsStore.getState().cards).toHaveLength(1);
  });

  it('ask() открывает диалог для отклонённой карточки (кнопка «Trust folder» в Chat)', async () => {
    render(<ConsentPrompt />);
    act(() => bridge.emit('consents.changed', { upsert: [card('c-01')], removed: [] }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: S.common.cancel }));
    await flush();
    act(() => useConsentsStore.getState().ask('c-01'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('карточку решили в другом месте — диалог закрывается', async () => {
    render(<ConsentPrompt />);
    act(() => bridge.emit('consents.changed', { upsert: [card('c-01')], removed: [] }));
    await screen.findByRole('dialog');
    act(() => bridge.emit('consents.changed', { upsert: [], removed: ['c-01'] }));
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useConsentsStore.getState().asking).toBeNull();
  });

  it('вторая карточка встаёт в очередь за первой', async () => {
    render(<ConsentPrompt />);
    act(() =>
      bridge.emit('consents.changed', {
        upsert: [card('c-01'), card('c-02', { folder: '/tmp/q', projectPath: '/tmp/q' })],
        removed: [],
      }),
    );
    await screen.findByRole('dialog');
    expect(screen.getByRole('dialog').textContent).toContain('/tmp/p');
    fireEvent.click(screen.getByRole('button', { name: S.common.cancel }));
    await flush();
    expect(screen.getByRole('dialog').textContent).toContain('/tmp/q');
  });

  it('отказ хоста на Trust — тост, диалог закрыт', async () => {
    bridge.setHandler('consents.decide', async () => {
      throw Object.assign(new Error('boom'), { code: 'internal' });
    });
    render(<ConsentPrompt />);
    act(() => bridge.emit('consents.changed', { upsert: [card('c-01')], removed: [] }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: S.dialogs.trustFolder.confirm }));
    await flush();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
