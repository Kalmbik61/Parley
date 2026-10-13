// packages/desktop/src/renderer/browser/annotate/use-annotate-mode.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import type { AnnotationElementTarget, AnnotationPick, AnnotationPosition, AnnotationRegionTarget } from '../../../shared/browser-types.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import type { ContextDraft, Delivered } from '../context/deliver.js';
import { useAnnotateStore } from './store.js';
import { addAnnotationsToChat, cancelMark, syncPins, useAnnotateMode } from './use-annotate-mode.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const TAB = 'browser:a1';
const PAGE = 'http://localhost:5173/settings';
const VIEWPORT = { width: 1280, height: 800, dpr: 2 };
const ELEMENT: AnnotationElementTarget = {
  kind: 'element',
  key: 'a1',
  selector: 'main > button.save',
  text: 'Save',
  html: '<button class="save">Save</button>',
  styles: {},
  anchor: { fx: 0.1, fy: 0.2 },
  viewport: VIEWPORT,
};
const REGION: AnnotationRegionTarget = { kind: 'region', key: 'a2', rect: { x: 1, y: 2, width: 308, height: 20 }, elements: [], anchor: { fx: 0.3, fy: 0.4 }, viewport: VIEWPORT };

function twoPins(): void {
  const store = useAnnotateStore.getState();
  store.receive(TAB, ELEMENT, PAGE);
  store.setDraft(TAB, 'make it green');
  store.save(TAB);
  store.receive(TAB, REGION, PAGE);
  store.save(TAB);
}

function collector(answer: Delivered) {
  const drafts: ContextDraft[] = [];
  const add = async (draft: ContextDraft): Promise<Delivered> => {
    drafts.push(draft);
    return answer;
  };
  return { drafts, add };
}

const items = () => useAnnotateStore.getState().tabs[TAB]?.items ?? [];

afterEach(() => useAnnotateStore.setState({ tabs: {} }));

describe('syncPins', () => {
  it('метки уходят по лотку; пропавшие помечены', async () => {
    const bridge = createFakeBridge();
    twoPins();
    bridge.setAnnotatePositions([
      { n: 1, rect: null },
      { n: 2, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } },
    ]);
    await syncPins(bridge, TAB, 7);
    expect(bridge.browserCalls).toEqual([{ method: 'annotateSync', args: [7, [{ n: 1, key: 'a1' }, { n: 2, key: 'a2' }]] }]);
    expect(items().map((item) => item.gone)).toEqual([true, false]);
  });
});

