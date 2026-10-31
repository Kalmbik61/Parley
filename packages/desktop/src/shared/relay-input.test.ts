import { describe, expect, it } from 'vitest';
import { normalizeRelayInput } from './relay-input.js';

describe('normalizeRelayInput', () => {
  it.each([
    ['relay.example.com', 'relay.example.com'],
    ['  relay.example.com:8443 ', 'relay.example.com:8443'],
    ['wss://relay.example.com', 'relay.example.com'],
    ['ws://192.168.1.10:8787/', '192.168.1.10:8787'],
  ])('%s → %s', (input, expected) => expect(normalizeRelayInput(input)).toBe(expected));

  it.each(['', 'wss://relay.example.com/path', 'user@relay.example.com', 'relay.example.com:99999', 'relay example.com', 'https://relay.example.com'])(
    'refuses %j',
    (input) => expect(normalizeRelayInput(input)).toBeNull(),
  );
});
