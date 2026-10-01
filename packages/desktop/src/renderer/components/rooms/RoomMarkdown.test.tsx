/**
 * `RoomMarkdown` — текст сообщения и решения комнаты как Markdown (GFM), 0.2.0: разметка — элементами,
 * `@s02` — чипом, ссылки — только `http(s)` и наружу (`onOpenExternal`), сырой HTML и удалённые картинки —
 * текстом: правила письма (`Letter.tsx`), `rehype-raw` нет.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import { MENTION_CHIP_CLASS } from './mention.js';
import { RoomMarkdown } from './RoomMarkdown.js';

// Счётчик разборов: `react-markdown` зовётся как раньше, но каждая его отрисовка — один разбор текста.
vi.mock('react-markdown', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-markdown')>();
  return { ...original, default: vi.fn(original.default) };
});
const parses = (): number => vi.mocked(ReactMarkdown).mock.calls.length;

afterEach(cleanup);

const LABELS: Record<string, string> = { 's-02': 'S02 бэкенд', 's-03': 'S03 ревью' };
const labelOf = (sessionId: string): string | null => LABELS[sessionId] ?? null;

function renderText(text: string) {
  const onOpenExternal = vi.fn();
  const view = render(
    <RoomMarkdown text={text} labelOf={labelOf} onOpenExternal={onOpenExternal} />,
  );
  return { ...view, onOpenExternal };
}

/** Клик, как его видит страница: возвращает, погасил ли обработчик переход окна. */
function clickPrevented(element: HTMLElement): boolean {
  const click = createEvent.click(element);
  fireEvent(element, click);
  return click.defaultPrevented;
}

describe('RoomMarkdown — разметка элементами', () => {
  it('жирный, курсив и зачёркнутый — strong, em и del', () => {
    const { container } = renderText('**жирный**, *курсив* и ~~зачёркнутый~~');
    expect(container.querySelector('strong')?.textContent).toBe('жирный');
    expect(container.querySelector('em')?.textContent).toBe('курсив');
    expect(container.querySelector('del')?.textContent).toBe('зачёркнутый');
  });

  it('заголовок и списки — h2, ul и ol с пунктами', () => {
    const { container } = renderText('## Итог\n\n- первый\n- второй\n\n1. раз\n2. два');
    expect(screen.getByRole('heading', { level: 2, name: 'Итог' })).toBeTruthy();
    expect(Array.from(container.querySelectorAll('ul > li'), (li) => li.textContent)).toEqual([
      'первый',
      'второй',
    ]);
    expect(Array.from(container.querySelectorAll('ol > li'), (li) => li.textContent)).toEqual([
      'раз',
      'два',
    ]);
  });

  it('инлайн-код — code в абзаце, блок кода — pre > code; без языка тоже', () => {
    const { container } = renderText(
      'Есть `inline` и блоки:\n\n```ts\nconst a = 1;\n```\n\n```\nбез языка\n```',
    );
    expect(container.querySelector('p code')?.textContent).toBe('inline');
    const blocks = Array.from(container.querySelectorAll('pre code'), (code) => code.textContent);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('const a = 1;');
    expect(blocks[1]).toContain('без языка');
  });

  it('таблица GFM — table с ячейками, внутри обёртки с горизонтальной прокруткой', () => {
    const { container } = renderText('| имя | роль |\n|---|---|\n| s02 | бэкенд |');
    const table = container.querySelector('table') as HTMLTableElement;
    expect(table).not.toBeNull();
    expect(Array.from(table.querySelectorAll('th'), (cell) => cell.textContent)).toEqual([
      'имя',
      'роль',
    ]);
    expect(Array.from(table.querySelectorAll('td'), (cell) => cell.textContent)).toEqual([
      's02',
      'бэкенд',
    ]);
    expect(table.parentElement?.className).toContain('overflow-x-auto');
  });

  it('цитата, разделитель и список задач', () => {
    const { container } = renderText('> цитата\n\n---\n\n- [x] готово\n- [ ] ждёт');
    expect(container.querySelector('blockquote')?.textContent?.trim()).toBe('цитата');
    expect(container.querySelector('hr')).not.toBeNull();
    const boxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(boxes.every((box) => box.disabled)).toBe(true);
  });

  it('пустой текст — пустой корень без ошибок', () => {
    const { container } = renderText('');
    expect(container.querySelector('[data-room-markdown]')?.textContent).toBe('');
  });
});

