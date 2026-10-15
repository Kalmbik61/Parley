import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { compactSession } from './compact-actions.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const ref = { projectPath: '/p', workId: 'w-01', sessionId: 's-01' };

afterEach(() => vi.clearAllMocks());

describe('compactSession: ошибка вызова', () => {
  it('без quiet — тост', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.compact', () => {
      throw new Error('boom');
    });
    expect(await compactSession(bridge, ref, 'S01', null)).toBeNull();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('quiet — без тоста (итог даёт Compact all), результат null', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('sessions.compact', () => {
      throw new Error('boom');
    });
    expect(await compactSession(bridge, ref, 'S01', null, { quiet: true })).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});
