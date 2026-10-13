// @vitest-environment jsdom
// vitest.config.ts даёт src/main/** среду node, а помощники живут в странице — им нужен DOM.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectorTail } from '../../shared/css-selector.js';
import { PICK_LIMITS } from './design-mode.js';
import { nodeMatches } from './element-info.js';

// Путь, а не URL: в jsdom глобальный URL — его, и readFileSync такой не примет.
const domScript = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'guest-dom.js'), 'utf8');

interface Dom {
  LIMITS: { selectorLinks: number; selector: number; text: number; html: number };
  selectorOf(el: Element): string;
  textOf(el: Element): string;
  htmlOf(el: Element, max: number): string;
  stylesOf(el: Element, keys: readonly string[]): Record<string, string>;
}

/** Скрипт как в госте (первым в строке скрипта режима): ставит `__parleyDom`, если его ещё нет. */
function dom(): Dom {
  (0, eval)(domScript);
  return (globalThis as unknown as { __parleyDom: Dom }).__parleyDom;
}

function $(selector: string): Element {
  const el = document.querySelector(selector);
  if (el === null) throw new Error(`нет ${selector}`);
  return el;
}

beforeEach(() => {
  delete (globalThis as { __parleyDom?: unknown }).__parleyDom;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('guest-dom.js — помощники DOM скриптов выбора и меток (адаптация Orca)', () => {
  it('пределы — зеркало PICK_LIMITS main; второй запуск помощники не подменяет', () => {
    const first = dom();
    expect(first.LIMITS).toEqual({
      selectorLinks: PICK_LIMITS.selectorLinks,
      selector: PICK_LIMITS.selector,
      text: PICK_LIMITS.text,
      html: PICK_LIMITS.html,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(dom()).toBe(first);
  });

  it('селектор — кратчайший уникальный суффикс: id сразу, иначе до двух классов, :nth-of-type — только когда нужен', () => {
    document.body.innerHTML = `
      <main class="page">
        <form id="f"><button class="save primary large" type="button">Save</button></form>
        <section class="card"><p>a</p></section>
        <section class="card"><p>b</p></section>
      </main>`;
    const { selectorOf } = dom();
    expect(selectorOf($('form'))).toBe('form#f');
    expect(selectorOf($('button'))).toBe('button.save.primary');
    expect(selectorOf($('main'))).toBe('main.page');
    expect(selectorOf($('section:nth-of-type(2) > p'))).toBe('section.card:nth-of-type(2) > p');
    expect(selectorOf(document.body)).toBe('body');
  });

  it('уникальность проверяется в порядке звеньев (у Orca с третьего звена — нет): лишнего :nth-of-type нет', () => {
    document.body.innerHTML = '<ul class="x"><li><a>1</a></li></ul><ul class="y"><li><a>2</a></li></ul>';
    expect(dom().selectorOf(document.querySelectorAll('a')[1] as Element)).toBe('ul.y > li > a');
  });

  it('селектор берёт id атрибутом: поле name="id" в форме (DOM clobbering) не превращает звено в form#[object HTMLInputElement]', () => {
    // В браузере именованные поля формы перекрывают её встроенные свойства: <input name="id"> делает form.id этим полем.
    // jsdom так не делает, поэтому подмена выставлена вручную; настоящий id лежит в атрибуте, его getAttribute и читает.
    document.body.innerHTML = '<form id="f"><input name="id" type="text"><button type="button">Go</button></form>';
    const form = $('form');
    Object.defineProperty(form, 'id', { value: $('input') });
    expect(dom().selectorOf(form)).toBe('form#f');
  });

  it('форма без id с полем name="id" (вход, поиск) идёт по классам из атрибута, а не по подменённым id и className', () => {
    // id в атрибуте нет — звено строится по классам. Подмена свойства id не должна давать звено form#[object …], а подмена
    // className — отнимать классы. classList здесь не подменяется: селекторный движок jsdom сам читает его у элемента
    // и падает; в браузере движок родной и свойства-обёртки не читает.
    document.body.innerHTML = `
      <form class="plain"><input name="q" type="text"></form>
      <form class="login primary"><input name="id" type="text"><input name="className" type="text"></form>`;
    const form = $('form.login');
    const [id, className] = Array.from(form.querySelectorAll('input'));
    Object.defineProperty(form, 'id', { value: id });
    Object.defineProperty(form, 'className', { value: className });
    expect(dom().selectorOf(form)).toBe('form.login.primary');
  });

  it('хэши CSS-modules и css-xxxx в селектор не идут; Tailwind-классы экранированы', () => {
    document.body.innerHTML = '<div class="css-1q2w3e Button_root__a1B2c3 md:flex py-1.5"><span>x</span></div><div><span>y</span></div>';
    expect(dom().selectorOf($('div'))).toBe('div.md\\:flex.py-1\\.5');
  });

  it('звено селектора доходит до сверки узла CDP: id из useId (`:r0:`), id с первой цифрой и классы Tailwind', () => {
    // main находит узел по точке клика и сверяет его с последним звеном этого селектора (`element-info.ts#nodeMatches`):
    // экранирование CSS.escape должно сниматься обратно в то, что лежит в атрибутах узла.
    document.body.innerHTML =
      '<form><input id=":r0:" type="text"><div id="123"></div><button class="md:flex py-1.5 plain" type="button">Go</button></form>';
    const { selectorOf } = dom();
    const elements = Array.from(document.querySelectorAll('input, div, button'));
    expect(elements.map((el) => selectorOf(el))).toEqual(['input#\\:r0\\:', 'div#\\31 23', 'button.md\\:flex.py-1\\.5']);
    for (const el of elements) {
      // DOM.describeNode отдаёт атрибуты плоским списком «имя, значение».
      const node = { localName: el.localName, attributes: Array.from(el.attributes).flatMap((attr) => [attr.name, attr.value]) };
      expect(nodeMatches(node, selectorTail(selectorOf(el))), selectorOf(el)).toBe(true);
    }
  });

  it('текст: узлы через пробел, пробелы схлопнуты, script и style не читаются; не больше 80 узлов и LIMITS.text', () => {
    document.body.innerHTML = '<div id="t"><script>window.leak = 1</script><style>.x{}</style><b>Sa</b>ve\n\n  now</div>';
    const { textOf, LIMITS } = dom();
    expect(textOf($('#t'))).toBe('Sa ve now');
    const many = document.createElement('div');
    for (let index = 0; index < 200; index += 1) {
      const span = document.createElement('span');
      span.textContent = 'x';
      many.append(span);
    }
    document.body.append(many);
    expect(textOf(many)).toBe(Array.from({ length: 80 }, () => 'x').join(' '));
    const long = document.createElement('p');
    long.textContent = 'y'.repeat(LIMITS.text + 100);
    document.body.append(long);
    expect(textOf(long)).toBe('y'.repeat(LIMITS.text));
  });

  it('текст: тело textarea не читается — значение секретного поля, которое htmlOf прячет, не уходит через text', () => {
    // Серверная разметка кладёт значение поля в текст узла textarea, а не в атрибут: htmlOf у секретных полей (как в
    // тесте HTML ниже) его очищает, и textOf не вправе его отдать. Прежний text шёл через innerText, а у него тела
    // textarea нет; тело обычного textarea остаётся в HTML.
    document.body.innerHTML = `
      <form id="f">
        <label>Code</label>
        <textarea autocomplete="one-time-code">123456</textarea>
        <textarea autocomplete="cc-number">4111</textarea>
        <textarea autocomplete="section-a new-password">pw2</textarea>
        <textarea name="note">draft</textarea>
        <span>after</span>
      </form>`;
    const { textOf } = dom();
    expect(textOf($('#f'))).toBe('Code after');
    // Выбран сам textarea: его тело тоже не читается.
    expect(textOf($('textarea'))).toBe('');
  });

  it('HTML: без script, style, on* и srcdoc; секретные поля пусты; у href, src и action нет query и hash, чужая схема — пусто', () => {
    document.body.innerHTML = `
      <form id="f" action="/login?next=/admin#x" onsubmit="steal()">
        <input type="password" value="secret">
        <input type="hidden" name="csrf" value="tok">
        <input autocomplete="cc-number" value="4111">
        <input autocomplete="section-a new-password" value="pw2">
        <textarea autocomplete="one-time-code">123456</textarea>
        <input type="text" name="nick" value="visible">
        <a href="/cb?token=abc#frag">back</a>
        <a href="javascript:alert(1)">evil</a>
        <img src="https://cdn.example/a.png?sig=zzz">
        <script>window.leak = 1</script><style>.x{}</style>
        <div srcdoc="leak-srcdoc">frame</div>
      </form>`;
    const { htmlOf } = dom();
    const html = htmlOf($('#f'), 4096);
    for (const secret of ['secret', 'tok', '4111', 'pw2', '123456', 'abc', 'frag', 'next=', 'sig=', 'alert', 'leak', 'steal']) {
      expect(html, secret).not.toContain(secret);
    }
    for (const kept of ['value="visible"', 'action="/login"', 'href="/cb"', 'href=""', 'src="https://cdn.example/a.png"']) expect(html, kept).toContain(kept);
    // На символ длиннее предела: так main видит обрезку и ставит пометку.
    expect(htmlOf($('#f'), 10)).toHaveLength(11);
  });

  it('стили — только переданные ключи, вычисленными значениями', () => {
    document.body.innerHTML = '<p id="s" style="display:flex;position:absolute">x</p>';
    expect(dom().stylesOf($('#s'), ['display', 'position'])).toEqual({ display: 'flex', position: 'absolute' });
  });

  it('стили: значение длиннее LIMITS.text режется в скрипте на символ сверх предела — длину font-family и box-shadow задаёт страница', () => {
    // Встроенные методы строк в изолированном мире целы (страница их не подменит), поэтому предел здесь настоящий, а не
    // в main: туда не должна доходить строка в сотни мегабайт. На символ длиннее — как у htmlOf: так main видит обрезку.
    document.body.innerHTML = '<p id="s">x</p>';
    const { stylesOf, LIMITS } = dom();
    const huge = 'f'.repeat(50_000_000);
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (key: string) => (key === 'font-family' ? huge : 'block') }));
    const styles = stylesOf($('#s'), ['font-family', 'display']);
    // Длина и сравнение булевым значением: упавший toEqual пытался бы показать разницу строк в 50 млн знаков.
    expect(styles['font-family']?.length).toBe(LIMITS.text + 1);
    expect(styles['font-family'] === 'f'.repeat(LIMITS.text + 1)).toBe(true);
    expect(styles.display).toBe('block');
  });
});