describe('addAnnotationsToChat (спека браузера 4.7)', () => {
  it('один файл annotations со снимком, лоток пуст; Undo возвращает пачку', async () => {
    const bridge = createFakeBridge();
    twoPins();
    bridge.setAnnotateCapture('/h/drops/page.png');
    const { drafts, add } = collector('room');
    await addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: 'http://localhost:5173/settings', viewportNote: null, add });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: 'annotations', label: 'settings', imagePath: '/h/drops/page.png', count: 2 });
    expect(drafts[0]?.markdown).toContain('> make it green');
    expect(drafts[0]?.markdown).toContain('## 2. Region 308 × 20');
    expect(drafts[0]?.markdown).toContain('Screenshot: {{parley:screenshot}}');
    expect(bridge.browserCalls.map((call) => call.method)).toEqual(['annotateSync', 'annotateCapture']);
    expect(items()).toEqual([]);
    drafts[0]?.onUndo?.();
    expect(items().map((item) => item.comment)).toEqual(['make it green', '']);
  });

  it('меток на странице нет — файл без снимка с пометкой; доставка не вышла — пачка на месте', async () => {
    const bridge = createFakeBridge();
    twoPins();
    bridge.setAnnotateCapture(null);
    const { drafts, add } = collector('failed');
    await addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: 'http://localhost:5173/', viewportNote: null, add });
    expect(drafts[0]).toMatchObject({ imagePath: null });
    expect(drafts[0]?.markdown).toContain('Screenshot: none — the page changed after annotating');
    expect(items()).toHaveLength(2);
  });

  it('пустой лоток — ничего', async () => {
    const bridge = createFakeBridge();
    const { drafts, add } = collector('room');
    await addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: 'http://x/', viewportNote: null, add });
    expect(drafts).toEqual([]);
    expect(bridge.browserCalls).toEqual([]);
  });

  it('метка, новый документ, ещё метка: прежний пункт «gone» и назван в файле по своей странице, на страницу уходит одна новая метка', async () => {
    const bridge = createFakeBridge();
    const store = useAnnotateStore.getState();
    store.receive(TAB, ELEMENT, PAGE);
    store.setDraft(TAB, 'make it green');
    store.save(TAB);
    store.markAllGone(TAB);
    // Скрипт меток нового документа нумерует с a1 заново — ключ тот же, что у первой метки.
    store.receive(TAB, { ...REGION, key: 'a1' }, 'http://localhost:5173/profile');
    store.save(TAB);
    bridge.setAnnotateCapture('/h/drops/page.png');
    const { drafts, add } = collector('room');
    await addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: 'http://localhost:5173/profile', viewportNote: null, add });
    expect(bridge.browserCalls[0]).toEqual({ method: 'annotateSync', args: [7, [{ n: 2, key: 'a1' }]] });
    const markdown = drafts[0]?.markdown ?? '';
    expect(markdown).toContain('URL: http://localhost:5173/profile\n');
    expect(markdown).toContain(
      '## 1. button.save\n> make it green\n(The element is gone from the page; it is not on the screenshot.)\n\n```text\nMarked on: http://localhost:5173/settings\nSelector: main > button.save\n',
    );
    expect(markdown).toContain('## 2. Region 308 × 20\n> (no comment)\n\n```text\nRect: 308 × 20 at 1, 2 (page coordinates)\n');
    expect(markdown.match(/Marked on:/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Ruling-тесты задачи 23: заметки отчётов задач 20-22 (N1-N5 и замечание 1 задачи 21, заметки задач 22 и 20).
// ---------------------------------------------------------------------------------------------------------------------

/** Отложенное значение: тест сам решает, когда страница или main «ответят». */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Страница ждёт клика человека: каждый `annotateStart` — ещё один ожидающий промис, ответ даёт тест. */
function manualPicks(bridge: FakeBridge): Array<(pick: AnnotationPick | null) => void> {
  const waiting: Array<(pick: AnnotationPick | null) => void> = [];
  bridge.browser.annotateStart = async (webContentsId) => {
    bridge.browserCalls.push({ method: 'annotateStart', args: [webContentsId] });
    return new Promise<AnnotationPick | null>((resolve) => waiting.push(resolve));
  };
  return waiting;
}

/** Режим Annotate в крошечной обвязке: без поверхности, но с настоящим хуком. */
function mountMode(bridge: FakeBridge) {
  const urlRef = { current: PAGE };
  return renderHook(({ on }: { on: boolean }) => useAnnotateMode({ bridge, tabId: TAB, webContentsId: 7, active: on, urlRef }), { initialProps: { on: true } });
}

/** Дать цепочкам промисов (ответ скрипта, перерисовка, следующая итерация цикла) дойти до конца. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) await act(async () => {});
}

const starts = (bridge: FakeBridge): number => bridge.browserCalls.filter((call) => call.method === 'annotateStart').length;
const syncs = (bridge: FakeBridge) => bridge.browserCalls.filter((call) => call.method === 'annotateSync');
const editing = () => useAnnotateStore.getState().tabs[TAB]?.editing ?? null;

describe('syncPins — ответ, опоздавший за новым документом или закрытой вкладкой (N2 задачи 21)', () => {
  it('markAllGone, пока annotateSync в пути: ответ прежнего документа пункт не оживляет', async () => {
    const bridge = createFakeBridge();
    const store = useAnnotateStore.getState();
    store.receive(TAB, ELEMENT, PAGE);
    store.save(TAB);
    const answer = deferred<AnnotationPosition[]>();
    bridge.browser.annotateSync = () => answer.promise;
    const sync = syncPins(bridge, TAB, 7);
    store.markAllGone(TAB);
    answer.resolve([{ n: 1, rect: { x: 0.2, y: 0.3, width: 0.1, height: 0.1 } }]);
    await sync;
    expect(items().map((item) => [item.gone, item.rect])).toEqual([[true, null]]);
  });

  it('номер прежнего пункта достался новой метке нового документа: опоздавший ответ прежнего её не трогает', async () => {
    const bridge = createFakeBridge();
    const store = useAnnotateStore.getState();
    store.receive(TAB, ELEMENT, PAGE);
    store.save(TAB);
    const answer = deferred<AnnotationPosition[]>();
    bridge.browser.annotateSync = () => answer.promise;
    const sync = syncPins(bridge, TAB, 7);
    // Новый документ, человек убрал прежнюю строку, поставил метку — у неё номер 1 и ключ a1, как у прежней.
    store.markAllGone(TAB);
    store.remove(TAB, 1);
    store.receive(TAB, { ...REGION, key: 'a1' }, 'http://localhost:5173/profile');
    store.save(TAB);
    answer.resolve([{ n: 1, rect: { x: 0.2, y: 0.3, width: 0.1, height: 0.1 } }]);
    await sync;
    expect(items().map((item) => [item.n, item.gone, item.rect])).toEqual([[1, false, null]]);
  });

  it('вкладку закрыли (drop), пока ответ в пути: запись лотка не воскресает', async () => {
    const bridge = createFakeBridge();
    const store = useAnnotateStore.getState();
    store.receive(TAB, ELEMENT, PAGE);
    store.save(TAB);
    const answer = deferred<AnnotationPosition[]>();
    bridge.browser.annotateSync = () => answer.promise;
    const sync = syncPins(bridge, TAB, 7);
    store.drop(TAB);
    answer.resolve([{ n: 1, rect: { x: 0.2, y: 0.3, width: 0.1, height: 0.1 } }]);
    await sync;
    expect(useAnnotateStore.getState().tabs[TAB]).toBeUndefined();
  });
});

describe('addAnnotationsToChat — черновик и Undo (N3, N4 задачи 21)', () => {
  it('набранный, но не сохранённый комментарий входит в файл: save первым делом, «(no comment)» нет', async () => {
    const bridge = createFakeBridge();
    const store = useAnnotateStore.getState();
    store.receive(TAB, ELEMENT, PAGE);
    store.setDraft(TAB, 'typed, not saved yet');
    const { drafts, add } = collector('room');
    await addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: PAGE, viewportNote: null, add });
    expect(drafts[0]?.markdown).toContain('> typed, not saved yet');
    expect(drafts[0]?.markdown).not.toContain('(no comment)');
    expect(editing()).toBeNull();
    // Undo возвращает пункт вместе с набранным.
    drafts[0]?.onUndo?.();
    expect(items().map((item) => item.comment)).toEqual(['typed, not saved yet']);
  });

  it('пустой лоток: ни файла, ни записи лотка у вкладки — save трогает только открытый редактор', async () => {
    const bridge = createFakeBridge();
    const { drafts, add } = collector('room');
    await addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: PAGE, viewportNote: null, add });
    expect(drafts).toEqual([]);
    expect(useAnnotateStore.getState().tabs[TAB]).toBeUndefined();
  });

  /** «Add to chat» стоит на снимке страницы; пока он идёт, человек ставит ещё одну метку. */
  async function addWhileMarking(answer: Delivered) {
    const bridge = createFakeBridge();
    const store = useAnnotateStore.getState();
    store.receive(TAB, { ...ELEMENT, selector: 'main > button.one' }, PAGE);
    store.setDraft(TAB, 'first');
    store.save(TAB);
    const capture = deferred<{ path: string | null }>();
    bridge.browser.annotateCapture = () => capture.promise;
    const { drafts, add } = collector(answer);
    const run = addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: PAGE, viewportNote: null, add });
    await settle();
    store.receive(TAB, { ...ELEMENT, key: 'a2', selector: 'main > button.two' }, PAGE);
    store.setDraft(TAB, 'second');
    store.save(TAB);
    capture.resolve({ path: '/h/drops/page.png' });
    await run;
    return drafts;
  }

  it('метка, поставленная, пока шёл снимок, в файл не входит и остаётся в лотке — не уходит в пачку «Undo»; число в тосте — только файловое', async () => {
    const drafts = await addWhileMarking('room');
    expect(drafts[0]?.markdown).toContain('button.one');
    expect(drafts[0]?.markdown).not.toContain('button.two');
    expect(drafts[0]).toMatchObject({ count: 1 });
    expect(items().map((item) => [item.n, item.comment])).toEqual([[1, 'second']]);
    // Undo возвращает пачку перед новой меткой; повторный — ничего не добавляет.
    drafts[0]?.onUndo?.();
    drafts[0]?.onUndo?.();
    expect(items().map((item) => [item.n, item.comment])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
  });

  it('доставка не вышла: пачка возвращается перед меткой, поставленной за время записи', async () => {
    await addWhileMarking('failed');
    expect(items().map((item) => [item.n, item.comment])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
  });

  it('метка за время записи с ключом, который уже был у пункта прежнего документа, — всё равно новая: ключ уникален лишь в пределах поколения', async () => {
    const bridge = createFakeBridge();
    const store = useAnnotateStore.getState();
    // Документ 1: a1 и a2; документ 2 нумерует заново — a1; во время записи в нём появляется a2.
    store.receive(TAB, { ...ELEMENT, key: 'a1', selector: 'main > button.one' }, PAGE);
    store.save(TAB);
    store.receive(TAB, { ...ELEMENT, key: 'a2', selector: 'main > button.two' }, PAGE);
    store.save(TAB);
    store.markAllGone(TAB);
    store.receive(TAB, { ...ELEMENT, key: 'a1', selector: 'main > a.three' }, 'http://localhost:5173/profile');
    store.save(TAB);
    const capture = deferred<{ path: string | null }>();
    bridge.browser.annotateCapture = () => capture.promise;
    const { drafts, add } = collector('room');
    const run = addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: 'http://localhost:5173/profile', viewportNote: null, add });
    await settle();
    store.receive(TAB, { ...ELEMENT, key: 'a2', selector: 'main > a.four' }, 'http://localhost:5173/profile');
    store.save(TAB);
    capture.resolve({ path: '/h/drops/page.png' });
    await run;
    expect(drafts[0]).toMatchObject({ count: 3 });
    expect(drafts[0]?.markdown).toContain('a.three');
    expect(drafts[0]?.markdown).not.toContain('a.four');
    expect(items().map((item) => [item.n, item.key, item.target.kind === 'element' ? item.target.selector : ''])).toEqual([[1, 'a2', 'main > a.four']]);
  });

  it('двойной «Undo» (двойной щелчок по тосту, пока он гаснет) возвращает пачку один раз', async () => {
    const bridge = createFakeBridge();
    twoPins();
    const { drafts, add } = collector('room');
    await addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: PAGE, viewportNote: null, add });
    expect(items()).toEqual([]);
    drafts[0]?.onUndo?.();
    drafts[0]?.onUndo?.();
    expect(items().map((item) => [item.n, item.key])).toEqual([
      [1, 'a1'],
      [2, 'a2'],
    ]);
  });
});

