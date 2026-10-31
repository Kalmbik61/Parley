// Critic m5: for `incoming {kind: 'connect'}` the relay-named device is required; without it the stream is not
// accepted, so the §7.5 binding check can never be skipped.
import { describe, expect, it } from 'vitest';
import type { AuditLog } from './audit.js';
import type { DeviceStore } from './devices.js';
import type { BridgeKeys } from './keys.js';
import type { BridgeLog } from './log.js';
import { SessionManager } from './sessions.js';

describe('SessionManager.handleIncoming', () => {
  it('ignores a connect stream without a relay-named device', async () => {
    let accepted = 0;
    const manager = new SessionManager({
      keys: () => ({}) as BridgeKeys,
      devices: {} as DeviceStore,
      link: {
        accept: () => {
          accepted += 1;
          throw new Error('must not accept');
        },
      },
      audit: { append: () => {}, tail: () => [] } as AuditLog,
      log: { info() {}, warn() {}, error() {}, addSecret() {} } as BridgeLog,
    });
    await manager.handleIncoming({ stream: 's1', kind: 'connect' });
    expect(accepted).toBe(0);
  });
});
