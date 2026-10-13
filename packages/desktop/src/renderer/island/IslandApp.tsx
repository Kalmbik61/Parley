/**
 * Проводка острова (спека 2026-10-12, раздел 6): статус хоста, сторы работ и активности, очередь запросов, настройки,
 * видимость и интерактивность окна. Хост не подключён — очередь пуста (удержанные хуки хост снимает сам), сторы не
 * поднимаются. Новый запрос снимает «×», выбирается в карточке и звучит (`beep` у main, если включён Sound).
 *
 * Окно острова — фиксированный прозрачный кадр, сквозной для мыши. Корень заполняет кадр и выравнивает форму по
 * точке (`config.anchor`), а размер формы анимирует сам вид (`IslandView`). Окно ловит мышь, только пока курсор над
 * формой: вход — `setInteractive(true)`, уход — `setInteractive(false)` и закрытый список; во время перетаскивания
 * уход не в счёт (окно едет за курсором), а после него интерактивность снимается, если курсор уже не над формой.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { refKey } from '@parley/protocol';
import type { IslandBridge, IslandConfig } from '../../shared/island.js';
import type { IslandAnchor } from '../../shared/ui-types.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { IslandView } from './IslandView.js';
import { islandModel, sessionLabels } from './model.js';
import { useIslandRequests } from './requests.js';

const INITIAL_CONFIG: IslandConfig = { sound: false, hintShown: true, topInset: 0, anchor: 'center' };

/** Выравнивание формы в кадре окна: влево, по центру или вправо — по точке, у которой стоит остров. */
const ANCHOR_CLASS: Record<IslandAnchor, string> = { left: 'justify-start', center: 'justify-center', right: 'justify-end' };

export function IslandApp({ bridge }: { bridge: IslandBridge }): JSX.Element {
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<IslandConfig>(INITIAL_CONFIG);
  const [hidden, setHidden] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const entries = useWorksStore((state) => state.entries);
  const byRef = useActivityStore((state) => state.byRef);
  const items = useIslandRequests((state) => state.items);
  const index = useIslandRequests((state) => state.index);
  /** Ключи запросов, что остров уже показывал: показанный раз не поднимает окно и не звучит повторно. */
  const seen = useRef(new Set<string>());

  useEffect(
    () =>
      bridge.onStatus((status) => {
        const ok = status.state === 'connected';
        setConnected(ok);
        if (!ok) {
          useIslandRequests.getState().clear();
          // После переподключения всё ещё ждущая карточка — новая: возвращает окно, выбирается и звучит.
          seen.current.clear();
        }
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

  // Хост не подключён — окна нет: сторы остались от прошлого подключения, и счётчики пилюли были бы устаревшими.
  const visible = connected && !hidden && (model.active || items.length > 0);
  // Номер показа растёт при каждом переходе «скрыт → виден» и считается прямо при отрисовке: карточка, оставшаяся на
  // экране с прошлого показа, не успевает мелькнуть с уже взведёнными кнопками.
  const [show, setShow] = useState({ visible: false, id: 0 });
  if (show.visible !== visible) setShow({ visible, id: visible ? show.id + 1 : show.id });
  useEffect(() => bridge.island.setVisible(visible), [visible, bridge]);

  const shapeRef = useRef<HTMLDivElement>(null);
  /** Идёт перетаскивание за ручку: окно едет за курсором, и «курсор ушёл с формы» в этот момент ничего не значит. */
  const dragging = useRef(false);
  const leaveShape = (): void => {
    bridge.island.setInteractive(false);
    setListOpen(false);
  };

  return (
    <div className={`fixed inset-0 flex items-start ${ANCHOR_CLASS[config.anchor]}`}>
      <IslandView
        model={model}
        items={items}
        index={index}
        config={config}
        listOpen={listOpen}
        showId={show.id}
        labels={labels}
        api={bridge.island}
        shapeRef={shapeRef}
        onShapeEnter={() => bridge.island.setInteractive(true)}
        onShapeLeave={() => {
          if (!dragging.current) leaveShape();
        }}
        onDragStart={() => {
          dragging.current = true;
        }}
        onDragEnd={() => {
          dragging.current = false;
          // Уход с формы во время жеста пропущен: если курсор уже не над формой, окно снова сквозное.
          if (shapeRef.current?.matches(':hover') !== true) leaveShape();
        }}
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
