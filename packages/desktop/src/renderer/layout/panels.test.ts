/**
 * Панели браузера хозяев — чистые операции над раскладкой (этап B2, спека браузера 3.10). Разбор с диска и перенос
 * `panels` через `pruneLayout` — в `tree.test.ts`; действия окна над стором — в `browser/panel/actions.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { BrowserOwner, WorkLayout } from '../../shared/layout-types.js';
import {
  activatePanelPage,
  addPanelPage,
  closePanelPage,
  ownerOfPage,
  panelOf,
  prunePanels,
  setPanelOpen,
  setPanelPaused,
  setPanelWidth,
  updatePanelPage,
} from './panels.js';
import { ownerKey } from './ids.js';
import { emptyLayout, PANEL_LIMITS } from './tree.js';

/** Одна пустая раскладка на файл: `emptyLayout()` каждый раз берёт новый случайный id группы. */
const EMPTY = emptyLayout();
const CHAT: BrowserOwner = { kind: 'session', sessionId: 's-01' };
const ROOM: BrowserOwner = { kind: 'room', roomId: 'r-01' };

function page(n: number, url = `http://localhost:${3000 + n}/`): { id: string; url: string } {
  return { id: `bp-00000${n}`, url };
}

/** Раскладка с панелью `owner` из страниц 1…`count`; активна последняя. */
function withPages(count: number, owner: BrowserOwner = CHAT): WorkLayout {
  let layout = EMPTY;
  for (let n = 1; n <= count; n += 1) {
    const result = addPanelPage(layout, owner, page(n));
    expect(result.error).toBeNull();
    layout = result.layout;
  }
  return layout;
}

