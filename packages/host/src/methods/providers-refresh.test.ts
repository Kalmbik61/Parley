import { describe, expect, it, vi } from 'vitest';
import type { RequestInfo } from '../context.js';
import type { LimitsService } from '../limits/limits-service.js';
import { createProvidersRefreshLimits } from './providers.js';

describe('providers.refreshLimits', () => {
  it('awaits all-provider refresh with explicit GLM opt-in', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const handler = createProvidersRefreshLimits({ refresh } as unknown as LimitsService);
    expect(await handler({}, {} as RequestInfo)).toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledWith(true);
  });
  it('returns only a safe error when any GLM request fails', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('upstream leaked synthetic-key'));
    const handler = createProvidersRefreshLimits({ refresh } as unknown as LimitsService);
    await expect(handler({}, {} as RequestInfo)).rejects.toMatchObject({ code: 'internal', message: 'Unable to refresh GLM quota' });
  });
});
