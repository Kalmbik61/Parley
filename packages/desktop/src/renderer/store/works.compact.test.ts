import { beforeEach, describe, expect, it } from 'vitest';
import type { MapCompact, Message, WorkEntry } from '@parley/core';
import type { WorksSnapshot } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { makeLetter, makeRoom, makeWork } from '../test-utils/work-fixtures.js';
import { useWorksStore } from './works.js';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const note = (id: string): Message => makeLetter(id, { roomId: 'r-01', to: [], from: 's-01', readBy: { human: 'x' } });
const meta = (total: number, tailFrom: number): MapCompact => ({
  version: 1,
  messages: { total, included: 0, latestId: `m-${total}`, rooms: { 'r-01': { total, included: 0, tailFrom } } },
  unread: { letters: 0, rooms: {} },
  cut: [],
  omitted: {},
});

function entry(messages: Message[], total: number, tailFrom: number): WorkEntry {
  const base = makeWork('w-01', { rooms: [makeRoom('r-01', 'К')], messages });
  return { ...base, map: { ...base.map, compact: meta(total, tailFrom) } };
}

const snapshot = (revision: number | undefined, entries: WorkEntry[]): WorksSnapshot => ({
  entries,
  branches: {},
  ...(revision === undefined ? {} : { revision }),
});

beforeEach(() => {
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
});

describe('useWorksStore: номер снимка (P35)', () => {
  it('устаревший ответ works.list после свежего события не откатывает список', async () => {
    const bridge = createFakeBridge();
    let answer: (value: WorksSnapshot) => void = () => {};
    bridge.setHandler('works.list', () => new Promise<WorksSnapshot>((resolve) => (answer = resolve)));
    const dispose = useWorksStore.getState().init(bridge);

    bridge.emit('works.changed', snapshot(5, [entry([note('m-05')], 5, 5)]));
    answer(snapshot(4, [entry([note('m-04')], 4, 4)]));
    await flush();

    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-05']);
    // Равный номер — повтор, не новее.
    bridge.emit('works.changed', snapshot(5, [entry([], 5, 5)]));
    expect(useWorksStore.getState().entries[0]?.map.messages).toHaveLength(1);
    bridge.emit('works.changed', snapshot(6, [entry([note('m-06')], 6, 6)]));
    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-05', 'm-06']);
    dispose();
  });

  it('после переподключения (новый init) отсчёт начинается заново: хост мог быть другим процессом', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => snapshot(900, [entry([note('m-01')], 1, 1)]));
    const first = useWorksStore.getState().init(bridge);
    await flush();
    first();

    const restarted = createFakeBridge();
    restarted.setHandler('works.list', () => snapshot(1, [makeWork('w-02', { title: 'Новый' })]));
    const second = useWorksStore.getState().init(restarted);
    await flush();
    expect(useWorksStore.getState().entries.map((item) => item.map.work.id)).toEqual(['w-02']);
    second();
  });

  it('хост до P35 без номера — снимки применяются в порядке прихода', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => snapshot(undefined, [makeWork('w-01')]));
    const dispose = useWorksStore.getState().init(bridge);
    await flush();
    bridge.emit('works.changed', snapshot(undefined, [makeWork('w-02')]));
    bridge.emit('works.changed', snapshot(undefined, [makeWork('w-03')]));
    expect(useWorksStore.getState().entries.map((item) => item.map.work.id)).toEqual(['w-03']);
    dispose();
  });

  it('хвост сдвинулся — письма, что человек уже видел, остаются в ленте; страница старых встаёт на место', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('works.list', () => snapshot(1, [entry([note('m-03'), note('m-04')], 4, 3)]));
    const dispose = useWorksStore.getState().init(bridge);
    await flush();

    bridge.emit('works.changed', snapshot(2, [entry([note('m-04'), note('m-05')], 5, 4)]));
    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-03', 'm-04', 'm-05']);

    useWorksStore.getState().addMessages('/tmp/proj', 'w-01', [note('m-01'), note('m-02')]);
    expect(useWorksStore.getState().entries[0]?.map.messages.map((message) => message.id)).toEqual(['m-01', 'm-02', 'm-03', 'm-04', 'm-05']);
    // Чужая работа не затронута.
    useWorksStore.getState().addMessages('/tmp/other', 'w-01', [note('m-99')]);
    expect(useWorksStore.getState().entries[0]?.map.messages).toHaveLength(5);
    dispose();
  });
});
