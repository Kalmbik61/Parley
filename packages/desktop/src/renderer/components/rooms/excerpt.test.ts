/**
 * `replyExcerpt` — выдержка из текста сообщения комнаты (Parley 0.3.0): цитата над ответом и тело уведомления
 * об упоминании. Строится из того же разбора Markdown, что и лента (`room-remark.ts`): первый блок, давший непустой
 * текст, строчное содержимое — как в ленте, упоминания — ярлыками, не длиннее 140 знаков (графем). Правила — в шапке
 * `excerpt.ts`; сверка с тем, что рисует `RoomMarkdown`, — `excerpt-feed.test.tsx`.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { unified } from 'unified';
import { replyExcerpt } from './excerpt.js';

const LABELS: Record<string, string> = { 's-02': 'S02 бэкенд', 's-03': 'S03 ревью' };
const labelOf = (sessionId: string): string | null => LABELS[sessionId] ?? null;
const excerpt = (text: string): string => replyExcerpt(text, labelOf);
/** Выдержка из сообщения человека: `@human` в нём — текст. */
const ownExcerpt = (text: string): string => replyExcerpt(text, labelOf, { humanChips: false });

/** Семья из четырёх эмодзи через ZWJ: одна графема из семи кодовых точек. */
const FAMILY = '👨‍👩‍👧‍👦';
/** Программистка — два эмодзи через ZWJ: одна графема из трёх кодовых точек, пять кодовых единиц. */
const TECHNOLOGIST = '👩‍💻';
/** Флаг — пара региональных индикаторов: одна графема из двух кодовых точек. */
const FLAG = '🇷🇺';
/** Обломок суррогатной пары: верхняя половина без нижней или нижняя без верхней. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Сколько раз разбирали Markdown: `parse` процессора — общий метод класса, им разбирает и выдержка. */
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

