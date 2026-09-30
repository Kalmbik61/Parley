import { beforeEach, describe, expect, it } from 'vitest';
import type { HostNotice } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { useNoticesStore } from './notices.js';

const notice = (text: string): HostNotice => ({ kind: 'launch-failed', ref: null, text, at: '2026-01-01T00:00:00.000Z' });

beforeEach(() => {
  useNoticesStore.setState({ notices: [] });
});

describe('useNoticesStore', () => {
  it('новые уведомления идут сверху', () => {
    const bridge = createFakeBridge();
    const dispose = useNoticesStore.getState().init(bridge);

    bridge.emit('host.notice', notice('первое'));
    bridge.emit('host.notice', notice('второе'));

    expect(useNoticesStore.getState().notices.map((n) => n.text)).toEqual(['второе', 'первое']);
    dispose();
  });

  it('не больше 20 записей', () => {
    const bridge = createFakeBridge();
    const dispose = useNoticesStore.getState().init(bridge);

    for (let i = 0; i < 25; i += 1) bridge.emit('host.notice', notice(`№${i}`));

    expect(useNoticesStore.getState().notices).toHaveLength(20);
    expect(useNoticesStore.getState().notices[0]?.text).toBe('№24');
    dispose();
  });
});
