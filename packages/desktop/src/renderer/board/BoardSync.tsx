import { useEffect, useRef } from 'react';
import { useHostStore } from '../store/host.js';
import { useWorksStore } from '../store/works.js';
import { hostMethods } from '../lib/capabilities.js';
import { boardProjectPaths } from './board-model.js';
import { dropSlot, ensureSlot, loadSlot, setSlotLive, useBoardStore } from './board-store.js';
import type { BoardBridge } from './board-store.js';

/** Методы хоста, без которых доска не работает. */
const REQUIRED = [
  'backlog.get', 'backlog.subscribe', 'backlog.unsubscribe', 'backlog.add', 'backlog.update', 'backlog.remove',
  'backlog.prepareTake', 'backlog.take', 'backlog.move', 'backlog.transfer', 'backlog.inbox',
  'backlog.suggestions.accept', 'backlog.suggestions.dismiss', 'backlog.preferences.set', 'backlog.file.set', 'rooms.send',
];

/**
 * Держит подписки на бэклоги всех проектов сайдбара и на «Входящие». Смонтирован всегда: счётчик Review
 * нужен и при закрытой вкладке. Старый хост без нужных методов — ни одного вызова.
 */
export function BoardSync({ bridge }: { bridge: BoardBridge }): null {
  const status = useHostStore(s => s.status);
  const connections = useHostStore(s => s.connections);
  const entries = useWorksStore(s => s.entries);
  const inboxPath = useBoardStore(s => s.inboxPath);
  const methods = hostMethods(status);
  const supported = REQUIRED.every(method => methods.has(method));
  // Карта работ меняется часто, набор проектов — редко: сравниваем по значению.
  const pathsKey = boardProjectPaths(entries).join('\n');
  const subscribed = useRef(new Set<string>());
  const lastConnection = useRef(connections);
  const inboxAsked = useRef(false);

  useEffect(() => {
    useBoardStore.setState({ supported });
  }, [supported]);

  useEffect(() => {
    if (!supported) {
      // Слоты уходят без вызовов хоста: у такого хоста нужных методов может не быть.
      for (const path of subscribed.current) dropSlot(path);
      subscribed.current.clear(); inboxAsked.current = false;
      return;
    }
    const wanted = new Set(pathsKey === '' ? [] : pathsKey.split('\n'));
    if (inboxPath !== null) wanted.add(inboxPath);
    if (lastConnection.current !== connections) {
      lastConnection.current = connections;
      subscribed.current.clear(); inboxAsked.current = false;
      // Прежние подписки ушли вместе со связью: `live` вернётся с новыми ответами. Проекты, пропавшие за время
      // разрыва, уходят из стора; отписывать их не нужно. Идём по слотам стора: в `subscribed` их уже нет.
      for (const path of [...useBoardStore.getState().slots.keys()]) {
        if (wanted.has(path)) setSlotLive(path, false); else dropSlot(path);
      }
    }
    if (!inboxAsked.current) {
      inboxAsked.current = true;
      void bridge.call('backlog.inbox', {}).then(
        result => useBoardStore.setState({ inboxPath: result.projectPath }),
        () => {},
      );
    }
    for (const path of [...subscribed.current]) {
      if (wanted.has(path)) continue;
      subscribed.current.delete(path);
      dropSlot(path);
      void bridge.call('backlog.unsubscribe', { projectPath: path }).catch(() => {});
    }
    for (const path of wanted) {
      if (subscribed.current.has(path)) continue;
      subscribed.current.add(path);
      ensureSlot(path);
      void loadSlot(bridge, path, true);
    }
  }, [bridge, pathsKey, supported, connections, inboxPath]);

  useEffect(() => {
    if (!supported) return;
    return bridge.on('backlog.changed', event => {
      if (!subscribed.current.has(event.projectPath)) return;
      if (event.unavailable) { setSlotLive(event.projectPath, false); return; }
      void loadSlot(bridge, event.projectPath, false);
    });
  }, [bridge, supported]);

  useEffect(() => () => {
    for (const path of subscribed.current) {
      dropSlot(path);
      void bridge.call('backlog.unsubscribe', { projectPath: path }).catch(() => {});
    }
    subscribed.current.clear();
  }, [bridge]);

  return null;
}
