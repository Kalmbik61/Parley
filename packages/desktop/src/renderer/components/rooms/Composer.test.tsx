/**
 * Поле ввода комнаты (спека окна 2026-09-29, 1.3, 2.2, 2.3, 3.4; кусок 6 плана): меню упоминаний,
 * сериализация в `@s02` и `to[]`, вставка текстом, удаление чипа целиком, черновик на комнату.
 *
 * jsdom не редактирует сам: набор моделируется правкой узлов и курсора (`type`, `caret`), а родная
 * команда браузера `document.execCommand` подменена в `beforeEach` — она делает то, что сделал бы
 * Chromium: вставляет текст или `<br>` в позицию курсора и шлёт `input`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useUiStore } from '../../store/ui.js';
import { fakeDictationDeps } from '../../test-utils/dictation.js';
import { useDictationStore } from '../../voice/dictation-store.js';
import { Composer, type ComposerMember, type ComposerSubmission } from './Composer.js';

const MEMBERS: ComposerMember[] = [
  { id: 's-01', label: 'S01 архитектор', rawLabel: 'архитектор', provider: 'claude', providerName: 'Claude Code', model: 'Opus 5.5', word: 'working', lead: true },
  { id: 's-02', label: 'S02 бэкенд', rawLabel: 'бэкенд', provider: 'claude', providerName: 'Claude Code', model: null, word: 'needs you', lead: false },
  { id: 's-03', label: 'S03 ревью', rawLabel: 'ревью', provider: 'codex', providerName: 'Codex', model: 'GPT-5.5', word: 'idle', lead: false },
];

/** Восемь агентов: список меню (max-height 260) с ними длиннее окна и прокручивается. */
const MANY: ComposerMember[] = Array.from({ length: 8 }, (_, index) => ({
  id: `s-0${index + 1}`,
  label: `S0${index + 1} агент`,
  rawLabel: 'агент',
  provider: 'claude',
  providerName: 'Claude Code',
  model: null,
  word: 'idle',
  lead: index === 0,
}));

const KEY = '/tmp/p w-01/r-01';

type SendResult = Promise<void> | void;
let execCommand: ReturnType<typeof vi.fn>;
/** Вызовы `scrollIntoView`: какой пункт меню и с какими параметрами просили показать. */
let scrolled: Array<{ id: string | null; options: boolean | ScrollIntoViewOptions | undefined }>;

