import { describe, expect, it } from 'vitest';
import { HostStore, PairError, pair, type HostRecord, type KeyStore, type PairOptions, type Platform } from '@parley/remote-client';
import { LINK_MESSAGES, PairingSession, describeFailure, linkFromParams, type PairDeps } from './session';
import { countdown, groupSas, isLastSeconds, sasLabel } from './sas';

const b64 = (n: number, c: string) => c.repeat(n);
const K = b64(43, 'A');
const S = b64(22, 'A');
const URL_OK = `parley://pair?v=1&k=${K}&s=${S}&r=relay.example.com`;
const URL_PRIVATE = `parley://pair?v=1&k=${K}&s=${S}&r=192.168.1.20:8787`;
const record = { hostId: 'h', hostName: 'Mac' } as HostRecord;

function makeDeps(impl: PairDeps['pair']) {
  const events: string[] = [];
  const deps: PairDeps = {
    pair: impl,
    adopt: async () => void events.push('adopt'),
    now: () => 1000,
    haptic: { sasShown: () => void events.push('haptic:sas'), paired: () => void events.push('haptic:paired') },
    app: 'parley-mobile/0.1.0',
    platformName: 'ios',
    allowLocalRelay: false,
  };
  return { deps, events };
}

describe('SAS screen model', () => {
  it('shows the code from onSas, grouped, only once the handshake delivers it', async () => {
    let finish!: (r: HostRecord) => void;
    let sasSeenBefore = false;
    const { deps, events } = makeDeps((_url, options: PairOptions) => {
      sasSeenBefore = true;
      return new Promise<HostRecord>((resolve) => {
        finish = resolve;
        options.onSas('123456');
      });
    });
    const session = new PairingSession(deps);
    expect(session.fromScan(URL_OK)).toBe('ok');
    const running = session.start('Phone');
    expect(sasSeenBefore).toBe(true);
    const s = session.getState();
    expect(s).toMatchObject({ step: 'sas', code: '123456', expiresAt: 1000 + 120_000 });
    expect(groupSas('123456')).toBe('123 456');
    expect(sasLabel('123456')).toBe('1 2 3, 4 5 6');
    expect(events).toContain('haptic:sas');
    finish(record);
    await running;
    expect(session.getState()).toMatchObject({ step: 'paired' });
    expect(events).toEqual(['haptic:sas', 'adopt', 'haptic:paired']);
  });

  it('shows no code while connecting and none after a handshake failure', async () => {
    const { deps } = makeDeps(async () => {
      throw new PairError('handshake');
    });
    const session = new PairingSession(deps);
    session.fromScan(URL_OK);
    await session.start('Phone');
    expect(session.getState().step).toBe('failed');
    expect(JSON.stringify(session.getState())).not.toMatch(/"code"/);
  });

  it('counts the Mac decision window down', () => {
    expect(countdown(120_000, 0)).toBe('2:00');
    expect(countdown(120_000, 66_000)).toBe('0:54');
    expect(countdown(1000, 5000)).toBe('0:00');
    expect(isLastSeconds(120_000, 110_000)).toBe(true);
    expect(isLastSeconds(120_000, 100_000)).toBe(false);
  });
});

describe('Confirm link screen cannot be skipped', () => {
  it('a parley:// link stops at confirm-link; start() and retry() do nothing until confirm()', async () => {
    let called = 0;
    const { deps } = makeDeps(async () => (called++, record));
    const session = new PairingSession(deps);
    expect(session.fromLink(URL_OK)).toBe('ok');
    expect(session.getState()).toEqual({ step: 'confirm-link', url: URL_OK });
    await session.start('Phone');
    session.retry();
    session.toNotifications();
    expect(session.getState().step).toBe('confirm-link');
    expect(called).toBe(0);
    expect(session.confirm()).toBe(true);
    expect(session.getState().step).toBe('name');
    expect(session.confirm()).toBe(false);
  });

  it('cancel on the confirm screen leaves the flow and a later start() does nothing', async () => {
    let called = 0;
    const { deps } = makeDeps(async () => (called++, record));
    const session = new PairingSession(deps);
    session.fromLink(URL_OK);
    session.cancel();
    await session.start('Phone');
    expect(session.getState().step).toBe('idle');
    expect(called).toBe(0);
  });

  it('rejects links that are not a Parley pairing link and rebuilds the link from router params', () => {
    const { deps } = makeDeps(async () => record);
    const session = new PairingSession(deps);
    expect(session.fromLink('https://example.com/?x=1')).toBe('not-parley');
    expect(session.fromScan('parley://pair?v=1&k=short')).toBe('not-parley');
    expect(session.getState().step).toBe('idle');
    expect(linkFromParams({ v: '1', k: K, s: S, r: 'relay.example.com' })).toBe(URL_OK);
    expect(linkFromParams({ v: '1', k: K })).toBeNull();
  });

  it('cancel during the handshake aborts it and ignores a late result', async () => {
    let signal!: AbortSignal;
    let finish!: (r: HostRecord) => void;
    const { deps, events } = makeDeps((_u, o) => {
      signal = o.signal!;
      return new Promise<HostRecord>((resolve) => (finish = resolve));
    });
    const session = new PairingSession(deps);
    session.fromScan(URL_OK);
    const running = session.start('Phone');
    session.cancel();
    expect(signal.aborted).toBe(true);
    finish(record);
    await running;
    expect(session.getState().step).toBe('idle');
    expect(events).toEqual([]);
  });
});

