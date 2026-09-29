/**
 * DOM-часть поля ввода комнаты (дизайн комнат, 1.4, 2.2, 2.3): чип упоминания — нередактируемый
 * `span` с `data-mention="s-02"`, за ним неразрывный пробел. Чтение поля в текст с токенами `@s02` и
 * `to[]`, контекст меню по положению курсора, вставка чипа, подъём черновика, удаление чипа целиком.
 * React тут не участвует: поле — `contentEditable`, его содержимое ведёт браузер, а компонент
 * (`Composer.tsx`) только читает его и правит через эти функции.
 */

import { MENTION_CHIP_CLASS, NBSP, findMentionQuery, mentionToken, splitMentions } from './mention.js';

const CHIP_ATTRIBUTE = 'data-mention';

/** Чип упоминания сессии: нередактируемый — браузер удаляет и двигает курсор через него как через один знак. */
export function createChip(doc: Document, sessionId: string, label: string): HTMLSpanElement {
  const chip = doc.createElement('span');
  chip.setAttribute(CHIP_ATTRIBUTE, sessionId);
  chip.setAttribute('contenteditable', 'false');
  chip.className = MENTION_CHIP_CLASS;
  chip.textContent = label;
  return chip;
}

function isChip(node: Node | null | undefined): node is HTMLElement {
  return node instanceof HTMLElement && node.hasAttribute(CHIP_ATTRIBUTE);
}

export interface EditorContent {
  /** Текст поля с токенами `@s02` на месте чипов; неразрывные пробелы — обычными. Не обрезан. */
  text: string;
  /** Упомянутые сессии — по одной, в порядке появления. Пусто — письмо всем (`to: []`, 2.2). */
  to: string[];
}

/**
 * Поле → текст и адресаты. `<br>` — перенос, блочный `div` (его заводит браузер, когда вставка
 * приходит с переносами) — тоже перенос. Адресаты берутся только из чипов: `@s02`, набранное руками,
 * остаётся текстом.
 */
export function readEditor(root: HTMLElement): EditorContent {
  const to: string[] = [];
  let text = '';
  const walk = (parent: Node): void => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += (node.textContent ?? '').replaceAll(NBSP, ' ');
        continue;
      }
      if (!(node instanceof HTMLElement)) continue;
      const sessionId = node.getAttribute(CHIP_ATTRIBUTE);
      if (sessionId !== null) {
        text += mentionToken(sessionId);
        if (!to.includes(sessionId)) to.push(sessionId);
        continue;
      }
      if (node.tagName === 'BR') {
        text += '\n';
        continue;
      }
      if (node.tagName === 'DIV' && text !== '' && !text.endsWith('\n')) text += '\n';
      walk(node);
    }
  };
  walk(root);
  return { text, to };
}

/** Пусто ли поле: ни чипов, ни знаков, кроме пробелов и переносов. */
export function isBlank(content: EditorContent): boolean {
  return content.to.length === 0 && content.text.trim() === '';
}

export interface MentionContext {
  /** Текстовый узел, в котором стоит курсор, и границы `@запроса` в нём. */
  node: Text;
  start: number;
  end: number;
  query: string;
}

/**
 * Контекст меню упоминаний по курсору (2.3): курсор свернут в текстовом узле поля, перед ним
 * `@запрос`, который открывает меню (`findMentionQuery`). Иначе — `null`.
 */
