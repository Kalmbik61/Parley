/**
 * Открытие только что созданного — работы, сессии или комнаты — когда снимок работ (`works.changed`) его принёс.
 * Раньше это была `activateWhenListed` формы новой работы (кусок 3.5); с куска 7 плана «Organic» её же зовут
 * диалоги «New session or room» и «New room»: `works.create`, `sessions.create` и `rooms.create` отвечают раньше
 * снимка, и вкладка, открытая сразу, мигнула бы телом «Session deleted» или «Room not found». Ожидание живёт в
 * подписке на стор работ, а не в компоненте: диалог успевают закрыть.
 */

import { toast } from 'sonner';
import { S } from '../../shared/strings.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { openTab } from '../layout/tree.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { roomKey } from './room-view.js';
import { workKey } from './tree-order.js';

/** Что открыть: сама работа (без вкладки), терминал сессии или вкладку комнаты. */
export type OpenTarget = { kind: 'work' } | { kind: 'session'; sessionId: string } | { kind: 'room'; roomId: string };

/**
 * Сколько ждать созданное в снимке. Дольше — снимок, видимо, отстал (FSEvents под нагрузкой): поздняя активация
 * выдернула бы человека из работы, в которую он уже ушёл.
 */
const LISTED_TIMEOUT_MS = 10_000;

/**
 * Делает работу активной и открывает вкладку цели, когда снимок работ её принёс. Работа ещё не гидрирована —
 * `apply` сам ждёт `hydrate` в очереди (кусок 2.2). Комната при открытии разворачивается в сайдбаре (2.1, 2.6).
 * Не дождались за `LISTED_TIMEOUT_MS` — ожидание снимается, человеку тост; снятие лежит в `pending`, чтобы
 * размонтирование диалога не оставило подписку.
 */
export function openWhenListed(projectPath: string, workId: string, target: OpenTarget, pending: Set<() => void>): void {
  const key = workKey(projectPath, workId);
  const listed = (): boolean => {
    const entry = useWorksStore.getState().entries.find((item) => item.projectPath === projectPath && item.map.work.id === workId);
    if (entry === undefined) return false;
    switch (target.kind) {
      case 'work':
        return true;
      case 'session':
        return entry.map.sessions.some((session) => session.id === target.sessionId);
      case 'room':
        return entry.map.rooms.some((room) => room.id === target.roomId);
    }
  };
  const activate = (): void => {
    useLayoutStore.getState().setActiveWork(key);
    switch (target.kind) {
      case 'work':
        return;
      case 'session': {
        const { sessionId } = target;
        useLayoutStore.getState().apply(key, (layout) => openTab(layout, { kind: 'terminal', id: tabId.terminal(sessionId), sessionId }));
        return;
      }
      case 'room': {
        const { roomId } = target;
        useUiStore.getState().setRoomExpanded(roomKey(key, roomId), true);
        useLayoutStore.getState().apply(key, (layout) => openTab(layout, { kind: 'room', id: tabId.room(roomId), roomId }));
        return;
      }
    }
  };
  if (listed()) {
    activate();
    return;
  }
  const cancel = (): void => {
    unsubscribe();
    clearTimeout(timer);
    pending.delete(cancel);
  };
  const unsubscribe = useWorksStore.subscribe(() => {
    if (!listed()) return;
    cancel();
    activate();
  });
  const timer = setTimeout(() => {
    cancel();
    toast(S.dialogs.notListedYet[target.kind]);
  }, LISTED_TIMEOUT_MS);
  pending.add(cancel);
}
