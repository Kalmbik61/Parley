/** Message tokens of Noise handshake patterns (§7.1, §9). */
export type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk';

export type PatternName = 'IK' | 'IKpsk0';

export interface HandshakePattern {
  readonly name: PatternName;
  /** Pre-message of the initiator (`->`), known to the responder before the handshake. */
  readonly initiatorPre: readonly Token[];
  /** Pre-message of the responder (`<-`), known to the initiator before the handshake. */
  readonly responderPre: readonly Token[];
  /** Messages in order; even indices are written by the initiator. */
  readonly messages: readonly (readonly Token[])[];
  /** True when the pattern carries a psk token (Noise §9: `e` then also calls MixKey). */
  readonly psk: boolean;
}

// IK:
//   <- s
//   ...
//   -> e, es, s, ss
//   <- e, ee, se
const IK = Object.freeze<HandshakePattern>({
  name: 'IK',
  initiatorPre: Object.freeze<Token[]>([]),
  responderPre: Object.freeze<Token[]>(['s']),
  messages: Object.freeze([
    Object.freeze<Token[]>(['e', 'es', 's', 'ss']),
    Object.freeze<Token[]>(['e', 'ee', 'se']),
  ]),
  psk: false,
});

// IKpsk0 (Noise §9.4 naming, psk at the start of the first message):
//   <- s
//   ...
//   -> psk, e, es, s, ss
//   <- e, ee, se
const IKpsk0 = Object.freeze<HandshakePattern>({
  name: 'IKpsk0',
  initiatorPre: Object.freeze<Token[]>([]),
  responderPre: Object.freeze<Token[]>(['s']),
  messages: Object.freeze([
    Object.freeze<Token[]>(['psk', 'e', 'es', 's', 'ss']),
    Object.freeze<Token[]>(['e', 'ee', 'se']),
  ]),
  psk: true,
});

export const PATTERNS: Readonly<Record<PatternName, HandshakePattern>> = Object.freeze({
  IK,
  IKpsk0,
});