describe('RoomMarkdown — упоминания', () => {
  it('@s02 — чип с ярлыком участника из labelOf; id — в data-mention, вид — как в поле ввода', () => {
    const { container } = renderText('Спросите @s02 про API');
    const chip = container.querySelector('[data-mention]') as HTMLElement;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.getAttribute('data-mention')).toBe('s-02');
    expect(chip.textContent).toBe('@S02 бэкенд');
    expect(chip.className).toBe(MENTION_CHIP_CLASS);
    expect(container.textContent).toBe('Спросите @S02 бэкенд про API');
  });

  it('неизвестный участник (labelOf вернул null) — чип с тегом из id: @S02', () => {
    const { container } = render(
      <RoomMarkdown text="@s02 и @s09 — кто это?" labelOf={() => null} onOpenExternal={() => {}} />,
    );
    const chips = Array.from(container.querySelectorAll('[data-mention]'));
    expect(chips.map((chip) => [chip.getAttribute('data-mention'), chip.textContent])).toEqual([
      ['s-02', '@S02'],
      ['s-09', '@S09'],
    ]);
  });

  it('записи @s-03 и @s2 — тоже упоминания', () => {
    const { container } = renderText('@s-03 и @s2');
    const chips = Array.from(container.querySelectorAll('[data-mention]'));
    expect(chips.map((chip) => [chip.getAttribute('data-mention'), chip.textContent])).toEqual([
      ['s-03', '@S03 ревью'],
      ['s-02', '@S02 бэкенд'],
    ]);
  });

  it('`@s02` в инлайн-коде и в блоке кода — буквальный текст, чипа нет', () => {
    const { container } = renderText('Токен `@s02` в коде\n\n```\n@s03 в блоке\n```');
    expect(container.querySelector('[data-mention]')).toBeNull();
    expect(container.querySelector('p code')?.textContent).toBe('@s02');
    expect(container.querySelector('pre code')?.textContent).toContain('@s03 в блоке');
  });

  it('@ в email и в адресе чипом не становится; настоящее упоминание рядом — становится', () => {
    const { container } = renderText('dev@s02.example.com, https://x.example/@s02 и @s03');
    const chips = container.querySelectorAll('[data-mention]');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.getAttribute('data-mention')).toBe('s-03');
    expect(container.textContent).toContain('dev@s02.example.com');
    expect(screen.getByRole('link', { name: 'https://x.example/@s02' })).toBeTruthy();
  });

  it('в подписи ссылки `@s02` — текст ссылки, а не чип: внутри <a> он открывал бы ссылку', () => {
    const { container } = renderText('[спросить @s02](https://example.com/ask)');
    expect(container.querySelector('[data-mention]')).toBeNull();
    expect(screen.getByRole('link', { name: 'спросить @s02' })).toBeTruthy();
  });

  it('чип стоит и внутри жирного, и в пункте списка', () => {
    const { container } = renderText('**@s02**\n\n- @s03 — ревью');
    expect(container.querySelector('strong [data-mention="s-02"]')).not.toBeNull();
    expect(container.querySelector('li [data-mention="s-03"]')).not.toBeNull();
  });

  it('разбор Markdown повторяется, только когда изменился текст: колбэки и ярлыки на него не влияют', () => {
    const text = '@s02 и **жирный**';
    const view = render(<RoomMarkdown text={text} labelOf={labelOf} onOpenExternal={() => {}} />);
    const first = parses();
    // Лента перерисовывается с новыми колбэками на каждое событие активности: разбирать каждый раз дорого.
    view.rerender(
      <RoomMarkdown text={text} labelOf={(id) => labelOf(id)} onOpenExternal={() => {}} />,
    );
    expect(parses()).toBe(first);
    // Ярлык упомянутого участника сменился — чип обновился, а текст заново не разбирался.
    view.rerender(
      <RoomMarkdown text={text} labelOf={() => 'S02 тесты'} onOpenExternal={() => {}} />,
    );
    expect(parses()).toBe(first);
    expect(view.container.querySelector('[data-mention]')?.textContent).toBe('@S02 тесты');
    view.rerender(
      <RoomMarkdown text="другой текст" labelOf={() => 'S02 тесты'} onOpenExternal={() => {}} />,
    );
    expect(parses()).toBe(first + 1);
  });

  it('ярлык берётся при каждой отрисовке: переименованная сессия меняет чип на месте', () => {
    const { container, rerender } = renderText('@s02');
    expect(container.querySelector('[data-mention]')?.textContent).toBe('@S02 бэкенд');
    rerender(<RoomMarkdown text="@s02" labelOf={() => 'S02 тесты'} onOpenExternal={() => {}} />);
    expect(container.querySelector('[data-mention]')?.textContent).toBe('@S02 тесты');
  });
});

