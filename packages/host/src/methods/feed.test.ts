import { describe, expect, it, vi } from 'vitest';
import { FEED_PROGRESS_MAX_BYTES, progressResult } from '@parley/protocol';
import { fakeClient, REF } from '../../test/feed-fakes.js';
import type { RequestInfo } from '../context.js';
import type { FeedService } from '../feed/feed-service.js';
import { createFeedHandlers } from './feed.js';

const empty = { revision: 7, availability: 'available', current: null, recent: [], truncated: false };
const request = { client: fakeClient() } as unknown as RequestInfo;

describe('feed.progress handler', () => {
  it('passes the exact request client and ref to the service', async () => {
    const progress = vi.fn().mockResolvedValue(empty);
    const handlers = createFeedHandlers({ feed: { progress } as unknown as FeedService });
    expect(await handlers.feedProgress({ ref: REF }, request)).toEqual(empty);
    expect(progress).toHaveBeenCalledWith(REF, request.client);
  });

  it.each([
    { ...empty, name: 'SECRET' },
    { ...empty, current: { id: 'secret', status: 'running' } },
    { ...empty, recent: Array.from({ length: 21 }, (_, id) => ({ id: String(id) })) },
    { ...empty, path: 'SECRET'.repeat(FEED_PROGRESS_MAX_BYTES) },
  ])('validates the complete service result before transport and fails closed without raw data', async (bad) => {
    const handlers = createFeedHandlers({ feed: { progress: vi.fn().mockResolvedValue(bad) } as unknown as FeedService });
    const result = await handlers.feedProgress({ ref: REF }, request);
    expect(result).toMatchObject({ revision: 7, availability: 'unavailable', current: null, recent: [], truncated: false });
    expect(progressResult.safeParse(result).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(FEED_PROGRESS_MAX_BYTES);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('preserves the explicit quota conflict for the renderer backoff', async () => {
    const conflict = { code: 'conflict', data: { reason: 'island-progress-rate-limit', retryAfterMs: 250 } };
    const handlers = createFeedHandlers({ feed: { progress: vi.fn().mockRejectedValue(conflict) } as unknown as FeedService });
    await expect(handlers.feedProgress({ ref: REF }, request)).rejects.toBe(conflict);
  });

  it.each([null, undefined, { ...empty, revision: -1 }, { ...empty, revision: Number.NaN }])('uses revision zero when the service has no valid feed revision', async (bad) => {
    const handlers = createFeedHandlers({ feed: { progress: vi.fn().mockResolvedValue(bad) } as unknown as FeedService });
    expect(await handlers.feedProgress({ ref: REF }, request)).toEqual({ revision: 0, availability: 'unavailable', current: null, recent: [], truncated: false });
  });
});
