import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyDevice } from './device-state.mjs';

const UDID = '00008150-001179DA0E50C01C';
const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

describe('classifyDevice', () => {
  it('a wired paired phone with a disconnected tunnel is ready (the tunnel comes up on demand)', () => {
    expect(classifyDevice(load('devicectl-wired-tunnel-disconnected.json'), UDID)).toMatchObject({ state: 'ready', name: 'Kalmbik', developerMode: 'enabled' });
  });
  it('a wired paired phone with a connected tunnel is ready', () => {
    expect(classifyDevice(load('devicectl-wired-tunnel-connected.json'), UDID).state).toBe('ready');
  });
  it('a phone that is not reachable is unavailable', () => {
    expect(classifyDevice(load('devicectl-unavailable.json'), UDID).state).toBe('unavailable');
  });
  it('an unpaired phone is unpaired', () => {
    expect(classifyDevice(load('devicectl-unpaired.json'), UDID).state).toBe('unpaired');
  });
  it('a missing phone or empty input is absent', () => {
    expect(classifyDevice(load('devicectl-wired-tunnel-connected.json'), 'other').state).toBe('absent');
    expect(classifyDevice(null, UDID).state).toBe('absent');
  });
});
