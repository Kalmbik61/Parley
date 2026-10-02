import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { resetThumbnailCacheForTests, useThumbnail } from './use-thumbnail.js';

const PNG = 'data:image/png;base64,AAAA';

let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
  resetThumbnailCacheForTests();
});

afterEach(() => {
  cleanup();
});

describe('useThumbnail', () => {
  it('пока ответа нет — null, потом data-URL; запрос один', async () => {
    bridge.setThumbnail('/a.png', PNG);
    const { result } = renderHook(() => useThumbnail(bridge, '/a.png'));
    expect(result.current).toBeNull();
    await act(async () => {});
    expect(result.current).toBe(PNG);
    expect(bridge.thumbnailCalls).toEqual(['/a.png']);
  });

  it('второе монтирование того же пути (строку ленты размонтировали и вернули) — миниатюра на первой же отрисовке, без нового запроса', async () => {
    bridge.setThumbnail('/a.png', PNG);
    const first = renderHook(() => useThumbnail(bridge, '/a.png'));
    await act(async () => {});
    first.unmount();
    const second = renderHook(() => useThumbnail(bridge, '/a.png'));
    expect(second.result.current).toBe(PNG);
    await act(async () => {});
    expect(bridge.thumbnailCalls).toEqual(['/a.png']);
  });

  it('два чипа одного пути сразу — один запрос, обоим приходит ответ', async () => {
    bridge.setThumbnail('/a.png', PNG);
    const one = renderHook(() => useThumbnail(bridge, '/a.png'));
    const two = renderHook(() => useThumbnail(bridge, '/a.png'));
    await act(async () => {});
    expect([one.result.current, two.result.current]).toEqual([PNG, PNG]);
    expect(bridge.thumbnailCalls).toEqual(['/a.png']);
  });

  it('нет моста или пути — null и ни одного запроса', async () => {
    const withoutBridge = renderHook(() => useThumbnail(null, '/a.png'));
    const withoutPath = renderHook(() => useThumbnail(bridge, null));
    await act(async () => {});
    expect([withoutBridge.result.current, withoutPath.result.current]).toEqual([null, null]);
    expect(bridge.thumbnailCalls).toEqual([]);
  });

  it('миниатюры нет (ответ null) или сбой IPC — null, и тот же путь заново не просят', async () => {
    const missing = renderHook(() => useThumbnail(bridge, '/gone.png'));
    bridge.app.imageThumbnail = () => Promise.reject(new Error('ipc'));
    const broken = renderHook(() => useThumbnail(bridge, '/broken.png'));
    await act(async () => {});
    expect([missing.result.current, broken.result.current]).toEqual([null, null]);
    missing.unmount();
    renderHook(() => useThumbnail(bridge, '/gone.png'));
    expect(bridge.thumbnailCalls).toEqual(['/gone.png']);
  });

  it('смена пути в том же компоненте — миниатюра нового пути, а не прежнего', async () => {
    bridge.setThumbnail('/a.png', 'A');
    bridge.setThumbnail('/b.png', 'B');
    const { result, rerender } = renderHook(({ path }) => useThumbnail(bridge, path), { initialProps: { path: '/a.png' } });
    await act(async () => {});
    expect(result.current).toBe('A');
    rerender({ path: '/b.png' });
    expect(result.current).toBeNull();
    await act(async () => {});
    expect(result.current).toBe('B');
  });

  it('кэш помнит не больше 200 путей: самый старый забывается и просится заново', async () => {
    for (let index = 0; index <= 200; index += 1) {
      const path = `/p${index}.png`;
      bridge.setThumbnail(path, `T${index}`);
      const view = renderHook(() => useThumbnail(bridge, path));
      await act(async () => {});
      view.unmount();
    }
    expect(bridge.thumbnailCalls).toHaveLength(201);
    // Свежий путь в кэше: ответ сразу и без запроса.
    const fresh = renderHook(() => useThumbnail(bridge, '/p200.png'));
    expect(fresh.result.current).toBe('T200');
    expect(bridge.thumbnailCalls).toHaveLength(201);
    // Самый старый вытеснен: пусто, пока не придёт новый ответ.
    const oldest = renderHook(() => useThumbnail(bridge, '/p0.png'));
    expect(oldest.result.current).toBeNull();
    await act(async () => {});
    expect(oldest.result.current).toBe('T0');
    expect(bridge.thumbnailCalls).toHaveLength(202);
  });
});
