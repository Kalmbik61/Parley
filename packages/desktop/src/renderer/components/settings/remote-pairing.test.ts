import { describe, expect, it } from 'vitest';
import type { RemotePairRequest } from '../../../shared/remote-types.js';
import { INITIAL_PAIR, pairReducer, reissueDue, type PairState } from './remote-pairing.js';

const req = (id: string): RemotePairRequest => ({ requestId: id, name: 'P', platform: 'ios', sas: '111111', fingerprint: 'f', expiresAt: 1 });
const offer = (n: number) => ({ qr: `qr${n}`, expiresAt: n });

describe('pair reducer', () => {
  it('stops the reissue timer while a request waits', () => {
    let s: PairState = pairReducer(INITIAL_PAIR, { type: 'begin' });
    s = pairReducer(s, { type: 'offer', offer: offer(1) });
    expect(reissueDue(s)).toBe(true);
    s = pairReducer(s, { type: 'request', request: req('A') });
    expect(reissueDue(s)).toBe(false);
  });

  it('closes the dialog of an old request when the offer is reissued', () => {
    let s = pairReducer(INITIAL_PAIR, { type: 'begin' });
    s = pairReducer(s, { type: 'offer', offer: offer(1) });
    s = pairReducer(s, { type: 'request', request: req('A') });
    s = pairReducer(s, { type: 'offer', offer: offer(2) });
    expect(s.request).toBeNull();
    expect(s.offer?.qr).toBe('qr2');
  });

  it('a wrong code burns the offer and flags the notice', () => {
    let s = pairReducer(INITIAL_PAIR, { type: 'begin' });
    s = pairReducer(s, { type: 'offer', offer: offer(1) });
    s = pairReducer(s, { type: 'offerClosed', reason: 'bad-psk' });
    expect(s).toMatchObject({ offer: null, wrongCode: true, active: true });
    s = pairReducer(s, { type: 'offer', offer: offer(2) });
    expect(s.wrongCode).toBe(true); // stays visible above the new QR
  });

  it('"used" drops the offer without a notice; done shows the connected phone', () => {
    let s = pairReducer(INITIAL_PAIR, { type: 'begin' });
    s = pairReducer(s, { type: 'offer', offer: offer(1) });
    s = pairReducer(s, { type: 'offerClosed', reason: 'used' });
    expect(s).toMatchObject({ offer: null, wrongCode: false });
    s = pairReducer(s, { type: 'request', request: req('A') });
    s = pairReducer(s, { type: 'done', requestId: 'A' });
    expect(s).toMatchObject({ connected: true, active: false, request: null });
  });

  it('ignores a failure of another request than the open dialog', () => {
    let s = pairReducer(INITIAL_PAIR, { type: 'begin' });
    s = pairReducer(s, { type: 'request', request: req('B') });
    expect(pairReducer(s, { type: 'failed', requestId: 'A', reason: 'timeout' })).toBe(s);
    expect(pairReducer(s, { type: 'failed', requestId: 'B', reason: 'denied' }).failedReason).toBe('denied');
  });
});
