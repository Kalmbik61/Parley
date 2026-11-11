// The migration registry (plan T7b): every tool a session can have is entered, nothing is proven yet, and the module stays pure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INITIAL_COHORT } from './catalog.js';
import {
  MIGRATABLE_READS, MIGRATION_REGISTRY, type MigrationRegistry, REGISTRY_REVISION, WRITES_EVER_SHIPPED, checkReplacement, migratableReads, registryRevision, writesExist,
} from './migration-registry.js';

const inventory = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../../docs/research/2026-11-07-code-mode-benchmark/implementation-inventory.json', import.meta.url)), 'utf8')) as { tools: { name: string; effect: string }[]; sincePin: { added: { name: string }[] } };
const NAMES = MIGRATION_REGISTRY.entries.map((e) => e.name);
const proven = (...names: string[]): MigrationRegistry => ({ ...MIGRATION_REGISTRY, proven: names });
// A fixture read for registry-only cases: a name the inventory does not enter, entered as a read in the fixture's own inventory (the shipped one plus
// this name). Never a real tool, and never a `browser_*` name: the human keeps those direct for good (m-7370), so no fixture may make one migratable.
const FIXTURE_READ = 'fixture_read';
const withFixtureRead = (change: Partial<MigrationRegistry>): MigrationRegistry => ({
  ...MIGRATION_REGISTRY, entries: [...MIGRATION_REGISTRY.entries, { name: FIXTURE_READ, cohort: false, effect: 'read', removal: 'fixture' }], ...change,
});

describe('the shipped registry', () => {
  it('is exactly the accepted inventory, 50 names', () => {
    expect(NAMES).toHaveLength(50);
    expect([...NAMES].sort()).toEqual(inventory.tools.map((t) => t.name).sort());
  });
  it('nothing is proven: no method has left the direct list', () => {
    expect(MIGRATION_REGISTRY.proven).toEqual([]);
    const all = checkReplacement(NAMES);
    expect(all).toEqual({ ok: true, migrated: [], direct: NAMES });
  });
  it('the cohort is the five initial reads; every other method has its own removal task', () => {
    expect(MIGRATION_REGISTRY.entries.filter((e) => e.cohort).map((e) => e.name).sort()).toEqual([...INITIAL_COHORT].sort());
    for (const e of MIGRATION_REGISTRY.entries) expect(e.removal, e.name).toBe(e.cohort ? 'T6/T7' : `T11-${e.name}`);
  });
  it('the eight T3a-refresh methods are direct', () => {
    const added = inventory.sincePin.added.map((a) => a.name);
    expect(added).toHaveLength(8);
    for (const name of added) expect(MIGRATION_REGISTRY.entries.find((e) => e.name === name), name).toMatchObject({ cohort: false, removal: `T11-${name}` });
  });
  it('every entry carries the effect the accepted inventory gives its annotations: 18 reads, 28 writes, 4 destructive', () => {
    const effect = new Map(inventory.tools.map((t) => [t.name, t.effect]));
    for (const e of MIGRATION_REGISTRY.entries) expect(e.effect, e.name).toBe(effect.get(e.name));
    const count = (x: string) => MIGRATION_REGISTRY.entries.filter((e) => e.effect === x).length;
    expect([count('read'), count('write'), count('destructive')]).toEqual([18, 28, 4]);
  });
  it('the allowlist is MIGRATABLE_READS: the five and the T11 reads, each entered as a read, never a browser tool', () => {
    expect(MIGRATION_REGISTRY.migratable).toBe(MIGRATABLE_READS);
    for (const name of INITIAL_COHORT) expect(MIGRATABLE_READS, name).toContain(name);
    expect(MIGRATABLE_READS.filter((name) => name.startsWith('browser_'))).toEqual([]);
    expect([...migratableReads(MIGRATION_REGISTRY)].sort()).toEqual([...MIGRATABLE_READS].sort());
    expect(Object.isFrozen(MIGRATABLE_READS)).toBe(true);
  });
  it('no write has shipped, so writes do not exist (sticky flag false, allowlist all reads)', () => {
    expect(WRITES_EVER_SHIPPED).toBe(false);
    expect(writesExist(MIGRATION_REGISTRY)).toBe(false);
  });
  it('the revision follows the data', () => {
    expect(REGISTRY_REVISION).toBe(registryRevision(MIGRATION_REGISTRY));
    expect(registryRevision(proven('get_map'))).not.toBe(REGISTRY_REVISION);
    expect(registryRevision({ ...MIGRATION_REGISTRY, entries: MIGRATION_REGISTRY.entries.slice(1), proven: [] })).not.toBe(REGISTRY_REVISION);
    expect(registryRevision({ ...MIGRATION_REGISTRY, migratable: [...MIGRATABLE_READS, FIXTURE_READ] })).not.toBe(REGISTRY_REVISION);
  });
  it('is deeply frozen', () => {
    expect(Object.isFrozen(MIGRATION_REGISTRY)).toBe(true);
    expect(Object.isFrozen(MIGRATION_REGISTRY.entries)).toBe(true);
    expect(Object.isFrozen(MIGRATION_REGISTRY.proven)).toBe(true);
    expect(Object.isFrozen(MIGRATION_REGISTRY.entries[0])).toBe(true);
  });
});

