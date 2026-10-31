import type { RemotePairOffer, RemotePairRequest } from '../../../shared/remote-types.js';

/**
 * State of the «Pair a device» block (spec 7.3–7.4, 5.3). A pure reducer so the stale-request rules are testable:
 * - a new offer closes a waiting request dialog (`pair.start` cancels it in the bridge);
 * - the reissue timer is paused while a request is open;
 * - a dialog answers with the `requestId` of the request it was opened for — see `answerTarget`.
 */
export interface PairState {
  /** The user pressed «Pair a device» and has not cancelled: offers are reissued while this is on. */
  active: boolean;
  offer: RemotePairOffer | null;
  request: RemotePairRequest | null;
  /** `pair.offerClosed` with a wrong code: shown above the new QR. */
  wrongCode: boolean;
  connected: boolean;
  failedReason: string | null;
}

export const INITIAL_PAIR: PairState = {
  active: false,
  offer: null,
  request: null,
  wrongCode: false,
  connected: false,
  failedReason: null,
};

export type PairAction =
  | { type: 'begin' }
  | { type: 'stop' }
  | { type: 'offer'; offer: RemotePairOffer }
  | { type: 'request'; request: RemotePairRequest }
  | { type: 'closeRequest'; requestId: string }
  | { type: 'done'; requestId: string }
  | { type: 'failed'; requestId: string; reason: string }
  | { type: 'offerClosed'; reason: 'bad-psk' | 'used' };

export function pairReducer(state: PairState, action: PairAction): PairState {
  switch (action.type) {
    case 'begin':
      return { ...INITIAL_PAIR, active: true };
    case 'stop':
      return INITIAL_PAIR;
    case 'offer':
      // Reissue: a request waiting for «Allow» belongs to the old offer and is cancelled by the bridge.
      return { ...state, active: true, offer: action.offer, request: null };
    case 'request':
      return { ...state, request: action.request, wrongCode: false, failedReason: null };
    case 'closeRequest':
      return state.request?.requestId === action.requestId ? { ...state, request: null } : state;
    case 'done':
      if (state.request !== null && state.request.requestId !== action.requestId) return state;
      return { ...INITIAL_PAIR, connected: true };
    case 'failed':
      if (state.request !== null && state.request.requestId !== action.requestId) return state;
      return { ...state, request: null, offer: null, failedReason: action.reason };
    case 'offerClosed':
      // `bad-psk`: nobody can pair with this QR any more and no request will come — a new one is issued at once.
      return action.reason === 'bad-psk' ? { ...state, offer: null, request: null, wrongCode: true } : { ...state, offer: null };
  }
}

/** Does the reissue timer run? Not while a request waits for the user (plan A10, review note m7). */
export function reissueDue(state: PairState): boolean {
  return state.active && state.request === null;
}
