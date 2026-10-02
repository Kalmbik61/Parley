/**
 * Слой поверхностей одной работы (кусок 2.5, спека 5.5): `TerminalSurface` на
 * каждую вкладку `terminal` раскладки, чья сессия есть в карте работы, и
 * `BrowserSurface` на каждую вкладку `browser` (кусок 9.2a, спека 12.2). Слой
 * стоит в контейнере работы следом за `LayoutView` (`AppShell.tsx`) и своего
 * containing block не создаёт — ни `position`, ни `transform`, ни `contain`,
 * ни `filter`: containing block поверхностей — контейнер работы, а тела групп
 * — его потомки, иначе `anchor()` недействительны.
 *
 * Ключ React — id вкладки, поэтому перенос вкладки между группами ключ не
 * меняет. Порядок — по id вкладки, а не по дереву групп: иначе перенос
 * переставлял бы узлы DOM, а перенесённый узел xterm теряет прокрутку, узел
 * `<webview>` — страницу (гость перезагружается).
 *
 * У вкладки удалённой сессии поверхности нет: её `pty.attach` падает, и
 * пустой xterm закрыл бы `MissingBody` с «Закрыть» (спека 5.10).
 *
 * Вид «Chat» (план 2026-10-01, решение 6, решение контролёра Ж): у вкладки в эффективном виде `chat`
 * поверхности терминала нет — размонтирование и есть `pty.detach`, переход в терминал монтирует её
 * заново обычным `pty.attach` со снимком экрана. Вместо неё слой держит подписку на ленту сессии
 * (`FeedSubscription`) — на каждую открытую вкладку, а не только активную в группе. Когда хост знает
 * ленту, поверхность опускается под тулбар вкладки с сегментом (`TAB_TOOLBAR_PX`). Пока доступность
 * вида неизвестна (`effectiveView` — `null`: первый ответ `providers.list` не пришёл), у вкладки нет ни
 * поверхности, ни подписки: иначе она мигнула бы одним видом и перескочила в другой. Без явного выбора
 * вкладка сессии, что ещё не стартовала (нет `lastEventAt` активности), — терминал (решение М куска 4a); пока снимок
 * активности не пришёл (`loaded` ложно), вид тоже не выбран.
 */

import { useMemo } from 'react';
import { refKey, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { BrowserSurface } from '../browser/BrowserSurface.js';
import { TAB_TOOLBAR_PX } from '../chat/ChatToolbar.js';
import { FeedSubscription } from '../chat/use-feed.js';
import { effectiveView, useFeedAvailability, useHostHasFeed, useStartedKeys } from '../lib/feed-view.js';
import { workKey as workKeyOf } from '../lib/tree-order.js';
import { useWorksStore } from '../store/works.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { TerminalSurface } from '../terminal/TerminalSurface.js';
import { useLayoutStore } from './store.js';
import { groups } from './tree.js';

export interface SurfaceLayerProps {
  workKey: string;
  active: boolean;
  bridge: ParleyBridge;
  fontFamily: string;
  fontSize: number;
  /**
   * Отправка агенту окна (7.2) — карточке Design Mode (9.3b). Слой — сосед `LayoutView`, контекст тел
   * групп до него не доходит, поэтому пропом.
   */
  sendDeps: SendWithToastDeps;
}

type SurfaceSpec =
  | { kind: 'terminal'; tabId: string; sessionId: string; groupId: string; visible: boolean }
  | { kind: 'feed'; tabId: string; sessionId: string }
  | { kind: 'browser'; tabId: string; url: string; groupId: string; visible: boolean };

export function SurfaceLayer({ workKey, active, bridge, fontFamily, fontSize, sendDeps }: SurfaceLayerProps): JSX.Element {
  const layout = useLayoutStore((state) => state.layouts[workKey]);
  const entry = useWorksStore((state) =>
    state.entries.find((item) => workKeyOf(item.projectPath, item.map.work.id) === workKey),
  );
  const feedAvailable = useFeedAvailability();
  const started = useStartedKeys();
  const topInset = useHostHasFeed() ? TAB_TOOLBAR_PX : 0;

  // Один объект sessionRef на сессию, пока не сменились проект и работа: новый литерал на каждый
  // рендер слоя заставлял бы поверхность снимать и заново вешать слушатель paste (он зависит от ref).
  const projectPath = entry?.projectPath;
  const workId = entry?.map.work.id;
  const sessionRefs = useMemo(() => new Map<string, SessionRef>(), [projectPath, workId]);
  const sessionRefOf = (sessionId: string): SessionRef => {
    let ref = sessionRefs.get(sessionId);
    if (ref === undefined) {
      ref = { projectPath: projectPath ?? '', workId: workId ?? '', sessionId };
      sessionRefs.set(sessionId, ref);
    }
    return ref;
  };

  const surfaces: SurfaceSpec[] = [];
  if (layout !== undefined && entry !== undefined) {
    const providers = new Map(entry.map.sessions.map((session) => [session.id, session.provider]));
    for (const group of groups(layout)) {
      for (const tab of group.tabs) {
        const visible = active && group.activeTabId === tab.id;
        if (tab.kind === 'browser') {
          surfaces.push({ kind: 'browser', tabId: tab.id, url: tab.url, groupId: group.id, visible });
          continue;
        }
        if (tab.kind !== 'terminal') continue;
        const provider = providers.get(tab.sessionId);
        if (provider === undefined) continue;
        const view = effectiveView(tab, feedAvailable(provider), started(refKey(sessionRefOf(tab.sessionId))));
        if (view === null) continue;
        if (view === 'chat') {
          surfaces.push({ kind: 'feed', tabId: tab.id, sessionId: tab.sessionId });
          continue;
        }
        surfaces.push({ kind: 'terminal', tabId: tab.id, sessionId: tab.sessionId, groupId: group.id, visible });
      }
    }
    surfaces.sort((a, b) => (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0));
  }

  return (
    <div data-surface-layer={workKey}>
      {entry === undefined
        ? null
        : surfaces.map((surface) =>
            surface.kind === 'feed' ? (
              <FeedSubscription key={surface.tabId} sessionRef={sessionRefOf(surface.sessionId)} />
            ) : surface.kind === 'browser' ? (
              <BrowserSurface
                key={surface.tabId}
                workKey={workKey}
                tabId={surface.tabId}
                url={surface.url}
                groupId={surface.groupId}
                visible={surface.visible}
                bridge={bridge}
                entry={entry}
                sendDeps={sendDeps}
              />
            ) : (
              <TerminalSurface
                key={surface.tabId}
                bridge={bridge}
                sessionRef={sessionRefOf(surface.sessionId)}
                tabId={surface.tabId}
                groupId={surface.groupId}
                visible={surface.visible}
                fontFamily={fontFamily}
                fontSize={fontSize}
                topInset={topInset}
              />
            ),
          )}
    </div>
  );
}
