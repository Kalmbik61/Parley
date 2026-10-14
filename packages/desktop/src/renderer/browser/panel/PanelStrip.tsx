/**
 * Полоска страниц панели браузера (спека браузера 4.11), 36 px, как строка вкладки браузера под ней: заголовок хозяина
 * (ярлык сессии или название комнаты), вкладки страниц, «+» и ×. Узкий вид закрывает панель собой, поэтому вместо × слева
 * стоит «Back to chat» («Back to room»): она прячет панель и возвращает к виду хозяина. Названия — данные, длинные режутся
 * многоточием и целиком видны в подсказке; вкладки страниц прокручиваются вбок, если не влезают.
 */

import { ArrowLeft, Plus, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { WorkEntry } from '@parley/core';
import type { BrowserOwner, BrowserPanelSpec } from '../../../shared/layout-types.js';
import { S } from '../../../shared/strings.js';
import { PANEL_LIMITS } from '../../layout/tree.js';
import { cn } from '../../lib/cn.js';
import { sessionRowLabel, sessionTag } from '../../lib/participant.js';
import { useBrowserStore } from '../store.js';
import { activatePage, addBlankPage, closePage, closePanel } from './actions.js';

export interface PanelStripProps {
  workKey: string;
  owner: BrowserOwner;
  panel: BrowserPanelSpec;
  entry: WorkEntry;
  /** Вид хозяина уже 720 px: панель закрывает его собой. */
  narrow: boolean;
}

/** Хозяин в заголовке: `S01 backend` у сессии (как строка дерева), название у комнаты. */
export function ownerTitle(entry: WorkEntry, owner: BrowserOwner): string {
  if (owner.kind === 'room') return entry.map.rooms.find((room) => room.id === owner.roomId)?.title ?? owner.roomId;
  const session = entry.map.sessions.find((item) => item.id === owner.sessionId);
  return session === undefined ? sessionTag(owner.sessionId) : sessionRowLabel(session.id, session.label);
}

/** Название вкладки страницы: заголовок живой страницы, иначе адрес без схемы, иначе «New page». */
export function pageTitle(url: string, liveTitle: string | null): string {
  if (liveTitle !== null && liveTitle !== '') return liveTitle;
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return S.browser.panel.newPage;
  }
}

const ICON_BUTTON =
  'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40';

export function PanelStrip({ workKey, owner, panel, entry, narrow }: PanelStripProps): JSX.Element {
  // Заголовки живых страниц: поверхностное сравнение — строка перерисовывается на смену заголовка, а не на загрузку.
  const liveTitles = useBrowserStore(useShallow((state) => panel.pages.map((page) => state.tabs[page.id]?.title ?? null)));
  const title = ownerTitle(entry, owner);
  return (
    <div data-testid="browser-panel-strip" className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-card px-1.5">
      {narrow ? (
        <button
          type="button"
          data-testid="browser-panel-back"
          onClick={() => closePanel(workKey, owner)}
          className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          {owner.kind === 'room' ? S.browser.panel.backToRoom : S.browser.panel.backToChat}
        </button>
      ) : null}
      <span data-testid="browser-panel-owner" title={title} className="min-w-0 max-w-[40%] shrink truncate text-xs font-medium text-foreground">
        {title}
      </span>
      <div role="tablist" aria-label={S.browser.panel.pages} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {panel.pages.map((page, index) => {
          const name = pageTitle(page.url, liveTitles[index] ?? null);
          const active = page.id === panel.active;
          return (
            <div
              key={page.id}
              role="tab"
              aria-selected={active}
              data-page-id={page.id}
              title={page.url === '' ? name : `${name}\n${page.url}`}
              className={cn(
                'flex h-6 max-w-36 shrink-0 items-center rounded text-xs',
                active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/60',
              )}
            >
              <button type="button" onClick={() => activatePage(workKey, owner, page.id)} className="min-w-0 flex-1 truncate px-2 text-left">
                {name}
              </button>
              <button
                type="button"
                aria-label={S.browser.panel.closePage(name)}
                onClick={() => closePage(workKey, owner, page.id)}
                className="mr-0.5 flex size-4 shrink-0 items-center justify-center rounded hover:bg-foreground/10"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label={S.browser.panel.addPage}
        title={S.browser.panel.addPage}
        disabled={panel.pages.length >= PANEL_LIMITS.pages}
        onClick={() => addBlankPage(workKey, owner)}
        className={ICON_BUTTON}
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
      {narrow ? null : (
        <button type="button" aria-label={S.browser.panel.closePanel} title={S.browser.panel.closePanel} onClick={() => closePanel(workKey, owner)} className={ICON_BUTTON}>
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
