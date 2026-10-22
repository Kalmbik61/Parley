import { startProviderVersions } from '../providers/versions.js';
import { describe, expect, it, vi } from 'vitest';
import type { RequestInfo } from '../context.js';
import type { LimitsService } from '../limits/limits-service.js';
import { ZaiQuotaError } from '../limits/zai-quota.js';
import { createProvidersRefreshLimits } from './providers.js';

describe('providers.refreshLimits', () => {
  it('refreshes a known old version and safely clears it when probing fails', async () => {
    let version: string | null = '0.159.0';
    const versions = startProviderVersions(async () => {
      if (version === null) throw new Error('probe failed');
      return version;
    }, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await versions.ready;
    const refresh = vi.fn().mockResolvedValue(undefined);
    const handler = createProvidersRefreshLimits({ refresh } as unknown as LimitsService, versions);
    version = '0.162.0';
    expect(await handler({}, {} as RequestInfo)).toEqual({ ok: true });
    expect(versions.get('codex')).toBe('0.162.0');
    version = null;
    expect(await handler({}, {} as RequestInfo)).toEqual({ ok: true });
    expect(versions.get('codex')).toBeNull();
  });

  it('awaits all-provider refresh with explicit GLM opt-in', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const handler = createProvidersRefreshLimits({ refresh } as unknown as LimitsService);
    expect(await handler({}, {} as RequestInfo)).toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledWith(true);
  });
  it('просит службу входа перепроверить аккаунты (К5), но её не ждёт', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    let finish!: () => void;
    const refreshAll = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const handler = createProvidersRefreshLimits({ refresh } as unknown as LimitsService, undefined, { refreshAll });
    // Ответ не ждёт зависшую проверку входа.
    expect(await handler({}, {} as RequestInfo)).toEqual({ ok: true });
    expect(refreshAll).toHaveBeenCalledTimes(1);
    finish();
  });

  it('returns only a safe error when any GLM request fails', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('upstream leaked synthetic-key'));
    const handler = createProvidersRefreshLimits({ refresh } as unknown as LimitsService);
    const error = await handler({}, {} as RequestInfo).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'internal', message: 'Unable to refresh GLM quota', data: { provider: 'glm', reason: 'unavailable' } });
    expect(JSON.stringify(error)).not.toContain('synthetic-key');
    expect(error).not.toHaveProperty('cause');
  });

  it.each(['authentication', 'unsupported_response', 'timeout', 'unavailable'] as const)(
    'returns only the allowlisted %s reason', async (reason) => {
      const failure = Object.assign(new ZaiQuotaError(reason), { upstream: 'synthetic-key', cause: new Error('/private/host/path') });
      const refresh = vi.fn().mockRejectedValue(failure);
      const handler = createProvidersRefreshLimits({ refresh } as unknown as LimitsService);
      const error = await handler({}, {} as RequestInfo).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'internal', message: 'Unable to refresh GLM quota' });
      expect(error).toHaveProperty('data', { provider: 'glm', reason });
      expect(JSON.stringify(error)).not.toContain('synthetic-key');
      expect(JSON.stringify(error)).not.toContain('/private/host/path');
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('upstream');
    },
  );
});
