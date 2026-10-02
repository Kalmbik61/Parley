/**
 * Выдержка и лента читают Markdown одним разбором (Parley 0.3.0): сверка на корпусе. Для каждого простого текста
 * выдержка (`replyExcerpt`) совпадает с видимым текстом первого блока, который рисует `RoomMarkdown`: `textContent`
 * первого узла корня, пробелы схлопнуты. Так выдержка не расходится с лентой там, где прежние регулярки расходились:
 * `[ask @human](url)` в цитате давало «@you», а лента рисует ссылку с буквальным текстом.
 *
 * Таблица и многострочный код — не в корпусе: лента рисует их целиком, а выдержка берёт первую ячейку и первую строку
 * кода (`excerpt.test.ts`). Единственное отличие у простого текста — подпись языка над блоком кода (```ts): её лента
 * рисует первым блоком, а выдержка пропускает и берёт строку кода (`isCodeCaption`); оно проверено отдельным тестом.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { replyExcerpt } from './excerpt.js';
import { RoomMarkdown } from './RoomMarkdown.js';

afterEach(cleanup);

const LABELS: Record<string, string> = { 's-02': 'S02 бэкенд', 's-03': 'S03 ревью' };
const labelOf = (sessionId: string): string | null => LABELS[sessionId] ?? null;

/**
 * Видимый текст первого блока ленты. Первый блок — первый узел корня: абзац, заголовок, список, цитата и блок кода —
 * элементы, а сырой HTML лента печатает текстом прямо в корне.
 */
function firstBlock(text: string, humanChips: boolean): string {
  const { container, unmount } = render(
    <RoomMarkdown
      text={text}
      humanChips={humanChips}
      labelOf={labelOf}
      onOpenExternal={() => {}}
    />,
  );
  const root = container.querySelector('[data-room-markdown]') as HTMLElement;
  const visible = (root.firstChild?.textContent ?? '').replace(/\s+/g, ' ').trim();
  unmount();
  return visible;
}

/** Простые тексты: абзац, заголовок, список, цитата, `@human` в выделении, коде и ссылке, код и HTML первым. */
const CORPUS: ReadonlyArray<readonly [name: string, text: string]> = [
  ['абзац', 'Привет, мир'],
  ['абзац из двух строк', 'раз\nдва'],
  ['абзац с переносом через два пробела', 'раз  \nдва'],
  ['абзац и второй абзац', 'Первый абзац\n\nВторой абзац'],
  ['пустые строки в начале', '\n\n  \nтекст'],
  ['заголовок', '# Заголовок'],
  ['заголовок и текст', '## Итог\n\nтекст ниже'],
  ['подчёркнутый заголовок', 'Заголовок\n=========='],
  ['список', '- первый'],
  ['нумерованный список', '1. раз'],
  ['список задач', '- [ ] сделать'],
  ['отмеченная задача', '- [x] готово'],
  ['цитата', '> цитата'],
  ['цитата со списком', '> - пункт'],
  ['цитата с заголовком', '> ## заголовок'],
  ['жирный и курсив', '**жирный** и _курсив_'],
  ['зачёркнутый', 'было ~~старое~~ стало новое'],
  ['упоминание сессии', '@s02, глянь'],
  ['упоминание неизвестной сессии', '@s09 — кто это?'],
  ['упоминание человека', 'Вопрос к @human: что дальше?'],
  ['`@human` в жирном', '**@human**'],
  ['`@human` в курсиве', '_@human_'],
  ['`@human` в зачёркнутом', '~~@human~~'],
  ['`@human` в инлайн-коде', '`@human`'],
  ['`@human` в инлайн-коде среди текста', 'Токен `@human` значит @human'],
  ['`@human` в заголовке', '# @human'],
  ['`@human` в пункте', '- пункт @human'],
  ['`@human` в цитате', '> @human в цитате'],
  ['ссылка с `@human`', '[ask @human](https://x.dev)'],
  ['ссылка-сноска с `@human`', '[ask @human][ref]\n\n[ref]: https://x.dev'],
  ['ссылка с `@s02`', 'Смотри [@s02](https://x.dev)'],
  ['адрес с `@human`', 'https://github.com/@human'],
  ['автоссылка с `@human`', '<https://x.dev/@human>'],
  ['`@human` в alt картинки', '![@human](https://x.dev/a.png)'],
  ['email', 'пишите на user@human.dev'],
  ['`@humans`', '@humans и @human_team'],
  ['экранированный `@human`', '\\@human'],
  ['`@human` ссылкой на символ', '&#64;human'],
  ['ссылка', 'Смотри [доки](https://example.com/docs?a=1) и [ещё](https://example.com)'],
  ['ссылка с title', '[a](https://x.dev "заголовок")'],
  ['картинка', '![схема](https://example.com/a.png) к задаче'],
  ['картинка с title', '![схема](https://example.com/a.png "заголовок")'],
  ['инлайн-код', 'Файл `__init__.py` и `a ** b`'],
  ['определение ссылки', '[x]: https://x.dev "заголовок"\n\n[x]'],
  ['определение сноски', '[^a]: сноска\n\nтекст[^a]'],
  ['блок кода первым', '```\nconst x = 1;\n```\nпосле'],
  ['блок кода с `@human`', '```\n@human\n```'],
  ['блок кода с отступом', '    код с отступом'],
  ['блок кода из тильд', '~~~\nкод\n~~~'],
  ['HTML первым', '<div>@human</div>'],
  ['HTML-комментарий первым', '<!-- скрытое -->\n\nтекст'],
  ['строчный HTML', '<b>@human</b> привет'],
  ['сущности и экранирование', '\\*не курсив\\* и &amp; и &lt;b&gt;'],
];

describe('выдержка и лента: сверка на корпусе', () => {
  describe.each([
    ['сообщение агента: `@human` — чип «@you»', true],
    ['сообщение человека: `@human` — текст', false],
  ] as const)('%s', (_rule, humanChips) => {
    it.each(CORPUS)('%s: %j', (_name, text) => {
      const shown = firstBlock(text, humanChips);
      expect(shown, 'в ленте есть видимый текст').not.toBe('');
      expect(replyExcerpt(text, labelOf, { humanChips })).toBe(shown);
    });
  });

  it('блок кода с языком: лента рисует подпись языка первым блоком, выдержка её пропускает и берёт строку кода', () => {
    const text = '```ts\nconst x = 1;\n```';
    expect(firstBlock(text, true)).toBe('ts');
    expect(replyExcerpt(text, labelOf)).toBe('const x = 1;');
  });
});