describe('checkReplacement', () => {
  it('an original list with a tool not in the registry fails, whatever else it holds', () => {
    expect(checkReplacement([...NAMES, 'new_tool'])).toEqual({ ok: false, problem: 'uninventoried-tool' });
    expect(checkReplacement(['new_tool'])).toEqual({ ok: false, problem: 'uninventoried-tool' });
  });
  it('a list with a name twice cannot be partitioned', () => {
    expect(checkReplacement(['get_map', 'get_map'])).toEqual({ ok: false, problem: 'partition' });
  });
  it('a subset of the registry is fine: a launch has only what it has', () => {
    expect(checkReplacement(['get_map', 'report'])).toEqual({ ok: true, migrated: [], direct: ['get_map', 'report'] });
  });
  it('the union is the original, and the sets do not meet', () => {
    const r = checkReplacement(['get_map', 'report', 'read_room'], proven('get_map', 'read_room'));
    expect(r).toEqual({ ok: true, migrated: ['get_map', 'read_room'], direct: ['report'] });
  });
  it.each([
    ['a method outside the allowlist proven', proven('report')],
    ['a method not in the registry proven', proven('new_tool')],
    ['a cohort method this launch does not have', proven('backlog_list')],
    ['a method proven twice', proven('get_map', 'get_map')],
    ['a write on the allowlist', { ...MIGRATION_REGISTRY, migratable: [...MIGRATABLE_READS, 'send_message'], proven: [] }],
    ['a destructive method on the allowlist', { ...MIGRATION_REGISTRY, migratable: [...MIGRATABLE_READS, 'close_session'], proven: [] }],
    ['a name the registry does not enter on the allowlist', { ...MIGRATION_REGISTRY, migratable: [...MIGRATABLE_READS, 'new_tool'], proven: [] }],
    ['an allowlisted name twice', { ...MIGRATION_REGISTRY, migratable: [...MIGRATABLE_READS, 'get_map'], proven: [] }],
    ['a read entered but not allowlisted proven', withFixtureRead({ proven: [FIXTURE_READ] })],
    ['a duplicate entry', { ...MIGRATION_REGISTRY, entries: [...MIGRATION_REGISTRY.entries, MIGRATION_REGISTRY.entries[0]!], proven: [] }],
  ])('%s: invalid registry', (_name, registry) => {
    expect(checkReplacement(['get_map', 'report', FIXTURE_READ], registry)).toEqual({ ok: false, problem: 'invalid-registry' });
  });
  it('a sixth read on a fixture allowlist can be proven: it alone leaves the direct list', () => {
    const six = withFixtureRead({ migratable: [...MIGRATABLE_READS, FIXTURE_READ], proven: [FIXTURE_READ] });
    expect(checkReplacement(['get_map', FIXTURE_READ, 'report'], six)).toEqual({ ok: true, migrated: [FIXTURE_READ], direct: ['get_map', 'report'] });
    expect(writesExist(six)).toBe(false);
  });
  it('writes exist only from the registry data: a non-read on a fixture allowlist makes it true', () => {
    for (const name of ['send_message', 'close_session', 'new_tool']) expect(writesExist({ ...MIGRATION_REGISTRY, migratable: [...MIGRATABLE_READS, name] }), name).toBe(true);
  });
});

describe('purity', () => {
  it('the registry imports nothing but a hash, so a launcher can load it without the contracts', () => {
    const source = readFileSync(fileURLToPath(new URL('./migration-registry.ts', import.meta.url)), 'utf8');
    expect([...source.matchAll(/^import\b[^;]*?'([^']+)';$/gm)].map((m) => m[1])).toEqual(['node:crypto']);
    expect(source).not.toMatch(/\bimport\(/);
  });
  it('no route to guest authority: the broker, the gate and the catalogue do not read it', () => {
    for (const file of ['broker.ts', 'native-policy.ts', 'catalog.ts', 'scheduler.ts', 'helper.ts', 'guest.ts', 'read-adapter-table.ts', 'read-output-schemas.ts']) {
      expect(readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8'), file).not.toMatch(/import[^;]*migration-registry/);
    }
  });
});
