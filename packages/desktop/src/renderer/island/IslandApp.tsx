/**
 * Проводка острова (спека 2026-10-12, раздел 6): статус хоста, сторы работ и активности, очередь запросов, настройки,
 * видимость окна и область под мышь. Хост не подключён — очередь пуста (удержанные хуки хост снимает сам), сторы не
 * поднимаются. Новый запрос выдвигает убранный остров, выбирается в карточке и звучит (`beep` у main, если включён Sound).
 *
 * Окно острова — фиксированный прозрачный кадр, сквозной для мыши. Корень заполняет кадр и выравнивает форму по
 * точке (`config.anchor`), а размер формы анимирует сам вид (`IslandView`). Окно ловит мышь, только пока курсор над
 * областью острова, и решает это main, а не DOM (в сквозном окне `mouseleave` мог не прийти вовсе): renderer лишь
 * сообщает область (`setHitRect` — форма выдвинутого острова или язычок убранного, `null`, пока окно не показано) и
 * получает «над / не над» из `onHover`. Наведение открывает список, уход закрывает; во время перетаскивания main
 * сообщает «над» (окно едет за курсором).
 *
 * Остров не пропадает, а убирается (`retracted`): окно видно, пока хост подключён, а убранная форма уезжает вверх
 * за кадр, оставляя язычок (`IslandTab`). Убирают «×» и покой: нечего показывать, очередь пуста, курсор не над
 * формой и форму не тащат — через `IDLE_RETRACT_MS`, а если на острове есть строки Done (агент закончил ход, в Parley
 * его ещё не смотрели) — через `DONE_HOLD_MS`, чтобы их успели заметить. Выдвигают новый запрос, начало работы
 * агентов, новый конец хода и язычок (клик или потяжка вниз). «×» при уже идущей работе остров не возвращает:
 * выдвижение по работе — только при смене «есть работа» с нет на да.
 *
 * Done — новый конец хода (`turnEndedAt` не раньше момента подключения острова к хосту) выдвигает убранный остров и
 * заново заводит отсчёт удержания, без звука. Done, что остров застал уже готовым (ход кончился до подключения), в
 * список попадает и красит язычок, но остров не выдвигает. Clear прячет все видимые сейчас Done: ключи (`doneKey`)
 * лежат в памяти острова до перезапуска и при переподключении не сбрасываются; новый конец хода — новый ключ. Текст
 * ответа к строкам Done берёт `useIslandReplies` (разовые снимки ленты; стор привязан к мосту вместе с очередью).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { refKey } from '@parley/protocol';
import type { IslandBridge, IslandConfig, IslandHitRect } from '../../shared/island.js';
import type { IslandAnchor } from '../../shared/ui-types.js';
import { isoMs } from '../lib/iso-time.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { IslandTab } from './IslandTab.js';
import { IslandView } from './IslandView.js';
import { islandModel, sessionLabels, type IslandRow } from './model.js';
import { useIslandReplies } from './replies.js';
import { useIslandRequests } from './requests.js';

/** Через сколько покоя (ничего не идёт, очереди нет, курсор не над формой, форму не тащат) остров убирается сам. */
export const IDLE_RETRACT_MS = 4000;
/** То же, но пока на острове есть строки Done: их надо успеть заметить. */
export const DONE_HOLD_MS = 20000;

const INITIAL_CONFIG: IslandConfig = { sound: false, hintShown: true, topInset: 0, anchor: 'center' };

/** Выравнивание формы в кадре окна: влево, по центру или вправо — по точке, у которой стоит остров. */
const ANCHOR_CLASS: Record<IslandAnchor, string> = { left: 'justify-start', center: 'justify-center', right: 'justify-end' };

type DoneRow = Extract<IslandRow, { kind: 'session'; state: 'done' }>;

