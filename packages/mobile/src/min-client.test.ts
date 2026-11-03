import { describe, expect, it } from 'vitest';
import { MIN_CLIENT_VERSION } from '@parley/protocol/remote';
import config from '../app.config';

const parts = (v: string): number[] => v.split('.').map(Number);

describe('app version vs the bridge hello', () => {
  it('app.config version is not lower than MIN_CLIENT_VERSION (else the supervisor blocks with update_phone right after pairing)', () => {
    const [a, b] = [parts(config.version ?? '0.0.0'), parts(MIN_CLIENT_VERSION)];
    const cmp = a.map((n, i) => n - (b[i] ?? 0)).find((d) => d !== 0) ?? 0;
    expect(cmp).toBeGreaterThanOrEqual(0);
  });
});
