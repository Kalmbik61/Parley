/**
 * Дерево доступности страницы для агента (спека 2026-10-07-browser-devtools-agent-design.md, 5.1 `browser_snapshot`):
 * ответ `Accessibility.getFullAXTree` → строки `[ref=e12] button "Save"` с отступом по глубине. Ссылка `eN` — узел с
 * `backendDOMNodeId`: по ней `browser_action` находит элемент. Весь текст — данные страницы: ограду ставит MCP-сервер,
 * значение поля с секретным именем — `<redacted>` (спека 6).
 */
import { isSecretName, REDACTED, redactSecretsInText } from '../../shared/redact.js';

/** Узел `Accessibility.getFullAXTree` (CDP 1.3) — нужные поля. */
export interface AxNode {
  nodeId: string;
  ignored: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value: { value?: unknown } }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface AxSnapshot {
  text: string;
  /** Ссылка → `backendNodeId`, только у строк, попавших в текст. */
  refs: Map<string, number>;
  truncated: boolean;
}

/** Узлы без своей строки: их дети встают на их место. */
const TRANSPARENT = new Set(['generic', 'GenericContainer', 'none', 'presentation']);
/** Узлы без строки и без обхода детей: куски текста строк и маркеры списков. */
const SKIPPED = new Set(['InlineTextBox', 'LineBreak', 'ListMarker']);
/** Фрейм: строка `iframe "<имя>"` со ссылкой; содержимое — из карты `AxFrames` (фреймы того же процесса), без неё — пометка. */
const FRAMES = new Set(['Iframe', 'iframe']);
/** Роли, с которыми агенту есть что делать: только они (и фокусируемые) — в `interactiveOnly`. */
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
]);
/** Состояния, которые агенту нужны: в скобках после имени. */
const STATES = ['focused', 'disabled', 'checked', 'pressed', 'selected', 'expanded', 'required'] as const;
/** Имя узла и значение поля — не длиннее (кодовых точек): длинный абзац целиком агенту не нужен. */
const NAME_LIMIT = 200;
const VALUE_LIMIT = 100;

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** Пробелы схлопнуты; длиннее `limit` кодовых точек — обрезано с многоточием. */
function clean(value: unknown, limit: number): string {
  const text = stringOf(value).replace(/\s+/g, ' ').trim();
  const points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit).join('')}…`;
}

function propertyOf(node: AxNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value.value;
}

function statesOf(node: AxNode): string[] {
  return STATES.flatMap((state) => {
    const value = propertyOf(node, state);
    if (value === 'mixed') return [`${state}: mixed`];
    return value === true || value === 'true' ? [state] : [];
  });
}

/**
 * Дети поля с секретным именем повторяют его значение текстом (`StaticText`): их не обходят ни снимок (значение поля уже
 * `<redacted>`; E2E 22b, Фокус ревью 6), ни поиск текста `wait_for` — иначе значение подбирается (финальная рецензия m3).
 * Только у поля — узла со значением: раздел «API key settings» обходится.
 */
function secretField(node: AxNode): boolean {
  return node.value !== undefined && isSecretName(clean(node.name?.value, NAME_LIMIT));
}

/** Деревья фреймов того же процесса: `backendDOMNodeId` элемента iframe → дерево его документа. Нет в карте — содержимое недоступно. */
export type AxFrames = ReadonlyMap<number, readonly AxNode[]>;

/** Хвост строки `iframe` без дерева: чужой сайт (отдельный процесс) или фрейм не удалось прочитать. */
const FRAME_UNAVAILABLE = ' (content not available: another site)';

export function axSnapshot(nodes: readonly AxNode[], options: { interactiveOnly: boolean; limitBytes: number; frames?: AxFrames }): AxSnapshot {
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;

  const push = (line: string): boolean => {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > options.limitBytes) {
      truncated = true;
      return false;
    }
    lines.push(line);
    bytes += size;
    return true;
  };

  /** Строка узла и его ссылка; `null` — своей строки нет (дети всё равно обходятся). */
  const entryOf = (node: AxNode, role: string, depth: number, hasTree: boolean): { line: string; ref: [string, number] | null } | null => {
    const name = clean(node.name?.value, NAME_LIMIT);
    const indent = options.interactiveOnly ? '' : '  '.repeat(depth);
    if (role === 'RootWebArea') return options.interactiveOnly ? null : { line: `${indent}document ${JSON.stringify(name)}`, ref: null };
    if (role === 'StaticText') return options.interactiveOnly || name === '' ? null : { line: `${indent}text ${JSON.stringify(name)}`, ref: null };
    if (options.interactiveOnly && !INTERACTIVE.has(role) && propertyOf(node, 'focusable') !== true) return null;
    const ref = typeof node.backendDOMNodeId === 'number' ? (['e' + String(refs.size + 1), node.backendDOMNodeId] as [string, number]) : null;
    const raw = node.value?.value;
    const value = stringOf(raw) === '' ? '' : ` value=${isSecretName(name) ? REDACTED : JSON.stringify(redactSecretsInText(clean(raw, VALUE_LIMIT)))}`;
    const states = statesOf(node);
    const line =
      `${indent}${ref === null ? '' : `[ref=${ref[0]}] `}${FRAMES.has(role) ? 'iframe' : role}${name === '' ? '' : ` ${JSON.stringify(name)}`}` +
      `${value}${states.length === 0 ? '' : ` (${states.join(', ')})`}${FRAMES.has(role) && !hasTree ? FRAME_UNAVAILABLE : ''}`;
    return { line, ref };
  };

  /**
   * Обход одного дерева: `nodeId` разных деревьев совпадают, поэтому карта узлов и `seen` — свои у каждого. Корень документа
   * фрейма (`inFrame`) своей строки не даёт и глубину не прибавляет. false — предел исчерпан, обход стоит.
   */
  const visitTree = (treeNodes: readonly AxNode[], startDepth: number, inFrame: boolean): boolean => {
    const byId = new Map(treeNodes.map((node) => [node.nodeId, node] as const));
    const seen = new Set<string>();
    const visit = (node: AxNode, depth: number): boolean => {
      if (seen.has(node.nodeId)) return true;
      seen.add(node.nodeId);
      const role = stringOf(node.role?.value);
      if (SKIPPED.has(role)) return true;
      const frameTree = FRAMES.has(role) && typeof node.backendDOMNodeId === 'number' ? options.frames?.get(node.backendDOMNodeId) : undefined;
      let childDepth = depth;
      if (!node.ignored && !TRANSPARENT.has(role) && !(inFrame && role === 'RootWebArea' && node.parentId === undefined)) {
        const entry = entryOf(node, role, depth, frameTree !== undefined);
        if (entry !== null) {
          if (!push(entry.line)) return false;
          if (entry.ref !== null) refs.set(entry.ref[0], entry.ref[1]);
          childDepth = depth + 1;
        }
      }
      if (FRAMES.has(role)) return frameTree === undefined || visitTree(frameTree, childDepth, true);
      if (secretField(node)) return true;
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child !== undefined && !visit(child, childDepth)) return false;
      }
      return true;
    };
    const root = treeNodes.find((node) => node.parentId === undefined) ?? treeNodes[0];
    return root === undefined ? true : visit(root, startDepth);
  };

  visitTree(nodes, 0, false);
  return { text: lines.join('\n'), refs, truncated };
}

/**
 * Обход тем же правилом, что у `axSnapshot`: пропускаются `SKIPPED`, дети поля с секретным именем и повторы; у элемента
 * iframe обход продолжается деревом его документа из `frames`. Игнорируемые узлы не отдаются, но их дети обходятся.
 * `false` из `onNode` останавливает обход.
 */
function walk(nodes: readonly AxNode[], onNode: (node: AxNode, role: string) => boolean | void, frames?: AxFrames): void {
  const walkTree = (treeNodes: readonly AxNode[]): boolean => {
    const byId = new Map(treeNodes.map((node) => [node.nodeId, node] as const));
    const seen = new Set<string>();
    const visit = (node: AxNode): boolean => {
      if (seen.has(node.nodeId)) return true;
      seen.add(node.nodeId);
      const role = stringOf(node.role?.value);
      if (SKIPPED.has(role)) return true;
      if (!node.ignored && onNode(node, role) === false) return false;
      if (FRAMES.has(role)) {
        const inner = typeof node.backendDOMNodeId === 'number' ? frames?.get(node.backendDOMNodeId) : undefined;
        return inner === undefined || walkTree(inner);
      }
      if (secretField(node)) return true;
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child !== undefined && !visit(child)) return false;
      }
      return true;
    };
    const root = treeNodes.find((node) => node.parentId === undefined) ?? treeNodes[0];
    return root === undefined ? true : visit(root);
  };
  walkTree(nodes);
}

const squash = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** Видимый текст: имена не игнорируемых узлов (в том числе `StaticText`) содержат `text`, без учёта регистра и пробелов. */
export function axHasText(nodes: readonly AxNode[], text: string, frames?: AxFrames): boolean {
  const needle = squash(text);
  let found = false;
  walk(nodes, (node) => {
    if (squash(stringOf(node.name?.value)).includes(needle)) {
      found = true;
      return false;
    }
    return undefined;
  }, frames);
  return found;
}

/** Состояние `checked` узла по `backendNodeId`: CDP отдаёт `'true' | 'false' | 'mixed'` строкой или boolean; нет узла — `null`. */
export function axState(nodes: readonly AxNode[], backendNodeId: number, state: 'checked', frames?: AxFrames): boolean | 'mixed' | null {
  let result: boolean | 'mixed' | null = null;
  walk(nodes, (node) => {
    if (node.backendDOMNodeId !== backendNodeId) return undefined;
    const value = propertyOf(node, state);
    result = value === 'mixed' ? 'mixed' : value === true || value === 'true';
    return false;
  }, frames);
  return result;
}