describe('RoomMarkdown — ссылки', () => {
  it('клик по http(s)-ссылке зовёт onOpenExternal(url), окно не переходит (defaultPrevented)', () => {
    const { onOpenExternal } = renderText('[доки](https://example.com/docs?a=1#b)');
    const link = screen.getByRole('link', { name: 'доки' });
    expect(link.getAttribute('href')).toBe('https://example.com/docs?a=1#b');
    expect(link.getAttribute('title')).toBe('https://example.com/docs?a=1#b');
    expect(clickPrevented(link)).toBe(true);
    expect(onOpenExternal).toHaveBeenCalledTimes(1);
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/docs?a=1#b');
  });

  it('http без s — тоже ссылка', () => {
    const { onOpenExternal } = renderText('[локально](http://localhost:3000/x)');
    clickPrevented(screen.getByRole('link', { name: 'локально' }));
    expect(onOpenExternal).toHaveBeenCalledWith('http://localhost:3000/x');
  });

  it('[x](javascript:alert(1)) — без активного href: текст x остаётся, ссылки нет', () => {
    const { container, onOpenExternal } = renderText('[x](javascript:alert(1))');
    expect(container.querySelector('[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('x');
    expect(onOpenExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['JavaScript: в другом регистре', '[x](JAVASCRIPT:alert(1))'],
    ['file:', '[x](file:///etc/passwd)'],
    ['data:', '[x](data:text/html,hi)'],
    ['mailto:', '[x](mailto:a@b.co)'],
    ['относительный путь', '[x](./readme.md)'],
    ['путь от корня', '[x](/etc/passwd)'],
    ['адрес без схемы //хост', '[x](//evil.example/x)'],
    ['якорь', '[x](#section)'],
    ['пустой адрес', '[x]()'],
  ])('%s — текстом, без href', (_name, markdown) => {
    const { container, onOpenExternal } = renderText(markdown);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
    expect(container.textContent).toBe('x');
    expect(onOpenExternal).not.toHaveBeenCalled();
  });

  it('адрес, который связал сам remark-gfm: https и www — ссылки, хвостовая точка в адрес не входит', () => {
    const { onOpenExternal } = renderText('см. https://example.com/doc. И ещё www.example.org');
    const doc = screen.getByRole('link', { name: 'https://example.com/doc' });
    const www = screen.getByRole('link', { name: 'www.example.org' });
    expect(clickPrevented(doc)).toBe(true);
    expect(clickPrevented(www)).toBe(true);
    expect(onOpenExternal.mock.calls).toEqual([
      ['https://example.com/doc'],
      ['http://www.example.org'],
    ]);
  });

  it('адрес электронной почты, который связал remark-gfm, — текстом: mailto наружу не уходит', () => {
    const { container } = renderText('пишите на dev@example.com');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('пишите на dev@example.com');
  });

  it('перерисовка с новыми колбэками не пересоздаёт ссылку, а клик зовёт свежий onOpenExternal', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <RoomMarkdown text="[a](https://example.com)" labelOf={labelOf} onOpenExternal={first} />,
    );
    const link = screen.getByRole('link', { name: 'a' });
    rerender(
      <RoomMarkdown
        text="[a](https://example.com)"
        labelOf={(id) => labelOf(id)}
        onOpenExternal={second}
      />,
    );
    expect(screen.getByRole('link', { name: 'a' })).toBe(link);
    clickPrevented(link);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('https://example.com');
  });
});

describe('RoomMarkdown — сырой HTML', () => {
  it('<script> не даёт элемента: показан текстом', () => {
    const { container } = renderText('до <script>alert(1)</script> после');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toBe('до <script>alert(1)</script> после');
  });

  it('блочный HTML — тоже текстом: ни img с onerror, ни iframe, ни style', () => {
    const { container } = renderText(
      '<img src=x onerror=alert(1)>\n\n<iframe src="https://evil.example"></iframe>\n\n<style>a{}</style>',
    );
    expect(container.querySelector('img, iframe, style, [onerror]')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('RoomMarkdown — картинки', () => {
  it('удалённая картинка — не img: alt виден текстом-ссылкой на адрес, клик открывает его наружу', () => {
    const { container, onOpenExternal } = renderText('![схема](https://example.com/a.png)');
    expect(container.querySelector('img')).toBeNull();
    const link = screen.getByRole('link', { name: 'схема' });
    expect(link.getAttribute('href')).toBe('https://example.com/a.png');
    expect(clickPrevented(link)).toBe(true);
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/a.png');
  });

  it('удалённая картинка без alt — ссылка с самим адресом: молча она не пропадает', () => {
    const { container } = renderText('![](https://example.com/a.png)');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'https://example.com/a.png' })).toBeTruthy();
  });

  it('картинка не по http(s) — только alt текстом: ни img, ни ссылки', () => {
    const { container } = renderText(
      '![раз](./a.png) ![два](file:///etc/a.png) ![три](data:image/png;base64,AAAA)',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('раз два три');
  });

  it('картинка внутри ссылки (значок-бейдж) — alt в одной ссылке, а не ссылка в ссылке', () => {
    const { container, onOpenExternal } = renderText(
      '[![значок](https://img.example/b.svg)](https://example.com/p)',
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    const link = screen.getByRole('link', { name: 'значок' });
    expect(link.getAttribute('href')).toBe('https://example.com/p');
    clickPrevented(link);
    expect(onOpenExternal.mock.calls).toEqual([['https://example.com/p']]);
  });
});

describe('RoomMarkdown — переносы строк', () => {
  it('строка1\\nстрока2 — обе строки в одном абзаце, между ними <br>', () => {
    const { container } = renderText('строка1\nстрока2');
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(1);
    // `\n` после `<br>` кладёт сам mdast-util-to-hast; браузер схлопывает его в начале строки.
    expect(paragraphs[0]?.innerHTML).toBe('строка1<br>\nстрока2');
    expect(paragraphs[0]?.querySelectorAll('br')).toHaveLength(1);
  });

  it('переводы строки \\r\\n и \\r — тоже по одному <br>', () => {
    const { container } = renderText('раз\r\nдва\rтри');
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.querySelectorAll('br')).toHaveLength(2);
    const lines = Array.from(paragraphs[0]?.childNodes ?? [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent?.trim())
      .filter((line) => line !== '');
    expect(lines).toEqual(['раз', 'два', 'три']);
  });

  it('пустая строка — новый абзац, а не <br>', () => {
    const { container } = renderText('раз\n\nдва');
    expect(Array.from(container.querySelectorAll('p'), (p) => p.textContent)).toEqual([
      'раз',
      'два',
    ]);
    expect(container.querySelector('br')).toBeNull();
  });

  it('перенос внутри пункта списка виден; перенос перед упоминанием — тоже', () => {
    const { container } = renderText('- раз\n  два\n\nпиши\n@s03');
    expect(container.querySelector('li')?.innerHTML).toBe('раз<br>\nдва');
    const last = Array.from(container.querySelectorAll('p')).at(-1) as HTMLElement;
    expect(last.querySelector('br')).not.toBeNull();
    expect(last.querySelector('[data-mention="s-03"]')).not.toBeNull();
  });

  it('вложенный список — ul внутри пункта, без лишних <br>', () => {
    const { container } = renderText('- a\n  - b\n  - c\n- d');
    expect(Array.from(container.querySelectorAll('li > ul > li'), (li) => li.textContent)).toEqual([
      'b',
      'c',
    ]);
    expect(container.querySelector('br')).toBeNull();
  });
});

describe('RoomMarkdown — вид', () => {
  it('корень — 14px/1.55 с переносом длинных слов и адресов; whitespace-pre-wrap нет', () => {
    const { container } = renderText('текст');
    const root = container.querySelector('[data-room-markdown]') as HTMLElement;
    for (const token of [
      'text-sm',
      'leading-[1.55]',
      'break-words',
      '[overflow-wrap:anywhere]',
      'min-w-0',
    ]) {
      expect(root.className, token).toContain(token);
    }
    expect(root.className).not.toContain('whitespace-pre');
  });

  it('типографика ленты — из темы: абзацы, заголовки, списки, код, цитата, hr, таблица', () => {
    const { container } = renderText('текст');
    const classes = (
      container.querySelector('[data-room-markdown]') as HTMLElement
    ).className.split(/\s+/);
    for (const token of [
      '[&_p]:my-1.5',
      '[&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold',
      '[&_ul]:list-disc',
      '[&_ul]:pl-5',
      '[&_ol]:list-decimal',
      '[&_ol]:pl-5',
      '[&_code]:bg-muted',
      '[&_code]:font-mono',
      '[&_pre]:overflow-x-auto',
      '[&_blockquote]:border-l-[3px]',
      '[&_hr]:border-border',
      '[&_td]:border-border',
    ]) {
      expect(classes, token).toContain(token);
    }
  });

  it('длинное слово без пробелов остаётся одним текстовым узлом внутри корня', () => {
    const word = 'Ы'.repeat(2000);
    const { container } = renderText(word);
    expect(container.querySelector('[data-room-markdown]')?.textContent).toBe(word);
  });
});

describe('RoomMarkdown — строчный вид (inline)', () => {
  const BLOCKS =
    'p, h1, h2, h3, h4, h5, h6, ul, ol, li, pre, blockquote, table, tr, td, th, hr, br';
  /** Текст так, как его видит читатель: пробельные цепочки и переводы строк схлопнуты. */
  const flat = (element: Element): string =>
    (element.textContent ?? '').replace(/\s+/g, ' ').trim();

  function renderInline(text: string) {
    const onOpenExternal = vi.fn();
    const view = render(
      <RoomMarkdown inline text={text} labelOf={labelOf} onOpenExternal={onOpenExternal} />,
    );
    const root = view.container.querySelector('[data-room-markdown]') as HTMLElement;
    return { ...view, root, onOpenExternal };
  }

  it('корень — span без блочной типографики: сидит в строке, а не отдельным блоком', () => {
    const { root } = renderInline('текст');
    expect(root.tagName).toBe('SPAN');
    expect(root.getAttribute('data-room-markdown')).toBe('inline');
    expect(root.className).toContain('[&_code]:bg-muted');
    expect(root.className).not.toContain('text-sm');
    expect(root.className).not.toContain('[&_p]:my-1.5');
  });

  it('блоки сворачиваются в строку: заголовок, абзацы, списки, цитата, таблица, hr и блок кода', () => {
    const { root } = renderInline(
      '# Заголовок\n\nабзац\n\n- пункт\n  - вложенный\n\n> цитата\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n```\nкод\n```',
    );
    expect(root.querySelector(BLOCKS)).toBeNull();
    expect(flat(root)).toBe('Заголовок абзац пункт вложенный цитата a b 1 2 код');
  });

  it('жирный, курсив, зачёркнутый, инлайн-код, ссылка и чип остаются элементами', () => {
    const { root } = renderInline('**ж** *к* ~~з~~ `код` [ссылка](https://example.com) @s02');
    expect(root.querySelector('strong')?.textContent).toBe('ж');
    expect(root.querySelector('em')?.textContent).toBe('к');
    expect(root.querySelector('del')?.textContent).toBe('з');
    expect(root.querySelector('code')?.textContent).toBe('код');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(root.querySelector('[data-mention="s-02"]')?.textContent).toBe('@S02 бэкенд');
  });

  it('перенос строки — пробел, а не <br>: одиночный, из двух пробелов и обратной косой', () => {
    const { root } = renderInline('раз\nдва  \nтри\\\nчетыре');
    expect(flat(root)).toBe('раз два три четыре');
    expect(root.querySelector('br')).toBeNull();
  });

  it('`@s02` в инлайн-коде и в блоке кода — буквально, чип только вне кода', () => {
    const { root } = renderInline('`@s02`, @s03\n\n```\n@s02\n```');
    expect(
      Array.from(root.querySelectorAll('[data-mention]'), (chip) =>
        chip.getAttribute('data-mention'),
      ),
    ).toEqual(['s-03']);
    expect(Array.from(root.querySelectorAll('code'), (code) => code.textContent?.trim())).toEqual([
      '@s02',
      '@s02',
    ]);
  });

  it('картинка — как в ленте: alt текстом или ссылкой; список задач — без флажков', () => {
    const { root } = renderInline(
      '![схема](https://example.com/a.png) ![два](./b.png)\n\n- [x] готово',
    );
    expect(root.querySelector('img, input')).toBeNull();
    expect(root.querySelector('a')?.textContent).toBe('схема');
    expect(flat(root)).toBe('схема два готово');
  });

  it('те же правила ссылок и HTML: javascript: и сырой <script> — текстом', () => {
    const { root, onOpenExternal } = renderInline(
      '[x](javascript:alert(1)) <script>alert(1)</script>',
    );
    expect(root.querySelector('a, script')).toBeNull();
    expect(flat(root)).toBe('x <script>alert(1)</script>');
    expect(onOpenExternal).not.toHaveBeenCalled();
  });

  it('внутри inline-текста перерисовка с новыми колбэками не разбирает текст заново', () => {
    const text = '## План\n\n- @s02';
    const view = render(
      <RoomMarkdown inline text={text} labelOf={labelOf} onOpenExternal={() => {}} />,
    );
    const first = parses();
    view.rerender(
      <RoomMarkdown inline text={text} labelOf={() => 'S02 иначе'} onOpenExternal={() => {}} />,
    );
    expect(parses()).toBe(first);
    expect(view.container.querySelector('[data-mention]')?.textContent).toBe('@S02 иначе');
  });
});
