import { describe, expect, it } from 'vitest';
import { searchSkills } from './search.js';
import type { NativeSkill } from './types.js';

const skill = (name: string, description: string, file = `/skills/${name}/SKILL.md`): NativeSkill => ({
  provider: 'codex', documentKind: 'skill', name, description, path: file,
  source: 'user', modelAvailable: true, unavailableReason: null,
});

describe('local deterministic BM25', () => {
  it('pins the first three by name boost, term frequency and length normalization', () => {
    const skills = [skill('other', 'Review reviews reviewing reviewed context'),
      skill('review', 'Inspect changes'), skill('code-review', 'Inspect changes'),
      skill('irrelevant', 'Cook dinner')];
    expect(searchSkills(skills, 'review').map(match => match.skill.name)).toEqual(['review', 'code-review', 'other']);
    expect(searchSkills([...skills].reverse(), 'review')).toEqual(searchSkills(skills, 'review'));
  });

  it('uses name ×3 with shared document frequency and independent field normalization', () => {
    const skills = [skill('review', 'other'), skill('other', 'review')];
    const matches = searchSkills(skills, 'review');
    const idf = Math.log(1 + (2 - 2 + 0.5) / (2 + 0.5));
    expect(matches[0]?.score).toBeCloseTo(3 * idf, 12);
    expect(matches[1]?.score).toBeCloseTo(idf, 12);
  });

  it('rewards repeated description terms but normalizes an excessively long description', () => {
    const skills = [skill('one', 'review'), skill('two', 'review review'),
      skill('long', `review ${'unrelated '.repeat(100)}`)];
    expect(searchSkills(skills, 'review').map(match => match.skill.name)).toEqual(['two', 'one', 'long']);
  });

  it('hidden records affect neither candidates, IDF nor corpus length statistics', () => {
    const visible = [skill('review', 'code'), skill('other', 'review review')];
    const hidden = ['human-disabled', 'availability-unverified', 'implicit-invocation-disabled'] as const;
    const inventory = [...visible, ...hidden.map((unavailableReason, index) => ({
      ...skill(`hidden-${index}`, `review ${'huge '.repeat(1000)}`), modelAvailable: false, unavailableReason,
    }))];
    expect(searchSkills(inventory, 'review')).toEqual(searchSkills(visible, 'review'));
  });

  it('lowercases, splits name punctuation, drops English stops and trims simple suffixes', () => {
    const skills = [skill('TEAM:Review_docs-testing', 'Boxes checked'), skill('other', 'unrelated')];
    for (const query of ['the REVIEW and docs', 'tested', 'box', 'checking', 'team_review'])
      expect(searchSkills(skills, query).map(match => match.skill.name)).toEqual(['TEAM:Review_docs-testing']);
    expect(searchSkills(skills, 'review review')).toEqual(searchSkills(skills, 'review'));
  });

  it('breaks equal scores by native name then canonical document path using UTF-8 bytes', () => {
    const skills = [skill('ä', 'same', '/z'), skill('a', 'same', '/z'),
      skill('Z', 'same', '/b'), skill('Z', 'same', '/a')];
    expect(searchSkills(skills, 'same').map(match => [match.skill.name, match.skill.path])).toEqual([
      ['Z', '/a'], ['Z', '/b'], ['a', '/z'], ['ä', '/z'],
    ]);
  });

  it('zero-token, absent-term and unavailable-only searches return no matches', () => {
    const skills = [skill('review', 'code')];
    for (const query of ['the and for', '123 !', 'unknown', 'обзор']) expect(searchSkills(skills, query)).toEqual([]);
    expect(searchSkills([{ ...skills[0]!, modelAvailable: false }], 'review')).toEqual([]);
    expect(searchSkills([], 'review')).toEqual([]);
  });

  it('defaults to five, caps at ten and rejects empty query or invalid limits', () => {
    const skills = Array.from({ length: 12 }, (_, index) => skill(`item-${index}`, 'review', `/doc/${index}`));
    expect(searchSkills(skills, 'review')).toHaveLength(5);
    expect(searchSkills(skills, 'review', 100)).toHaveLength(10);
    expect(searchSkills(skills, 'review', 2)).toHaveLength(2);
    expect(() => searchSkills(skills, '  ')).toThrow('must not be empty');
    for (const limit of [0, -1, 1.5, Infinity]) expect(() => searchSkills(skills, 'review', limit)).toThrow('positive integer');
  });
});
