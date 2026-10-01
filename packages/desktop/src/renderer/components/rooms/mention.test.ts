/**
 * Чистая часть упоминаний (дизайн комнат, 1.4, 2.2, 2.3): токены `@s02` в тексте, условия открытия
 * меню и его фильтр. DOM-часть редактора проверяет `Composer.test.tsx`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../test-utils/contrast.js';
import { parseTokens, resolveColor, type Theme } from '../../test-utils/css-tokens.js';
import {
  HUMAN_MENTION_CHIP_CLASS,
  MENTION_CHIP_CLASS,
  MENTION_QUERY_MAX,
  filterMentions,
  findMentionQuery,
  mentionToken,
  splitFeedMentions,
  splitMentions,
  type FeedSegment,
  type TextSegment,
} from './mention.js';

describe('mentionToken', () => {
  it('id сессии → токен письма: s-02 → @s02', () => {
    expect(mentionToken('s-02')).toBe('@s02');
    expect(mentionToken('s-12')).toBe('@s12');
    expect(mentionToken('s-100')).toBe('@s100');
  });
});

describe('splitMentions — токены в тексте (поле ввода и лента)', () => {
  const mention = (sessionId: string, raw: string): TextSegment => ({ kind: 'mention', sessionId, raw });
  const text = (value: string): TextSegment => ({ kind: 'text', text: value });

  it('@s02 и @s-02 — упоминание сессии s-02; номер добивается нулём слева', () => {
    expect(splitMentions('привет @s02, как дела')).toEqual([text('привет '), mention('s-02', '@s02'), text(', как дела')]);
    expect(splitMentions('@s-02')).toEqual([mention('s-02', '@s-02')]);
    expect(splitMentions('@s2 и @S03')).toEqual([mention('s-02', '@s2'), text(' и '), mention('s-03', '@S03')]);
  });

  it('текст без токенов — один текстовый сегмент, пустой текст — ни одного', () => {
    expect(splitMentions('просто текст')).toEqual([text('просто текст')]);
    expect(splitMentions('')).toEqual([]);
  });

  it('@ внутри слова и email токеном не считается', () => {
    expect(splitMentions('user@s02.example.com')).toEqual([text('user@s02.example.com')]);
    expect(splitMentions('a@s02')).toEqual([text('a@s02')]);
    // За номером сразу буква — это уже не токен, а слово.
    expect(splitMentions('@s02бэкенд')).toEqual([text('@s02бэкенд')]);
  });

  it('токен в начале, в конце строки, после скобки и переноса', () => {
    expect(splitMentions('(@s02)')).toEqual([text('('), mention('s-02', '@s02'), text(')')]);
    expect(splitMentions('раз\n@s03')).toEqual([text('раз\n'), mention('s-03', '@s03')]);
  });
});

describe('@human — упоминание человека (Parley 0.3.0)', () => {
  const human = (raw: string): FeedSegment => ({ kind: 'human', raw });
  const mention = (sessionId: string, raw: string): FeedSegment => ({
    kind: 'mention',
    sessionId,
    raw,
  });
  const text = (value: string): FeedSegment => ({ kind: 'text', text: value });

  it('splitFeedMentions: @human — свой сегмент, упоминания сессий — как у splitMentions', () => {
    expect(splitFeedMentions('@human, глянь')).toEqual([human('@human'), text(', глянь')]);
    expect(splitFeedMentions('@s02 и @Human')).toEqual([
      mention('s-02', '@s02'),
      text(' и '),
      human('@Human'),
    ]);
    expect(splitFeedMentions('(@HUMAN)')).toEqual([text('('), human('@HUMAN'), text(')')]);
  });

  it('@ внутри слова, email и продолжение слова упоминанием человека не считаются', () => {
    for (const value of [
      'user@human.dev',
      'a@human',
      '@humans',
      '@human_team',
      '@human2',
      '@@human',
      '@s02@human',
    ]) {
      expect(
        splitFeedMentions(value).some((segment) => segment.kind === 'human'),
        value,
      ).toBe(false);
    }
  });

  it('поле ввода человека @human не трогает: splitMentions оставляет его текстом', () => {
    expect(splitMentions('@human @s02')).toEqual([text('@human '), mention('s-02', '@s02')]);
  });

  // Что из текста лента вырежет чипом «@you», а что нет, решает разбор Markdown (`room-remark.ts`): здесь только
  // разбор токенов в тексте одного узла, и он ничего не теряет.
  it('сегменты splitFeedMentions склеиваются в исходный текст: ничего не теряется и не добавляется', () => {
    const samples = [
      '',
      '@human',
      'вопрос к @human: что дальше?',
      'раз\n@human\nдва',
      '**@human** решай',
      '@s02 @human @s-03',
      'user@human.dev',
      '@humans и @human_',
      '@s02@human',
      '@human@human',
      'нет упоминаний',
      '@ human',
      '`@human` в коде',
    ];
    for (const value of samples) {
      const joined = splitFeedMentions(value)
        .map((segment) => (segment.kind === 'text' ? segment.text : segment.raw))
        .join('');
      expect(joined, value).toBe(value);
    }
  });
});

/**
 * Чип «@you» (Parley 0.3.0): форма та же, что у чипа сессии, но заливка плотная — пара главной кнопки, `--primary` и
 * `--primary-foreground`. Пару тест читает из самого класса, поэтому правка класса без правки токенов ловится здесь.
 */