describe('addAnnotationsToChat — вкладку закрыли или лоток опустел, пока шли перерисовка и снимок (заметки задачи 23)', () => {
  /** «Add to chat» стоит на снимке; `during` — что делает человек, пока он идёт. Возвращает то, что ушло в добавление. */
  async function addWhile(during: () => void, answer: Delivered = 'room') {
    const bridge = createFakeBridge();
    const store = useAnnotateStore.getState();
    store.receive(TAB, ELEMENT, PAGE);
    store.setDraft(TAB, 'first');
    store.save(TAB);
    const capture = deferred<{ path: string | null }>();
    bridge.browser.annotateCapture = () => capture.promise;
    const { drafts, add } = collector(answer);
    const run = addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: PAGE, viewportNote: null, add });
    await settle();
    during();
    capture.resolve({ path: '/h/drops/page.png' });
    await run;
    return drafts;
  }

  it('вкладку закрыли (drop), пока шёл снимок: в чат ничего не уходит, запись лотка закрытой вкладки не воскресает', async () => {
    const drafts = await addWhile(() => useAnnotateStore.getState().drop(TAB));
    expect(drafts).toEqual([]);
    expect(useAnnotateStore.getState().tabs[TAB]).toBeUndefined();
  });

  it('«Clear», пока шёл снимок: пачка пуста — в чат ничего не уходит («0 annotations added» не будет)', async () => {
    const drafts = await addWhile(() => useAnnotateStore.getState().clear(TAB));
    expect(drafts).toEqual([]);
    expect(items()).toEqual([]);
  });

  it('пункт убран по одному и поставлен новый, пока шёл снимок: в файл вошло только прежнее — его нет, пачка пуста, новая метка в лотке', async () => {
    const drafts = await addWhile(() => {
      const store = useAnnotateStore.getState();
      store.remove(TAB, 1);
      store.receive(TAB, { ...ELEMENT, key: 'a2', selector: 'main > button.two' }, PAGE);
      store.setDraft(TAB, 'second');
      store.save(TAB);
    });
    expect(drafts).toEqual([]);
    expect(items().map((item) => [item.n, item.comment])).toEqual([[1, 'second']]);
  });

  it('вкладку закрыли, пока тост «Undo» висел: возврат пачки не воскрешает запись лотка', async () => {
    const bridge = createFakeBridge();
    twoPins();
    const { drafts, add } = collector('room');
    await addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: PAGE, viewportNote: null, add });
    useAnnotateStore.getState().drop(TAB);
    drafts[0]?.onUndo?.();
    expect(useAnnotateStore.getState().tabs[TAB]).toBeUndefined();
  });

  it('доставка не вышла, а вкладку закрыли за время записи: пачка не возвращается в несуществующий лоток', async () => {
    const bridge = createFakeBridge();
    twoPins();
    const drafts: ContextDraft[] = [];
    const add = async (draft: ContextDraft): Promise<Delivered> => {
      drafts.push(draft);
      useAnnotateStore.getState().drop(TAB);
      return 'failed';
    };
    await addAnnotationsToChat({ bridge, tabId: TAB, webContentsId: 7, pageUrl: PAGE, viewportNote: null, add });
    expect(drafts).toHaveLength(1);
    expect(useAnnotateStore.getState().tabs[TAB]).toBeUndefined();
  });
});

