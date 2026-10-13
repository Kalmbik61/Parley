// packages/desktop/src/renderer/browser/annotate/store.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import type { AnnotationElementTarget, AnnotationRegionTarget } from '../../../shared/browser-types.js';
import { EMPTY_ANNOTATE, pinsOf, useAnnotateStore } from './store.js';

const TAB = 'browser:a1';
const PAGE = 'http://localhost:5173/settings';
const OTHER_PAGE = 'http://localhost:5173/profile';
const VIEWPORT = { width: 1280, height: 800, dpr: 2 };

function element(key: string): AnnotationElementTarget {
  return { kind: 'element', key, selector: 'main > button.save', text: 'Save', html: '<button>', styles: {}, anchor: { fx: 0.1, fy: 0.2 }, viewport: VIEWPORT };
}

function region(key: string): AnnotationRegionTarget {
  return { kind: 'region', key, rect: { x: 1, y: 2, width: 308, height: 20 }, elements: [], anchor: { fx: 0.3, fy: 0.4 }, viewport: VIEWPORT };
}

const tab = () => useAnnotateStore.getState().tabs[TAB];
const store = () => useAnnotateStore.getState();

afterEach(() => useAnnotateStore.setState({ tabs: {} }));

describe('useAnnotateStore (спека браузера 4.7)', () => {
  it('новая метка — пункт с номером по порядку и открытый редактор у метки', () => {
    store().receive(TAB, element('a1'), PAGE);
    expect(tab()?.items.map((item) => [item.n, item.key, item.comment])).toEqual([[1, 'a1', '']]);
    expect(tab()?.editing).toEqual({ n: 1, isNew: true, anchor: { fx: 0.1, fy: 0.2 }, draft: '' });
  });

  it('Save: черновик обрезан по краям и до 2000; редактор закрыт; правка готовой — с её комментарием и местом из последней перерисовки', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().setDraft(TAB, `  ${'x'.repeat(2500)}  `);
    store().save(TAB);
    expect(tab()?.items[0]?.comment).toBe('x'.repeat(2000));
    expect(tab()?.editing).toBeNull();
    store().markPositions(TAB, [{ n: 1, rect: { x: 0.5, y: 0.6, width: 0.1, height: 0.1 } }]);
    store().receive(TAB, { kind: 'edit', n: 1 }, PAGE);
    expect(tab()?.editing).toEqual({ n: 1, isNew: false, anchor: { fx: 0.5, fy: 0.6 }, draft: 'x'.repeat(2000) });
  });

  it('Esc у новой метки — пункта нет; у готовой — только редактор закрыт', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().save(TAB);
    store().receive(TAB, region('a2'), PAGE);
    store().cancelEdit(TAB);
    expect(tab()?.items.map((item) => item.key)).toEqual(['a1']);
    store().startEdit(TAB, 1);
    store().cancelEdit(TAB);
    expect(tab()?.items.map((item) => item.key)).toEqual(['a1']);
    expect(tab()?.editing).toBeNull();
  });

  it('удаление перенумеровывает; больше 20 — новая метка не ставится', () => {
    for (let index = 1; index <= 3; index += 1) {
      store().receive(TAB, element(`a${index}`), PAGE);
      store().save(TAB);
    }
    store().remove(TAB, 2);
    expect(pinsOf(tab() ?? EMPTY_ANNOTATE)).toEqual([
      { n: 1, key: 'a1' },
      { n: 2, key: 'a3' },
    ]);
    for (let index = 4; index <= 25; index += 1) {
      store().receive(TAB, element(`a${index}`), PAGE);
      store().save(TAB);
    }
    expect(tab()?.items).toHaveLength(20);
  });

  it('clear отдаёт пачку для Undo, restore возвращает её перед новыми пунктами', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().save(TAB);
    const removed = store().clear(TAB);
    expect(tab()?.items).toEqual([]);
    store().receive(TAB, region('a2'), PAGE);
    store().save(TAB);
    store().restore(TAB, removed);
    expect(pinsOf(tab() ?? EMPTY_ANNOTATE)).toEqual([
      { n: 1, key: 'a1' },
      { n: 2, key: 'a2' },
    ]);
  });

  it('положения: null — «element gone»; новый документ — все пропали; drop убирает вкладку', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().save(TAB);
    store().receive(TAB, region('a2'), PAGE);
    store().save(TAB);
    store().markPositions(TAB, [
      { n: 1, rect: null },
      { n: 2, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } },
    ]);
    expect(tab()?.items.map((item) => item.gone)).toEqual([true, false]);
    store().markAllGone(TAB);
    expect(tab()?.items.map((item) => [item.gone, item.rect])).toEqual([
      [true, null],
      [true, null],
    ]);
    store().drop(TAB);
    expect(tab()).toBeUndefined();
  });

  it('пункт помнит адрес страницы, на которой поставлен, и поколение документа', () => {
    store().receive(TAB, element('a1'), PAGE);
    expect(tab()?.items.map((item) => [item.url, item.generation])).toEqual([[PAGE, 0]]);
  });

  it('новый документ: метки прошлого в страницу не уходят, пункт остаётся «gone»; тот же ключ в новом документе — другая метка', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().save(TAB);
    store().markAllGone(TAB);
    // Скрипт нового документа нумерует с a1 заново.
    store().receive(TAB, region('a1'), OTHER_PAGE);
    store().save(TAB);
    expect(pinsOf(tab() ?? EMPTY_ANNOTATE)).toEqual([{ n: 2, key: 'a1' }]);
    store().markPositions(TAB, [{ n: 2, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } }]);
    expect(tab()?.items.map((item) => [item.url, item.gone])).toEqual([
      [PAGE, true],
      [OTHER_PAGE, false],
    ]);
  });

  it('«Undo» после нового документа: вернувшиеся пункты прошлого — «gone» и в метки не уходят, даже если лоток был пуст', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().save(TAB);
    const removed = store().clear(TAB);
    // Тост «Undo» ещё на экране, а страница сменилась: лоток пуст, но поколение растёт всё равно.
    store().markAllGone(TAB);
    store().receive(TAB, region('a1'), OTHER_PAGE);
    store().save(TAB);
    store().restore(TAB, removed);
    expect(tab()?.items.map((item) => [item.n, item.url, item.gone])).toEqual([
      [1, PAGE, true],
      [2, OTHER_PAGE, false],
    ]);
    expect(pinsOf(tab() ?? EMPTY_ANNOTATE)).toEqual([{ n: 2, key: 'a1' }]);
  });

  it('комментарий режется по кодовым точкам, а не по знакам UTF-16: пара суррогатов не рвётся', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().setDraft(TAB, '😀'.repeat(2001));
    store().save(TAB);
    expect(tab()?.items[0]?.comment).toBe('😀'.repeat(2000));
  });

  it('remove, clear и restore закрывают редактор: после пересчёта номеров его номер назвал бы другой пункт, и Save записал бы комментарий не туда', () => {
    for (const key of ['a1', 'a2', 'a3']) {
      store().receive(TAB, element(key), PAGE);
      store().save(TAB);
    }
    store().startEdit(TAB, 2);
    store().remove(TAB, 1);
    expect(tab()?.editing).toBeNull();
    store().startEdit(TAB, 1);
    const removed = store().clear(TAB);
    expect(tab()?.editing).toBeNull();
    store().receive(TAB, element('b1'), PAGE);
    store().save(TAB);
    store().startEdit(TAB, 1);
    store().restore(TAB, removed);
    expect(tab()?.editing).toBeNull();
  });

  it('«Undo» не раздувает лоток сверх 20: убранная пачка идёт первой, номера 1…20 без дыр, лишние пункты — с хвоста', () => {
    for (let index = 1; index <= 15; index += 1) {
      store().receive(TAB, element(`a${index}`), PAGE);
      store().save(TAB);
    }
    const removed = store().clear(TAB);
    for (let index = 1; index <= 15; index += 1) {
      store().receive(TAB, element(`b${index}`), PAGE);
      store().save(TAB);
    }
    store().restore(TAB, removed);
    expect(tab()?.items.map((item) => item.n)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(tab()?.items.map((item) => item.key)).toEqual([
      ...Array.from({ length: 15 }, (_, index) => `a${index + 1}`),
      ...Array.from({ length: 5 }, (_, index) => `b${index + 1}`),
    ]);
  });

  it('свёрнутый лоток: setCollapsed сворачивает и раскрывает, а новая метка раскрывает сама', () => {
    store().setCollapsed(TAB, true);
    expect(tab()?.collapsed).toBe(true);
    store().setCollapsed(TAB, false);
    expect(tab()?.collapsed).toBe(false);
    store().setCollapsed(TAB, true);
    store().receive(TAB, element('a1'), PAGE);
    expect(tab()?.collapsed).toBe(false);
  });

  it('повторный restore той же пачки (двойной щелчок по «Undo») ничего не добавляет: ключи в поколении уникальны', () => {
    for (const key of ['a1', 'a2']) {
      store().receive(TAB, element(key), PAGE);
      store().save(TAB);
    }
    const removed = store().clear(TAB);
    // Тост «Undo» ещё кликабелен, пока гаснет: второй щелчок зовёт тот же restore с той же пачкой.
    store().restore(TAB, removed);
    store().restore(TAB, removed);
    expect(tab()?.items.map((item) => [item.n, item.key])).toEqual([
      [1, 'a1'],
      [2, 'a2'],
    ]);
    // Повтор ключа в списке меток отклонил бы `parseAnnotationPins`: страница перестала бы перерисовываться.
    expect(pinsOf(tab() ?? EMPTY_ANNOTATE)).toEqual([
      { n: 1, key: 'a1' },
      { n: 2, key: 'a2' },
    ]);
  });

  it('повторный restore не закрывает редактор, который человек успел открыть, и не трогает его черновик', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().save(TAB);
    const removed = store().clear(TAB);
    store().restore(TAB, removed);
    store().receive(TAB, region('a2'), PAGE);
    store().setDraft(TAB, 'half-written');
    store().restore(TAB, removed);
    expect(tab()?.editing).toEqual({ n: 2, isNew: true, anchor: { fx: 0.3, fy: 0.4 }, draft: 'half-written' });
    expect(tab()?.items.map((item) => item.key)).toEqual(['a1', 'a2']);
  });

  it('повторный restore после нового документа: вернувшийся пункт прошлого поколения тоже не двоится', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().save(TAB);
    const removed = store().clear(TAB);
    store().markAllGone(TAB);
    store().restore(TAB, removed);
    store().restore(TAB, removed);
    expect(tab()?.items.map((item) => [item.n, item.key, item.generation, item.gone])).toEqual([[1, 'a1', 0, true]]);
  });

  it('поздний ответ sync прежнего документа не оживляет пункт: markPositions трогает только пункты текущего поколения', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().save(TAB);
    // `annotateSync` ушёл с метками старого документа, а страница сменилась, пока ответ был в пути.
    store().markAllGone(TAB);
    store().markPositions(TAB, [{ n: 1, rect: { x: 0.2, y: 0.3, width: 0.1, height: 0.1 } }]);
    expect(tab()?.items.map((item) => [item.gone, item.rect])).toEqual([[true, null]]);
  });

  it('startEdit не теряет черновик открытого редактора: набранное становится комментарием его пункта', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().save(TAB);
    store().receive(TAB, region('a2'), PAGE);
    store().setDraft(TAB, '  typed but not saved  ');
    // Редактор не модальный, поэтому кнопка «изменить» лотка доступна при открытом редакторе.
    store().startEdit(TAB, 1);
    expect(tab()?.items.map((item) => [item.n, item.comment])).toEqual([
      [1, ''],
      [2, 'typed but not saved'],
    ]);
    expect(tab()?.editing).toEqual({ n: 1, isNew: false, anchor: { fx: 0.1, fy: 0.2 }, draft: '' });
  });

  it('startEdit пункта, чей редактор уже открыт, не сбрасывает набранное: редактор встаёт с ним', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().setDraft(TAB, 'typed but not saved');
    store().startEdit(TAB, 1);
    expect(tab()?.editing).toEqual({ n: 1, isNew: false, anchor: { fx: 0.1, fy: 0.2 }, draft: 'typed but not saved' });
    expect(tab()?.items.map((item) => item.comment)).toEqual(['typed but not saved']);
  });

  it('remove не теряет черновик редактора другого пункта: комментарий переезжает вместе с пересчитанным номером', () => {
    for (const key of ['a1', 'a2']) {
      store().receive(TAB, element(key), PAGE);
      store().save(TAB);
    }
    store().startEdit(TAB, 2);
    store().setDraft(TAB, 'typed but not saved');
    store().remove(TAB, 1);
    expect(tab()?.items.map((item) => [item.n, item.key, item.comment])).toEqual([[1, 'a2', 'typed but not saved']]);
    expect(tab()?.editing).toBeNull();
  });

  it('clear уносит в пачку «Undo» и набранный, но не сохранённый комментарий', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().setDraft(TAB, 'typed but not saved');
    const removed = store().clear(TAB);
    expect(removed.map((item) => item.comment)).toEqual(['typed but not saved']);
    store().restore(TAB, removed);
    expect(tab()?.items.map((item) => item.comment)).toEqual(['typed but not saved']);
  });

  it('restore не теряет черновик открытого редактора: набранное становится комментарием его пункта', () => {
    store().receive(TAB, element('a1'), PAGE);
    store().save(TAB);
    const removed = store().clear(TAB);
    store().receive(TAB, region('a2'), PAGE);
    store().setDraft(TAB, 'typed but not saved');
    store().restore(TAB, removed);
    expect(tab()?.items.map((item) => [item.n, item.key, item.comment])).toEqual([
      [1, 'a1', ''],
      [2, 'a2', 'typed but not saved'],
    ]);
    expect(tab()?.editing).toBeNull();
  });
});
