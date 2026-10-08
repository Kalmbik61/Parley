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

describe('основы слов: write/writing и соседние запросы на фикстурном каталоге', () => {
  // Описания — как у настоящих навыков, но фикстурные: тест не читает домашний каталог пользователя.
  const catalog = [
    skill('superpowers:writing-plans', 'Use when you have a spec or requirements for a multi-step task, before touching code'),
    skill('superpowers:executing-plans', 'Use when executing an implementation plan in the current session as the implementer yourself, your human partner chose inline execution, or no subagent tool is available'),
    skill('claude-seo:seo-plan', 'Strategic SEO planning for new or existing websites. Industry-specific templates, competitive analysis, content strategy, and implementation roadmap. Use when user says SEO plan, SEO strategy or SEO roadmap'),
    skill('oh-my-claudecode:plan', 'Strategic planning with optional interview workflow'),
    skill('superpowers:requesting-code-review', 'Use when completing tasks, implementing major features, or before merging to verify work meets requirements'),
    skill('superpowers:receiving-code-review', 'Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable'),
    skill('superpowers:systematic-debugging', 'Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes'),
    skill('superpowers:test-driven-development', 'Use when implementing any feature or bugfix, before writing implementation code'),
    skill('anthropic-skills:pptx', 'Use this skill any time a .pptx file is involved: creating slide decks, pitch decks, or presentations as PowerPoint files; reading, editing or updating existing presentations'),
    skill('anthropic-skills:docx', 'Use this skill whenever the user wants to create, read, edit, or manipulate Word documents'),
    skill('oh-my-claudecode:ultraqa', 'QA cycling workflow - test, verify, fix, repeat until goal met'),
  ];
  const top = (query: string, count = 1): string[] => searchSkills(catalog, query, count).map(match => match.skill.name);

  it('write и writing — одна основа, поэтому writing-plans первый на «write an implementation plan»', () => {
    expect(top('write an implementation plan')).toEqual(['superpowers:writing-plans']);
    expect(top('writing implementation plans')).toEqual(['superpowers:writing-plans']);
    // Было: executing-plans и seo-plan обгоняли writing-plans, потому что «write» и «writ» не совпадали.
    expect(top('write an implementation plan', 3)[0]).toBe('superpowers:writing-plans');
  });

  it('конечная e не мешает: make/making, slide/slides, code/coding, review/reviewing', () => {
    expect(searchSkills([skill('making', 'x')], 'make').map(match => match.skill.name)).toEqual(['making']);
    expect(searchSkills([skill('slides', 'x')], 'slide').map(match => match.skill.name)).toEqual(['slides']);
    expect(searchSkills([skill('coding', 'x')], 'code').map(match => match.skill.name)).toEqual(['coding']);
    expect(searchSkills([skill('review', 'x')], 'reviewing').map(match => match.skill.name)).toEqual(['review']);
  });

  it('удвоенная согласная после ing/ed схлопывается только там, где это не ломает основу', () => {
    for (const [name, query] of [['debugging', 'debug'], ['planning', 'plan'], ['mapped', 'map'], ['calling', 'call'], ['adding', 'add']] as const) {
      expect(searchSkills([skill(name, 'x')], query).map(match => match.skill.name), query).toEqual([name]);
    }
  });

  it('соседние запросы: код-ревью, слайды, отладка падающего теста', () => {
    expect(top('review code', 2)).toEqual(expect.arrayContaining(['superpowers:requesting-code-review']));
    expect(top('review code', 2).every(name => name.endsWith('-code-review'))).toBe(true);
    expect(top('make a slide deck')).toEqual(['anthropic-skills:pptx']);
    expect(top('debug a failing test')).toEqual(['superpowers:systematic-debugging']);
  });

  it('порядок каталога на результат не влияет', () => {
    const query = 'write an implementation plan';
    expect(searchSkills([...catalog].reverse(), query, 5)).toEqual(searchSkills(catalog, query, 5));
  });
});