describe('useAnnotateMode — цикл меток (N1, N5 задачи 21; замечание 1; заметки задач 22 и 20)', () => {
  afterEach(() => vi.mocked(toast).mockClear());

  it('✎ выкл и вкл при открытом редакторе: страница не взводится, пока редактор не закрыт (N5)', async () => {
    const bridge = createFakeBridge();
    bridge.setAnnotatePicks([ELEMENT]);
    const view = mountMode(bridge);
    await vi.waitFor(() => expect(editing()).not.toBeNull());
    expect(starts(bridge)).toBe(1);
    view.rerender({ on: false });
    view.rerender({ on: true });
    await settle();
    // Редактор открыт: следующая метка легла бы поверх него и стёрла бы набранное.
    expect(starts(bridge)).toBe(1);
    act(() => useAnnotateStore.getState().save(TAB));
    await vi.waitFor(() => expect(starts(bridge)).toBe(2));
    // Прежний цикл (его режим выключали) тоже ждал закрытия редактора — проснувшись, он страницу не взводит.
    await settle();
    expect(starts(bridge)).toBe(2);
  });

  it('правка по метке на странице: положение сначала обновляется, потом открывается редактор — у свежего места (N1)', async () => {
    const bridge = createFakeBridge();
    useAnnotateStore.getState().receive(TAB, ELEMENT, PAGE);
    useAnnotateStore.getState().save(TAB);
    bridge.setAnnotatePositions([{ n: 1, rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 } }]);
    const waiting = manualPicks(bridge);
    mountMode(bridge);
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    await settle();
    expect(items()[0]?.rect).toMatchObject({ x: 0.1, y: 0.1 });
    // Страницу прокрутили: метка теперь в другом месте, а человек кликает по её номеру.
    bridge.setAnnotatePositions([{ n: 1, rect: { x: 0.5, y: 0.6, width: 0.2, height: 0.05 } }]);
    const syncsBefore = syncs(bridge).length;
    await act(async () => waiting[0]?.({ kind: 'edit', n: 1 }));
    await vi.waitFor(() => expect(editing()).not.toBeNull());
    expect(editing()?.anchor).toEqual({ fx: 0.5, fy: 0.6 });
    // Одна свежая перерисовка до редактора, и всё: состав лотка не менялся, лишней за правкой нет.
    await settle();
    expect(syncs(bridge).length - syncsBefore).toBe(1);
  });

  it('receive отказал на пределе 20 (Undo вернул пачку, пока страница ждала клика): метки страницы перерисованы, временный номер не висит (замечание 1)', async () => {
    const bridge = createFakeBridge();
    const store = useAnnotateStore.getState();
    for (let index = 1; index <= 19; index += 1) {
      store.receive(TAB, { ...ELEMENT, key: `a${index}` }, PAGE);
      store.save(TAB);
    }
    const waiting = manualPicks(bridge);
    mountMode(bridge);
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    act(() => {
      store.receive(TAB, { ...ELEMENT, key: 'a20' }, PAGE);
      store.save(TAB);
    });
    await settle();
    const before = bridge.browserCalls.length;
    // Клик человека: скрипт уже нарисовал временную метку «21», а лоток её не примет.
    await act(async () => waiting[0]?.({ ...ELEMENT, key: 'a21' }));
    await settle();
    expect(items()).toHaveLength(20);
    const after = bridge.browserCalls.slice(before);
    expect(after.filter((call) => call.method === 'annotateSync')).toHaveLength(1);
    expect(vi.mocked(toast)).toHaveBeenCalledWith('No more than 20 annotations — add these to chat or clear them first');
  });

  it('редактор открыт из лотка, пока страница ждёт клика: метка со страницы не стирает набранное — оно становится комментарием', async () => {
    const bridge = createFakeBridge();
    const store = useAnnotateStore.getState();
    store.receive(TAB, ELEMENT, PAGE);
    store.save(TAB);
    const waiting = manualPicks(bridge);
    mountMode(bridge);
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    act(() => {
      store.startEdit(TAB, 1);
      store.setDraft(TAB, 'typed in the tray editor');
    });
    await act(async () => waiting[0]?.({ ...REGION, key: 'a2' }));
    await vi.waitFor(() => expect(items()).toHaveLength(2));
    expect(items()[0]?.comment).toBe('typed in the tray editor');
    expect(editing()).toMatchObject({ n: 2, isNew: true });
  });

  it('выключение режима и размонтирование — annotateCancel странице', async () => {
    const bridge = createFakeBridge();
    const waiting = manualPicks(bridge);
    const view = mountMode(bridge);
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(bridge.browserCalls.filter((call) => call.method === 'annotateCancel')).toEqual([]);
    view.rerender({ on: false });
    expect(bridge.browserCalls.filter((call) => call.method === 'annotateCancel')).toEqual([{ method: 'annotateCancel', args: [7] }]);
    view.rerender({ on: true });
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    view.unmount();
    expect(bridge.browserCalls.filter((call) => call.method === 'annotateCancel')).toHaveLength(2);
  });
});