describe('private relay and a link during a pairing', () => {
  it('a release build refuses a private relay with its own message, before any step', () => {
    const { deps } = makeDeps(async () => record);
    const session = new PairingSession(deps);
    expect(session.fromScan(URL_PRIVATE)).toBe('private-relay');
    expect(session.fromLink(URL_PRIVATE)).toBe('private-relay');
    expect(session.getState().step).toBe('idle');
    expect(LINK_MESSAGES['private-relay']).toMatch(/private network/);
    const dev = new PairingSession({ ...deps, allowLocalRelay: true });
    expect(dev.fromScan(URL_PRIVATE)).toBe('ok');
    expect(describeFailure(new PairError('bad_qr'), null).body).toMatch(/private network/);
  });

  it('is busy while a pairing is under way, and a new link leaves it untouched until accepted', async () => {
    let finish!: (r: HostRecord) => void;
    const { deps } = makeDeps((_u, o) => new Promise<HostRecord>((resolve) => ((finish = resolve), o.onSas('654321'))));
    const session = new PairingSession(deps);
    expect(session.isBusy()).toBe(false);
    session.fromScan(URL_OK);
    expect(session.isBusy()).toBe(true);
    const running = session.start('Phone');
    expect(session.isBusy()).toBe(true);
    // The screen asks before calling fromLink; until then the state is the SAS step.
    expect(session.getState()).toMatchObject({ step: 'sas', code: '654321' });
    finish(record);
    await running;
    expect(session.isBusy()).toBe(false);
  });
});

describe('failures', () => {
  it('maps pairing errors to the D1 §6.5 screens', () => {
    expect(describeFailure(new PairError('denied'), 'r').title).toBe('Your Mac denied this phone');
    expect(describeFailure(new PairError('timeout'), 'r').title).toBe("Your Mac didn't answer in time");
    const used = describeFailure(new PairError('offer_closed'), 'r');
    expect(used).toMatchObject({ title: 'This code was already used', action: 'Scan again' });
    expect(used.note).toMatch(/Deny/);
    expect(describeFailure(new PairError('relay', 'rate_limited'), 'relay.example.com')).toMatchObject({
      title: "Can't reach relay",
      body: 'relay.example.com',
    });
  });
});

describe('release build', () => {
  it('rejects a QR with a private relay address before any socket is opened', async () => {
    let opened = 0;
    const keyStore: KeyStore = { list: async () => [], put: async () => undefined, remove: async () => undefined };
    const platform = {
      allowLocalRelay: false,
      openSocket: () => {
        opened++;
        throw new Error('must not open');
      },
      random: (n: number) => new Uint8Array(n).fill(7),
      now: () => 0,
    } as unknown as Platform;
    const opts: PairOptions = { deviceName: 'P', platformName: 'ios', app: 'x/1', onSas: () => undefined };
    for (const r of ['192.168.1.20:8787', '10.0.0.5', 'mac.local']) {
      const url = `parley://pair?v=1&k=${K}&s=${S}&r=${r}`;
      await expect(pair(platform, new HostStore(keyStore), url, opts)).rejects.toMatchObject({ code: 'bad_qr' });
    }
    expect(opened).toBe(0);
    // sanity: the same fixture with a public host is not rejected as bad_qr (it then fails at the socket).
    await expect(pair(platform, new HostStore(keyStore), URL_OK, opts)).rejects.not.toMatchObject({ code: 'bad_qr' });
    expect(URL_PRIVATE).toContain('192.168');
  });
});
