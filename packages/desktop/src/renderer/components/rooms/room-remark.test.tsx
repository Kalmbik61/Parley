/**
 * `room-remark` — разбор Markdown комнаты без React (Parley 0.3.0): ответ на вопрос «есть ли в тексте упоминание
 * человека» и его сверка с лентой. Правило `@human` одно: чип «@you» в ленте (`RoomMarkdown`) и счётчик, Dock и
 * уведомление (`attention/derive.ts#isHumanMention`) читают его одним и тем же разбором, и корпус ниже держит их
 * вместе: на каждом тексте чип, `isHumanMention` и `hasHumanMention` дают один и тот же ответ.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { unified } from 'unified';
import { isHumanMention } from '../../attention/derive.js';
import { makeLetter } from '../../test-utils/work-fixtures.js';
import { RoomMarkdown } from './RoomMarkdown.js';
import { hasHumanMention } from './room-remark.js';

afterEach(cleanup);

/** Текст и ответ: есть ли в нём упоминание человека (а значит, и чип «@you» в ленте). */
const CORPUS: ReadonlyArray<readonly [text: string, mentions: boolean]> = [
  // Обычный текст и выделение: чип есть.
  ['@human', true],
  ['Вопрос к @human: что дальше?', true],
  ['@Human и @HUMAN', true],
  ['раз\n@human', true],
  ['**@human**', true],
  ['*@human*', true],
  ['_@human_', true],
  ['__@human__', true],
  ['~~@human~~', true],
  ['# @human', true],
  ['> @human в цитате', true],
  ['- пункт @human', true],
  ['- [ ] задача для @human', true],
  ['| a | b |\n|---|---|\n| @human | x |', true],
  ['<b>@human</b>', true],
  ['\\@human', true],
  // Ссылка на символ — после разбора обычный текст: чип рисуется, а значит, и упоминание есть.
  ['&#64;human', true],
  ['&commat;human', true],
  ['@&#104;uman', true],
  ['`&#64;human`', false],
  ['&#64;humans', false],
  // Код: узел со своим `value`, а не текст.
  ['`@human`', false],
  ['``@human``', false],
  ['```\n@human\n```', false],
  ['~~~ts\n@human\n~~~', false],
  ['    @human в блоке с отступом', false],
  // Ссылки: текст и адрес — часть ссылки, а чип внутри `<a>` открывал бы ссылку.
  ['[ask @human](https://x.dev)', false],
  ['[ask @human][ref]\n\n[ref]: https://x.dev', false],
  ['https://github.com/@human', false],
  ['www.example.com/@human', false],
  ['<https://x.dev/@human>', false],
  ['user@human.dev', false],
  // Картинка: `alt` — свойство узла, а не текст.
  ['![@human](https://x.dev/a.png)', false],
  // То, что Markdown прячет и окно возвращает текстом (`remarkReveal`): это исходник, а не разметка.
  ['[a](https://x.dev "@human")', false],
  ['[x]: https://x.dev "@human"', false],
  ['[^a]: @human', false],
  ['```@human\nкод\n```', false],
  ['| a |\n|---|\n| 1 | @human |', false],
  // HTML целым блоком — текст узла `html`.
  ['<div>@human</div>', false],
  // Границы токена.
  ['@humans', false],
  ['@human_team', false],
  ['@human2', false],
  ['a@human', false],
  ['@@human', false],
  ['@s02@human', false],
  ['@ human', false],
  ['нет упоминаний', false],
  ['', false],
];

describe('hasHumanMention — есть ли в тексте упоминание человека', () => {
  it.each(CORPUS)('%j → %s', (text, mentions) => {
    expect(hasHumanMention(text)).toBe(mentions);
  });

  it('несколько упоминаний в одном тексте и рядом с упоминанием сессии', () => {
    expect(hasHumanMention('@s02, @human и @human')).toBe(true);
    expect(hasHumanMention('`@human`, но @s02 — не человек')).toBe(false);
    expect(hasHumanMention('`@human` и ещё раз @human')).toBe(true);
  });
});

/** Сообщение комнаты от агента с этим текстом — то, что считает внимание. */
const agentMessage = (text: string) =>
  makeLetter('m-1', { roomId: 'r-01', from: 's-02', to: [], text });

const humanChips = (root: ParentNode): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-mention-human]'));