describe('replyExcerpt — блоки: берётся первый, давший непустой текст', () => {
  it('абзац — целиком, а не первая строка: перенос строки любого вида — пробел', () => {
    expect(excerpt('Одна строка')).toBe('Одна строка');
    expect(excerpt('Первая строка\nвторая строка')).toBe('Первая строка вторая строка');
    expect(excerpt('раз\r\nдва')).toBe('раз два');
    expect(excerpt('раз\rдва')).toBe('раз два');
    expect(excerpt('раз  \nдва')).toBe('раз два');
    expect(excerpt('раз\\\nдва')).toBe('раз два');
  });

  it('абзац один: второй абзац в выдержку не идёт', () => {
    expect(excerpt('Первый абзац\n\nВторой абзац')).toBe('Первый абзац');
    expect(excerpt('Первый\nабзац\n\nВторой абзац')).toBe('Первый абзац');
  });

  it('пустые строки и строки из одних пробелов в начале пропускаются', () => {
    expect(excerpt('\n  \t\nПервая строка\nвторая строка')).toBe('Первая строка вторая строка');
    expect(excerpt('\r\n\r\nкрайняя\r\nдва')).toBe('крайняя два');
    expect(excerpt(`${'\n'.repeat(1000)}текст`)).toBe('текст');
    expect(excerpt(`${'\r\n'.repeat(1000)}текст`)).toBe('текст');
  });

  it('заголовок — его текст; дальнейшее в выдержку не идёт', () => {
    expect(excerpt('# Заголовок')).toBe('Заголовок');
    expect(excerpt('### Заголовок')).toBe('Заголовок');
    expect(excerpt('Заголовок\n=====')).toBe('Заголовок');
    expect(excerpt('## Итог\n\nТекст ниже')).toBe('Итог');
  });

  it('цитата читается по детям: абзац, список, заголовок, код и разрыв внутри неё', () => {
    expect(excerpt('> цитата')).toBe('цитата');
    expect(excerpt('>цитата')).toBe('цитата');
    expect(excerpt('> - пункт в цитате')).toBe('пункт в цитате');
    expect(excerpt('> # заголовок в цитате')).toBe('заголовок в цитате');
    expect(excerpt('> ```\n> код в цитате\n> ```')).toBe('код в цитате');
    expect(excerpt('> ---\n> текст за разрывом')).toBe('текст за разрывом');
    expect(excerpt('> > вложенная цитата')).toBe('вложенная цитата');
  });

  it.each([
    ['маркер «-»', '- пункт', 'пункт'],
    ['маркер «*»', '* пункт', 'пункт'],
    ['маркер «+»', '+ пункт', 'пункт'],
    ['нумерация «1.»', '1. первый', 'первый'],
    ['нумерация «12)»', '12) двенадцатый', 'двенадцатый'],
    ['отступ перед маркером', '   - пункт', 'пункт'],
    ['вложенный список — сначала пункт внешнего', '- внешний\n  - вложенный', 'внешний'],
    ['пункт без текста — первый вложенный', '-\n  - вложенный', 'вложенный'],
    ['пустой первый пункт — следующий', '-\n- второй', 'второй'],
    ['пункт из нескольких строк — целиком', '- раз\n  два', 'раз два'],
  ])('список, пункт: %s', (_name, source, expected) => {
    expect(excerpt(source)).toBe(expected);
  });

  it.each([
    ['пустой флажок', '- [ ] task', 'task'],
    ['отмеченный флажок', '- [x] done', 'done'],
    ['заглавная X', '* [X] Done', 'Done'],
    ['маркер «+»', '+ [ ] plus', 'plus'],
    ['нумерованный список', '1. [ ] step', 'step'],
    ['в цитате', '> - [x] quoted', 'quoted'],
    ['отступ перед маркером', '   - [ ] indented', 'indented'],
    ['разметка после флажка', '- [ ] **важное** дело', 'важное дело'],
    ['флажок и упоминание', '- [ ] @s02 проверит', '@S02 бэкенд проверит'],
  ])('флажок задачи — свойство пункта, а не текст: %s', (_name, source, expected) => {
    expect(excerpt(source)).toBe(expected);
  });

  it('флажок без маркера списка, без пробела после себя или с другой буквой — обычный текст, как в ленте', () => {
    expect(excerpt('[ ] без маркера')).toBe('[ ] без маркера');
    expect(excerpt('- [ ]слитно')).toBe('[ ]слитно');
    expect(excerpt('- [v] другая буква')).toBe('[v] другая буква');
    expect(excerpt('# [ ] в заголовке')).toBe('[ ] в заголовке');
  });

  it('таблица — первая ячейка с текстом; пустые ячейки пропускаются', () => {
    expect(excerpt('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a');
    expect(excerpt('|   | b |\n|---|---|\n| 1 | 2 |')).toBe('b');
    expect(excerpt('| **@s02** | b |\n|---|---|\n| 1 | 2 |')).toBe('@S02 бэкенд');
  });

  it('таблица с лишними ячейками лента выводит исходником (remarkReveal) — выдержка берёт его первую строку', () => {
    expect(excerpt('| a |\n|---|\n| 1 | 2 |')).toBe('| a |');
  });

  it('блок кода — первая непустая строка буквально, разметка в ней не разбирается', () => {
    expect(excerpt('```\nconst x = 1;\n```')).toBe('const x = 1;');
    expect(excerpt('  ~~~\nкод\n~~~')).toBe('код');
    expect(excerpt('    код с отступом\nвторая')).toBe('код с отступом');
    expect(excerpt('```\n\n\nпосле пустых\n```')).toBe('после пустых');
    expect(excerpt('```\n**не жирный**, `@human` и [не ссылка](x)\n```')).toBe(
      '**не жирный**, `@human` и [не ссылка](x)',
    );
    expect(excerpt('```\nдля @s02\n```')).toBe('для @s02');
  });

  it('блок кода в цитате и в пункте списка — тоже его первая строка', () => {
    expect(excerpt('> ```\n> const x = 1;\n> ```')).toBe('const x = 1;');
    expect(excerpt('- ```bash\n  ls -la\n  ```')).toBe('ls -la');
    expect(excerpt('1. ```\n   step\n   ```')).toBe('step');
    expect(excerpt('> - ~~~\n>   код\n>   ~~~')).toBe('код');
  });

  it('пустой блок кода своего текста не даёт: берётся следующий блок', () => {
    expect(excerpt('```\n```\nпосле')).toBe('после');
    expect(excerpt('```\n```')).toBe('');
    expect(excerpt('> ```\n> ```\n\nпосле цитаты')).toBe('после цитаты');
  });

  it('подпись языка над блоком кода (её ставит remarkReveal) — метка кода, а не текст: берётся строка кода', () => {
    expect(excerpt('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
    expect(excerpt('```ts title="a.ts"\nconst x = 1;\n```')).toBe('const x = 1;');
    expect(excerpt('> ```ts\n> const x = 1;')).toBe('const x = 1;');
    expect(excerpt('- ```bash\n  ls -la\n  ```')).toBe('ls -la');
    // Пустой код с языком — ни кода, ни подписи: дальше берётся следующий блок.
    expect(excerpt('```ts\n```\nпосле')).toBe('после');
    // Абзац с тем же словом — обычный текст, пропускается только подпись, поставленная плагином.
    expect(excerpt('ts\n\n```ts\nкод\n```')).toBe('ts');
  });

  it('сырой HTML — первая непустая строка буквально, как лента печатает его текстом', () => {
    expect(excerpt('<div>@human</div>')).toBe('<div>@human</div>');
    expect(excerpt('<!-- скрытое -->\n\nтекст')).toBe('<!-- скрытое -->');
    expect(excerpt('<div>\n  текст\n</div>')).toBe('<div>');
    expect(excerpt('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
    // HTML после абзаца — уже не первый блок.
    expect(excerpt('текст\n\n<div>html</div>')).toBe('текст');
  });

  it('тематический разрыв своего текста не даёт: ---, ***, ___, * * *, - - -, длинные и в цитате', () => {
    for (const line of [
      '---',
      '***',
      '___',
      '* * *',
      '- - -',
      '_ _ _',
      '----------',
      '  ***  ',
      '> ---',
    ]) {
      expect(excerpt(`${line}\n\nТекст`), line).toBe('Текст');
    }
    expect(excerpt(`${'---\n'.repeat(990)}текст`)).toBe('текст');
    // Разрыв, за которым заголовок: «---» после абзаца — подчёркивание заголовка, а не разрыв.
    expect(excerpt('---\ntitle: Заголовок\n---\nТекст')).toBe('title: Заголовок');
    // В блоке кода это просто строка.
    expect(excerpt('---\n***\n```\n___\n```')).toBe('___');
  });

  it('на разрыв похоже, но он не разрыв: две черты, разрыв с текстом, вложенные пункты', () => {
    expect(excerpt('--')).toBe('--');
    expect(excerpt('---текст')).toBe('---текст');
    expect(excerpt('- - - пункт')).toBe('пункт');
  });

  it('определение ссылки и сноски лента возвращает текстом (remarkReveal) — выдержка берёт то же', () => {
    expect(excerpt('[x]: https://example.com "заголовок"\n\n[x]')).toBe(
      '[x]: https://example.com "заголовок"',
    );
    expect(excerpt('[^a]: сноска\n\nтекст[^a]')).toBe('[^a]: сноска');
  });

  it('пусто, если блока с текстом нет: пустой и пробельный текст, картинка без alt, пустые маркеры, пустой код', () => {
    for (const source of [
      '',
      '   ',
      '\n\n',
      '![](https://example.com/a.png)',
      '- ',
      '> ',
      '```\n```',
      '---',
      '***\n---\n___',
    ]) {
      expect(excerpt(source), JSON.stringify(source)).toBe('');
    }
  });
});

describe('replyExcerpt — строчное содержимое: как в ленте', () => {
  it('выделения — их дети: жирный, подчёркнутый, зачёркнутый, курсив, вложенные', () => {
    expect(excerpt('**жирный**, __под__, ~~зачёркнутый~~, *курсив* и _тоже_')).toBe(
      'жирный, под, зачёркнутый, курсив и тоже',
    );
    expect(excerpt('**_вложенное_** и ~~**ещё**~~')).toBe('вложенное и ещё');
  });

  it('то, что не разметка, остаётся: дефис и звёздочка внутри строки, #тег, 2 * 3, одиночные _ и *', () => {
    expect(excerpt('a - b, 2 * 3 и #тег')).toBe('a - b, 2 * 3 и #тег');
    expect(excerpt('snake_case и 2 * 3')).toBe('snake_case и 2 * 3');
    expect(excerpt('-5 градусов и +1')).toBe('-5 градусов и +1');
    expect(excerpt('**')).toBe('**');
    expect(excerpt('раз ` два')).toBe('раз ` два');
  });

  it('пробелы схлопываются, по краям обрезаются', () => {
    expect(excerpt('  много    пробелов \t и неразрывный  ')).toBe('много пробелов и неразрывный');
  });

  it('ссылка [текст](адрес) — её текст; адреса в выдержке нет', () => {
    expect(
      excerpt('Смотри [доки](https://example.com/docs?a=1) и [ещё](https://example.com)'),
    ).toBe('Смотри доки и ещё');
    expect(excerpt('- [x](https://example.com) — ссылка, а не флажок')).toBe(
      'x — ссылка, а не флажок',
    );
    expect(excerpt('Смотри [`file.ts`](src/file.ts) и **[жирная](https://x.dev)**')).toBe(
      'Смотри file.ts и жирная',
    );
  });

  it('ссылка-сноска [текст][метка] — её текст; адрес из определения не берётся', () => {
    expect(excerpt('Смотри [доки][d].\n\n[d]: https://example.com/docs')).toBe('Смотри доки.');
  });

  it('автоссылки: адрес — текст ссылки, и он остаётся как написан', () => {
    expect(excerpt('Адрес <https://example.com/a> и www.example.com/b')).toBe(
      'Адрес https://example.com/a и www.example.com/b',
    );
  });

  it('у ссылки и картинки с title лента дописывает его в скобках — и выдержка', () => {
    expect(excerpt('[a](https://x.dev "заголовок")')).toBe('a (заголовок)');
    expect(excerpt('![схема](https://x.dev/a.png "заголовок")')).toBe('схема (заголовок)');
  });

  it('картинка — её alt; без alt — пусто, а текст рядом остаётся', () => {
    expect(excerpt('![схема](https://example.com/a.png) к задаче')).toBe('схема к задаче');
    expect(excerpt('![](https://example.com/a.png) к задаче')).toBe('к задаче');
    expect(excerpt('![схема][img]\n\n[img]: https://example.com/a.png')).toBe('схема');
  });

  it('инлайн-код — значение буквально: ни разметка в нём, ни упоминания не разбираются', () => {
    expect(excerpt('Файл `__init__.py` и `a ** b`')).toBe('Файл __init__.py и a ** b');
    expect(excerpt('`~~не зачёркнуто~~`')).toBe('~~не зачёркнуто~~');
    expect(excerpt('``a`b``')).toBe('a`b');
  });

  it('сырой HTML внутри абзаца лента печатает текстом — и выдержка', () => {
    expect(excerpt('до <b>жирного</b> после')).toBe('до <b>жирного</b> после');
  });

  it('экранирование и ссылки на символы — как в ленте: разбор уже снял их', () => {
    expect(excerpt('\\*не курсив\\* и &amp; и &lt;b&gt;')).toBe('*не курсив* и & и <b>');
  });
});

describe('replyExcerpt — упоминания', () => {
  it('упоминания — как у чипов ленты: @s02 → @S02 бэкенд, @human → @you, неизвестная сессия — тег', () => {
    expect(excerpt('@s02, глянь')).toBe('@S02 бэкенд, глянь');
    expect(excerpt('@s-03 и @s2 готовы')).toBe('@S03 ревью и @S02 бэкенд готовы');
    expect(excerpt('Вопрос к @human: что дальше?')).toBe('Вопрос к @you: что дальше?');
    expect(excerpt('@Human')).toBe('@you');
    expect(excerpt('@s09 — кто это?')).toBe('@S09 — кто это?');
  });

  it('упоминание внутри разметки тоже заменяется; @humans, @s02бэкенд и email остаются как есть', () => {
    expect(excerpt('- **@s02** и __@human__')).toBe('@S02 бэкенд и @you');
    expect(excerpt('> ## @human')).toBe('@you');
    expect(excerpt('@humans и user@human.dev и @s02бэкенд')).toBe(
      '@humans и user@human.dev и @s02бэкенд',
    );
  });

  it('в инлайн-коде и в блоке кода упоминание остаётся буквальным, как в ленте: `@human` и `@s02` — код', () => {
    expect(excerpt('`@human`')).toBe('@human');
    expect(excerpt('`@s02`')).toBe('@s02');
    expect(excerpt('Токен `@s02` значит @s02, а `@human` — @human')).toBe(
      'Токен @s02 значит @S02 бэкенд, а @human — @you',
    );
    expect(excerpt('``@human`` и ```@s03```')).toBe('@human и @s03');
    expect(excerpt('- **`@s02`** готов')).toBe('@s02 готов');
  });

  it('границы кода: токен вплотную к коду — упоминание, код с обратной кавычкой внутри — один код', () => {
    expect(excerpt('@human`x`')).toBe('@youx');
    expect(excerpt('`x`@s02')).toBe('x@S02 бэкенд');
    expect(excerpt('``a`@s02b``')).toBe('a`@s02b');
  });

  it('в ссылке `@` остаётся буквальным, как в ленте: подпись и адрес — текст ссылки, а не чип', () => {
    expect(excerpt('[ask @human](https://x.dev)')).toBe('ask @human');
    expect(
      excerpt('Смотри [@s02](https://x.dev) и [ask @human][ref]\n\n[ref]: https://x.dev'),
    ).toBe('Смотри @s02 и ask @human');
    expect(excerpt('https://github.com/@human и <https://x.dev/@s02>')).toBe(
      'https://github.com/@human и https://x.dev/@s02',
    );
  });

  it('alt картинки — свойство, а не текст: `@` в нём буквальный', () => {
    expect(excerpt('![@human](https://x.dev/a.png) и ![@s02](https://x.dev/b.png)')).toBe(
      '@human и @s02',
    );
  });

  it('сырой HTML: упоминание в самом блоке — текст, между тегами в абзаце — упоминание, как в ленте', () => {
    expect(excerpt('<div>@human и @s02</div>')).toBe('<div>@human и @s02</div>');
    expect(excerpt('<b>@human</b> привет')).toBe('<b>@you</b> привет');
  });

  it('подпись берётся при каждом вызове: сессию переименовали — выдержка обновилась, хотя разбор лежит в кеше', () => {
    const text = 'кеш-подписи: @s02, посмотри';
    expect(replyExcerpt(text, () => 'S02 бэкенд')).toBe('кеш-подписи: @S02 бэкенд, посмотри');
    expect(parse).toHaveBeenCalledTimes(1);
    expect(replyExcerpt(text, () => 'S02 тесты')).toBe('кеш-подписи: @S02 тесты, посмотри');
    expect(replyExcerpt(text, () => null)).toBe('кеш-подписи: @S02, посмотри');
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

describe('replyExcerpt — свой @human человека (humanChips: false)', () => {
  it('@human остаётся текстом, как написан: без «@you», регистр сохранён', () => {
    expect(ownExcerpt('Вопрос к @human: что дальше?')).toBe('Вопрос к @human: что дальше?');
    expect(ownExcerpt('@Human и @HUMAN')).toBe('@Human и @HUMAN');
    expect(ownExcerpt('- **@human** и __@human__')).toBe('@human и @human');
    expect(ownExcerpt('> ## @human')).toBe('@human');
  });

  it('упоминания сессий остаются: правило касается только @human', () => {
    expect(ownExcerpt('@s02, @human и @s03 — смотрите')).toBe(
      '@S02 бэкенд, @human и @S03 ревью — смотрите',
    );
  });

  it('прочее — как у сообщения агента: код, ссылка, перенос строки, граница токена', () => {
    expect(ownExcerpt('`@human`, [ask @human](https://x.dev) и user@human.dev')).toBe(
      '@human, ask @human и user@human.dev',
    );
    expect(ownExcerpt('раз\n@human')).toBe('раз @human');
    expect(ownExcerpt('@humans')).toBe('@humans');
  });

  it('по умолчанию, при пустых параметрах и при humanChips: true — «@you»', () => {
    expect(replyExcerpt('@human', labelOf)).toBe('@you');
    expect(replyExcerpt('@human', labelOf, {})).toBe('@you');
    expect(replyExcerpt('@human', labelOf, { humanChips: true })).toBe('@you');
  });

  it('правило входит в ключ кеша: тот же текст с разным правилом — два разбора и два ответа', () => {
    const text = 'кеш-правила: @human';
    expect(excerpt(text)).toBe('кеш-правила: @you');
    expect(ownExcerpt(text)).toBe('кеш-правила: @human');
    expect(parse).toHaveBeenCalledTimes(2);
    expect(excerpt(text)).toBe('кеш-правила: @you');
    expect(ownExcerpt(text)).toBe('кеш-правила: @human');
    expect(parse).toHaveBeenCalledTimes(2);
  });
});

describe('replyExcerpt — длина', () => {
  it('обрезка, инвариант на длинах 0..300: до 140 знаков — как есть, длиннее — 140 знаков и «…», не больше 141', () => {
    for (let length = 0; length <= 300; length += 1) {
      const text = 'ы'.repeat(length);
      const result = excerpt(text);
      expect(Array.from(result).length, `длина ${length}`).toBeLessThanOrEqual(141);
      expect(result, `длина ${length}`).toBe(length <= 140 ? text : `${'ы'.repeat(140)}…`);
    }
  });

  it('длина считается по тексту без разметки: 140 знаков внутри ** ** помещаются целиком', () => {
    expect(excerpt(`**${'ы'.repeat(140)}**`)).toBe('ы'.repeat(140));
    expect(excerpt(`> - ${'ы'.repeat(141)}`)).toBe(`${'ы'.repeat(140)}…`);
  });

  it('суррогатная пара на краю обрезки остаётся целой: считается по знакам, а не по кодовым единицам', () => {
    for (let length = 130; length <= 150; length += 1) {
      const result = excerpt('😀'.repeat(length));
      expect(Array.from(result).length, `длина ${length}`).toBeLessThanOrEqual(141);
      expect(result, `длина ${length}`).not.toMatch(LONE_SURROGATE);
    }
    expect(excerpt('😀'.repeat(140))).toBe('😀'.repeat(140));
    expect(excerpt('😀'.repeat(141))).toBe(`${'😀'.repeat(140)}…`);
  });

  it('обрезка не оставляет пробела перед «…»', () => {
    expect(excerpt(`${'а'.repeat(139)} ${'б'.repeat(10)}`)).toBe(`${'а'.repeat(139)}…`);
  });

  it('обрезка по графемам: флаг и эмодзи с ZWJ не рвутся и считаются за один знак', () => {
    expect(excerpt(FLAG.repeat(140))).toBe(FLAG.repeat(140));
    expect(excerpt(FLAG.repeat(141))).toBe(`${FLAG.repeat(140)}…`);
    expect(excerpt(TECHNOLOGIST.repeat(140))).toBe(TECHNOLOGIST.repeat(140));
    expect(excerpt(TECHNOLOGIST.repeat(141))).toBe(`${TECHNOLOGIST.repeat(140)}…`);
    expect(excerpt(`${'а'.repeat(139)}${FAMILY}б`)).toBe(`${'а'.repeat(139)}${FAMILY}…`);
    expect(excerpt(`${'а'.repeat(139)}${FLAG}б`)).toBe(`${'а'.repeat(139)}${FLAG}…`);
  });

  it('обрезка по графемам: буква с комбинирующим знаком и эмодзи с оттенком кожи — один знак', () => {
    const accented = 'é';
    const thumbs = '👍🏽';
    expect(excerpt(accented.repeat(140))).toBe(accented.repeat(140));
    expect(excerpt(accented.repeat(141))).toBe(`${accented.repeat(140)}…`);
    expect(excerpt(thumbs.repeat(141))).toBe(`${thumbs.repeat(140)}…`);
  });

  it('склеенные куски обрезаются как один текст: упоминание, код и ссылка считаются своими знаками', () => {
    // «@S02 бэкенд» — 11 знаков, «код» — 3, пробелы между кусками — 2: остаток до 140 — 124.
    const text = `@s02 \`код\` ${'я'.repeat(200)}`;
    expect(excerpt(text)).toBe(`@S02 бэкенд код ${'я'.repeat(124)}…`);
  });
});

describe('replyExcerpt — вход: длинные тексты читаются с начала', () => {
  it('до разбора текст обрезается до 4000 кодовых единиц: что за краем, выдержке не нужно', () => {
    expect(excerpt(`${'\n'.repeat(3995)}текст`)).toBe('текст');
    // От текста остаётся одна буква: 3999 переводов строки и первая единица слова — 4000.
    expect(excerpt(`${'\n'.repeat(3999)}текст`)).toBe('т');
    expect(excerpt(`${'\n'.repeat(4000)}текст`)).toBe('');
  });

  it('суррогатную пару на краю 4000 не рвёт: верхняя половина без нижней отбрасывается', () => {
    // Верхняя половина эмодзи — последняя из 4000 единиц, нижняя уже за краем: без отбрасывания в выдержке остался бы обломок.
    const result = excerpt(`${'\n'.repeat(3998)}a😀b`);
    expect(result).toBe('a');
    expect(result).not.toMatch(LONE_SURROGATE);
    // Пара целиком внутри 4000 единиц — остаётся.
    expect(excerpt(`${'\n'.repeat(3996)}a😀bc`)).toBe('a😀b');
  });

  it('очень длинная строка без переводов и из тысяч строк — выдержка из первого блока', () => {
    expect(excerpt('x'.repeat(1_000_000))).toBe(`${'x'.repeat(140)}…`);
    expect(excerpt(`${'ы'.repeat(5000)}\nвторая строка`)).toBe(`${'ы'.repeat(140)}…`);
    // 20 слов по шесть знаков и 19 пробелов — 139 знаков; 140-й — пробел, он перед «…» не остаётся.
    expect(excerpt('строка\n'.repeat(100_000))).toBe(`${Array(20).fill('строка').join(' ')}…`);
  });

  it('длинная строка с «[» без «]» и серии обратных кавычек разбираются мгновенно: на разбор идёт не больше 4000 знаков', () => {
    const started = performance.now();
    expect(excerpt('['.repeat(200_000))).toBe(`${'['.repeat(140)}…`);
    expect(excerpt(`![${'['.repeat(100_000)}`)).toBe(`![${'['.repeat(138)}…`);
    // Серия обратных кавычек без закрытия — незавершённая ограда блока кода без текста.
    expect(excerpt('`'.repeat(100_001))).toBe('');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('две тысячи звёздочек со словом — серия без закрытия, текст; одни звёздочки в 4000 знаков — тематический разрыв', () => {
    expect(excerpt(`${'**'.repeat(1000)}tail`)).toBe(`${'*'.repeat(140)}…`);
    // Слово ушло за край 4000 — осталась строка из одних звёздочек, а это разрыв.
    expect(excerpt(`${'**'.repeat(2500)}tail`)).toBe('');
  });
});

describe('replyExcerpt — кеш разобранных кусков', () => {
  it('тот же текст второй раз берётся из кеша: разбора нет, ответ тот же', () => {
    const text = 'кеш: **жирный** и @s02';
    expect(excerpt(text)).toBe('кеш: жирный и @S02 бэкенд');
    expect(parse).toHaveBeenCalledTimes(1);
    expect(excerpt(text)).toBe('кеш: жирный и @S02 бэкенд');
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('ключ — текст после обрезки до 4000: два текста с общим началом не разбираются дважды', () => {
    const head = `кеш-вход: ${'ы'.repeat(3990)}`;
    expect(excerpt(`${head}первый хвост`)).toBe(`${'кеш-вход: '}${'ы'.repeat(130)}…`);
    expect(excerpt(`${head}второй хвост`)).toBe(`${'кеш-вход: '}${'ы'.repeat(130)}…`);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('кеш ограничен: после 500 других текстов прежний разбирается заново, а свежий остаётся в кеше', () => {
    const first = 'кеш-предел: первый';
    expect(excerpt(first)).toBe(first);
    for (let index = 0; index < 500; index += 1) excerpt(`кеш-предел: ${index}`);
    parse.mockClear();
    // Свежий текст — в кеше: разбора нет.
    expect(excerpt('кеш-предел: 499')).toBe('кеш-предел: 499');
    expect(parse).not.toHaveBeenCalled();
    // Первый давно вытеснен: ответ тот же, но он разобран заново.
    expect(excerpt(first)).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});

describe('replyExcerpt — разбор не осилил текст', () => {
  /** Разбор роняет стек так, как его роняет вложенность глубже стека плагинов. */
  const failParse = (): void => {
    parse.mockImplementationOnce(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
  };

  it('запасной путь — первая непустая строка сырого текста, обрезанная так же; ничего не бросает', () => {
    failParse();
    expect(excerpt('\n  \n**сырая** строка с `разметкой` и @human\nвторая')).toBe(
      '**сырая** строка с `разметкой` и @human',
    );
    failParse();
    expect(excerpt(`сбой-длины: ${'ы'.repeat(300)}`)).toBe(`сбой-длины: ${'ы'.repeat(128)}…`);
    failParse();
    expect(excerpt('   \n\t\n')).toBe('');
  });

  it('запасной вариант тоже в кеше: повторный вызов не разбирает текст снова', () => {
    const text = 'сбой-кеш: **сырой** @s02';
    failParse();
    expect(excerpt(text)).toBe('сбой-кеш: **сырой** @s02');
    expect(parse).toHaveBeenCalledTimes(1);
    expect(excerpt(text)).toBe('сбой-кеш: **сырой** @s02');
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('сбой плагина, а не разбора, ловится так же', () => {
    const run = vi
      .spyOn(Object.getPrototypeOf(unified()) as { runSync(tree: unknown): unknown }, 'runSync')
      .mockImplementationOnce(() => {
        throw new RangeError('Maximum call stack size exceeded');
      });
    try {
      expect(excerpt('сбой-плагина: **строка**')).toBe('сбой-плагина: **строка**');
    } finally {
      run.mockRestore();
    }
  });

  it('вложенность из тысяч «>»: ничего не бросает, выдержка не длиннее 141 знака', () => {
    for (const depth of [1000, 3900, 5000, 20_000]) {
      const result = excerpt(`${'>'.repeat(depth)} текст`);
      expect(Array.from(result).length, `глубина ${depth}`).toBeLessThanOrEqual(141);
    }
  }, 20_000);
});
