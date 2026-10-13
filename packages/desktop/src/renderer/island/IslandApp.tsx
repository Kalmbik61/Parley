/**
 * Проводка острова (спека 2026-10-12, раздел 6): статус хоста, сторы работ и активности, очередь запросов, настройки,
 * видимость и размер окна. Хост не подключён — очередь пуста (удержанные хуки хост снимает сам), сторы не
 * поднимаются. Новый запрос снимает «×», выбирается в карточке и звучит (`beep` у main, если включён Sound). Размер
 * содержимого уходит в main: окно острова прозрачное и ровно по содержимому, а корень не сжимается до текущей ширины
 * окна (`w-max`) — иначе окно, стартовавшее узким, никогда бы не выросло.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { refKey } from '@parley/protocol';
import type { IslandBridge, IslandConfig } from '../../shared/island.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { IslandView } from './IslandView.js';
import { islandModel, sessionLabels } from './model.js';
import { useIslandRequests } from './requests.js';

const INITIAL_CONFIG: IslandConfig = { sound: false, hintShown: true, topInset: 0 };

export function IslandApp({ bridge }: { bridge: IslandBridge }): JSX.Element {
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<IslandConfig>(INITIAL_CONFIG);
  const [hidden, setHidden] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const entries = useWorksStore((state) => state.entries);
  const byRef = useActivityStore((state) => state.byRef);
  const items = useIslandRequests((state) => state.items);
  const index = useIslandRequests((state) => state.index);

  useEffect(
    () =>
      bridge.onStatus((status) => {
        const ok = status.state === 'connected';
        setConnected(ok);
        if (!ok) useIslandRequests.getState().clear();
      }),
    [bridge],
  );
  useEffect(() => {
    if (!connected) return undefined;
    useIslandRequests.getState().bind(bridge.call);
    const disposers = [useWorksStore.getState().init(bridge), useActivityStore.getState().init(bridge)];
    return () => {
      useIslandRequests.getState().bind(null);
      for (const dispose of disposers) dispose();
    };
  }, [connected, bridge]);
  useEffect(() => {
    void bridge.island.config().then(setConfig, () => undefined);
    return bridge.island.onConfig(setConfig);
  }, [bridge]);
  useEffect(() => {
    if (connected) useIslandRequests.getState().sync(entries, byRef);
  }, [connected, entries, byRef]);

  const withCard = useMemo(() => new Set(items.map((item) => refKey(item.ref))), [items]);
  const model = useMemo(() => islandModel(entries, byRef, withCard), [entries, byRef, withCard]);
  const labels = useMemo(() => sessionLabels(entries), [entries]);

  const seen = useRef(new Set<string>());
  useEffect(() => {
    // Новые запросы встают в очередь по времени, а на экране мог остаться прежний — показываем первый из новых.
    let firstFresh = -1;
    items.forEach((item, at) => {
      if (seen.current.has(item.key)) return;
      seen.current.add(item.key);
      if (firstFresh === -1) firstFresh = at;
    });
    if (firstFresh === -1) return;
    useIslandRequests.getState().select(firstFresh);
    setHidden(false);
    if (config.sound) bridge.island.beep();
  }, [items, config.sound, bridge]);

  const visible = !hidden && (model.active || items.length > 0);
  // Номер показа растёт при каждом переходе «скрыт → виден» и считается прямо при отрисовке: карточка, оставшаяся на
  // экране с прошлого показа, не успевает мелькнуть с уже взведёнными кнопками.
  const [show, setShow] = useState({ visible: false, id: 0 });
  if (show.visible !== visible) setShow({ visible, id: visible ? show.id + 1 : show.id });
  useEffect(() => bridge.island.setVisible(visible), [visible, bridge]);

  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (element === null) return undefined;
    const report = (): void => bridge.island.setSize(Math.max(1, Math.ceil(element.offsetWidth)), Math.max(1, Math.ceil(element.offsetHeight)));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [bridge]);

  return (
    <div ref={rootRef} className="inline-block w-max" onMouseLeave={() => setListOpen(false)}>
      <IslandView
        model={model}
        items={items}
        index={index}
        config={config}
        listOpen={listOpen}
        showId={show.id}
        labels={labels}
        api={bridge.island}
        onToggleList={setListOpen}
        onHide={() => {
          setHidden(true);
          setListOpen(false);
        }}
        onSelect={(next) => useIslandRequests.getState().select(next)}
        onDecide={(key, decision) => void useIslandRequests.getState().decide(key, decision)}
        onHintDone={() => {
          bridge.island.hintShown();
          setConfig((current) => ({ ...current, hintShown: true }));
        }}
      />
    </div>
  );
}
