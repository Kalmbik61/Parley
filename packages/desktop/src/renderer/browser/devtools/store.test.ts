import { afterEach, describe, expect, it } from 'vitest';
import { DEVTOOLS_LIMITS } from '../../../shared/browser-devtools.js';
import { consoleEntry, devtoolsBatch, networkEntry } from '../../test-utils/devtools-fixtures.js';
import {
  devtoolsCounters,
  documentUrl,
  EMPTY_DEVTOOLS,
  useDevtoolsStore,
  visibleConsole,
  visibleNetwork,
  type TabDevtools,
} from './store.js';

const TAB = 'browser:0000c1';
const tab = (): TabDevtools => useDevtoolsStore.getState().tabs[TAB] ?? EMPTY_DEVTOOLS;
const withTab = (patch: Partial<TabDevtools>): TabDevtools => ({ ...EMPTY_DEVTOOLS, ...patch });

afterEach(() => useDevtoolsStore.setState({ tabs: {} }));

describe('журнал вкладки: снимок и пачки (спека 3.5)', () => {
  it('снимок заменяет журнал и эпоху, вид панели не трогает', () => {
    const store = useDevtoolsStore.getState();
    store.show(TAB, 'network');
    store.batch(TAB, devtoolsBatch({ console: [consoleEntry(1)] }));
    store.snapshot(TAB, { epoch: 3, capture: 'late', console: [consoleEntry(5)], network: [networkEntry('r1')] });
    expect(tab()).toMatchObject({ epoch: 3, capture: 'late', open: true, view: 'network' });
    expect(tab().console.map((entry) => entry.id)).toEqual([5]);
    expect(tab().network.map((entry) => entry.id)).toEqual(['r1']);
  });

  it('пачка: новые записи — в конец, изменённые (count, ответ) — на своём месте', () => {
    const store = useDevtoolsStore.getState();
    store.batch(TAB, devtoolsBatch({ console: [consoleEntry(1), consoleEntry(2)], network: [networkEntry('r1', { status: null })] }));
    store.batch(
      TAB,
      devtoolsBatch({ console: [consoleEntry(1, { count: 4 }), consoleEntry(3)], network: [networkEntry('r1', { status: 500 }), networkEntry('r2')] }),
    );
    expect(tab().console.map((entry) => [entry.id, entry.count])).toEqual([
      [1, 4],
      [2, 1],
      [3, 1],
    ]);
    expect(tab().network.map((entry) => [entry.id, entry.status])).toEqual([
      ['r1', 500],
      ['r2', 200],
    ]);
  });

  it('reset — журнал очищен до пачки; эпоха и capture — из пачки', () => {
    const store = useDevtoolsStore.getState();
    store.batch(TAB, devtoolsBatch({ console: [consoleEntry(1)] }));
    store.batch(TAB, devtoolsBatch({ reset: true, epoch: 2, capture: 'unavailable', console: [consoleEntry(9)] }));
    expect(tab()).toMatchObject({ epoch: 2, capture: 'unavailable' });
    expect(tab().console.map((entry) => entry.id)).toEqual([9]);
  });

  it('пределы как у колец main: 1000 сообщений, 500 запросов — старшие уходят', () => {
    const store = useDevtoolsStore.getState();
    store.batch(TAB, devtoolsBatch({ console: Array.from({ length: DEVTOOLS_LIMITS.consoleEntries + 2 }, (_, index) => consoleEntry(index + 1)) }));
    store.batch(TAB, devtoolsBatch({ network: Array.from({ length: DEVTOOLS_LIMITS.networkEntries + 1 }, (_, index) => networkEntry(`r${index}`)) }));
    expect(tab().console).toHaveLength(DEVTOOLS_LIMITS.consoleEntries);
    expect(tab().console[0]?.id).toBe(3);
    expect(tab().network).toHaveLength(DEVTOOLS_LIMITS.networkEntries);
    expect(tab().network[0]?.id).toBe('r1');
  });

  it('новая эпоха без Preserve log снимает выбор запроса, с ним — оставляет; clear — пустой журнал', () => {
    const store = useDevtoolsStore.getState();
    store.batch(TAB, devtoolsBatch({ network: [networkEntry('r1')] }));
    store.patch(TAB, { selected: 'r1' });
    store.batch(TAB, devtoolsBatch({ epoch: 1 }));
    expect(tab().selected).toBeNull();
    store.patch(TAB, { selected: 'r1', preserve: true });
    store.batch(TAB, devtoolsBatch({ epoch: 2 }));
    expect(tab().selected).toBe('r1');
    store.clear(TAB);
    expect(tab()).toMatchObject({ console: [], network: [], selected: null, epoch: 2 });
  });
});

