// FIXTURE ONLY (plan T5a). The reviewed fake native-policy source for tests. It lives at the repository root, outside
// every workspace package, so no package build or deploy contains it. Never import this module outside *.test.ts files:
// a static guard in packages/core/src/mcp/code-mode/native-policy.test.ts fails on any other reference. Fixture `allow` is not proof of a real
// client's native policy; a real launch stays unavailable (resolveLiveNativePolicy) whatever this module does.
//
// Loading this module claims the process's only source mint. A fake source is made only with the synthetic fixture host
// identity below: an object compared by identity, so no string, account id, JSON value, environment flag or symbol can
// stand in for it. The transport is a direct in-process call; nothing is read from the environment or configuration.

import { type PolicyQuery, type PolicySource, type PolicyState, claimFixtureSourceMint } from '../../../packages/core/src/mcp/code-mode/native-policy.js';

const mint = claimFixtureSourceMint();

/** The synthetic fixture host identity. */
export const FIXTURE_HOST: object = Object.freeze(Object.create(null) as object);

export type FixtureRule = (query: PolicyQuery) => PolicyState | unknown;

export interface FixturePolicySource {
  readonly source: PolicySource;
  /** Change the fake policy revision (a policy change): every gate opened on this source is revoked. */
  bump(): void;
  /** Replace the rule (the revision is unchanged unless `bump` is called too). */
  setRule(rule: FixtureRule): void;
  /** Every query the source answered, in order (frozen copies). */
  readonly queries: readonly PolicyQuery[];
}

export function createFixturePolicySource(identity: unknown, rule: FixtureRule, sourceId = 'fixture-policy'): FixturePolicySource {
  if (identity !== FIXTURE_HOST) throw new Error('fixture policy: a synthetic fixture host identity is required');
  let revision = 1;
  let current = rule;
  const queries: PolicyQuery[] = [];
  const source = mint(sourceId, {
    revision: () => `fixture-rev-${revision}`,
    decide: (q: PolicyQuery) => { queries.push(q); return current(q); },
  });
  return Object.freeze({
    source,
    bump: () => { revision++; },
    setRule: (r: FixtureRule) => { current = r; },
    queries,
  });
}