describe('лента и внимание читают @human одним правилом (сверка на корпусе)', () => {
  for (const inline of [false, true]) {
    describe(inline ? 'строчный вид (плашка решений)' : 'лента', () => {
      it.each(CORPUS)('%j: чип «@you», isHumanMention и hasHumanMention — %s', (text, mentions) => {
        const { container, unmount } = render(
          <RoomMarkdown
            text={text}
            inline={inline}
            labelOf={() => null}
            onOpenExternal={() => {}}
          />,
        );
        const chips = humanChips(container).length;
        unmount();
        // Чип есть ровно там, где внимание считает сообщение упоминанием.
        expect(chips > 0, 'чип в ленте').toBe(mentions);
        expect(isHumanMention(agentMessage(text)), 'isHumanMention').toBe(mentions);
        expect(hasHumanMention(text), 'hasHumanMention').toBe(mentions);
      });
    });
  }

  it('число чипов в ленте — число упоминаний в тексте, а не одно на сообщение', () => {
    const { container } = render(
      <RoomMarkdown
        text="@human, @s02 и ещё раз @human; `@human` не в счёт"
        labelOf={() => null}
        onOpenExternal={() => {}}
      />,
    );
    expect(humanChips(container)).toHaveLength(2);
  });

  it('письмо без комнаты, сообщение человека и системное — не упоминание, даже с @human в тексте', () => {
    const letter = makeLetter('m-1', { roomId: null, from: 's-02', to: ['human'], text: '@human' });
    expect(isHumanMention(letter)).toBe(false);
    expect(isHumanMention({ ...agentMessage('@human'), from: 'human' })).toBe(false);
    expect(isHumanMention({ ...agentMessage('@human'), from: 'system' })).toBe(false);
  });
});

describe('hasHumanMention — быстрый отсев и кеш', () => {
  /** Сколько раз разбирали Markdown: `parse` процессора — общий метод класса, им разбирает и `react-markdown`. */
  const parse = vi.spyOn(
    Object.getPrototypeOf(unified()) as { parse(file: string): unknown },
    'parse',
  );

  beforeEach(() => {
    parse.mockClear();
  });
  afterAll(() => {
    parse.mockRestore();
  });

  it('текст без подстроки @human разбора не получает: ни разметка, ни @s02, ни обрывки слова не в счёт', () => {
    for (const text of [
      '',
      'просто текст',
      '**жирный** и `код`',
      '@s02, @hum и @an',
      'human без собаки',
    ]) {
      expect(hasHumanMention(text), text).toBe(false);
    }
    expect(parse).not.toHaveBeenCalled();
  });

  it('подстрока @human в любом регистре отправляет текст на разбор', () => {
    expect(hasHumanMention('кеш: регистр @HuMaN')).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('ссылка на символ тоже отправляет на разбор: после него `&#64;human` — тот же текст, что и `@human`', () => {
    expect(hasHumanMention('кеш: числом &#64;human')).toBe(true);
    expect(hasHumanMention('кеш: именем &commat;human')).toBe(true);
    expect(hasHumanMention('кеш: буквой @&#x68;uman')).toBe(true);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it('подстрока есть, а упоминания нет (код, ссылка) — разбор был, ответ false', () => {
    expect(hasHumanMention('кеш: `@human` в коде')).toBe(false);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('тот же текст второй раз берётся из кеша — и true, и false', () => {
    const yes = 'кеш: да, @human';
    const no = 'кеш: нет, `@human`';
    expect(hasHumanMention(yes)).toBe(true);
    expect(hasHumanMention(no)).toBe(false);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(hasHumanMention(yes)).toBe(true);
    expect(hasHumanMention(no)).toBe(false);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('кеш ограничен: после 500 других текстов прежний разбирается заново, а свежий остаётся в кеше', () => {
    const first = 'кеш-предел: первый, @human';
    expect(hasHumanMention(first)).toBe(true);
    for (let index = 0; index < 500; index += 1) hasHumanMention(`кеш-предел: ${index}, @human`);
    parse.mockClear();
    // Свежий текст — в кеше: разбора нет.
    expect(hasHumanMention('кеш-предел: 499, @human')).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    // Первый давно вытеснен: ответ тот же, но он разобран заново.
    expect(hasHumanMention(first)).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('вложенность глубже стека плагинов: не бросает и упоминанием не считается — внимание окна не падает', () => {
    // Разбор такой цитаты роняет рекурсию плагинов уже на 4000 уровнях.
    const text = `${'>'.repeat(10_000)} @human`;
    expect(() => hasHumanMention(text)).not.toThrow();
    expect(hasHumanMention(text)).toBe(false);
  }, 20_000);
});
