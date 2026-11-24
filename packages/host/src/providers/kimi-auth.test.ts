import { afterEach, expect, it, vi } from 'vitest';
import { createKimiAuth } from './kimi-auth.js';
import { createKimiAcp } from '../kimi/acp.js';

vi.mock('@parley/core', async (importOriginal) => ({ ...await importOriginal<typeof import('@parley/core')>(), findRunnerBinary: async () => '/fixture/kimi' }));
vi.mock('../kimi/acp.js', () => ({ createKimiAcp: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('forces fresh native auth after login despite cached state and closes every probe', async () => {
  const checkAuth = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const close = vi.fn(async () => {});
  vi.mocked(createKimiAcp).mockReturnValue({ checkAuth, close } as unknown as ReturnType<
    typeof createKimiAcp
  >);
  const auth = createKimiAuth(() => {});
  auth.refreshIfStale('kimi');
  await vi.waitFor(() => expect(auth.current()).toBe(false));
  expect(await auth.refreshNow('kimi')).toBe(true);
  expect(checkAuth).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
  expect(vi.mocked(createKimiAcp).mock.calls[1]![0]).toMatchObject({
    command: '/fixture/kimi',
    args: ['acp'],
    mcpServers: [],
  });
  await auth.stop();
});

it('does not report stale success when the post-login probe fails', async () => {
  vi.mocked(createKimiAcp).mockReturnValue({
    checkAuth: async () => {
      throw new Error('fixture');
    },
    close: async () => {},
  } as unknown as ReturnType<typeof createKimiAcp>);
  const auth = createKimiAuth(() => {});
  auth.observe(true);
  expect(await auth.refreshNow('kimi')).toBe(false);
  await auth.stop();
});
