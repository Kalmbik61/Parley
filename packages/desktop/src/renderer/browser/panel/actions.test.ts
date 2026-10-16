/**
 * Действия окна над панелями браузера хозяев (этап B2, часть 1): кнопка «Browser», страницы панели, ширина, `openPageInPanel`
 * для человека и для агента, «Move to browser of…». Идут через настоящий стор раскладки, как в окне.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { BrowserOwner, WorkLayout } from '../../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../../layout/history.js';
import { panelOf } from '../../layout/panels.js';
import { useLayoutStore } from '../../layout/store.js';
import { emptyLayout, findTab, groups, openTab, PANEL_LIMITS } from '../../layout/tree.js';
import { wantsAddressFocus } from '../store.js';
import {
  activatePage,
  addBlankPage,
  closePage,
  closePanel,
  moveTabToPanel,
  openAgentPage,
  openPageInPanel,
  resizePanel,
  togglePanel,
} from './actions.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const KEY = '/tmp/p w';
const CHAT: BrowserOwner = { kind: 'session', sessionId: 's-01' };
const ROOM: BrowserOwner = { kind: 'room', roomId: 'r-01' };

function setLayout(layout: WorkLayout | null): void {
  useLayoutStore.setState({
    activeWorkKey: KEY,
    layouts: layout === null ? {} : { [KEY]: layout },
    hydrated: layout === null ? {} : { [KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
}

/** Раскладка: терминал s-01 (активный) и вкладка браузера `browser:aaaaaa` с адресом и размером. */
function baseLayout(): WorkLayout {
  let layout = openTab(emptyLayout(), { kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01' }, 'active');
  layout = openTab(layout, { kind: 'browser', id: 'browser:aaaaaa', url: 'http://localhost:5173/app', viewport: { preset: 'mobile-m', rotated: false, dpr: 2 } }, 'active');
  return openTab(layout, { kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01' }, 'active');
}

const layoutNow = (): WorkLayout => useLayoutStore.getState().layouts[KEY] as WorkLayout;
const panelNow = (owner: BrowserOwner = CHAT): ReturnType<typeof panelOf> => panelOf(layoutNow(), owner);

beforeEach(() => {
  vi.mocked(toast).mockClear();
  setLayout(baseLayout());
});

afterEach(() => setLayout(null));

describe('togglePanel — кнопка «Browser»', () => {
  it('первое нажатие создаёт открытую панель с одной пустой страницей; адресная строка просит фокус', () => {
    togglePanel(KEY, CHAT);
    const panel = panelNow();
    expect(panel).toMatchObject({ open: true, width: PANEL_LIMITS.defaultWidth, pages: [{ url: '' }] });
    const pageId = panel?.pages[0]?.id as string;
    expect(panel?.active).toBe(pageId);
    expect(wantsAddressFocus(pageId)).toBe(true);
  });

  it('следующие нажатия прячут и показывают ту же панель, страниц не прибавляется', () => {
    togglePanel(KEY, CHAT);
    const pageId = panelNow()?.pages[0]?.id;
    togglePanel(KEY, CHAT);
    expect(panelNow()).toMatchObject({ open: false, pages: [{ id: pageId }] });
    togglePanel(KEY, CHAT);
    expect(panelNow()).toMatchObject({ open: true, pages: [{ id: pageId }] });
  });

  it('панели сессии и комнаты независимы', () => {
    togglePanel(KEY, CHAT);
    togglePanel(KEY, ROOM);
    expect(Object.keys(layoutNow().panels ?? {})).toEqual(['session:s-01', 'room:r-01']);
  });

  it('вкладки, активная группа и историю переходов не трогает', () => {
    const before = layoutNow();
    togglePanel(KEY, CHAT);
    const after = layoutNow();
    expect(after.root).toBe(before.root);
    expect(after.activeGroupId).toBe(before.activeGroupId);
  });
});

describe('страницы и ширина панели', () => {
  it('«+» — пустая страница, активная, адресная строка просит фокус; шестой нет — тост предела', () => {
    togglePanel(KEY, CHAT);
    for (let i = 1; i < PANEL_LIMITS.pages; i += 1) addBlankPage(KEY, CHAT);
    expect(panelNow()?.pages).toHaveLength(PANEL_LIMITS.pages);
    const last = panelNow()?.pages.at(-1)?.id as string;
    expect(panelNow()?.active).toBe(last);
    expect(wantsAddressFocus(last)).toBe(true);
    expect(toast).not.toHaveBeenCalled();
    addBlankPage(KEY, CHAT);
    expect(panelNow()?.pages).toHaveLength(PANEL_LIMITS.pages);
    expect(toast).toHaveBeenCalledWith('No more than 5 pages in a browser panel');
  });

  it('activatePage, closePage и closePanel', () => {
    togglePanel(KEY, CHAT);
    addBlankPage(KEY, CHAT);
    const [first, second] = panelNow()?.pages.map((page) => page.id) as [string, string];
    activatePage(KEY, CHAT, first);
    expect(panelNow()?.active).toBe(first);
    closePage(KEY, CHAT, first);
    expect(panelNow()).toMatchObject({ pages: [{ id: second }], active: second });
    closePanel(KEY, CHAT);
    expect(panelNow()?.open).toBe(false);
    closePage(KEY, CHAT, second);
    expect(panelNow()).toBeUndefined();
  });

  it('resizePanel — ширина в раскладку, не меньше 320', () => {
    togglePanel(KEY, CHAT);
    resizePanel(KEY, CHAT, 555);
    expect(panelNow()?.width).toBe(555);
    resizePanel(KEY, CHAT, 10);
    expect(panelNow()?.width).toBe(PANEL_LIMITS.minWidth);
  });

  it('работа ещё не гидрирована — операция ждёт очереди и применяется на гидрации', () => {
    useLayoutStore.setState({ layouts: {}, hydrated: {}, pending: {} });
    togglePanel(KEY, CHAT);
    expect(useLayoutStore.getState().pending[KEY]).toHaveLength(1);
    useLayoutStore.getState().hydrate(KEY, baseLayout());
    expect(panelNow()?.open).toBe(true);
  });
});

describe('openPageInPanel — страница человека и агента', () => {
  it('закрытая панель открывается, страница активна; focus: false адресную строку не просит и вкладки не трогает', () => {
    togglePanel(KEY, CHAT);
    closePanel(KEY, CHAT);
    const before = layoutNow();
    const result = openPageInPanel(KEY, CHAT, 'http://localhost:5173/docs', { focus: false });
    expect(result).toMatchObject({ ok: true, opened: true });
    const panel = panelNow();
    expect(panel?.open).toBe(true);
    expect(panel?.pages.at(-1)).toEqual({ id: (result as { pageId: string }).pageId, url: 'http://localhost:5173/docs' });
    expect(panel?.active).toBe((result as { pageId: string }).pageId);
    expect(wantsAddressFocus((result as { pageId: string }).pageId)).toBe(false);
    expect(layoutNow().root).toBe(before.root);
    expect(layoutNow().activeGroupId).toBe(before.activeGroupId);
  });

  it('панели не было — создаётся; уже открытая — opened: false', () => {
    expect(openPageInPanel(KEY, ROOM, 'http://localhost:3000/', { focus: false })).toMatchObject({ ok: true, opened: true });
    expect(panelNow(ROOM)).toMatchObject({ open: true, pages: [{ url: 'http://localhost:3000/' }] });
    expect(openPageInPanel(KEY, ROOM, 'http://localhost:3001/', { focus: false })).toMatchObject({ ok: true, opened: false });
    expect(panelNow(ROOM)?.pages).toHaveLength(2);
  });

  it('focus: true и пустой адрес — адресная строка новой страницы просит фокус', () => {
    const result = openPageInPanel(KEY, CHAT, '', { focus: true });
    expect(result.ok).toBe(true);
    expect(wantsAddressFocus((result as { pageId: string }).pageId)).toBe(true);
    const other = openPageInPanel(KEY, CHAT, 'http://localhost:3000/', { focus: true });
    expect(wantsAddressFocus((other as { pageId: string }).pageId)).toBe(false);
  });

  it('адрес идёт в раскладку как у вкладки: пароль из ссылки убирается, не http(s) — bad-url', () => {
    const ok = openPageInPanel(KEY, CHAT, 'http://user:secret@localhost:5173/app', { focus: false });
    expect(panelNow()?.pages.find((page) => page.id === (ok as { pageId: string }).pageId)?.url).toBe('http://localhost:5173/app');
    for (const bad of ['javascript:alert(1)', 'file:///etc/hosts', 'localhost:5173', 'not a url']) {
      expect(openPageInPanel(KEY, CHAT, bad, { focus: false }), bad).toEqual({ ok: false, reason: 'bad-url' });
    }
    expect(panelNow()?.pages).toHaveLength(1);
  });

  it('в панели пять страниц — limit, раскладка и тост предела; раскладки работы нет — no-work', () => {
    for (let i = 0; i < PANEL_LIMITS.pages; i += 1) openPageInPanel(KEY, CHAT, `http://localhost:${3000 + i}/`, { focus: false });
    const before = layoutNow();
    expect(openPageInPanel(KEY, CHAT, 'http://localhost:4000/', { focus: false })).toEqual({ ok: false, reason: 'limit' });
    expect(layoutNow()).toBe(before);
    expect(toast).toHaveBeenCalledWith('No more than 5 pages in a browser panel');
    expect(openPageInPanel('/tmp/other w', CHAT, 'http://localhost:3000/', { focus: false })).toEqual({ ok: false, reason: 'no-work' });
  });
});

describe('moveTabToPanel — «Move to browser of…»', () => {
  it('адрес и размер переезжают в новую активную страницу панели, вкладка закрыта и в стек ⌘⇧T не попала', () => {
    expect(moveTabToPanel(KEY, 'browser:aaaaaa', CHAT)).toBeNull();
    const panel = panelNow();
    expect(panel?.open).toBe(true);
    expect(panel?.pages).toEqual([
      { id: panel?.active, url: 'http://localhost:5173/app', viewport: { preset: 'mobile-m', rotated: false, dpr: 2 } },
    ]);
    expect(findTab(layoutNow(), 'browser:aaaaaa')).toBeNull();
    expect(layoutNow().closedTabs.map((tab) => tab.id)).not.toContain('browser:aaaaaa');
    expect(groups(layoutNow())[0]?.tabs.map((tab) => tab.id)).toEqual(['terminal:s-01']);
  });

  it('в панели пять страниц — вкладка остаётся на месте, тост предела', () => {
    for (let i = 0; i < PANEL_LIMITS.pages; i += 1) openPageInPanel(KEY, ROOM, `http://localhost:${3000 + i}/`, { focus: false });
    const before = layoutNow();
    expect(moveTabToPanel(KEY, 'browser:aaaaaa', ROOM)).toBe('too-many-pages');
    expect(layoutNow()).toBe(before);
    expect(toast).toHaveBeenCalledWith('No more than 5 pages in a browser panel');
  });

  it('вкладка не браузера или её нет — ничего не меняется', () => {
    const before = layoutNow();
    expect(moveTabToPanel(KEY, 'terminal:s-01', CHAT)).toBe('not-found');
    expect(moveTabToPanel(KEY, 'browser:nope', CHAT)).toBe('not-found');
    expect(layoutNow()).toBe(before);
  });
});

describe('openAgentPage — browser_open агента, повтор страницы (спека браузера 5.1, 5.2)', () => {
  it('адрес без #фрагмента уже открыт — новая не открывается, найденная активна, закрытая панель открыта', () => {
    const first = openAgentPage(KEY, CHAT, 'http://localhost:5173/app');
    expect(first).toMatchObject({ ok: true, opened: true, reused: false });
    openPageInPanel(KEY, CHAT, 'http://localhost:3000/', { focus: false });
    closePanel(KEY, CHAT);
    const before = layoutNow();
    const again = openAgentPage(KEY, CHAT, 'http://localhost:5173/app#section');
    expect(again).toEqual({ ok: true, pageId: (first as { pageId: string }).pageId, opened: true, reused: true });
    expect(panelNow()).toMatchObject({ open: true, active: (first as { pageId: string }).pageId });
    expect(panelNow()?.pages).toHaveLength(2);
    expect(layoutNow().root).toBe(before.root);
    expect(layoutNow().activeGroupId).toBe(before.activeGroupId);
  });

  it('другой путь или запрос — новая страница; повтор ищется только в панели этого хозяина', () => {
    openAgentPage(KEY, CHAT, 'http://localhost:5173/app');
    expect(openAgentPage(KEY, CHAT, 'http://localhost:5173/app?x=1')).toMatchObject({ ok: true, reused: false });
    expect(openAgentPage(KEY, ROOM, 'http://localhost:5173/app')).toMatchObject({ ok: true, reused: false });
    expect(panelNow()?.pages).toHaveLength(2);
  });

  it('повтор работает и на полной панели, а шестая новая страница — limit', () => {
    for (let i = 0; i < PANEL_LIMITS.pages; i += 1) openAgentPage(KEY, CHAT, `http://localhost:${3000 + i}/`);
    expect(openAgentPage(KEY, CHAT, 'http://localhost:3002/')).toMatchObject({ ok: true, reused: true });
    expect(openAgentPage(KEY, CHAT, 'http://localhost:4000/')).toEqual({ ok: false, reason: 'limit' });
  });

  it('работа не прочитана — no-work; не http(s) — bad-url', () => {
    expect(openAgentPage('/tmp/other', CHAT, 'http://localhost:5173/')).toEqual({ ok: false, reason: 'no-work' });
    expect(openAgentPage(KEY, CHAT, 'file:///etc/hosts')).toEqual({ ok: false, reason: 'bad-url' });
  });
});