export function mentionContext(root: HTMLElement): MentionContext | null {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const node = selection.anchorNode;
  if (node === null || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
  const end = selection.anchorOffset;
  const found = findMentionQuery((node as Text).data.slice(0, end));
  return found === null ? null : { node: node as Text, start: found.start, end, query: found.query };
}

/**
 * Вставка упоминания: `@запрос` заменяется чипом и неразрывным пробелом, курсор — за пробелом (2.3).
 * Пробел нужен, чтобы курсор мог встать между чипом и следующим словом: за нередактируемым узлом в
 * конце поля ему не за что зацепиться.
 */
export function insertMention(root: HTMLElement, context: MentionContext, sessionId: string, label: string): void {
  const { node, start } = context;
  if (!node.isConnected) return;
  const doc = root.ownerDocument;
  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, Math.min(context.end, node.data.length));
  range.deleteContents();
  const chip = createChip(doc, sessionId, label);
  range.insertNode(chip);
  const space = doc.createTextNode(NBSP);
  chip.after(space);
  doc.getSelection()?.collapse(space, 1);
}

/**
 * Черновик или неотправленный текст → в поле: токены известных участников (`chipLabel` вернул ярлык)
 * снова чипы, остальное — текст, переносы — `<br>`. Чип в конце получает после себя пробел по той же
 * причине, что и при вставке.
 */
export function fillEditor(root: HTMLElement, text: string, chipLabel: (sessionId: string) => string | null): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const appendText = (value: string): void => {
    value.split('\n').forEach((line, index) => {
      if (index > 0) root.append(doc.createElement('br'));
      if (line !== '') root.append(doc.createTextNode(line));
    });
  };
  for (const segment of splitMentions(text)) {
    if (segment.kind === 'text') {
      appendText(segment.text);
      continue;
    }
    const label = chipLabel(segment.sessionId);
    if (label === null) appendText(segment.raw);
    else root.append(createChip(doc, segment.sessionId, label));
  }
  if (isChip(root.lastChild)) root.append(doc.createTextNode(NBSP));
}

/** Соседний узел, который сотрёт Backspace (`backward`) или Delete (`forward`), если внутри узла курсора стирать нечего. */
function neighbour(node: Node, offset: number, direction: 'backward' | 'forward'): Node | null {
  const backward = direction === 'backward';
  let candidate: Node | null;
  if (node.nodeType === Node.TEXT_NODE) {
    const length = (node as Text).data.length;
    // Знак рядом с курсором внутри того же текстового узла — его сотрёт сам браузер.
    if (backward ? offset > 0 : offset < length) return null;
    candidate = backward ? node.previousSibling : node.nextSibling;
  } else {
    candidate = (backward ? node.childNodes[offset - 1] : node.childNodes[offset]) ?? null;
  }
  // Пустые текстовые узлы остаются от прежних правок; между курсором и чипом они не стена.
  while (candidate !== null && candidate.nodeType === Node.TEXT_NODE && (candidate as Text).data === '') {
    candidate = backward ? candidate.previousSibling : candidate.nextSibling;
  }
  return candidate;
}

/**
 * Backspace или Delete вплотную к чипу стирает его целиком, одним нажатием (Review Focus 5). Само по
 * себе `contenteditable="false"` даёт то же в Chromium, но поведение зависит от того, как браузер
 * разложил узлы вокруг чипа (пустые текстовые узлы, курсор в родителе), и проверить его тестом нельзя:
 * jsdom ничего не стирает. Явное удаление проверяемо и не зависит от раскладки узлов. `true` — чип
 * удалён, нажатие обработано; `false` — рядом чипа нет, дальше работает браузер.
 */
export function removeAdjacentChip(root: HTMLElement, direction: 'backward' | 'forward'): boolean {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return false;
  const { anchorNode, anchorOffset } = selection;
  if (anchorNode === null || !root.contains(anchorNode)) return false;
  const next = neighbour(anchorNode, anchorOffset, direction);
  if (!isChip(next)) return false;
  next.remove();
  return true;
}

/** Вставка текста в позицию курсора — родная команда браузера: она держит стек отмены поля. */
export function insertPlainText(doc: Document, text: string): void {
  doc.execCommand('insertText', false, text);
}

/** Перенос строки по Shift+Enter: то же, что Enter в обычном поле, но Enter отправляет письмо. */
export function insertLineBreak(doc: Document): void {
  doc.execCommand('insertLineBreak');
}
