import { beforeEach, describe, expect, it } from 'vitest';
import { refKey, type SessionRef } from '@harnas/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { activityFor, useActivityStore } from './activity.js';

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
