import { expect, it } from 'vitest';
import { kimiHookLaunch } from './hook-bridge.js';

it('never derives a hook channel for ordinary Kimi, and refuses a non-loopback endpoint', () => {
  const values = { PARLEY_HOOK_TOKEN: '0'.repeat(64), PARLEY_SESSION_ID: 's-01', PARLEY_HOOK_URL: 'http://127.0.0.1:1234/hooks' };
  expect(kimiHookLaunch(values)).toBeUndefined();
  expect(kimiHookLaunch({ ...values, PARLEY_KIMI_NATIVE: '1', PARLEY_HOOK_URL: 'http://example.invalid/hooks' })).toBeUndefined();
  expect(kimiHookLaunch({ ...values, PARLEY_KIMI_NATIVE: '1' })?.url.origin).toBe('http://127.0.0.1:1234');
});
