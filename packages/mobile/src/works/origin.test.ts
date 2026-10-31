import { describe, expect, it } from 'vitest';
import type { RemoteWork } from '@parley/protocol/remote';
import { demoSnapshot } from '../dev/demo';
import { originOf } from './origin';

const work = demoSnapshot.works[0] as RemoteWork;

describe('originOf', () => {
  it('is empty for a main session', () => {
    expect(originOf(work, 'greta')).toEqual([]);
    expect(originOf(work, 'solo')).toEqual([]);
  });
  it('a room member: main session › room; a drone: main session › swarm', () => {
    expect(originOf(work, 'd1').map((o) => o.label)).toEqual(['Greta', '# iOS app: stage A']);
    expect(originOf(work, 'drone1').map((o) => o.label)).toEqual(['Greta', 'Swarm [Research]']);
  });
});
