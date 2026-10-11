/**
 * Докрутка поля ввода за кареткой: jsdom не считает раскладку, поэтому геометрия поля (`getBoundingClientRect`,
 * `scrollHeight`, `clientHeight`, отступ) и прямоугольник каретки (`Range#getClientRects`) подставлены вручную.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepCaretVisible } from './keep-caret-visible.js';

const rect = (top: number, bottom: number): DOMRect => ({ top, bottom, height: bottom - top, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

/** Прямоугольники, которые вернёт диапазон каретки (по очереди вызовов — одни и те же). */
let caretRects: DOMRect[];

beforeEach(() => {
  caretRects = [];
  Range.prototype.getClientRects = function getClientRects() {
    return caretRects as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return caretRects[0] ?? rect(0, 0);
  };
});

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(Range.prototype, 'getClientRects');
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
});

interface Geometry {
  /** Верх поля в окне. */
  top?: number;
  clientHeight: number;
  scrollHeight: number;
  scrollTop?: number;
  paddingBottom?: string;
}

function geometry(el: HTMLElement, g: Geometry): void {
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: g.clientHeight });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: g.scrollHeight });
  Object.defineProperty(el, 'clientTop', { configurable: true, value: 0 });
  el.scrollTop = g.scrollTop ?? 0;
  el.style.paddingBottom = g.paddingBottom ?? '8px';
  el.getBoundingClientRect = () => rect(g.top ?? 100, (g.top ?? 100) + g.clientHeight);
}

/** `contentEditable` с одной строкой текста и кареткой в её конце. */
function editable(g: Geometry): HTMLElement {
  const el = document.createElement('div');
  el.contentEditable = 'true';
  el.append(document.createTextNode('text'));
  document.body.append(el);
  geometry(el, g);
  const selection = document.getSelection();
  selection?.collapse(el.firstChild, 4);
  return el;
}

describe('keepCaretVisible — contentEditable', () => {
  it('каретка ниже видимой части: докручивает так, чтобы виден и нижний отступ', () => {
    // Поле 100..238 (138px); каретка занимает 300..320, ниже края на 82px; отступ 8px.
    const el = editable({ clientHeight: 138, scrollHeight: 400, scrollTop: 168 });
    caretRects = [rect(300, 320)];
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(168 + (320 + 8 - 238));
  });

  it('каретка у нижнего края вплотную: отступ тоже втягивается в видимую часть', () => {
    const el = editable({ clientHeight: 138, scrollHeight: 400, scrollTop: 100 });
    caretRects = [rect(218, 238)];
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(108);
  });

  it('каретка выше видимой части: докручивает вверх до её верха', () => {
    const el = editable({ clientHeight: 138, scrollHeight: 400, scrollTop: 200 });
    caretRects = [rect(70, 90)];
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(200 - 30);
  });

  it('каретка видна целиком вместе с отступом: поле не двигается', () => {
    const el = editable({ clientHeight: 138, scrollHeight: 400, scrollTop: 50 });
    caretRects = [rect(150, 170)];
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(50);
  });

  it('поле не переполнено: поле не двигается', () => {
    const el = editable({ clientHeight: 138, scrollHeight: 138, scrollTop: 0 });
    caretRects = [rect(300, 320)];
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(0);
  });

  it('берётся последний из прямоугольников каретки', () => {
    const el = editable({ clientHeight: 138, scrollHeight: 400 });
    caretRects = [rect(110, 130), rect(300, 320)];
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(320 + 8 - 238);
  });

  it('каретки в поле нет (фокус в другом месте): поле не двигается', () => {
    const el = editable({ clientHeight: 138, scrollHeight: 400 });
    document.getSelection()?.removeAllRanges();
    caretRects = [rect(300, 320)];
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(0);
  });

  it('пустая строка после <br>: прямоугольника у диапазона нет — каретка под <br>', () => {
    const el = document.createElement('div');
    el.contentEditable = 'true';
    const br = document.createElement('br');
    br.getBoundingClientRect = () => rect(280, 300);
    el.append(document.createTextNode('a'), br);
    document.body.append(el);
    geometry(el, { clientHeight: 138, scrollHeight: 400 });
    document.getSelection()?.collapse(el, 2);
    caretRects = [];
    keepCaretVisible(el);
    // Строка под <br>: 300..320, плюс отступ 8 — на 90 ниже края 238.
    expect(el.scrollTop).toBe(320 + 8 - 238);
  });

  it('каретка перед <br> пустой строки: берётся прямоугольник самого <br>', () => {
    const el = document.createElement('div');
    el.contentEditable = 'true';
    const br = document.createElement('br');
    br.getBoundingClientRect = () => rect(300, 320);
    el.append(document.createTextNode('a'), br);
    document.body.append(el);
    geometry(el, { clientHeight: 138, scrollHeight: 400 });
    document.getSelection()?.collapse(el, 1);
    caretRects = [];
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(320 + 8 - 238);
  });

  it('прямоугольник найти нечем: поле не двигается', () => {
    const el = editable({ clientHeight: 138, scrollHeight: 400 });
    caretRects = [];
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(0);
  });
});

describe('keepCaretVisible — textarea', () => {
  function area(g: Geometry, caretAt: number | 'end'): HTMLTextAreaElement {
    const el = document.createElement('textarea');
    el.value = 'строка\n'.repeat(30);
    document.body.append(el);
    geometry(el, g);
    el.setSelectionRange(caretAt === 'end' ? el.value.length : caretAt, caretAt === 'end' ? el.value.length : caretAt);
    return el;
  }

  it('каретка в конце текста: прокрутка до самого низа, с нижним отступом', () => {
    const el = area({ clientHeight: 180, scrollHeight: 600, scrollTop: 410 }, 'end');
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(420);
  });

  it('каретка в середине: родная прокрутка не трогается', () => {
    const el = area({ clientHeight: 180, scrollHeight: 600, scrollTop: 100 }, 10);
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(100);
  });

  it('не переполнено: не двигается', () => {
    const el = area({ clientHeight: 180, scrollHeight: 180, scrollTop: 0 }, 'end');
    keepCaretVisible(el);
    expect(el.scrollTop).toBe(0);
  });
});
