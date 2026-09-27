/**
 * Кусок 7.2: повтор при `files:denied` — реестр корней main отстаёт от `works.changed` окна.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DENIED_RETRY_DELAYS_MS, retryWhileDenied } from './retry.js';

afterEach(() => vi.useRealTimers());

const denied = { code: 'files:denied', message: 'unknown root' };

describe('retryWhileDenied', () => {
  it('files:denied — повторы с паузами, затем успех; прочий отказ — сразу', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValueOnce(denied).mockRejectedValueOnce(denied).mockResolvedValue('ok');
    const result = retryWhileDenied(call, () => true);
    await vi.advanceTimersByTimeAsync(DENIED_RETRY_DELAYS_MS[0]! + DENIED_RETRY_DELAYS_MS[1]!);
    await expect(result).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(3);

    const other = vi.fn().mockRejectedValue({ code: 'not_found', message: 'нет' });
    await expect(retryWhileDenied(other, () => true)).rejects.toMatchObject({ code: 'not_found' });
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('паузы кончились или компонент ушёл — отказ наружу', async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockRejectedValue(denied);
    const result = retryWhileDenied(call, () => true);
    const settled = expect(result).rejects.toMatchObject({ code: 'files:denied' });
    await vi.advanceTimersByTimeAsync(DENIED_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    await settled;
    expect(call).toHaveBeenCalledTimes(DENIED_RETRY_DELAYS_MS.length + 1);

    const gone = vi.fn().mockRejectedValue(denied);
    await expect(retryWhileDenied(gone, () => false)).rejects.toMatchObject({ code: 'files:denied' });
    expect(gone).toHaveBeenCalledTimes(1);
  });
});
