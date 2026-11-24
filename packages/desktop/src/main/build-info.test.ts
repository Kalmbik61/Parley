import { describe, expect, it } from 'vitest';
import { readBuildInfo, tildify } from './build-info.js';

describe('readBuildInfo', () => {
  it('правильная форма проходит как есть', () => {
    expect(readBuildInfo({ commit: '2b52d262', commitDate: '2026-11-17', dirty: true })).toEqual({
      commit: '2b52d262',
      commitDate: '2026-11-17',
      dirty: true,
    });
  });

  it('undefined и не объект — нули', () => {
    const none = { commit: null, commitDate: null, dirty: false };
    expect(readBuildInfo(undefined)).toEqual(none);
    expect(readBuildInfo(null)).toEqual(none);
    expect(readBuildInfo('abc')).toEqual(none);
  });

  it('чужие типы полей — нули по полям', () => {
    expect(readBuildInfo({ commit: 5, commitDate: {}, dirty: 'yes' })).toEqual({
      commit: null,
      commitDate: null,
      dirty: false,
    });
  });
});

describe('tildify', () => {
  it('сам дом — ~', () => expect(tildify('/Users/anna', '/Users/anna')).toBe('~'));
  it('путь внутри дома — ~/…', () => expect(tildify('/Users/anna/.parley', '/Users/anna')).toBe('~/.parley'));
  it('сосед с общим префиксом не трогается', () =>
    expect(tildify('/Users/annabel/x', '/Users/anna')).toBe('/Users/annabel/x'));
  it('путь вне дома — как есть', () =>
    expect(tildify('/Applications/Parley.app', '/Users/anna')).toBe('/Applications/Parley.app'));
});
