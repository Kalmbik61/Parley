import { describe, expect, it } from 'vitest';
import { normalizeRelayInput, relayInputProblem } from './relay-input.js';

describe('normalizeRelayInput', () => {
  it.each([
    ['relay.example.com', 'relay.example.com'],
    ['  relay.example.com:8443 ', 'relay.example.com:8443'],
    ['wss://relay.example.com', 'relay.example.com'],
    ['ws://192.168.1.10:8787/', '192.168.1.10:8787'],
    ['https://82-146-37-224.sslip.io', '82-146-37-224.sslip.io'],
    ['https://relay.example.com:8443/', 'relay.example.com:8443'],
    ['HTTPS://relay.example.com', 'relay.example.com'],
  ])('%s → %s', (input, expected) => expect(normalizeRelayInput(input)).toBe(expected));

  it.each(['', 'wss://relay.example.com/path', 'user@relay.example.com', 'relay.example.com:99999', 'relay example.com', 'http://relay.example.com', 'https://relay.example.com/path', 'https://user@relay.example.com'])(
    'refuses %j',
    (input) => expect(normalizeRelayInput(input)).toBeNull(),
  );
});

describe('relayInputProblem', () => {
  it.each([
    ['http://relay.example.com', 'insecure'],
    ['https://relay.example.com/path', 'invalid'],
    ['https://user@relay.example.com', 'invalid'],
    ['relay example.com', 'invalid'],
    ['https://relay.example.com', null],
    ['relay.example.com', null],
  ])('%s → %s', (input, expected) => expect(relayInputProblem(input)).toBe(expected));
});
