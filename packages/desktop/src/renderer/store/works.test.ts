import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { orderedWorks, useWorksStore } from './works.js';
import type { WindowWorkEntry } from '@parley/core';

function entry(id: string, createdAt: string): WindowWorkEntry {
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

  // Хост рассылает снимок ещё до ворот `worksReady` (разбор 2026-10-14): окно уже рисует комнату, а методы снимка
  // (`rooms.resolveProposal`) ждут. Готовность — только ответ `works.list`; переподключение начинает её заново.
  it('ready — только после ответа works.list: рассылка до него ворот не открывает', async () => {
    const bridge = createFakeBridge();
    let answer!: () => void;
    bridge.setHandler(
      'works.list',
      () => new Promise((resolve) => (answer = () => resolve({ entries: [entry('w-01', '2026-01-01')], branches: {} }))),
    );
    useWorksStore.setState({ ready: true });
    const dispose = useWorksStore.getState().init(bridge);
    expect(useWorksStore.getState().ready).toBe(false);

    bridge.emit('works.changed', { entries: [entry('w-01', '2026-01-01')], branches: {} });
    expect(useWorksStore.getState().loading).toBe(false);
    expect(useWorksStore.getState().ready).toBe(false);

    answer();
    await vi.waitFor(() => expect(useWorksStore.getState().ready).toBe(true));
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
    // Снимка нет — «загружено» не наступило (lane-r5): иначе пустой список сошёл бы за ответ хоста,
    // и первый снимок раскладок (retainLayouts) стёр бы сохранённые вкладки всех работ.
    expect(useWorksStore.getState().loading).toBe(true);
    dispose();
  });

  it('отказ хоста с причиной — error несёт код и причину; прежний снимок не трогается (lane-r5)', async () => {
    const bridge = createFakeBridge();
    const kept = entry('w-01', '2026-01-01');
    useWorksStore.setState({ entries: [kept], branches: {}, loading: false, error: null });
    bridge.setHandler('works.list', () => {
      // Причина — в `data.reason`, как у ошибок git 8.2a (форма ветки после слияния).
      throw { code: 'internal', message: 'работы не прочитаны', data: { reason: 'works-unreadable' } };
    });
    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    expect(useWorksStore.getState().error).toEqual({ code: 'internal', reason: 'works-unreadable' });
    expect(useWorksStore.getState().entries).toEqual([kept]);
    expect(useWorksStore.getState().loading).toBe(false);
    dispose();
  });

  it('data.reason не строкой — причины нет (reason: null), остаётся код (слияние с 8.2a)', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => {
      throw { code: 'internal', message: 'x', data: { reason: 7 } };
    });
    const dispose = useWorksStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    expect(useWorksStore.getState().error).toEqual({ code: 'internal', reason: null });
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
