/**
 * Полоска страниц панели браузера (спека браузера 4.11; этап B2, часть 1): хозяин, вкладки страниц, «+» и ×; в узком виде —
 * «Back to chat» («Back to room») вместо ×. Действия идут в настоящий стор раскладки.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserOwner, BrowserPanelSpec, WorkLayout } from '../../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../../layout/history.js';
import { addPanelPage, panelOf } from '../../layout/panels.js';
import { useLayoutStore } from '../../layout/store.js';
import { emptyLayout, PANEL_LIMITS } from '../../layout/tree.js';
import { makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { useBrowserStore } from '../store.js';
import { ownerTitle, pageTitle, PanelStrip } from './PanelStrip.js';

const KEY = '/tmp/proj w-01';
const LONG = 'x'.repeat(60);
const WORK = makeWork('w-01', {
  projectPath: '/tmp/proj',
  sessions: [makeSession('s-01', `backend ${LONG}`), makeSession('s-02', '')],
  rooms: [makeRoom('r-01', `review ${LONG}`)],
});
const CHAT: BrowserOwner = { kind: 'session', sessionId: 's-01' };
const ROOM: BrowserOwner = { kind: 'room', roomId: 'r-01' };

function setLayout(layout: WorkLayout): void {
  useLayoutStore.setState({ activeWorkKey: KEY, layouts: { [KEY]: layout }, hydrated: { [KEY]: true }, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
}

/** Раскладка с панелью `owner` из страниц `urls`; активна последняя. */
function withPages(owner: BrowserOwner, urls: string[]): BrowserPanelSpec {
  let layout = emptyLayout();
  urls.forEach((url, i) => {
    layout = addPanelPage(layout, owner, { id: `bp-00000${i + 1}`, url }).layout;
  });
  setLayout(layout);
  return panelOf(layout, owner) as BrowserPanelSpec;
}

const panelNow = (owner: BrowserOwner): BrowserPanelSpec | undefined => panelOf(useLayoutStore.getState().layouts[KEY] as WorkLayout, owner);

function renderStrip(owner: BrowserOwner, panel: BrowserPanelSpec, narrow = false): void {
  render(<PanelStrip workKey={KEY} owner={owner} panel={panel} entry={WORK} narrow={narrow} />);
}

beforeEach(() => useBrowserStore.setState({ tabs: {} }));

afterEach(() => {
  cleanup();
  useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
});

describe('ownerTitle и pageTitle', () => {
  it('сессия — ярлык строки дерева (S01 ярлык), без ярлыка — S02; комната — название; пропавшие — id', () => {
    expect(ownerTitle(WORK, CHAT)).toBe(`S01 backend ${LONG}`);
    expect(ownerTitle(WORK, { kind: 'session', sessionId: 's-02' })).toBe('S02');
    expect(ownerTitle(WORK, ROOM)).toBe(`review ${LONG}`);
    expect(ownerTitle(WORK, { kind: 'session', sessionId: 's-99' })).toBe('S99');
    expect(ownerTitle(WORK, { kind: 'room', roomId: 'r-99' })).toBe('r-99');
  });

  it('страница: заголовок живой страницы, иначе адрес без схемы и без корневого «/», иначе «New page»', () => {
    expect(pageTitle('http://localhost:5173/', 'Dev server')).toBe('Dev server');
    expect(pageTitle('http://localhost:5173/', null)).toBe('localhost:5173');
    expect(pageTitle('http://localhost:5173/docs/a?x=1', '')).toBe('localhost:5173/docs/a');
    expect(pageTitle('', null)).toBe('New page');
    expect(pageTitle('мусор', null)).toBe('New page');
  });
});

describe('PanelStrip', () => {
  it('хозяин назван ярлыком; длинное имя режется многоточием и целиком в подсказке', () => {
    renderStrip(CHAT, withPages(CHAT, ['http://localhost:3000/']));
    const owner = screen.getByTestId('browser-panel-owner');
    expect(owner.textContent).toBe(`S01 backend ${LONG}`);
    expect(owner.getAttribute('title')).toBe(`S01 backend ${LONG}`);
    expect(owner.className).toContain('truncate');
  });

  it('вкладки страниц: имя из заголовка или адреса, активная помечена, клик активирует страницу', () => {
    const panel = withPages(CHAT, ['http://localhost:3000/', 'http://localhost:3001/docs', '']);
    act(() => useBrowserStore.getState().update('bp-000001', { title: 'Dev server' }));
    renderStrip(CHAT, panel);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Dev server', 'localhost:3001/docs', 'New page']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
    fireEvent.click(within(tabs[0] as HTMLElement).getByText('Dev server'));
    expect(panelNow(CHAT)?.active).toBe('bp-000001');
  });

  it('× вкладки закрывает страницу; последняя уносит панель', () => {
    const panel = withPages(CHAT, ['http://localhost:3000/', 'http://localhost:3001/']);
    renderStrip(CHAT, panel);
    fireEvent.click(screen.getByRole('button', { name: 'Close localhost:3001' }));
    expect(panelNow(CHAT)?.pages.map((page) => page.id)).toEqual(['bp-000001']);
    fireEvent.click(screen.getByRole('button', { name: 'Close localhost:3000' }));
    expect(panelNow(CHAT)).toBeUndefined();
  });

  it('«+» добавляет пустую страницу; на пятой страницы кнопка неактивна', () => {
    const panel = withPages(CHAT, ['http://localhost:3000/']);
    renderStrip(CHAT, panel);
    fireEvent.click(screen.getByRole('button', { name: 'Add a page' }));
    expect(panelNow(CHAT)?.pages).toHaveLength(2);
    cleanup();
    const full = withPages(CHAT, Array.from({ length: PANEL_LIMITS.pages }, (_, i) => `http://localhost:${3000 + i}/`));
    renderStrip(CHAT, full);
    expect((screen.getByRole('button', { name: 'Add a page' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('широкий вид: × панели прячет её, «Back» нет', () => {
    renderStrip(CHAT, withPages(CHAT, ['http://localhost:3000/']));
    expect(screen.queryByTestId('browser-panel-back')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close the browser panel' }));
    expect(panelNow(CHAT)).toMatchObject({ open: false, pages: [{ id: 'bp-000001' }] });
  });

  it('узкий вид: у сессии «Back to chat», у комнаты «Back to room»; кнопка прячет панель, × панели нет', () => {
    renderStrip(CHAT, withPages(CHAT, ['http://localhost:3000/']), true);
    expect(screen.queryByRole('button', { name: 'Close the browser panel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(panelNow(CHAT)?.open).toBe(false);
    cleanup();
    renderStrip(ROOM, withPages(ROOM, ['http://localhost:3000/']), true);
    expect(screen.getByTestId('browser-panel-back').textContent).toBe('Back to room');
    expect(screen.getByTestId('browser-panel-owner').textContent).toBe(`review ${LONG}`);
  });
});
