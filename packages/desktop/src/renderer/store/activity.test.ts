import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refKey, type SessionRef } from '@harnas/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { activityFor, useActivityStore, type ActivityEntry } from './activity.js';

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' };

beforeEach(() => {
  useActivityStore.setState({ byRef: {} });
});

describe('useActivityStore', () => {
  it('activity.changed кладёт запись по refKey', () => {
    const bridge = createFakeBridge();
    const dispose = useActivityStore.getState().init(bridge);

    bridge.emit('activity.changed', {
      ref,
      activity: { activity: 'blocked', subagents: 0, turnEndedAt: null, lastEventAt: null, source: 'hooks', exited: false, hooksMissing: false },
      metrics: null,
    });

    expect(activityFor(useActivityStore.getState().byRef, ref)?.activity.activity).toBe('blocked');
    dispose();
  });

  it('dispose снимает подписку', () => {
    const bridge = createFakeBridge();
    const dispose = useActivityStore.getState().init(bridge);
    dispose();

    bridge.emit('activity.changed', {
      ref,
      activity: { activity: 'working', subagents: 0, turnEndedAt: null, lastEventAt: null, source: 'hooks', exited: false, hooksMissing: false },
      metrics: null,
    });

    expect(activityFor(useActivityStore.getState().byRef, ref)).toBeNull();
  });
});

describe('useActivityStore: снимок активности из main (раунд исправлений 1 куска 3.1)', () => {
  const entry = (state: 'blocked' | 'working' | 'idle'): ActivityEntry => ({
    ref,
    activity: { activity: state, subagents: 0, turnEndedAt: null, lastEventAt: null, source: 'hooks', exited: false, hooksMissing: false },
    metrics: null,
  });

  it('событие пришло до подписки рендерера — после init оно в сторе; повторная подписка снова получает снимок', async () => {
    const bridge = createFakeBridge();
    // Повтор хоста после hello: main его запомнил, рендерер ещё не подписан.
    bridge.setActivitySnapshot([entry('blocked')]);

    const dispose = useActivityStore.getState().init(bridge);
    await vi.waitFor(() =>
      expect(activityFor(useActivityStore.getState().byRef, ref)?.activity.activity).toBe('blocked'),
    );
    dispose();

    // Перезагрузка окна: стор пуст, подписка заново.
    useActivityStore.setState({ byRef: {} });
    const again = useActivityStore.getState().init(bridge);
    await vi.waitFor(() =>
      expect(activityFor(useActivityStore.getState().byRef, ref)?.activity.activity).toBe('blocked'),
    );
    again();
  });

  it('живое событие после подписки не перетирается снимком, пришедшим позже', async () => {
    const bridge = createFakeBridge();
    let answer: (entries: ActivityEntry[]) => void = () => {};
    bridge.activitySnapshot = () => new Promise((resolve) => (answer = resolve));

    const dispose = useActivityStore.getState().init(bridge);
    bridge.emit('activity.changed', entry('working'));
    answer([entry('blocked')]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(activityFor(useActivityStore.getState().byRef, ref)?.activity.activity).toBe('working');
    dispose();
  });
});

describe('activityFor', () => {
  it('null для незнакомого refKey', () => {
    expect(activityFor({}, ref)).toBeNull();
  });

  it('ключ строится тем же refKey, что и у store', () => {
    const entry = {
      ref,
      activity: { activity: 'idle' as const, subagents: 0, turnEndedAt: null, lastEventAt: null, source: 'log' as const, exited: false, hooksMissing: false },
      metrics: null,
    };
    expect(activityFor({ [refKey(ref)]: entry }, ref)).toBe(entry);
  });
});