describe('addPanelPage', () => {
  it('первая страница создаёт панель: открыта, ширина по умолчанию, страница активна', () => {
    const { layout, error } = addPanelPage(EMPTY, CHAT, page(1));
    expect(error).toBeNull();
    expect(layout.panels).toEqual({ 'session:s-01': { open: true, width: PANEL_LIMITS.defaultWidth, pages: [page(1)], active: 'bp-000001' } });
  });

  it('следующая встаёт в конец, становится активной и открывает закрытую панель; ширина и страницы прежние', () => {
    const closed = setPanelOpen(withPages(1), CHAT, false);
    const widened = setPanelWidth(closed, CHAT, 600);
    const { layout } = addPanelPage(widened, CHAT, page(2));
    expect(panelOf(layout, CHAT)).toEqual({ open: true, width: 600, pages: [page(1), page(2)], active: 'bp-000002' });
  });

  it('панель комнаты и панель сессии — разные записи', () => {
    const layout = addPanelPage(withPages(1), ROOM, page(7)).layout;
    expect(Object.keys(layout.panels ?? {})).toEqual(['session:s-01', 'room:r-01']);
    expect(panelOf(layout, ROOM)?.pages).toEqual([page(7)]);
  });

  it('шестая страница — too-many-pages, раскладка та же ссылка', () => {
    const full = withPages(PANEL_LIMITS.pages);
    const result = addPanelPage(full, CHAT, page(9));
    expect(result.error).toBe('too-many-pages');
    expect(result.layout).toBe(full);
  });

  it('входную раскладку не меняет', () => {
    const before = withPages(2);
    const snapshot = JSON.stringify(before);
    addPanelPage(before, CHAT, page(3));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('setPanelPaused', () => {
  it('ставит паузу и снимает: поле удаляется, а не пишется false; остальное цело', () => {
    const layout = withPages(2);
    const paused = setPanelPaused(layout, CHAT, true);
    expect(panelOf(paused, CHAT)).toEqual({ ...panelOf(layout, CHAT), paused: true });
    const resumed = setPanelPaused(paused, CHAT, false);
    expect(panelOf(resumed, CHAT)).toEqual(panelOf(layout, CHAT));
    expect('paused' in (panelOf(resumed, CHAT) ?? {})).toBe(false);
  });

  it('Resume сохраняет неизвестное поле панели', () => {
    const layout = withPages(2);
    const panel = panelOf(layout, CHAT)!;
    const future: WorkLayout = { ...layout, panels: { [ownerKey(CHAT)]: { ...panel, paused: true, futureField: 7 } as typeof panel } };
    const resumed = setPanelPaused(future, CHAT, false);
    expect(panelOf(resumed, CHAT)).toEqual({ ...panel, futureField: 7 });
    expect('paused' in (panelOf(resumed, CHAT) ?? {})).toBe(false);
  });

  it('то же состояние и несуществующая панель — та же ссылка', () => {
    const layout = withPages(1);
    expect(setPanelPaused(layout, CHAT, false)).toBe(layout);
    expect(setPanelPaused(layout, ROOM, true)).toBe(layout);
  });
});

describe('setPanelOpen', () => {
  it('прячет и показывает; страницы и активная остаются', () => {
    const layout = withPages(2);
    const closed = setPanelOpen(layout, CHAT, false);
    expect(panelOf(closed, CHAT)).toMatchObject({ open: false, pages: [page(1), page(2)], active: 'bp-000002' });
    expect(panelOf(setPanelOpen(closed, CHAT, true), CHAT)?.open).toBe(true);
  });

  it('то же состояние и несуществующая панель — та же ссылка', () => {
    const layout = withPages(1);
    expect(setPanelOpen(layout, CHAT, true)).toBe(layout);
    expect(setPanelOpen(layout, ROOM, true)).toBe(layout);
    expect(setPanelOpen(EMPTY, CHAT, false)).toBe(EMPTY);
  });
});

describe('closePanelPage', () => {
  it('закрыта активная — активной становится сосед справа, иначе слева', () => {
    const layout = withPages(3);
    const middle = activatePanelPage(layout, CHAT, 'bp-000002');
    expect(panelOf(closePanelPage(middle, CHAT, 'bp-000002'), CHAT)?.active).toBe('bp-000003');
    expect(panelOf(closePanelPage(layout, CHAT, 'bp-000003'), CHAT)?.active).toBe('bp-000002');
  });

  it('закрыта неактивная — активная прежняя', () => {
    const closed = closePanelPage(withPages(3), CHAT, 'bp-000001');
    expect(panelOf(closed, CHAT)).toMatchObject({ active: 'bp-000003', pages: [page(2), page(3)] });
  });

  it('последняя страница уносит панель; поле panels уходит с последней панелью', () => {
    const both = addPanelPage(withPages(1), ROOM, page(8)).layout;
    const noChat = closePanelPage(both, CHAT, 'bp-000001');
    expect(Object.keys(noChat.panels ?? {})).toEqual(['room:r-01']);
    const none = closePanelPage(noChat, ROOM, 'bp-000008');
    expect(none).toEqual(EMPTY);
    expect('panels' in none).toBe(false);
  });

  it('openedBy остаётся у страниц, которые не закрывали, и у страницы после смены адреса', () => {
    const agent = { ...page(1), openedBy: 'agent' as const };
    const layout = addPanelPage(addPanelPage(EMPTY, CHAT, agent).layout, CHAT, page(2)).layout;
    expect(panelOf(closePanelPage(layout, CHAT, 'bp-000002'), CHAT)?.pages).toEqual([agent]);
    expect(panelOf(updatePanelPage(layout, CHAT, 'bp-000001', { url: 'http://localhost:3999/' }), CHAT)?.pages[0]).toEqual({ ...agent, url: 'http://localhost:3999/' });
  });

  it('нет такой страницы или панели — та же ссылка', () => {
    const layout = withPages(1);
    expect(closePanelPage(layout, CHAT, 'bp-nope')).toBe(layout);
    expect(closePanelPage(layout, ROOM, 'bp-000001')).toBe(layout);
  });
});

describe('activatePanelPage', () => {
  it('делает страницу активной; уже активная и чужая — та же ссылка', () => {
    const layout = withPages(2);
    expect(panelOf(activatePanelPage(layout, CHAT, 'bp-000001'), CHAT)?.active).toBe('bp-000001');
    expect(activatePanelPage(layout, CHAT, 'bp-000002')).toBe(layout);
    expect(activatePanelPage(layout, CHAT, 'bp-nope')).toBe(layout);
  });
});

describe('updatePanelPage', () => {
  it('адрес и размер ложатся на свою страницу, другие не меняются; размер null — Fit, поля нет', () => {
    const layout = withPages(2);
    const sized = updatePanelPage(layout, CHAT, 'bp-000001', { url: 'http://localhost:5173/a', viewport: { preset: 'tablet', rotated: false, dpr: 1 } });
    expect(panelOf(sized, CHAT)?.pages).toEqual([
      { id: 'bp-000001', url: 'http://localhost:5173/a', viewport: { preset: 'tablet', rotated: false, dpr: 1 } },
      page(2),
    ]);
    const fit = updatePanelPage(sized, CHAT, 'bp-000001', { viewport: null });
    expect(panelOf(fit, CHAT)?.pages[0]).toEqual({ id: 'bp-000001', url: 'http://localhost:5173/a' });
    expect('viewport' in (panelOf(fit, CHAT)?.pages[0] ?? {})).toBe(false);
  });

  it('тот же адрес, нет страницы или панели — та же ссылка', () => {
    const layout = withPages(1);
    expect(updatePanelPage(layout, CHAT, 'bp-000001', { url: page(1).url })).toBe(layout);
    expect(updatePanelPage(layout, CHAT, 'bp-000001', {})).toBe(layout);
    expect(updatePanelPage(layout, CHAT, 'bp-nope', { url: 'http://x/' })).toBe(layout);
    expect(updatePanelPage(layout, ROOM, 'bp-000001', { url: 'http://x/' })).toBe(layout);
  });
});

describe('setPanelWidth', () => {
  it('ширина округляется и не меньше 320; нечисло и та же ширина — та же ссылка', () => {
    const layout = withPages(1);
    expect(panelOf(setPanelWidth(layout, CHAT, 612.4), CHAT)?.width).toBe(612);
    expect(panelOf(setPanelWidth(layout, CHAT, 100), CHAT)?.width).toBe(PANEL_LIMITS.minWidth);
    expect(setPanelWidth(layout, CHAT, Number.NaN)).toBe(layout);
    expect(setPanelWidth(layout, CHAT, PANEL_LIMITS.defaultWidth)).toBe(layout);
    expect(setPanelWidth(layout, ROOM, 600)).toBe(layout);
  });
});

describe('prunePanels', () => {
  it('панель исчезнувшего хозяина уходит вместе со страницами, прочие остаются', () => {
    const layout = addPanelPage(withPages(2), ROOM, page(8)).layout;
    const pruned = prunePanels(layout, (owner) => owner.kind === 'room');
    expect(Object.keys(pruned.panels ?? {})).toEqual(['room:r-01']);
  });

  it('все живы — та же ссылка; панелей нет — та же ссылка; ушли все — поля panels нет', () => {
    const layout = withPages(1);
    expect(prunePanels(layout, () => true)).toBe(layout);
    expect(prunePanels(EMPTY, () => false)).toBe(EMPTY);
    expect('panels' in prunePanels(layout, () => false)).toBe(false);
  });

  it('чужой ключ в памяти (не session: и не room:) считается мёртвым', () => {
    const layout: WorkLayout = { ...EMPTY, panels: { 'x:1': { open: true, width: 480, pages: [page(1)], active: 'bp-000001' } } };
    expect(prunePanels(layout, () => true).panels).toBeUndefined();
  });
});

describe('ownerOfPage', () => {
  it('хозяин панели, в которой стоит страница; такой страницы нет — null', () => {
    const layout = addPanelPage(withPages(2), ROOM, page(8)).layout;
    expect(ownerOfPage(layout, 'bp-000002')).toEqual(CHAT);
    expect(ownerOfPage(layout, 'bp-000008')).toEqual(ROOM);
    expect(ownerOfPage(layout, 'bp-nope')).toBeNull();
    expect(ownerOfPage(EMPTY, 'bp-000001')).toBeNull();
  });
});
