// Pure mapping from supervisor / bridge state to the connection banner of D1 §4. No React Native imports.
import type { BlockReason, HostStatus, SupervisorStatus } from '@parley/remote-client';

export type BannerTone = 'neutral' | 'warning';
export type BannerIcon =
  | 'progress'
  | 'arrow.triangle.2.circlepath'
  | 'wifi.slash'
  | 'antenna.radiowaves.left.and.right.slash'
  | 'desktopcomputer'
  | 'exclamationmark.triangle'
  | 'questionmark.circle';
export type BannerAction = 'retry' | 'pair-again' | 'remove';

export interface Banner {
  kind:
    | 'connecting'
    | 'updating'
    | 'retrying'
    | 'no-internet'
    | 'relay-unreachable'
    | 'mac-offline'
    | 'mac-starting'
    | 'host-not-running'
    | 'not-recognized';
  icon: BannerIcon;
  tone: BannerTone;
  text: string;
  /** Second line. */
  detail: string | null;
  actions: BannerAction[];
  /** Hold the banner back for this long, so a short reconnect does not flash it (D1 §4). */
  delayMs: number;
}

/** Blocked states are full-screen in D1 §4 / §11.4–11.5, not a banner. */
export interface BlockedScreen {
  screen: 'revoked' | 'update-phone' | 'update-mac';
}

export interface BannerInput {
  /** `null` — no host paired. */
  supervisor: SupervisorStatus | null;
  hostStatus: HostStatus | null;
  hasSnapshot: boolean;
  /** Last time the snapshot changed (ms since epoch), `null` — never. */
  lastUpdatedAt: number | null;
  /** When the supervisor entered `waiting` / `idle` after a failure; `null` — not waiting. */
  waitingSince: number | null;
  /** `host[:port]` of the current relay, for the "Can't reach relay" line. */
  relay: string | null;
  now: number;
}

export const UPDATING_DELAY_MS = 1500;
export const LONG_WAIT_MS = 30_000;

export function blockedScreen(reason: BlockReason | null, hostStatus: HostStatus | null): BlockedScreen['screen'] | null {
  if (reason === 'revoked' || reason === 'reset') return 'revoked';
  if (reason === 'update_phone') return 'update-phone';
  if (reason === 'update_mac' || hostStatus === 'incompatible') return 'update-mac';
  return null;
}

export function ago(from: number, now: number): string {
  const s = Math.max(0, Math.round((now - from) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const lastUpdated = (i: BannerInput): string | null =>
  i.lastUpdatedAt === null ? null : `Last updated ${ago(i.lastUpdatedAt, i.now)}`;

/** `null` — no banner (also for blocked states, see `blockedScreen`). */
export function bannerFor(i: BannerInput): Banner | null {
  const sup = i.supervisor;
  if (sup === null) return null;
  if (blockedScreen(sup.blocked, i.hostStatus) !== null) return null;

  const make = (b: Omit<Banner, 'delayMs' | 'actions'> & { actions?: BannerAction[]; delayMs?: number }): Banner => ({
    actions: [],
    delayMs: 0,
    ...b,
  });

  if (sup.state === 'offline') {
    return make({ kind: 'no-internet', icon: 'wifi.slash', tone: 'neutral', text: 'No internet connection', detail: lastUpdated(i) });
  }
  if (sup.relayError === 'unknown_device' || sup.relayError === 'unknown_route') {
    return make({
      kind: 'not-recognized',
      icon: 'questionmark.circle',
      tone: 'warning',
      text: 'This Mac does not recognize this phone',
      detail: null,
      actions: ['pair-again', 'remove'],
    });
  }
  if (sup.relayError === 'host_offline') {
    return make({
      kind: 'mac-offline',
      icon: 'desktopcomputer',
      tone: 'warning',
      text: 'Mac offline',
      detail: 'Your Mac is asleep or Parley is closed',
    });
  }
  if (sup.state === 'ready') {
    if (i.hostStatus === 'starting') {
      return make({ kind: 'mac-starting', icon: 'progress', tone: 'neutral', text: 'Mac is starting…', detail: null });
    }
    if (i.hostStatus === 'offline') {
      return make({
        kind: 'host-not-running',
        icon: 'exclamationmark.triangle',
        tone: 'warning',
        text: "Parley isn't running on your Mac",
        detail: 'Open Parley on your Mac',
      });
    }
    return null;
  }
  // idle / connecting / handshaking / waiting
  const waited = i.waitingSince === null ? 0 : i.now - i.waitingSince;
  if (sup.state === 'waiting' && waited > LONG_WAIT_MS) {
    const left = sup.retryAt === null ? null : Math.max(0, Math.ceil((sup.retryAt - i.now) / 1000));
    const retrying = left === null ? null : `Retrying in ${left} s`;
    return make({
      kind: 'relay-unreachable',
      icon: 'antenna.radiowaves.left.and.right.slash',
      tone: 'warning',
      text: "Can't reach relay",
      detail: [i.relay, retrying].filter((x) => x !== null).join(' · ') || null,
      actions: ['retry'],
    });
  }
  if (!i.hasSnapshot) {
    return make({ kind: 'connecting', icon: 'progress', tone: 'neutral', text: 'Connecting…', detail: null });
  }
  return make({
    kind: 'updating',
    icon: 'arrow.triangle.2.circlepath',
    tone: 'neutral',
    text: 'Updating…',
    detail: lastUpdated(i),
    delayMs: UPDATING_DELAY_MS,
  });
}
