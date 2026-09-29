/**
 * Черновики полей ввода комнат (дизайн комнат, 3.4, решение контролёра 6 куска 6): по ключу
 * `{workKey}/{roomId}`, только в памяти окна. Отдельный файл рядом с `ui.test.ts`: тот же стор,
 * но черновики — своя тема, и параллельный кусок сайдбара правит `ui.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { composerDraftKey, useUiStore } from './ui.js';

beforeEach(() => {
  useUiStore.setState({ composerDrafts: {} });
});

describe('useUiStore.composerDrafts', () => {
  it('ключ черновика — `{workKey}/{roomId}`: id комнаты повторяются от работы к работе', () => {
    expect(composerDraftKey('/tmp/proj w-01', 'r-01')).toBe('/tmp/proj w-01/r-01');
    expect(composerDraftKey('/tmp/proj w-02', 'r-01')).not.toBe(composerDraftKey('/tmp/proj w-01', 'r-01'));
  });

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