/** Равны ли области (`null` равен только `null`). */
const sameRect = (a: IslandHitRect | null, b: IslandHitRect | null): boolean =>
  a === null || b === null ? a === b : a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function IslandApp({ bridge }: { bridge: IslandBridge }): JSX.Element {
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<IslandConfig>(INITIAL_CONFIG);
  const [listOpen, setListOpen] = useState(false);
  /** Курсор над областью острова (от main) и идёт перетаскивание — условия покоя; их смена отменяет и заново заводит таймер уборки. */
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const entries = useWorksStore((state) => state.entries);
  const byRef = useActivityStore((state) => state.byRef);
  const items = useIslandRequests((state) => state.items);
  const index = useIslandRequests((state) => state.index);
  /** Ключи запросов, что остров уже показывал: показанный раз не поднимает окно и не звучит повторно. */
  const seen = useRef(new Set<string>());
  /** Скрытые Clear ключи Done: память острова до перезапуска, при переподключении не сбрасывается. */
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());
  /** Ключи Done, что остров уже видел, и момент (мс) последнего подключения к хосту: выдвигает только свежий конец хода. */
  const seenDone = useRef(new Set<string>());
  const connectedAt = useRef(0);
  /** Счётчик свежих Done: его смена заводит отсчёт удержания заново. */
  const [freshDone, setFreshDone] = useState(0);

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
    connectedAt.current = Date.now();
    useIslandRequests.getState().bind(bridge.call);
    useIslandReplies.getState().bind(bridge.call);
    const disposers = [useWorksStore.getState().init(bridge), useActivityStore.getState().init(bridge)];
    return () => {
      useIslandRequests.getState().bind(null);
      useIslandReplies.getState().bind(null);
      for (const dispose of disposers) dispose();
    };
  }, [connected, bridge]);
  useEffect(() => {
    void bridge.island.config().then(setConfig, () => undefined);
    return bridge.island.onConfig(setConfig);
  }, [bridge]);
  // Наведение решает main по настоящему курсору: над областью острова список открыт, вне её — закрыт.
  useEffect(
    () =>
      bridge.island.onHover((over) => {
        setHovered(over);
        setListOpen(over);
      }),
    [bridge],
  );
  useEffect(() => {
    if (connected) useIslandRequests.getState().sync(entries, byRef);
  }, [connected, entries, byRef]);

  const withCard = useMemo(() => new Set(items.map((item) => refKey(item.ref))), [items]);
  const model = useMemo(() => islandModel(entries, byRef, withCard, cleared), [entries, byRef, withCard, cleared]);
  const doneRows = useMemo(
    () => model.groups.flatMap((group) => group.rows).filter((row): row is DoneRow => row.kind === 'session' && row.state === 'done'),
    [model],
  );
  const labels = useMemo(() => sessionLabels(entries), [entries]);
  const idle = !model.active && items.length === 0;
  /** Убран ли остров: в покое при открытии — да, при работе или очереди — нет. */
  const [retracted, setRetracted] = useState(idle);
  // `hovered` здесь не трогаем: его ведёт только main, и локальный сброс разошёлся бы с ним, пока курсор над язычком.
  const retract = useCallback(() => {
    setRetracted(true);
    setListOpen(false);
  }, []);

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
    setRetracted(false);
    if (config.sound) bridge.island.beep();
  }, [items, config.sound, bridge]);
  // Агенты начали работу — остров выдвигается. Эффект идёт только при смене признака: «×» среди работы его не возвращает.
  useEffect(() => {
    if (model.active) setRetracted(false);
  }, [model.active]);
  // Строки Done: тексту ответа — снимок ленты на каждый ключ, ушедшим ключам — уборка; конец хода, случившийся после
  // подключения и ещё не виденный, выдвигает остров (без звука) и заводит удержание заново. `connected` в зависимостях:
  // после (пере)привязки к мосту снимки заказываются, не дожидаясь следующего изменения модели.
  useEffect(() => {
    const replies = useIslandReplies.getState();
    for (const row of doneRows) replies.fetch(row.ref, row.doneKey);
    replies.prune(new Set(doneRows.map((row) => row.doneKey)));
    if (!connected) return;
    let fresh = false;
    for (const row of doneRows) {
      if (seenDone.current.has(row.doneKey)) continue;
      seenDone.current.add(row.doneKey);
      const endedAt = row.turnEndedAt === null ? null : isoMs(row.turnEndedAt);
      if (endedAt !== null && endedAt >= connectedAt.current) fresh = true;
    }
    if (!fresh) return;
    setRetracted(false);
    setFreshDone((count) => count + 1);
  }, [connected, doneRows]);
  // Покой: любое изменение условий снимает таймер и, если покой остался, заводит его заново. Со строками Done покой
  // дольше; Clear (Done стало 0) возвращает короткий срок.
  const holdMs = model.done > 0 ? DONE_HOLD_MS : IDLE_RETRACT_MS;
  useEffect(() => {
    if (retracted || !idle || hovered || dragging) return undefined;
    const timer = setTimeout(retract, holdMs);
    return () => clearTimeout(timer);
  }, [retracted, idle, hovered, dragging, retract, holdMs, freshDone]);

  // Хост не подключён — окна нет: сторы остались от прошлого подключения, и счётчики пилюли были бы устаревшими.
  // Подключён — окно видно всегда: убранный остров лишь не рисуется (форма за кадром, на месте язычок).
  useEffect(() => bridge.island.setVisible(connected), [connected, bridge]);
  const shown = connected && !retracted;
  // Номер показа растёт при каждом переходе «убран → выдвинут» и считается прямо при отрисовке: карточка, оставшаяся
  // на экране с прошлого показа, не успевает мелькнуть с уже взведёнными кнопками.
  const [show, setShow] = useState({ visible: false, id: 0 });
  if (show.visible !== shown) setShow({ visible: shown, id: shown ? show.id + 1 : show.id });

  const shapeRef = useRef<HTMLDivElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  /** Последняя область, отправленная main: равную ей не шлём повторно (`undefined` — ещё ничего не слали). */
  const sentHitRect = useRef<IslandHitRect | null | undefined>(undefined);
  // Область под мышь: форма у выдвинутого острова, язычок у убранного, ничего — пока хост не подключён (окно спрятано).
  const reportHitRect = useCallback(() => {
    const target = !connected ? null : retracted ? tabRef.current : shapeRef.current;
    const box = target?.getBoundingClientRect();
    const next: IslandHitRect | null = box === undefined ? null : { x: box.x, y: box.y, width: box.width, height: box.height };
    const last = sentHitRect.current;
    if (last !== undefined && sameRect(last, next)) return;
    sentHitRect.current = next;
    bridge.island.setHitRect(next);
  }, [bridge, connected, retracted]);
  // Область меняется при монтировании, смене вида, размере формы или язычка и при смене места в кадре (точка, отступ под
  // чёлку); сдвиг убирающейся / выдвигающейся формы размера не меняет — его ловит `transitionend` на корне.
  useLayoutEffect(() => {
    reportHitRect();
    const observer = new ResizeObserver(reportHitRect);
    if (shapeRef.current !== null) observer.observe(shapeRef.current);
    if (tabRef.current !== null) observer.observe(tabRef.current);
    return () => observer.disconnect();
  }, [reportHitRect, config.anchor, config.topInset]);

  return (
    <div className={`fixed inset-0 flex items-start ${ANCHOR_CLASS[config.anchor]}`} onTransitionEnd={reportHitRect}>
      <IslandView
        model={model}
        items={items}
        index={index}
        config={config}
        listOpen={listOpen}
        retracted={retracted}
        showId={show.id}
        labels={labels}
        api={bridge.island}
        shapeRef={shapeRef}
        onDragStart={() => setDragging(true)}
        onDragEnd={() => setDragging(false)}
        onToggleList={setListOpen}
        onHide={retract}
        onClearDone={() => setCleared((current) => new Set([...current, ...doneRows.map((row) => row.doneKey)]))}
        onSelect={(next) => useIslandRequests.getState().select(next)}
        onDecide={(key, decision) => void useIslandRequests.getState().decide(key, decision)}
        onHintDone={() => {
          bridge.island.hintShown();
          setConfig((current) => ({ ...current, hintShown: true }));
        }}
      />
      {retracted ? (
        <IslandTab
          anchorClass={ANCHOR_CLASS[config.anchor]}
          topInset={config.topInset}
          done={model.done > 0}
          tabRef={tabRef}
          onExpand={() => setRetracted(false)}
        />
      ) : null}
    </div>
  );
}