describe('cancelMark — отмена новой метки (замечание 1 задачи 21)', () => {
  it('новая метка: пункт убран, а страница перерисована сама — временный номер уходит, лоток между рендерами мог и не меняться', async () => {
    const bridge = createFakeBridge();
    useAnnotateStore.getState().receive(TAB, ELEMENT, PAGE);
    await cancelMark(bridge, TAB, 7);
    expect(items()).toEqual([]);
    expect(editing()).toBeNull();
    expect(bridge.browserCalls).toEqual([{ method: 'annotateSync', args: [7, []] }]);
  });

  it('готовая метка (Esc при правке): пункт цел, страница не перерисовывается', async () => {
    const bridge = createFakeBridge();
    const store = useAnnotateStore.getState();
    store.receive(TAB, ELEMENT, PAGE);
    store.save(TAB);
    store.startEdit(TAB, 1);
    await cancelMark(bridge, TAB, 7);
    expect(items()).toHaveLength(1);
    expect(editing()).toBeNull();
    expect(bridge.browserCalls).toEqual([]);
  });

  it('страницы ещё нет (webContentsId null): пункт убран, мост не зовётся', async () => {
    const bridge = createFakeBridge();
    useAnnotateStore.getState().receive(TAB, ELEMENT, PAGE);
    await cancelMark(bridge, TAB, null);
    expect(items()).toEqual([]);
    expect(bridge.browserCalls).toEqual([]);
  });
});
