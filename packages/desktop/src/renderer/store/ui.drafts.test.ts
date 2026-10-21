/**
 * Черновики полей ввода комнат (дизайн комнат, 3.4, решение контролёра 6 куска 6): по ключу
 * `{workKey}/{roomId}` (`roomKey`, `lib/room-view.ts`), только в памяти окна. Отдельный файл рядом с `ui.test.ts`: тот же стор,
 * но черновики — своя тема, и параллельный кусок сайдбара правит `ui.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { useUiStore } from './ui.js';

beforeEach(() => {
  useUiStore.setState({ composerDrafts: {} });
});

describe('useUiStore.composerDrafts', () => {
  it('черновик пишется по ключу комнаты, у разных комнат — свой', () => {
    useUiStore.getState().setComposerDraft('/tmp/p w-01/r-01', 'привет @s02');
    useUiStore.getState().setComposerDraft('/tmp/p w-01/r-02', 'другое');
    expect(useUiStore.getState().composerDrafts).toEqual({
      '/tmp/p w-01/r-01': 'привет @s02',
      '/tmp/p w-01/r-02': 'другое',
    });
  });

  it('пустой черновик убирает ключ, а не копит пустые строки', () => {
    useUiStore.getState().setComposerDraft('/tmp/p w-01/r-01', 'текст');
    useUiStore.getState().setComposerDraft('/tmp/p w-01/r-01', '');
    expect(useUiStore.getState().composerDrafts).toEqual({});
  });

  it('повтор того же текста стор не меняет: подписчики не перерисовываются зря', () => {
    useUiStore.getState().setComposerDraft('/tmp/p w-01/r-01', 'текст');
    const before = useUiStore.getState().composerDrafts;
    useUiStore.getState().setComposerDraft('/tmp/p w-01/r-01', 'текст');
    expect(useUiStore.getState().composerDrafts).toBe(before);
    useUiStore.getState().setComposerDraft('/tmp/p w-01/r-02', '');
    expect(useUiStore.getState().composerDrafts).toBe(before);
  });

  it('черновики живут только в памяти: в ui.json (app.saveUi) не уходят', async () => {
    const bridge = createFakeBridge();
    const dispose = useUiStore.getState().init(bridge);
    await vi.waitFor(() => expect(useUiStore.getState().uiLoaded).toBe(true));
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    useUiStore.getState().setComposerDraft('/tmp/p w-01/r-01', 'текст');
    expect(saveUi).not.toHaveBeenCalled();
    dispose();
  });
});

describe('useUiStore.decisionDrafts', () => {
  beforeEach(() => {
    useUiStore.setState({ decisionDrafts: {} });
  });

  it('запись по ключу; закрытая форма с заметкой хранится', () => {
    useUiStore.getState().setDecisionDraft('k', { open: false, note: 'текст' });
    expect(useUiStore.getState().decisionDrafts).toEqual({ k: { open: false, note: 'текст' } });
  });

  it('null и закрытая форма с пустой заметкой убирают запись', () => {
    useUiStore.getState().setDecisionDraft('k', { open: true, note: '' });
    useUiStore.getState().setDecisionDraft('k', null);
    expect(useUiStore.getState().decisionDrafts).toEqual({});
    useUiStore.getState().setDecisionDraft('k', { open: true, note: 'a' });
    useUiStore.getState().setDecisionDraft('k', { open: false, note: '' });
    expect(useUiStore.getState().decisionDrafts).toEqual({});
  });

  it('то же значение стор не меняет', () => {
    useUiStore.getState().setDecisionDraft('k', { open: true, note: 'a' });
    const before = useUiStore.getState().decisionDrafts;
    useUiStore.getState().setDecisionDraft('k', { open: true, note: 'a' });
    expect(useUiStore.getState().decisionDrafts).toBe(before);
    useUiStore.getState().setDecisionDraft('other', null);
    expect(useUiStore.getState().decisionDrafts).toBe(before);
  });
});
