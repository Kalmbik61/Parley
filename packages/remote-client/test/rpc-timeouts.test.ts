import { describe, expect, it } from 'vitest';
import { VOICE_PREPARE_PHONE_TIMEOUT_MS } from '@parley/protocol/remote';
import { BRIDGE_CALL_DEADLINE_MS, RPC_MUTATING_TIMEOUT_MS, RPC_TIMEOUT_MS, defaultTimeoutFor } from '../src/rpc.js';

describe('таймауты вызовов', () => {
  it('voice.session.prepare ждёт дольше остальных долгих вызовов', () => {
    expect(defaultTimeoutFor('voice.session.prepare')).toBe(VOICE_PREPARE_PHONE_TIMEOUT_MS);
    expect(VOICE_PREPARE_PHONE_TIMEOUT_MS).toBeGreaterThan(RPC_MUTATING_TIMEOUT_MS);
  });

  it('jobs.submit и cards.decide — изменяющие вызовы (дольше срока моста), чтения — по умолчанию', () => {
    expect(defaultTimeoutFor('jobs.submit')).toBe(RPC_MUTATING_TIMEOUT_MS);
    expect(defaultTimeoutFor('cards.decide')).toBe(RPC_MUTATING_TIMEOUT_MS);
    expect(RPC_MUTATING_TIMEOUT_MS).toBeGreaterThan(BRIDGE_CALL_DEADLINE_MS);
    expect(defaultTimeoutFor('jobs.get')).toBe(RPC_TIMEOUT_MS);
  });
});