describe('вид: фильтры (спека 4.3, 4.4)', () => {
  it('Console: текущая эпоха, с Preserve log — все; Debug выключен по умолчанию; текст — без учёта регистра', () => {
    const entries = [
      consoleEntry(1, { epoch: 0, text: 'old' }),
      consoleEntry(2, { epoch: 1, text: 'Boom happened', level: 'error' }),
      consoleEntry(3, { epoch: 1, text: 'trace', level: 'debug' }),
      consoleEntry(4, { epoch: 1, text: 'ok' }),
    ];
    const ids = (value: TabDevtools): number[] => visibleConsole(value).map((entry) => entry.id);
    expect(ids(withTab({ epoch: 1, console: entries }))).toEqual([2, 4]);
    expect(ids(withTab({ epoch: 1, console: entries, preserve: true }))).toEqual([1, 2, 4]);
    expect(ids(withTab({ epoch: 1, console: entries, levels: { ...EMPTY_DEVTOOLS.levels, debug: true } }))).toEqual([2, 3, 4]);
    expect(ids(withTab({ epoch: 1, console: entries, consoleText: 'BOOM' }))).toEqual([2]);
  });

  it('Network: All, Fetch/XHR, Doc, JS, CSS, Img, Other; Failed only; URL', () => {
    const entries = [
      networkEntry('doc', { kind: 'document', url: 'http://localhost:5173/' }),
      networkEntry('api', { kind: 'fetch', status: 500 }),
      networkEntry('xhr', { kind: 'xhr' }),
      networkEntry('js', { kind: 'script' }),
      networkEntry('css', { kind: 'stylesheet' }),
      networkEntry('img', { kind: 'image' }),
      networkEntry('font', { kind: 'font' }),
      networkEntry('ws', { kind: 'websocket' }),
      networkEntry('cancel', { status: null, failure: { reason: 'canceled', text: 'net::ERR_ABORTED' } }),
    ];
    const ids = (patch: Partial<TabDevtools>): string[] => visibleNetwork(withTab({ network: entries, ...patch })).map((entry) => entry.id);
    expect(ids({})).toHaveLength(9);
    expect(ids({ networkFilter: 'fetch' })).toEqual(['api', 'xhr', 'cancel']);
    expect(ids({ networkFilter: 'doc' })).toEqual(['doc']);
    expect(ids({ networkFilter: 'js' })).toEqual(['js']);
    expect(ids({ networkFilter: 'css' })).toEqual(['css']);
    expect(ids({ networkFilter: 'img' })).toEqual(['img']);
    expect(ids({ networkFilter: 'other' })).toEqual(['font', 'ws']);
    expect(ids({ failedOnly: true })).toEqual(['api']);
    expect(ids({ urlText: 'API/XHR' })).toEqual(['xhr']);
  });

  it('documentUrl — адрес документа эпохи для разделителя «Navigated to»', () => {
    const value = withTab({ network: [networkEntry('doc', { kind: 'document', epoch: 2, url: 'http://localhost:5173/next' })] });
    expect(documentUrl(value, 2)).toBe('http://localhost:5173/next');
    expect(documentUrl(value, 1)).toBeNull();
  });
});

describe('счётчики строки (спека 4.1; Фокус ревью 3)', () => {
  it('упавший запрос и его строки «Failed to load resource» и CORS — одна ошибка на запрос', () => {
    const value = withTab({
      console: [
        consoleEntry(1, { level: 'error', origin: 'network', text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)' }),
        consoleEntry(2, { level: 'error', origin: 'network', text: 'Access to fetch has been blocked by CORS policy' }),
      ],
      network: [networkEntry('api', { status: 500 }), networkEntry('cors', { status: null, failure: { reason: 'cors', text: 'MissingAllowOriginHeader' } })],
    });
    expect(devtoolsCounters(value)).toEqual({ errors: 2, warnings: 0 });
  });

  it('ошибки консоли с повторами, исключения и ошибки браузера без запроса (CSP) — красный, предупреждения консоли — жёлтый; прошлая эпоха и отмена — не в счёт', () => {
    const value = withTab({
      epoch: 1,
      console: [
        consoleEntry(1, { epoch: 0, level: 'error' }),
        consoleEntry(2, { epoch: 1, level: 'error', count: 3 }),
        consoleEntry(3, { epoch: 1, level: 'error', origin: 'exception' }),
        consoleEntry(4, { epoch: 1, level: 'warning', count: 2 }),
        consoleEntry(5, { epoch: 1, level: 'warning', origin: 'browser' }),
        consoleEntry(6, { epoch: 1, level: 'error', origin: 'browser', text: "Refused to load the script because it violates the Content Security Policy" }),
      ],
      network: [
        networkEntry('old', { epoch: 0, status: 500 }),
        networkEntry('x', { epoch: 1, status: null, failure: { reason: 'canceled', text: 'net::ERR_ABORTED' } }),
      ],
    });
    expect(devtoolsCounters(value)).toEqual({ errors: 5, warnings: 2 });
  });
});

describe('панель: открыть, вид, спрятать', () => {
  it('toggle, show на нужном виде, hide, remove', () => {
    const store = useDevtoolsStore.getState();
    store.toggle(TAB);
    expect(tab()).toMatchObject({ open: true, view: 'console' });
    store.toggle(TAB);
    expect(tab().open).toBe(false);
    store.show(TAB, 'network');
    expect(tab()).toMatchObject({ open: true, view: 'network' });
    store.hide(TAB);
    expect(tab().open).toBe(false);
    store.remove(TAB);
    expect(useDevtoolsStore.getState().tabs[TAB]).toBeUndefined();
  });
});
