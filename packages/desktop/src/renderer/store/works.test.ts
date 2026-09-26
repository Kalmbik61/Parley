import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { orderedWorks, useWorksStore } from './works.js';
import type { WorkEntry } from '@harnas/core';

function entry(id: string, createdAt: string): WorkEntry {
  return {
    projectPath: '/tmp/proj',
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id, title: id, goal: '', status: 'active', createdAt, updatedAt: createdAt },
      sessions: [],
      messages: [],
    },
  };
}

beforeEach(() => {
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
});

describe('useWorksStore.init', () => {
  it('запрашивает works.list при старте', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => ({ entries: [entry('w-01', '2026-01-01')], branches: {} }));

    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    expect(useWorksStore.getState().entries).toHaveLength(1);
    expect(useWorksStore.getState().loading).toBe(false);
    dispose();
  });

  it('works.changed обновляет список без повторного call', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => ({ entries: [], branches: {} }));
    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    bridge.emit('works.changed', { entries: [entry('w-02', '2026-01-02')], branches: { '/tmp/proj': 'main' } });

    expect(useWorksStore.getState().entries.map((item) => item.map.work.id)).toEqual(['w-02']);
    expect(useWorksStore.getState().branches).toEqual({ '/tmp/proj': 'main' });
    dispose();
  });

  it('ошибка call — error в сторе, а не падение', async () => {
    const bridge = createFakeBridge();
    // Нет setHandler('works.list', ...) — fake-bridge сам отклонит вызов.
    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    expect(useWorksStore.getState().error).not.toBeNull();
    expect(useWorksStore.getState().loading).toBe(false);
    dispose();
  });

  it('dispose снимает подписку — works.changed после неё не применяется', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => ({ entries: [], branches: {} }));
    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();
    dispose();

    bridge.emit('works.changed', { entries: [entry('w-03', '2026-01-03')], branches: {} });

    expect(useWorksStore.getState().entries).toEqual([]);
  });
});

describe('orderedWorks', () => {
  it('сортирует по времени создания', () => {
    const b = entry('w-b', '2026-01-02');
    const a = entry('w-a', '2026-01-01');
    expect(orderedWorks([b, a]).map((item) => item.map.work.id)).toEqual(['w-a', 'w-b']);
  });
});
