import type { ProviderLimits } from '@parley/core';

/** Fixed read-only endpoint used by the official Z.ai coding plugins quota script. */
export const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
export const ZAI_QUOTA_TIMEOUT_MS = 10_000;
export const ZAI_QUOTA_MAX_BYTES = 256 * 1024;

export type ZaiQuotaFailureReason = 'authentication' | 'unsupported_response' | 'timeout' | 'unavailable';

/** Safe to return or log: never retain upstream messages, headers, bodies, or causes. */
export class ZaiQuotaError extends Error {
  constructor(readonly reason: ZaiQuotaFailureReason = 'unavailable') {
    super(reason === 'authentication' ? 'GLM quota authentication failed' : 'Unable to refresh GLM quota');
    this.name = 'ZaiQuotaError';
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

/** Only the legacy single unqualified token quota is documented as five-hour usage. */
export function zaiQuotaOf(value: unknown, at: string): ProviderLimits {
  const response = record(value);
  if (response?.success === false || response?.code === 401 || response?.code === '401') {
    throw new ZaiQuotaError(response.code === 401 || response.code === '401'
      ? 'authentication' : 'unavailable');
  }
  const data = record(response?.data);
  const limits = data?.limits;
  if (!Array.isArray(limits)) throw new ZaiQuotaError('unsupported_response');
  const tokens = limits.map(record).filter((item) => item?.type === 'TOKENS_LIMIT');
  if (tokens.length !== 1) throw new ZaiQuotaError('unsupported_response');
  const token = tokens[0]!;
  // No verified mapping exists for typed/tagged windows, credit, tool, or monthly quotas.
  if (Object.hasOwn(token, 'unit') || Object.hasOwn(token, 'number')) throw new ZaiQuotaError('unsupported_response');
  const percentage = token.percentage;
  if (typeof percentage !== 'number' || !Number.isFinite(percentage)) throw new ZaiQuotaError('unsupported_response');
  return {
    fiveHour: { usedPercent: Math.max(0, Math.min(100, percentage)), resetsAt: null },
    week: null,
    at,
    source: 'zai',
  };
}

export interface ZaiQuotaOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** Raw Authorization follows the official script; redirect credentials are never forwarded. */
export async function readZaiQuota(key: string, options: ZaiQuotaOptions = {}): Promise<ProviderLimits> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ZaiQuotaError('timeout'));
    }, ZAI_QUOTA_TIMEOUT_MS);
  });
  const read = async (): Promise<ProviderLimits> => {
    const response = await (options.fetch ?? globalThis.fetch)(ZAI_QUOTA_URL, {
      method: 'GET', headers: { Authorization: key, Accept: 'application/json' },
      redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) throw new ZaiQuotaError(response.status === 401
      ? 'authentication' : 'unavailable');
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > ZAI_QUOTA_MAX_BYTES) {
      controller.abort();
      throw new ZaiQuotaError();
    }
    const reader = response.body?.getReader();
    if (reader === undefined) throw new ZaiQuotaError('unsupported_response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > ZAI_QUOTA_MAX_BYTES) throw new ZaiQuotaError();
        chunks.push(chunk.value);
      }
    } catch {
      controller.abort();
      void reader.cancel().catch(() => {});
      throw new ZaiQuotaError();
    } finally {
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ZaiQuotaError('unsupported_response');
    }
    return zaiQuotaOf(value, new Date((options.now ?? Date.now)()).toISOString());
  };
  try {
    return await Promise.race([read(), timeout]);
  } catch (error) {
    if (timedOut) throw new ZaiQuotaError('timeout');
    if (error instanceof ZaiQuotaError) throw error;
    throw new ZaiQuotaError();
  } finally {
    clearTimeout(timer);
  }
}