beforeEach(() => {
  useUiStore.setState({ composerDrafts: {} });
  // Как Chromium: команда правит поле в позиции курсора и посылает `input` редактируемому узлу.
  execCommand = vi.fn((command: string, _showUi?: boolean, value?: string): boolean => {
    const selection = document.getSelection();
    if (selection === null || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    if (command === 'insertText') {
      const node = document.createTextNode(value ?? '');
      range.insertNode(node);
      selection.collapse(node, node.data.length);
    } else if (command === 'insertLineBreak') {
      const br = document.createElement('br');
      range.insertNode(br);
      selection.collapse(br.parentNode, Array.from(br.parentNode?.childNodes ?? []).indexOf(br) + 1);
    } else {
      return false;
    }
    const host = document.querySelector('[data-room-editor]');
    host?.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  document.execCommand = execCommand as unknown as typeof document.execCommand;
  // Меню прокручивает выбранный пункт в видимую область; в jsdom `scrollIntoView` нет.
  scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element, options?: boolean | ScrollIntoViewOptions) {
    scrolled.push({ id: this.getAttribute('data-mention-item'), options });
  };
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'execCommand');
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  Reflect.deleteProperty(document, 'caretRangeFromPoint');
});

function renderComposer(
  onSend: (submission: ComposerSubmission) => SendResult = vi.fn(),
  draftKey = KEY,
  members: ComposerMember[] = MEMBERS,
) {
  const view = render(<Composer members={members} draftKey={draftKey} onSend={onSend} />);
  return { ...view, onSend };
}

/** Новое поле «с нуля» посреди теста: прежнее размонтировано и черновик стёрт, иначе он поднялся бы в новое поле. */
function fresh(): void {
  cleanup();
  useUiStore.setState({ composerDrafts: {} });
}

const editor = (): HTMLElement => screen.getByRole('textbox', { name: 'Message' });
const options = (): HTMLElement[] => screen.queryAllByRole('option');
const chips = (): HTMLElement[] => Array.from(editor().querySelectorAll<HTMLElement>('[data-mention]'));

function caret(node: Node, offset: number): void {
  document.getSelection()?.collapse(node, offset);
}

/** Набор с клавиатуры: дописывает в последний текстовый узел (или заводит его), курсор — в конец, затем `input`. */
function type(text: string): Text {
  const host = editor();
  let node = host.lastChild;
  if (!(node instanceof Text)) {
    node = document.createTextNode('');
    host.append(node);
  }
  const textNode = node as Text;
  textNode.data += text;
  caret(textNode, textNode.data.length);
  fireEvent.input(host);
  return textNode;
}

function press(key: string, init: KeyboardEventInit = {}): boolean {
  return fireEvent.keyDown(editor(), { key, ...init });
}

/** Открыть меню и выбрать участника по номеру пункта клавишами: ↓ нужное число раз и Enter. */
function pickByKeys(index: number): void {
  type('@');
  for (let i = 0; i < index; i += 1) press('ArrowDown');
  press('Enter');
}

describe('Composer — поле и подпись', () => {
  it('пустое поле: плейсхолдер и подпись «To everyone»', () => {
    renderComposer();
    expect(screen.getByText('Write to everyone · type @ to mention an agent')).toBeTruthy();
    expect(screen.getByText('To everyone')).toBeTruthy();
    expect(editor().getAttribute('contenteditable')).toBe('true');
  });

  it('набор текста убирает плейсхолдер', () => {
    renderComposer();
    type('привет');
    expect(screen.queryByText('Write to everyone · type @ to mention an agent')).toBeNull();
  });

  it('подпись следует за чипами: To S02, S03', () => {
    renderComposer();
    pickByKeys(1);
    expect(screen.getByText('To S02')).toBeTruthy();
    type('и ');
    type('@');
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    expect(screen.getByText('To S02, S03')).toBeTruthy();
  });
});

describe('Composer — признак фокуса (спека, раздел 4)', () => {
  it('фокус — контур --ring 2px с отступом 2px из base.css: поле его не гасит, каретка цвета ring', () => {
    renderComposer();
    // `outline-none` перекрыл бы правило `:focus-visible` слоя base (см. `styles/fonts.test.ts`).
    expect(editor().className).not.toMatch(/outline-(none|hidden|0)\b/);
    expect(editor().className).toContain('caret-ring');
  });
});

describe('Composer — когда открывается меню упоминаний (2.3)', () => {
  it('@ в начале строки: все участники комнаты и заголовок', () => {
    renderComposer();
    type('@');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByText('Agents in this room')).toBeTruthy();
    // Мета пункта: `{модель} · {состояние}`; модель неизвестна — только состояние.
    expect(options().map((item) => item.textContent)).toEqual([
      'S01 архитектор★Opus 5.5 · working',
      'S02 бэкендneeds you',
      'S03 ревьюGPT-5.5 · idle',
    ]);
  });

  it('у ведущего в меню ★ с подписью Lead, у прочих её нет', () => {
    renderComposer();
    type('@');
    const stars = screen.getAllByTitle('Lead');
    expect(stars).toHaveLength(1);
    expect(stars[0]?.closest('[role="option"]')?.getAttribute('data-mention-item')).toBe('s-01');
  });

  it('@ после пробела, неразрывного пробела и переноса', () => {
    renderComposer();
    type('привет @');
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fresh();

    renderComposer();
    type('привет @');
    expect(screen.queryByRole('listbox')).not.toBeNull();
    fresh();

    renderComposer();
    type('раз');
    press('Enter', { shiftKey: true });
    type('@');
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('@ в середине слова и в email меню не открывает', () => {
    renderComposer();
    type('слово@');
    expect(screen.queryByRole('listbox')).toBeNull();
    fresh();

    renderComposer();
    type('пишите на user@');
    expect(screen.queryByRole('listbox')).toBeNull();
    type('example.com');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('до 24 знаков запроса меню открыто, на 25-м закрывается', () => {
    renderComposer();
    type(`@${'x'.repeat(24)}`);
    expect(screen.queryByRole('listbox')).not.toBeNull();
    type('x');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('фильтр — по «S02 s02 ярлык провайдер» без учёта регистра; ничего не подошло — «No agents match»', () => {
    renderComposer();
    type('@БЭК');
    expect(options().map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-02']);
    fresh();

    renderComposer();
    type('@codex');
    expect(options().map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-03']);
    fresh();

    renderComposer();
    type('@s01');
    expect(options().map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-01']);
    type('9');
    expect(options()).toHaveLength(0);
    expect(screen.getByText('No agents match')).toBeTruthy();
  });

  it('фильтр ищет и по модели: «S02 s02 ярлык провайдер модель» (2.3)', () => {
    renderComposer();
    type('@opus');
    expect(options().map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-01']);
    fresh();

    renderComposer();
    type('@GPT-5');
    expect(options().map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-03']);
  });
});

describe('Composer — клавиши меню', () => {
  const selectedIds = (): string[] =>
    options()
      .filter((item) => item.getAttribute('aria-selected') === 'true')
      .map((item) => item.getAttribute('data-mention-item') ?? '');

  it('↓ и ↑ ходят по кругу', () => {
    renderComposer();
    type('@');
    expect(selectedIds()).toEqual(['s-01']);
    press('ArrowDown');
    expect(selectedIds()).toEqual(['s-02']);
    press('ArrowDown');
    press('ArrowDown');
    expect(selectedIds()).toEqual(['s-01']);
    press('ArrowUp');
    expect(selectedIds()).toEqual(['s-03']);
  });

  it('выбор держится, пока запрос тот же (keyup стрелки), и возвращается на первый пункт, когда запрос сменился', () => {
    renderComposer();
    type('@');
    press('ArrowDown');
    press('ArrowDown');
    fireEvent.keyUp(editor(), { key: 'ArrowDown' });
    expect(selectedIds()).toEqual(['s-03']);
    type('cl');
    expect(options().map((item) => item.getAttribute('data-mention-item'))).toEqual(['s-01', 's-02']);
    expect(selectedIds()).toEqual(['s-01']);
  });

  it('стрелки не двигают курсор в поле: событие погашено', () => {
    renderComposer();
    type('@');
    expect(press('ArrowDown')).toBe(false);
  });

  it('Enter вставляет выбранного и письмо не отправляет', () => {
    const { onSend } = renderComposer();
    type('@');
    press('ArrowDown');
    expect(press('Enter')).toBe(false);
    expect(chips().map((chip) => chip.getAttribute('data-mention'))).toEqual(['s-02']);
    expect(chips()[0]?.textContent).toBe('@S02 бэкенд');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Tab вставляет выбранного', () => {
    renderComposer();
    type('@');
    press('ArrowDown');
    press('ArrowDown');
    press('Tab');
    expect(chips().map((chip) => chip.getAttribute('data-mention'))).toEqual(['s-03']);
  });

  it('Esc закрывает меню, и оно не возвращается на keyup того же Esc', () => {
    renderComposer();
    type('@');
    expect(press('Escape')).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyUp(editor(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    // Набор в том же @запросе меню не возвращает; новая @ после пробела — открывает.
    type('с');
    expect(screen.queryByRole('listbox')).toBeNull();
    type(' @');
    expect(screen.queryByRole('listbox')).not.toBeNull();
  });

  it('клик по пункту — на mousedown, с preventDefault: поле не теряет фокус', () => {
    renderComposer();
    type('@');
    const notPrevented = fireEvent.mouseDown(options()[1] as HTMLElement);
    expect(notPrevented).toBe(false);
    expect(chips().map((chip) => chip.getAttribute('data-mention'))).toEqual(['s-02']);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('наведение выделяет пункт', () => {
    renderComposer();
    type('@');
    fireEvent.mouseMove(options()[2] as HTMLElement);
    expect(selectedIds()).toEqual(['s-03']);
  });

  it('потеря фокуса полем закрывает меню', () => {
    renderComposer();
    type('@');
    fireEvent.blur(editor());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Enter при меню без совпадений отправляет письмо как обычный Enter', () => {
    const { onSend } = renderComposer();
    type('@нету');
    expect(options()).toHaveLength(0);
    press('Enter');
    expect(onSend).toHaveBeenCalledWith({ to: [], text: '@нету' });
  });
});

describe('Composer — меню при 7+ агентах: выбранный пункт в видимой части списка', () => {
  const lastScrolled = (): string | null | undefined => scrolled[scrolled.length - 1]?.id;

  it('↓ прокручивает выбранный пункт в видимую область: scrollIntoView({ block: nearest })', () => {
    renderComposer(vi.fn(), KEY, MANY);
    type('@');
    scrolled = [];
    press('ArrowDown');
    expect(scrolled).toEqual([{ id: 's-02', options: { block: 'nearest' } }]);
    press('ArrowDown');
    press('ArrowDown');
    expect(lastScrolled()).toBe('s-04');
  });

  it('↑ с первого пункта по кругу уходит на последний, и он показан', () => {
    renderComposer(vi.fn(), KEY, MANY);
    type('@');
    press('ArrowUp');
    expect(lastScrolled()).toBe('s-08');
    press('ArrowDown');
    expect(lastScrolled()).toBe('s-01');
  });

  it('открытие меню показывает первый пункт', () => {
    renderComposer(vi.fn(), KEY, MANY);
    type('@');
    expect(scrolled.map((call) => call.id)).toEqual(['s-01']);
  });

  it('наведение мыши список не прокручивает: пункт под курсором и так виден, иначе список бежал бы из-под мыши', () => {
    renderComposer(vi.fn(), KEY, MANY);
    type('@');
    scrolled = [];
    fireEvent.mouseMove(options()[5] as HTMLElement);
    expect(options()[5]?.getAttribute('aria-selected')).toBe('true');
    expect(scrolled).toEqual([]);
    // Клавиша после наведения снова ведёт выбор и прокручивает.
    press('ArrowDown');
    expect(lastScrolled()).toBe('s-07');
  });

  it('запрос сменился — выбор вернулся на первый пункт, и он показан, хотя список был прокручен вниз', () => {
    renderComposer(vi.fn(), KEY, MANY);
    type('@');
    for (let i = 0; i < 6; i += 1) press('ArrowDown');
    expect(lastScrolled()).toBe('s-07');
    type('а');
    expect(options()).toHaveLength(8);
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(lastScrolled()).toBe('s-01');
  });

  it('перерисовка при том же выборе (keyup стрелки) заново не прокручивает', () => {
    renderComposer(vi.fn(), KEY, MANY);
    type('@');
    press('ArrowDown');
    const before = scrolled.length;
    fireEvent.keyUp(editor(), { key: 'ArrowDown' });
    expect(scrolled).toHaveLength(before);
  });
});

describe('Composer — чип: вставка, курсор, удаление целиком', () => {
  it('вставка заменяет @запрос нередактируемым чипом и неразрывным пробелом; курсор — за пробелом', () => {
    renderComposer();
    type('привет @бэ');
    press('Enter');
    const [chip] = chips();
    expect(chip?.getAttribute('contenteditable')).toBe('false');
    expect(chip?.previousSibling?.textContent).toBe('привет ');
    const space = chip?.nextSibling as Text;
    expect(space.data).toBe(' ');
    const selection = document.getSelection();
    expect(selection?.anchorNode).toBe(space);
    expect(selection?.anchorOffset).toBe(1);
  });

  it('после чипа набор идёт в текст за ним', () => {
    renderComposer();
    pickByKeys(1);
    type('проверь границы');
    expect(editor().textContent).toBe('@S02 бэкенд проверь границы');
  });

  it('Backspace вплотную к чипу стирает его целиком, одним нажатием', () => {
    renderComposer();
    pickByKeys(1);
    const space = chips()[0]?.nextSibling as Text;
    // Первый Backspace стоит за неразрывным пробелом: стирает его сам браузер.
    expect(press('Backspace')).toBe(true);
    space.data = '';
    caret(space, 0);
    expect(press('Backspace')).toBe(false);
    expect(chips()).toHaveLength(0);
    expect(screen.getByText('To everyone')).toBeTruthy();
  });

  it('Backspace с курсором в родителе сразу за чипом стирает чип', () => {
    renderComposer();
    pickByKeys(0);
    const chip = chips()[0] as HTMLElement;
    chip.nextSibling?.remove();
    caret(editor(), Array.from(editor().childNodes).indexOf(chip) + 1);
    expect(press('Backspace')).toBe(false);
    expect(chips()).toHaveLength(0);
  });

  it('Delete перед чипом стирает его целиком', () => {
    renderComposer();
    type('до ');
    type('@');
    press('Enter');
    const before = editor().firstChild as Text;
    caret(before, before.data.length);
    expect(press('Delete')).toBe(false);
    expect(chips()).toHaveLength(0);
    expect(editor().textContent).toContain('до ');
  });

  it('Backspace рядом с обычным текстом чип не трогает: стирает браузер', () => {
    renderComposer();
    pickByKeys(0);
    type('слово');
    expect(press('Backspace')).toBe(true);
    expect(chips()).toHaveLength(1);
  });

  it('стёртый чип убирает адресата из подписи', () => {
    renderComposer();
    pickByKeys(2);
    expect(screen.getByText('To S03')).toBeTruthy();
    const chip = chips()[0] as HTMLElement;
    chip.nextSibling?.remove();
    caret(editor(), Array.from(editor().childNodes).indexOf(chip) + 1);
    press('Backspace');
    expect(screen.getByText('To everyone')).toBeTruthy();
  });
});

describe('Composer — отправка и сериализация (2.2)', () => {
  it('без упоминаний — to: [], то есть всем', () => {
    const { onSend } = renderComposer();
    type('привет всем');
    expect(press('Enter')).toBe(false);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({ to: [], text: 'привет всем' });
  });

  it('чип уходит токеном @s02, его сессия — в to', () => {
    const { onSend } = renderComposer();
    pickByKeys(1);
    type('проверь границы');
    press('Enter');
    expect(onSend).toHaveBeenCalledWith({ to: ['s-02'], text: '@s02 проверь границы' });
  });

  it('два разных чипа и повтор одного: в to каждый один раз, в порядке появления', () => {
    const { onSend } = renderComposer();
    pickByKeys(2);
    type('и ');
    type('@');
    press('Enter');
    type('и ');
    type('@');
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    press('Enter');
    expect(onSend).toHaveBeenCalledWith({ to: ['s-03', 's-01'], text: '@s03 и @s01 и @s03' });
  });

  it('@s02, набранное руками, остаётся текстом: to пуст', () => {
    const { onSend } = renderComposer();
    type('@s02 привет');
    press('Escape');
    press('Enter');
    expect(onSend).toHaveBeenCalledWith({ to: [], text: '@s02 привет' });
  });

  it('Shift+Enter — перенос строки: письмо не уходит, в тексте \\n', () => {
    const { onSend } = renderComposer();
    type('раз');
    expect(press('Enter', { shiftKey: true })).toBe(false);
    expect(execCommand).toHaveBeenCalledWith('insertLineBreak');
    expect(onSend).not.toHaveBeenCalled();
    type('два');
    press('Enter');
    expect(onSend).toHaveBeenCalledWith({ to: [], text: 'раз\nдва' });
  });

  it('пустое и из одних пробелов и переносов не уходит', () => {
    const { onSend } = renderComposer();
    press('Enter');
    type('   ');
    press('Enter');
    press('Enter', { shiftKey: true });
    press('Enter');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Enter, которым подтверждают набор в IME, не отправляет', () => {
    const { onSend } = renderComposer();
    type('こんにちは');
    fireEvent.keyDown(editor(), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('кнопка Send отправляет то же, что Enter', () => {
    const { onSend } = renderComposer();
    type('кнопкой');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith({ to: [], text: 'кнопкой' });
  });

  it('Enter с ⌘ тоже отправляет: прежний способ отправки не сломан', () => {
    const { onSend } = renderComposer();
    type('старый способ');
    press('Enter', { metaKey: true });
    expect(onSend).toHaveBeenCalledWith({ to: [], text: 'старый способ' });
  });

  it('после отправки поле пусто, подпись и плейсхолдер вернулись, черновика нет; второй Enter не шлёт то же снова', () => {
    const { onSend } = renderComposer();
    pickByKeys(0);
    type('текст');
    press('Enter');
    press('Enter');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(editor().childNodes).toHaveLength(0);
    expect(screen.getByText('To everyone')).toBeTruthy();
    expect(screen.getByText('Write to everyone · type @ to mention an agent')).toBeTruthy();
    expect(useUiStore.getState().composerDrafts[KEY]).toBeUndefined();
  });

  it('текст обрезается по краям, внутри пробелы и переносы сохраняются', () => {
    const { onSend } = renderComposer();
    type('  два  слова  ');
    press('Enter');
    expect(onSend).toHaveBeenCalledWith({ to: [], text: 'два  слова' });
  });
});

describe('Composer — вставка только текстом (2.2)', () => {
  const clipboard = (plain: string, html: string) => ({
    clipboardData: { getData: (format: string) => (format === 'text/plain' ? plain : format === 'text/html' ? html : '') },
  });

  it('из буфера берётся text/plain: разметка в поле не попадает, событие погашено', () => {
    renderComposer();
    caret(editor(), 0);
    const notPrevented = fireEvent.paste(editor(), clipboard('просто текст', '<b onclick="x()">жирный</b>'));
    expect(notPrevented).toBe(false);
    expect(execCommand).toHaveBeenCalledWith('insertText', false, 'просто текст');
    expect(editor().innerHTML).toBe('просто текст');
    expect(editor().querySelector('b')).toBeNull();
  });

  it('пустой буфер ничего не вставляет', () => {
    renderComposer();
    caret(editor(), 0);
    fireEvent.paste(editor(), clipboard('', '<i>html</i>'));
    expect(execCommand).not.toHaveBeenCalled();
    expect(editor().childNodes).toHaveLength(0);
  });
});

describe('Composer — перетаскивание в поле: только текст, как вставка (2.2)', () => {
  /**
   * `drop` с данными перетаскивания и координатами. jsdom не знает `DragEvent`, и `clientX/Y` из параметров
   * события пропадают, поэтому они доклеиваются на событие. `false` — событие погашено.
   */
  const drop = (plain: string, html: string, point = { x: 40, y: 12 }): boolean => {
    const event = createEvent.drop(editor(), {
      dataTransfer: {
        files: [],
        getData: (format: string) => (format === 'text/plain' ? plain : format === 'text/html' ? html : ''),
      },
    });
    Object.defineProperties(event, { clientX: { value: point.x }, clientY: { value: point.y } });
    return fireEvent(editor(), event);
  };

  it('выделение из ленты приносит HTML с data-mention: берётся text/plain, чипа нет, адресата в to нет', () => {
    const { onSend } = renderComposer();
    caret(editor(), 0);
    const notPrevented = drop('@S02 бэкенд, проверь границы', '<span data-mention="s-02" class="chip">@S02 бэкенд</span>, проверь границы');
    // Событие погашено: разметку браузер сам не вставит.
    expect(notPrevented).toBe(false);
    expect(execCommand).toHaveBeenCalledWith('insertText', false, '@S02 бэкенд, проверь границы');
    expect(chips()).toHaveLength(0);
    expect(editor().querySelector('span')).toBeNull();
    expect(screen.getByText('To everyone')).toBeTruthy();
    press('Enter');
    expect(onSend).toHaveBeenCalledWith({ to: [], text: '@S02 бэкенд, проверь границы' });
  });

  it('чип из меню при этом остаётся чипом: упоминание бывает только из меню', () => {
    const { onSend } = renderComposer();
    pickByKeys(2);
    caret(editor(), editor().childNodes.length);
    drop('@S01 архитектор', '<span data-mention="s-01">@S01 архитектор</span>');
    press('Enter');
    expect(onSend).toHaveBeenCalledWith({ to: ['s-03'], text: '@s03 @S01 архитектор' });
  });

  it('без text/plain (только разметка или файл) ничего не вставляется, но и браузер разметку не вставит', () => {
    renderComposer();
    caret(editor(), 0);
    const notPrevented = drop('', '<span data-mention="s-02">@S02 бэкенд</span>');
    expect(notPrevented).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
    expect(editor().childNodes).toHaveLength(0);
  });

  it('текст вставляется в точку сброса, а не туда, где стоял курсор', () => {
    renderComposer();
    const text = document.createTextNode('абвг');
    editor().append(text);
    caret(text, 4);
    const point = vi.fn(() => {
      const range = document.createRange();
      range.setStart(text, 2);
      range.collapse(true);
      return range;
    });
    document.caretRangeFromPoint = point;
    drop('XY', '');
    expect(point).toHaveBeenCalledWith(40, 12);
    expect(editor().textContent).toBe('абXYвг');
  });

  it('сброс на чип вставляет текст после чипа, а не внутрь него', () => {
    renderComposer();
    pickByKeys(1);
    const chip = chips()[0] as HTMLElement;
    document.caretRangeFromPoint = () => {
      const range = document.createRange();
      range.setStart(chip.firstChild as Text, 3);
      range.collapse(true);
      return range;
    };
    drop('X', '');
    expect(chip.textContent).toBe('@S02 бэкенд');
    expect(chip.nextSibling?.textContent).toBe('X');
    expect(chips()).toHaveLength(1);
  });

  it('точку сброса браузер назвать не может: в конец поля, если курсор вне его', () => {
    renderComposer();
    const text = document.createTextNode('начало');
    editor().append(text);
    caret(document.body, 0);
    drop('X', '');
    expect(editor().textContent).toBe('началоX');
  });

  it('выделенное в поле сбросом не заменяется: текст встаёт рядом, за концом выделения', () => {
    renderComposer();
    const text = document.createTextNode('абвг');
    editor().append(text);
    document.getSelection()?.setBaseAndExtent(text, 0, text, 3);
    drop('X', '');
    expect(editor().textContent).toBe('абвXг');
  });

  it('текст из сброса попадает в черновик и отправляется как обычный', () => {
    const { onSend } = renderComposer();
    caret(editor(), 0);
    drop('перетащено', '<b>перетащено</b>');
    expect(useUiStore.getState().composerDrafts[KEY]).toBe('перетащено');
    press('Enter');
    expect(onSend).toHaveBeenCalledWith({ to: [], text: 'перетащено' });
  });
});

describe('Composer — черновик на комнату (3.4)', () => {
  it('набранное попадает в стор под ключом комнаты, без обрезки', () => {
    renderComposer();
    type('слово ');
    expect(useUiStore.getState().composerDrafts[KEY]).toBe('слово ');
  });

  it('пустое поле черновика не оставляет', () => {
    renderComposer();
    type('слово');
    editor().replaceChildren();
    fireEvent.input(editor());
    expect(useUiStore.getState().composerDrafts).toEqual({});
  });

  it('смена вкладки (размонтирование) и возврат: текст и чипы на месте', () => {
    const first = renderComposer();
    pickByKeys(1);
    type('проверь границы');
    first.unmount();

    renderComposer();
    expect(chips().map((chip) => chip.getAttribute('data-mention'))).toEqual(['s-02']);
    expect(chips()[0]?.textContent).toBe('@S02 бэкенд');
    expect(editor().textContent).toContain('проверь границы');
    expect(screen.getByText('To S02')).toBeTruthy();
    expect(screen.queryByText('Write to everyone · type @ to mention an agent')).toBeNull();
  });

  it('у каждой комнаты свой черновик: чужой не подсовывается', () => {
    const roomA = renderComposer(vi.fn(), '/tmp/p w-01/r-01');
    type('про комнату A');
    roomA.unmount();

    const roomB = renderComposer(vi.fn(), '/tmp/p w-01/r-02');
    expect(editor().textContent).toBe('');
    type('про комнату B');
    roomB.unmount();

    renderComposer(vi.fn(), '/tmp/p w-01/r-01');
    expect(editor().textContent).toBe('про комнату A');
    expect(useUiStore.getState().composerDrafts).toEqual({
      '/tmp/p w-01/r-01': 'про комнату A',
      '/tmp/p w-01/r-02': 'про комнату B',
    });
  });

  it('переносы черновика возвращаются переносами', () => {
    const first = renderComposer();
    type('раз');
    press('Enter', { shiftKey: true });
    type('два');
    first.unmount();

    const { onSend } = renderComposer();
    expect(editor().querySelectorAll('br')).toHaveLength(1);
    press('Enter');
    expect(onSend).toHaveBeenCalledWith({ to: [], text: 'раз\nдва' });
  });

  it('токен участника, которого в комнате уже нет, возвращается текстом, а не чипом', () => {
    useUiStore.getState().setComposerDraft(KEY, 'привет @s09 и @s03');
    const { onSend } = renderComposer();
    expect(chips().map((chip) => chip.getAttribute('data-mention'))).toEqual(['s-03']);
    expect(editor().textContent).toContain('@s09');
    press('Enter');
    expect(onSend).toHaveBeenCalledWith({ to: ['s-03'], text: 'привет @s09 и @s03' });
  });

  it('в стор идёт текст, а не разметка поля: чужой узел из поля токеном не становится', () => {
    renderComposer();
    editor().innerHTML = '<b>жирный</b> <img src="x" onerror="alert(1)">';
    fireEvent.input(editor());
    expect(useUiStore.getState().composerDrafts[KEY]).toBe('жирный ');
  });
});

describe('Composer — отказ отправки', () => {
  it('письмо не ушло: текст и чип возвращаются в пустое поле', async () => {
    const onSend = vi.fn<(submission: ComposerSubmission) => Promise<void>>().mockRejectedValue(new Error('offline'));
    renderComposer(onSend);
    pickByKeys(1);
    type('важное');
    press('Enter');
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(editor().textContent).toContain('важное');
    expect(screen.getByText('To S02')).toBeTruthy();
  });

  it('пока шёл запрос, человек начал новое письмо: его текст не затирается', async () => {
    let fail: (error: Error) => void = () => {};
    const onSend = vi.fn(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    renderComposer(onSend);
    type('первое');
    press('Enter');
    type('второе');
    fail(new Error('offline'));
    await Promise.resolve();
    await Promise.resolve();
    expect(editor().textContent).toBe('второе');
  });
});

describe('диктовка в поле комнаты (спека 3.2)', () => {
  let dispose: () => void = () => undefined;
  afterEach(() => dispose());

  it('кнопка микрофона есть; стоп — текст встал в поле, письмо не ушло', async () => {
    useUiStore.setState({ ui: { ...useUiStore.getState().ui, voice: { enabled: true, model: 'small', language: 'auto' } } });
    dispose = useDictationStore.getState().configure(fakeDictationDeps('hello from voice'));
    const { onSend } = renderComposer();
    const mic = screen.getByTestId('mic');
    fireEvent.click(within(mic).getByRole('button'));
    await waitFor(() => expect(mic.dataset.state).toBe('recording'));
    fireEvent.click(within(mic).getByRole('button'));
    await waitFor(() => expect(screen.getByRole('textbox').textContent).toBe('hello from voice'));
    expect(onSend).not.toHaveBeenCalled();
  });
});
