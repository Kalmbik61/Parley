// packages/desktop/src/main/browser/element-info.ts
/**
 * Роль, доступное имя и React выбранного элемента (спека браузера 3.8). По точке клика main находит узел через CDP
 * (`DOM.getNodeForLocation`; точка — в координатах документа, вызывающий прибавляет прокрутку через
 * `guest-data.ts#documentPoint`, спайк 0.4) и сверяет его с выбранным по тегу, id и классам последнего звена селектора
 * (`shared/css-selector.ts`): страница могла успеть поменяться. Совпал — дочитывает роль и имя из дерева доступности и
 * компонент React функцией `REACT_INFO_FN`. Не совпал узел, нет React или не вышел вызов — соответствующих полей нет:
 * выбор от этого не ломается.
 */

import type { ReactComponentInfo } from '../../shared/browser-types.js';
import { selectorTail, type SelectorTail } from '../../shared/css-selector.js';
import { cutCodePoints } from './guest-data.js';
import type { Inspector } from './inspector.js';
import { parseReactInfo, REACT_INFO_FN } from './react-info.js';

export type CdpSender = Pick<Inspector, 'send'>;

export interface ElementInfo {
  role?: string;
  name?: string;
  react?: ReactComponentInfo[];
}

/** Роль — короткое слово CDP; имя — как текст элемента (`PICK_LIMITS.text`). */
export const ELEMENT_INFO_LIMITS = { role: 100, name: 500 } as const;

interface DescribedNode {
  localName?: unknown;
  attributes?: unknown;
}

interface AxNode {
  backendDOMNodeId?: unknown;
  ignored?: unknown;
  role?: { value?: unknown };
  name?: { value?: unknown };
}

/** Узел CDP (`DOM.describeNode`) — тот, что выбрал скрипт: тег, id и все классы последнего звена селектора. */
export function nodeMatches(node: DescribedNode | undefined, tail: SelectorTail): boolean {
  if (node === undefined || typeof node.localName !== 'string' || node.localName.toLowerCase() !== tail.tag) return false;
  const attributes: unknown[] = Array.isArray(node.attributes) ? node.attributes : [];
  const attribute = (name: string): string | null => {
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      if (attributes[index] === name) return String(attributes[index + 1]);
    }
    return null;
  };
  if (tail.id !== null && attribute('id') !== tail.id) return false;
  // Имена в class делят пробельные знаки ASCII, как в HTML и в guest-dom (`stableClasses`), а не `\s`: тот режет и
  // неразрывный пробел, который CSS.escape в имени класса не экранирует, — звено селектора не нашло бы свой класс.
  const classes = new Set((attribute('class') ?? '').split(/[ \t\n\f\r]+/).filter((name) => name !== ''));
  return tail.classes.every((name) => classes.has(name));
}

/** Ответ или запасное значение, если не уложился в `ms` или отказал: страница в цикле не держит выбор. */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function accessibility(inspector: CdpSender, id: number, backendNodeId: number): Promise<Pick<ElementInfo, 'role' | 'name'>> {
  await inspector.send(id, 'Accessibility.enable');
  try {
    const tree = await inspector.send<{ nodes?: unknown }>(id, 'Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
    const nodes: AxNode[] = Array.isArray(tree.nodes) ? tree.nodes : [];
    const node = nodes.find((candidate) => candidate.backendDOMNodeId === backendNodeId) ?? nodes[0];
    const out: Pick<ElementInfo, 'role' | 'name'> = {};
    if (node === undefined || node.ignored === true) return out;
    const role = node.role?.value;
    const name = node.name?.value;
    if (typeof role === 'string' && role !== '') out.role = cutCodePoints(role, ELEMENT_INFO_LIMITS.role).text;
    if (typeof name === 'string' && name !== '') out.name = cutCodePoints(name, ELEMENT_INFO_LIMITS.name).text;
    return out;
  } finally {
    // Дерево доступности страница ведёт, пока домен включён: держать его включённым незачем.
    await inspector.send(id, 'Accessibility.disable').catch(() => undefined);
  }
}

async function reactInfo(inspector: CdpSender, id: number, backendNodeId: number): Promise<ReactComponentInfo[] | undefined> {
  const resolved = await inspector.send<{ object?: { objectId?: unknown } }>(id, 'DOM.resolveNode', { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (typeof objectId !== 'string') return undefined;
  try {
    const called = await inspector.send<{ result?: { value?: unknown } }>(id, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: REACT_INFO_FN,
      returnByValue: true,
    });
    return parseReactInfo(called.result?.value);
  } finally {
    await inspector.send(id, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

export async function elementInfo(inspector: CdpSender, id: number, point: { x: number; y: number } | null, selector: string): Promise<ElementInfo> {
  if (point === null) return {};
  try {
    await inspector.send(id, 'DOM.enable');
    const located = await inspector.send<{ backendNodeId?: unknown }>(id, 'DOM.getNodeForLocation', {
      x: Math.round(point.x),
      y: Math.round(point.y),
      includeUserAgentShadowDOM: false,
    });
    const backendNodeId = located.backendNodeId;
    if (typeof backendNodeId !== 'number') return {};
    const described = await inspector.send<{ node?: DescribedNode }>(id, 'DOM.describeNode', { backendNodeId });
    if (!nodeMatches(described.node, selectorTail(selector))) return {};
    const info: ElementInfo = await accessibility(inspector, id, backendNodeId).catch(() => ({}));
    const react = await reactInfo(inspector, id, backendNodeId).catch(() => undefined);
    return react === undefined ? info : { ...info, react };
  } catch (error) {
    console.warn('[parley] element info failed', error);
    return {};
  }
}