describe('HUMAN_MENTION_CHIP_CLASS — чип «@you»', () => {
  const tokens = parseTokens(
    readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../styles/tokens.css'),
      'utf8',
    ),
  );
  const classes = HUMAN_MENTION_CHIP_CLASS.split(/\s+/);
  const solid = (theme: Theme, name: string): [number, number, number] => {
    const { rgb, alpha } = resolveColor(tokens, theme, name);
    if (alpha !== 1) throw new Error(`${name} (${theme}) прозрачный: alpha ${alpha}`);
    return rgb;
  };

  it('форма та же, что у чипа сессии: пилюля, без переноса, с обрезкой', () => {
    for (const token of [
      'mx-px',
      'inline-block',
      'max-w-full',
      'overflow-hidden',
      'text-ellipsis',
      'whitespace-nowrap',
      'rounded-full',
      'px-[7px]',
      'align-bottom',
      'font-semibold',
    ]) {
      expect(MENTION_CHIP_CLASS.split(/\s+/), `у чипа сессии: ${token}`).toContain(token);
      expect(classes, token).toContain(token);
    }
  });

  it('заметнее чипа сессии: плотная заливка акцентом (пара главной кнопки), а не подкраска 22 %', () => {
    expect(classes).toContain('bg-primary');
    expect(classes).toContain('text-primary-foreground');
    expect(classes.some((token) => token.startsWith('bg-[color-mix'))).toBe(false);
  });

  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: текст чипа на его заливке — не ниже 4.5:1`, () => {
      expect(
        contrastRatio(solid(theme, '--primary-foreground'), solid(theme, '--primary')),
      ).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme}: заливка чипа к листу центра, на котором стоит лента, — не ниже 3:1`, () => {
      expect(
        contrastRatio(solid(theme, '--primary'), solid(theme, '--sheet')),
      ).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('findMentionQuery — когда открывается меню (2.3)', () => {
  it('@ в начале строки: запрос пуст', () => {
    expect(findMentionQuery('@')).toEqual({ start: 0, query: '' });
  });

  it('@ после пробела, неразрывного пробела и переноса; запрос — до курсора', () => {
    expect(findMentionQuery('привет @s')).toEqual({ start: 7, query: 's' });
    expect(findMentionQuery('привет @бэ')).toEqual({ start: 7, query: 'бэ' });
    expect(findMentionQuery('раз\n@')).toEqual({ start: 4, query: '' });
  });

  it('@ в середине слова и в email меню не открывает', () => {
    expect(findMentionQuery('a@')).toBeNull();
    expect(findMentionQuery('user@example')).toBeNull();
    expect(findMentionQuery('mail me at user@example.com')).toBeNull();
    expect(findMentionQuery('@@')).toBeNull();
  });

  it('до 24 знаков запроса; на 25-м меню закрывается', () => {
    expect(MENTION_QUERY_MAX).toBe(24);
    expect(findMentionQuery(`@${'x'.repeat(24)}`)).toEqual({ start: 0, query: 'x'.repeat(24) });
    expect(findMentionQuery(`@${'x'.repeat(25)}`)).toBeNull();
  });

  it('пробел в запросе закрывает меню; берётся последняя @', () => {
    expect(findMentionQuery('@s02 текст')).toBeNull();
    expect(findMentionQuery('@a @b')).toEqual({ start: 3, query: 'b' });
    expect(findMentionQuery('нет собаки')).toBeNull();
  });
});

describe('filterMentions — фильтр меню по «S02 s02 {ярлык} {провайдер} {модель}»', () => {
  const items = [
    { id: 's-01', rawLabel: 'архитектор', providerName: 'Claude Code', model: 'Opus 5.5' },
    { id: 's-02', rawLabel: 'бэкенд', providerName: 'Claude Code', model: null },
    { id: 's-03', rawLabel: 'ревью', providerName: 'Codex', model: 'GPT-5.5' },
  ];

  it('пустой запрос — все', () => {
    expect(filterMentions(items, '')).toEqual(items);
  });

  it('по номеру: S02 и s02 без учёта регистра', () => {
    expect(filterMentions(items, 'S02').map((item) => item.id)).toEqual(['s-02']);
    expect(filterMentions(items, 's03').map((item) => item.id)).toEqual(['s-03']);
  });

  it('по ярлыку — подстрока без учёта регистра', () => {
    expect(filterMentions(items, 'ЭКЕН').map((item) => item.id)).toEqual(['s-02']);
  });

  it('по имени провайдера', () => {
    expect(filterMentions(items, 'codex').map((item) => item.id)).toEqual(['s-03']);
    expect(filterMentions(items, 'claude').map((item) => item.id)).toEqual(['s-01', 's-02']);
  });

  it('по модели — подстрока без учёта регистра; у сессии без модели «null» в поиск не попадает', () => {
    expect(filterMentions(items, 'opus').map((item) => item.id)).toEqual(['s-01']);
    expect(filterMentions(items, 'gpt-5').map((item) => item.id)).toEqual(['s-03']);
    expect(filterMentions(items, '5.5').map((item) => item.id)).toEqual(['s-01', 's-03']);
    expect(filterMentions(items, 'null')).toEqual([]);
  });

  it('ничего не подошло — пусто', () => {
    expect(filterMentions(items, 'нету')).toEqual([]);
  });
});
