/**
 * Поле ввода комнаты (спека окна 2026-09-29, 1.3, 2.2, 2.3, 3.4; кусок 6 плана): меню упоминаний,
 * сериализация в `@s02` и `to[]`, вставка текстом, удаление чипа целиком, черновик на комнату.
 *
 * jsdom не редактирует сам: набор моделируется правкой узлов и курсора (`type`, `caret`), а родная
 * команда браузера `document.execCommand` подменена в `beforeEach` — она делает то, что сделал бы
 * Chromium: вставляет текст или `<br>` в позицию курсора и шлёт `input`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useUiStore } from '../../store/ui.js';
import { Composer, type ComposerMember, type ComposerSubmission } from './Composer.js';

const MEMBERS: ComposerMember[] = [
  { id: 's-01', label: 'S01 архитектор', rawLabel: 'архитектор', provider: 'claude', providerName: 'Claude Code', word: 'working', lead: true },
  { id: 's-02', label: 'S02 бэкенд', rawLabel: 'бэкенд', provider: 'claude', providerName: 'Claude Code', word: 'needs you', lead: false },
  { id: 's-03', label: 'S03 ревью', rawLabel: 'ревью', provider: 'codex', providerName: 'Codex', word: 'idle', lead: false },
];

const KEY = '/tmp/p w-01/r-01';

type SendResult = Promise<void> | void;
let execCommand: ReturnType<typeof vi.fn>;

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
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'execCommand');
});

function renderComposer(onSend: (submission: ComposerSubmission) => SendResult = vi.fn(), draftKey = KEY) {
  const view = render(<Composer members={MEMBERS} draftKey={draftKey} onSend={onSend} />);
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

describe('Composer — когда открывается меню упоминаний (2.3)', () => {
  it('@ в начале строки: все участники комнаты и заголовок', () => {
    renderComposer();
    type('@');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByText('Agents in this room')).toBeTruthy();
    expect(options().map((item) => item.textContent)).toEqual([
      'S01 архитектор★Claude Code · working',
      'S02 бэкендClaude Code · needs you',
      'S03 ревьюCodex · idle',
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
