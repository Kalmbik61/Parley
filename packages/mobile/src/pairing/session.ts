// The pairing flow as one state machine (D1 §6). Screens only render `state`; they cannot reach a later step by
// navigating, because every method checks the step it is called from. A `parley://pair` link (opened by any web page,
// spec §14) starts at `confirm-link` and only `confirm()` leaves it; a scanned QR starts at `name`.
import {
  CREDENTIALS_TIMEOUT_MS,
  PairError,
  type HostRecord,
  type PairOptions,
} from '@parley/remote-client';
import { parsePairUrl } from '@parley/protocol/remote';

export type PairFailureKind = 'denied' | 'timeout' | 'offer_closed' | 'relay' | 'other';

export interface PairFailure {
  kind: PairFailureKind;
  icon: 'xmark.octagon' | 'clock.badge.exclamationmark' | 'qrcode' | 'antenna.radiowaves.left.and.right.slash' | 'exclamationmark.triangle';
  title: string;
  body: string;
  /** Primary button. */
  action: 'Try again' | 'Scan again';
  /** Fine print under the body (the stranger-phone hint for a used code). */
  note: string | null;
}

export type PairState =
  | { step: 'idle' }
  | { step: 'confirm-link'; url: string }
  | { step: 'name'; url: string }
  | { step: 'connecting'; url: string }
  | { step: 'sas'; url: string; code: string; expiresAt: number }
  | { step: 'paired'; record: HostRecord }
  | { step: 'notify'; record: HostRecord }
  | { step: 'failed'; url: string; failure: PairFailure };

export interface PairDeps {
  pair(url: string, options: PairOptions): Promise<HostRecord>;
  /** Called with the new record once pairing succeeded, to make it the current Mac. */
  adopt(record: HostRecord): Promise<void>;
  now(): number;
  /** Haptics, injected so the machine stays free of native modules. */
  haptic: { sasShown(): void; paired(): void };
  app: string;
  platformName: string;
}

export const DEVICE_NAME_MAX = 40;

export function describeFailure(error: unknown, relay: string | null): PairFailure {
  const code = error instanceof PairError ? error.code : 'protocol';
  switch (code) {
    case 'denied':
      return { kind: 'denied', icon: 'xmark.octagon', title: 'Your Mac denied this phone', body: 'Make a new code on your Mac and try again.', action: 'Try again', note: null };
    case 'timeout':
      return { kind: 'timeout', icon: 'clock.badge.exclamationmark', title: "Your Mac didn't answer in time", body: 'Make a new code on your Mac: Pair a device.', action: 'Try again', note: null };
    case 'offer_closed':
      return {
        kind: 'offer_closed',
        icon: 'qrcode',
        title: 'This code was already used',
        body: 'Make a new code on your Mac: Pair a device.',
        action: 'Scan again',
        note: 'If your Mac shows a pairing request you did not make, it is another phone: click Deny on the Mac.',
      };
    case 'relay':
    case 'connection':
      return { kind: 'relay', icon: 'antenna.radiowaves.left.and.right.slash', title: "Can't reach relay", body: relay ?? 'The relay address from the code', action: 'Try again', note: null };
    default:
      return { kind: 'other', icon: 'exclamationmark.triangle', title: "Pairing didn't finish", body: 'Make a new code on your Mac and try again.', action: 'Try again', note: null };
  }
}

export class PairingSession {
  readonly #deps: PairDeps;
  readonly #listeners = new Set<() => void>();
  #state: PairState = { step: 'idle' };
  #abort: AbortController | null = null;

  constructor(deps: PairDeps) {
    this.#deps = deps;
  }

  getState = (): PairState => this.#state;

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => void this.#listeners.delete(l);
  };

  #set(next: PairState): void {
    this.#state = next;
    for (const l of [...this.#listeners]) l();
  }

  /** A QR the person scanned in the app: straight to the device name. `false` — not a Parley code. */
  fromScan(url: string): boolean {
    if (!isPairUrl(url)) return false;
    this.#abort?.abort();
    this.#set({ step: 'name', url });
    return true;
  }

  /** A `parley://pair` link from outside the app: the confirm screen first, never skipped. `false` — malformed. */
  fromLink(url: string): boolean {
    if (!isPairUrl(url)) return false;
    this.#abort?.abort();
    this.#set({ step: 'confirm-link', url });
    return true;
  }

  /** Developer build only: shows a given step without a Mac, for screenshots and design review. */
  previewStep(next: PairState): void {
    if (typeof __DEV__ !== 'undefined' && __DEV__) this.#set(next);
  }

  /** "Continue" on the confirm screen; the only way out of `confirm-link`. */
  confirm(): boolean {
    const s = this.#state;
    if (s.step !== 'confirm-link') return false;
    this.#set({ step: 'name', url: s.url });
    return true;
  }

  /** "Continue" on the name screen: starts the handshake. Ignored from any other step. */
  async start(deviceName: string): Promise<void> {
    const s = this.#state;
    if (s.step !== 'name') return;
    const name = [...deviceName.trim()].slice(0, DEVICE_NAME_MAX).join('');
    const abort = new AbortController();
    this.#abort = abort;
    this.#set({ step: 'connecting', url: s.url });
    try {
      const record = await this.#deps.pair(s.url, {
        deviceName: name || 'iPhone',
        platformName: this.#deps.platformName,
        app: this.#deps.app,
        signal: abort.signal,
        onSas: (code) => {
          if (abort.signal.aborted) return;
          this.#deps.haptic.sasShown();
          this.#set({ step: 'sas', url: s.url, code, expiresAt: this.#deps.now() + CREDENTIALS_TIMEOUT_MS });
        },
      });
      if (abort.signal.aborted) return;
      await this.#deps.adopt(record);
      this.#deps.haptic.paired();
      this.#set({ step: 'paired', record });
    } catch (error) {
      if (abort.signal.aborted) return;
      const relay = relayOf(s.url);
      this.#set({ step: 'failed', url: s.url, failure: describeFailure(error, relay) });
    } finally {
      if (this.#abort === abort) this.#abort = null;
    }
  }

  /** "Continue" on Paired → the notification prompt. */
  toNotifications(): void {
    const s = this.#state;
    if (s.step === 'paired') this.#set({ step: 'notify', record: s.record });
  }

  /** Back to the device name after a failure ("Try again" re-uses the same code only if the relay still knows it). */
  retry(): void {
    const s = this.#state;
    if (s.step === 'failed') this.#set({ step: 'name', url: s.url });
  }

  /** Cancel at any step; aborts a running handshake. */
  cancel(): void {
    this.#abort?.abort();
    this.#abort = null;
    this.#set({ step: 'idle' });
  }

  /** Leave the flow after the last step. */
  finish(): void {
    this.#set({ step: 'idle' });
  }
}

function isPairUrl(url: string): boolean {
  try {
    parsePairUrl(url.trim());
    return true;
  } catch {
    return false;
  }
}

function relayOf(url: string): string | null {
  try {
    return parsePairUrl(url.trim()).r;
  } catch {
    return null;
  }
}

/** Rebuilds the pairing link from the query parameters expo-router parsed out of `parley://pair?…`. */
export function linkFromParams(params: Record<string, string | string[] | undefined>): string | null {
  const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' ? v : null);
  const v = one(params.v);
  const k = one(params.k);
  const s = one(params.s);
  const r = one(params.r);
  if (v === null || k === null || s === null || r === null) return null;
  return `parley://pair?v=${v}&k=${k}&s=${s}&r=${r}`;
}
