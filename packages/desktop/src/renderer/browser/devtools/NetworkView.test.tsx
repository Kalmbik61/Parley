import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NetworkEntry } from '../../../shared/browser-devtools.js';
import { networkEntry } from '../../test-utils/devtools-fixtures.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { NetworkView } from './NetworkView.js';
import { EMPTY_DEVTOOLS, useDevtoolsStore, type TabDevtools } from './store.js';

const TAB = 'browser:0000c1';
const PAGE = 'http://localhost:5173/';
let bridge: FakeBridge;

const ENTRIES: NetworkEntry[] = [
  networkEntry('doc', { kind: 'document', url: PAGE, mimeType: 'text/html' }),
  networkEntry('fail', { url: 'http://localhost:5173/api/fail?x=1', status: 500, statusText: 'Internal Server Error' }),
  networkEntry('cors', { url: 'http://127.0.0.1:9/data', status: null, failure: { reason: 'cors', text: 'MissingAllowOriginHeader' } }),
  networkEntry('cancel', { url: 'http://localhost:5173/abort', status: null, failure: { reason: 'canceled', text: 'net::ERR_ABORTED' } }),
  networkEntry('wait', { url: 'http://localhost:5173/slow', status: null, durationMs: null, encodedBytes: null }),
  networkEntry('img', { kind: 'image', url: 'http://localhost:5173/logo.png', fromCache: true }),
];

function seed(patch: Partial<TabDevtools> = {}): void {
  useDevtoolsStore.setState({ tabs: { [TAB]: { ...EMPTY_DEVTOOLS, network: ENTRIES, ...patch } } });
}

function rows(): string[] {
  return [...document.querySelectorAll('[data-network-row]')].map((row) => row.getAttribute('data-network-row') ?? '');
}

function row(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-network-row="${id}"]`);
  if (found === null) throw new Error(`нет строки ${id}`);
  return found;
}

function renderView(narrow = false): void {
  render(<NetworkView tabId={TAB} pageUrl={PAGE} webContentsId={7} bridge={bridge} narrow={narrow} />);
}

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

beforeEach(() => {
  // virtual-core мерит прокрутчик `offsetHeight` (в jsdom — 0, и список был бы пуст).
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('data-testid') === 'network-scroll' ? 600 : 0;
    },
  });
  bridge = createFakeBridge();
});

afterEach(() => {
  cleanup();
  useDevtoolsStore.setState({ tabs: {} });
  if (originalOffsetHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
});

describe('NetworkView (спека 4.4)', () => {
  it('строки по времени начала; Status: 500 и CORS красным, (canceled) и (pending) серым', () => {
    seed();
    renderView();
    expect(rows()).toEqual(['doc', 'fail', 'cors', 'cancel', 'wait', 'img']);
    const tone = (id: string): [string, string | null] => {
      const cell = row(id).querySelector('[data-tone]');
      return [cell?.textContent ?? '', cell?.getAttribute('data-tone') ?? null];
    };
    expect(tone('doc')).toEqual(['200', 'normal']);
    expect(tone('fail')).toEqual(['500', 'error']);
    expect(tone('cors')).toEqual(['CORS', 'error']);
    expect(tone('cancel')).toEqual(['(canceled)', 'muted']);
    expect(tone('wait')).toEqual(['(pending)', 'muted']);
    expect(row('fail').getAttribute('data-failed')).toBe('true');
  });

  it('Name — путь и query; хост — только у чужого origin; полный адрес — в подсказке; Size из кэша — (cache)', () => {
    seed();
    renderView();
    expect(row('fail').textContent).toContain('/api/fail?x=1');
    expect(row('fail').textContent).not.toContain('localhost:5173');
    expect(row('fail').getAttribute('title')).toBe('http://localhost:5173/api/fail?x=1');
    expect(row('cors').textContent).toContain('/data · 127.0.0.1:9');
    expect(row('img').textContent).toContain('(cache)');
  });

  it('фильтры Img, Failed only и URL — в стор вкладки', () => {
    seed();
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Img' }));
    expect(rows()).toEqual(['img']);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Failed only' }));
    expect(rows()).toEqual(['fail', 'cors']);
    fireEvent.click(screen.getByRole('button', { name: 'Failed only' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter URL' }), { target: { value: 'LOGO' } });
    expect(rows()).toEqual(['img']);
    expect(useDevtoolsStore.getState().tabs[TAB]?.urlText).toBe('LOGO');
  });

  it('выбор строки — детали рядом; на узкой панели — поверх списка; закрыть — выбор снят', () => {
    seed();
    renderView();
    fireEvent.click(row('fail'));
    expect(useDevtoolsStore.getState().tabs[TAB]?.selected).toBe('fail');
    expect(screen.getByTestId('request-details-pane').getAttribute('data-overlay')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(useDevtoolsStore.getState().tabs[TAB]?.selected).toBeNull();
    cleanup();
    seed({ selected: 'fail' });
    renderView(true);
    expect(screen.getByTestId('request-details-pane').getAttribute('data-overlay')).toBe('true');
  });

  it('рядом с деталями список сжат до Status и Name; без деталей колонки возвращаются', () => {
    seed({ selected: 'fail' });
    renderView();
    expect(screen.getByTestId('network-header').textContent).toBe('StatusName');
    expect(row('fail').textContent).toContain('/api/fail?x=1');
    expect(row('fail').textContent).not.toContain('GET');
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.getByTestId('network-header').textContent).toBe('StatusMethodNameTypeSizeTime');
    expect(row('fail').textContent).toContain('GET');
    cleanup();
    // Детали поверх списка (узкая панель): список под ними остаётся с полным набором колонок.
    seed({ selected: 'fail' });
    renderView(true);
    expect(screen.getByTestId('network-header').textContent).toBe('StatusMethodNameTypeSizeTime');
  });

  it('пусто — No requests', () => {
    seed({ network: [] });
    renderView();
    expect(screen.getByText('No requests')).toBeTruthy();
  });
});
