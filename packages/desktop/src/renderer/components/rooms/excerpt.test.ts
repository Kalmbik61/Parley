/**
 * `replyExcerpt` — выдержка из текста сообщения комнаты (Parley 0.3.0): цитата над ответом и тело уведомления
 * об упоминании. Первая подходящая строка без простой разметки Markdown, упоминания — ярлыками ленты, не длиннее
 * 140 знаков (графем). Правила — в шапке `excerpt.ts`.
 */

import { describe, expect, it } from 'vitest';
import { replyExcerpt } from './excerpt.js';

const LABELS: Record<string, string> = { 's-02': 'S02 бэкенд', 's-03': 'S03 ревью' };
const labelOf = (sessionId: string): string | null => LABELS[sessionId] ?? null;
const excerpt = (text: string): string => replyExcerpt(text, labelOf);

/** Семья из четырёх эмодзи через ZWJ: одна графема из семи кодовых точек. */
const FAMILY = '👨‍👩‍👧‍👦';
/** Программистка — два эмодзи через ZWJ: одна графема из трёх кодовых точек, пять кодовых единиц. */
const TECHNOLOGIST = '👩‍💻';
/** Флаг — пара региональных индикаторов: одна графема из двух кодовых точек. */
const FLAG = '🇷🇺';

describe('replyExcerpt — строка', () => {
  it('берётся первая непустая строка: пустые и из одних пробелов пропускаются, перевод строки любой', () => {
    expect(excerpt('Одна строка')).toBe('Одна строка');
    expect(excerpt('\n  \t\nПервая строка\nвторая строка')).toBe('Первая строка');
    expect(excerpt('раз\r\nдва')).toBe('раз');
    expect(excerpt('раз\rдва')).toBe('раз');
    expect(excerpt('\r\n\r\nкрайняя\r\nдва')).toBe('крайняя');
  });

  it('текст без перевода строки в конце и очень много пустых строк в начале', () => {
    expect(excerpt('без перевода')).toBe('без перевода');
    expect(excerpt(`${'\n'.repeat(100_000)}текст`)).toBe('текст');
    expect(excerpt(`${'\r\n'.repeat(1000)}текст`)).toBe('текст');
  });

  it('ограда блока кода своего текста не даёт: берётся следующая строка', () => {
    expect(excerpt('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
    expect(excerpt('  ~~~\nкод\n~~~')).toBe('код');
    expect(excerpt('```\n```')).toBe('');
  });

  it('ограду узнают после снятия разметки начала строки: `> ```ts`, `- ```bash`, `> - ~~~`', () => {
    expect(excerpt('> ```ts\nconst x = 1;')).toBe('const x = 1;');
    expect(excerpt('- ```bash\nls -la')).toBe('ls -la');
    expect(excerpt('1. ```\nstep')).toBe('step');
    expect(excerpt('> - ~~~\nкод')).toBe('код');
    expect(excerpt('   > ```ts\n> const x = 1;')).toBe('const x = 1;');
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
      expect(excerpt(`${line}\nТекст`), line).toBe('Текст');
    }
    expect(excerpt('---\ntitle: Заголовок\n---\nТекст')).toBe('title: Заголовок');
    expect(excerpt('---\n***\n```\n___\n```')).toBe('');
    expect(excerpt(`${'---\n'.repeat(1000)}текст`)).toBe('текст');
  });

  it('на разрыв похоже, но он не разрыв: две черты, разрыв с текстом, вложенные пункты', () => {
    expect(excerpt('--')).toBe('--');
    expect(excerpt('---текст')).toBe('---текст');
    expect(excerpt('- - - пункт')).toBe('пункт');
    expect(excerpt('**жирный**')).toBe('жирный');
  });

  it('пусто, если подходящей строки нет или от строки ничего не осталось', () => {
    for (const source of ['', '   ', '\n\n', '![](https://example.com/a.png)', '- ', '> ', '**']) {
      expect(excerpt(source), JSON.stringify(source)).toBe('');
    }
  });
});

describe('replyExcerpt — разметка', () => {
  it.each([
    ['заголовок', '# Заголовок', 'Заголовок'],
    ['заголовок третьего уровня', '### Заголовок', 'Заголовок'],
    ['цитата', '> цитата', 'цитата'],
    ['цитата без пробела', '>цитата', 'цитата'],
    ['маркер «-»', '- пункт', 'пункт'],
    ['маркер «*»', '* пункт', 'пункт'],
    ['маркер «+»', '+ пункт', 'пункт'],
    ['нумерация «1.»', '1. первый', 'первый'],
    ['нумерация «12)»', '12) двенадцатый', 'двенадцатый'],
    ['разметка подряд: цитата со списком', '> - пункт в цитате', 'пункт в цитате'],
    [
      'жирный, подчёркнутый, зачёркнутый и код',
      '**жирный**, __под__, ~~зачёркнутый~~ и `код`',
      'жирный, под, зачёркнутый и код',
    ],
    ['отступ перед маркером', '   - пункт', 'пункт'],
  ])('снимает простую разметку: %s', (_name, source, expected) => {
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
  ])('флажок задачи после маркера списка снимается: %s', (_name, source, expected) => {
    expect(excerpt(source)).toBe(expected);
  });

  it('флажок без маркера списка, без пробела после себя или с другой буквой — обычный текст', () => {
    expect(excerpt('[ ] без маркера')).toBe('[ ] без маркера');
    expect(excerpt('- [ ]слитно')).toBe('[ ]слитно');
    expect(excerpt('- [v] другая буква')).toBe('[v] другая буква');
    expect(excerpt('# [ ] в заголовке')).toBe('[ ] в заголовке');
  });

  it('ссылка [текст](адрес) становится текстом, картинка — своим alt; адреса в выдержке нет', () => {
    expect(
      excerpt('Смотри [доки](https://example.com/docs?a=1) и [ещё](https://example.com)'),
    ).toBe('Смотри доки и ещё');
    expect(excerpt('![схема](https://example.com/a.png) к задаче')).toBe('схема к задаче');
    expect(excerpt('- [x](https://example.com) — ссылка, а не флажок')).toBe(
      'x — ссылка, а не флажок',
    );
  });

  it('то, что не разметка, остаётся: дефис и звёздочка внутри строки, #тег, 2 * 3, одиночные _ и *', () => {
    expect(excerpt('a - b, 2 * 3 и #тег')).toBe('a - b, 2 * 3 и #тег');
    expect(excerpt('snake_case и *курсив*')).toBe('snake_case и *курсив*');
    expect(excerpt('-5 градусов и +1')).toBe('-5 градусов и +1');
  });

  it('пробелы схлопываются, по краям обрезаются', () => {
    expect(excerpt('  много    пробелов \t и неразрывный  ')).toBe('много пробелов и неразрывный');
  });
});

describe('replyExcerpt — упоминания и инлайн-код', () => {
  it('упоминания — как у чипов ленты: @s02 → @S02 бэкенд, @human → @you, неизвестная сессия — тег', () => {
    expect(excerpt('@s02, глянь')).toBe('@S02 бэкенд, глянь');
    expect(excerpt('@s-03 и @s2 готовы')).toBe('@S03 ревью и @S02 бэкенд готовы');
    expect(excerpt('Вопрос к @human: что дальше?')).toBe('Вопрос к @you: что дальше?');
    expect(excerpt('@Human')).toBe('@you');
    expect(excerpt('@s09 — кто это?')).toBe('@S09 — кто это?');
  });

  it('упоминание внутри разметки тоже заменяется; @humans и email остаются как есть', () => {
    expect(excerpt('- **@s02** и __@human__')).toBe('@S02 бэкенд и @you');
    expect(excerpt('@humans и user@human.dev')).toBe('@humans и user@human.dev');
  });

  it('в инлайн-коде упоминание остаётся буквальным, как в ленте: `@human` и `@s02` — код', () => {
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

  it('содержимое кода не чистится: `__init__` и `a ** b` остаются как написаны', () => {
    expect(excerpt('Файл `__init__.py` и `a ** b`')).toBe('Файл __init__.py и a ** b');
    expect(excerpt('`~~не зачёркнуто~~`')).toBe('~~не зачёркнуто~~');
  });

  it('подпись ссылки с кодом внутри: от ссылки остаётся код без кавычек', () => {
    expect(excerpt('Смотри [`file.ts`](src/file.ts) и [@s02](https://x.dev)')).toBe(
      'Смотри file.ts и @S02 бэкенд',
    );
  });

  it('обратная кавычка без пары — обрывок разметки, он снимается; код без закрытия кодом не считается', () => {
    expect(excerpt('раз ` два @human')).toBe('раз два @you');
    expect(excerpt('`незакрытый @s02')).toBe('незакрытый @S02 бэкенд');
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
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (let length = 130; length <= 150; length += 1) {
      const result = excerpt('😀'.repeat(length));
      expect(Array.from(result).length, `длина ${length}`).toBeLessThanOrEqual(141);
      expect(result, `длина ${length}`).not.toMatch(lone);
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
    const accented = 'é';
    const thumbs = '👍🏽';
    expect(excerpt(accented.repeat(140))).toBe(accented.repeat(140));
    expect(excerpt(accented.repeat(141))).toBe(`${accented.repeat(140)}…`);
    expect(excerpt(thumbs.repeat(141))).toBe(`${thumbs.repeat(140)}…`);
  });
});

describe('replyExcerpt — длинные строки и тексты', () => {
  it('строка длиннее 1000 знаков читается до 1000-го: разметка дальше него в выдержку не попадает', () => {
    // 400 пар `**` и слово: вся строка (804 знака) читается — слово в выдержке.
    expect(excerpt(`${'**'.repeat(400)}tail`)).toBe('tail');
    // 600 пар `**` (1200 знаков) обрезаны до 500 пар — слово за ними не прочитано.
    expect(excerpt(`${'**'.repeat(600)}tail`)).toBe('');
  });

  it('суррогатную пару на краю 1000 знаков не рвёт: обломка знака в выдержке нет', () => {
    // Верхняя половина эмодзи — 1000-й знак строки, нижняя уже за краем.
    expect(excerpt(`${'**'.repeat(499)}a😀b`)).toBe('a');
  });

  it('очень длинная строка с «[» без «]» разбирается мгновенно: регулярка ссылки видит не больше 1000 знаков', () => {
    expect(excerpt('['.repeat(200_000))).toBe(`${'['.repeat(140)}…`);
    expect(excerpt(`![${'['.repeat(100_000)}`)).toBe(`!${'['.repeat(139)}…`);
    expect(excerpt('`'.repeat(100_001))).toBe('');
  });

  it('очень длинный текст без переводов строки и из тысяч строк — выдержка из первой подходящей', () => {
    expect(excerpt('x'.repeat(1_000_000))).toBe(`${'x'.repeat(140)}…`);
    expect(excerpt(`${'ы'.repeat(5000)}\nвторая строка`)).toBe(`${'ы'.repeat(140)}…`);
    expect(excerpt(`${'строка\n'.repeat(100_000)}`)).toBe('строка');
  });
});
