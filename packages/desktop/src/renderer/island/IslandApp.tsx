/**
 * Проводка острова (спека 2026-10-12, раздел 6): статус хоста, сторы работ и активности, очередь запросов, настройки,
 * видимость окна и область под мышь. Хост не подключён — очередь пуста (удержанные хуки хост снимает сам), сторы не
 * поднимаются. Новый запрос выдвигает убранный остров, выбирается в карточке и звучит (`beep` у main, если включён Sound).
 *
 * Окно острова — фиксированный прозрачный кадр, сквозной для мыши. Корень заполняет кадр и выравнивает форму по
 * точке (`config.anchor`), а размер формы анимирует сам вид (`IslandView`). Окно ловит мышь, только пока курсор над
 * областью острова, и решает это main, а не DOM (в сквозном окне `mouseleave` мог не прийти вовсе): renderer лишь
 * сообщает область (`setHitRect` — форма выдвинутого острова или зона нажатия убранного, `null`, пока окно не показано) и
 * получает «над / не над» из `onHover`. Наведение открывает список, уход закрывает; во время перетаскивания main
 * сообщает «над» (окно едет за курсором).
 *
 * Остров не пропадает, а убирается (`retracted`): окно видно, пока хост подключён, а убранная форма сжимается в брусок
 * (или в `✅ N`, если есть непросмотренные Done) на месте, как Dynamic Island; поверх неё лежит прозрачная зона
 * нажатия, язычок (`IslandTab`). Убирают стрелка ⌃ внизу формы (видна под курсором), смахивание вверх и
 * покой: нечего показывать, очередь пуста, курсор не над формой и форму не тащат — через `IDLE_RETRACT_MS`, а если на
 * острове есть строки Done (агент закончил ход, в Parley его ещё не смотрели) — через `DONE_HOLD_MS`, чтобы их успели
 * заметить. Выдвигают новый запрос, начало работы агентов, новый конец хода и язычок (клик или потяжка вниз). Стрелка и
 * смахивание при уже идущей работе остров не возвращают: выдвижение по работе — только при смене «есть работа» с нет
 * на да.
 *
 * Done — новый конец хода (`turnEndedAt` не раньше момента подключения острова к хосту) выдвигает убранный остров и
 * заново заводит отсчёт удержания, без звука. Done, что остров застал уже готовым (ход кончился до подключения), в
 * список попадает и даёт `✅ N` убранному острову, но остров не выдвигает. Clear прячет все видимые сейчас Done: ключи (`doneKey`)
 * лежат в памяти острова до перезапуска и при переподключении не сбрасываются; новый конец хода — новый ключ. Clear
 * заодно отмечает эти сессии просмотренными в Parley (`island.markSeen` → `activity.seen` в хост): гаснет «непросмотрено» в
 * боковой панели. Локальный `cleared` остаётся: строки уходят сразу, не дожидаясь ответа хоста. Удержанные просмотренные
 * строки (`seen`) хосту не шлются. Текст ответа к строкам Done берёт `useIslandReplies` (разовые снимки ленты; стор
 * привязан к мосту вместе с очередью).
 *
 * Показанная Done-строка держится до конца показа. Пока остров выдвинут, ключи его непросмотренных строк Done (`seen`
 * ложно) копятся в `held`, и когда окно Parley отметит сессию просмотренной (`unseen` → `idle`, `turnEndedAt` прежний),
 * модель строку не убирает. Показ кончается, когда курсор ушёл с острова (`onHover(false)`) или остров убрался
 * (`retracted`): `held` очищается, и строки уже просмотренных сессий уходят; всё ещё `unseen` остаются, как обычно. При
 * уборке очистка идёт не сразу, а через `RETRACT_MORPH_MS` — пока форма сжимается в брусок; выдвинули раньше срока —
 * очистка в тот же миг. Done, что убранный остров застал готовыми, не показывался — их не держим. Убранный остров
 * показывает число непросмотренных Done (`seen` ложно) в форме `✅ N`: просмотренные удержанные не считаются.
 *
 * Помощник (спека 2026-10-14, раздел 8): стор `useAssistantStore` привязан к мосту при подключении хоста. Режим открывает
 * событие main (`onAssistantOpen`) или точка в пилюле; пока он открыт или идёт ход, окно видно даже при выключенном
 * острове, а остров в покое не убирается. Esc, стрелка ⌃, смахивание и потеря фокуса панели (`onKeyboardBlur`) выходят
 * через `hideAssistant`: идущий ход сворачивается в мини-вид, иначе режим закрывается и клавиатура уходит обратно.
 * Ответ сам не закрывается: человек читает его сколько нужно и закрывает одним из этих способов.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { refKey, type AssistantProposal } from '@parley/protocol';
import { markSeenBatches, type IslandBridge, type IslandConfig, type IslandHitRect } from '../../shared/island.js';
import type { IslandAnchor } from '../../shared/ui-types.js';
import { isoMs } from '../lib/iso-time.js';
import { useActivityStore } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { browserRecorderDeps } from '../voice/browser-recorder.js';
import { startRecording } from '../voice/recorder.js';
import { listen } from './assistant/listen.js';
import { miniLabel } from './assistant/labels.js';
import { assistantBusy, useAssistantStore } from './assistant/store.js';
import { useConsentsStore } from './consents/store.js';
import { IslandTab } from './IslandTab.js';
import { IslandView, sessionKeyOf, type IslandAssistantProps } from './IslandView.js';
import { islandModel, sessionLabels, type IslandRow } from './model.js';
import { useIslandReplies } from './replies.js';
import { useIslandRequests } from './requests.js';

/** Через сколько покоя (ничего не идёт, очереди нет, курсор не над формой, форму не тащат) остров убирается сам. */
export const IDLE_RETRACT_MS = 4000;
/** То же, но пока на острове есть строки Done: их надо успеть заметить. */
export const DONE_HOLD_MS = 20000;
/** Сколько форма сжимается в брусок: та же длительность, что `duration-[250ms]` перехода формы в `IslandView`. */
export const RETRACT_MORPH_MS = 250;

const INITIAL_CONFIG: IslandConfig = {
  islandEnabled: true,
  assistant: { enabled: false, provider: null, model: null, language: 'en', hotkey: 'Alt+Space', voice: { enabled: false, model: null } },
  sound: false,
  topInset: 0,
  anchor: 'center',
};

/** Выравнивание формы в кадре окна: влево, по центру или вправо — по точке, у которой стоит остров. */
const ANCHOR_CLASS: Record<IslandAnchor, string> = { left: 'justify-start', center: 'justify-center', right: 'justify-end' };

type DoneRow = Extract<IslandRow, { kind: 'session'; state: 'done' }>;

/** Очистка удержанных ключей: пустое множество остаётся тем же объектом, лишнего рендера нет. */
const releaseHeld = (current: Set<string>): Set<string> => (current.size === 0 ? current : new Set());

/** Равны ли области (`null` равен только `null`). */
const sameRect = (a: IslandHitRect | null, b: IslandHitRect | null): boolean =>
  a === null || b === null ? a === b : a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Строка «needs you» в виде помощника. Когда карточка помощника сама решает запрос первой ждущей сессии (`decision`
 * на неё) и это единственный запрос, строка прячется: тот же запрос не показывают дважды. Если запросов несколько,
 * строка остаётся: она говорит и о других.
 */
function pendingFor(name: string | null, total: number, proposal: AssistantProposal | null): { name: string; total: number } | null {
  if (name === null) return null;
  if (total === 1 && proposal?.action === 'decision' && proposal.target === name) return null;
  return { name, total };
}

/**
 * Общий выход из режима помощника: идущий ход сворачивается в мини-вид, иначе режим закрывается. `true` — режим был
 * открыт и выход выполнен (остров убирать не надо). Читает стор напрямую, поэтому годится и в подписке на событие main.
 */
function hideAssistant(): boolean {
  const s = useAssistantStore.getState();
  if (!s.open) return false;
  if (assistantBusy(s)) s.collapse();
  else s.close();
  return true;
}

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
  const selectedKey = useIslandRequests((state) => state.selectedKey);
  const index = Math.max(0, items.findIndex((item) => item.key === selectedKey));
  const consents = useConsentsStore((state) => state.items);
  const consentDeciding = useConsentsStore((state) => state.deciding);
  const consentNote = useConsentsStore((state) => state.note);
  const shapeRef = useRef<HTMLDivElement>(null);
  /** Один owner для всей панели; ref даёт актуальное значение синхронным callbacks стора. */
  const ownerRef = useRef<'assistant' | 'request' | null>(null);
  const [keyboardOwner, setKeyboardOwner] = useState<'assistant' | 'request' | null>(null);
  const setOwner = useCallback((next: 'assistant' | 'request' | null): void => {
    const previous = ownerRef.current;
    if (previous === next) return;
    ownerRef.current = next;
    setKeyboardOwner(next);
    if (previous === null || next === null) bridge.island.keyboard(next !== null);
  }, [bridge]);
  const releaseKeyboard = useCallback((): void => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && shapeRef.current?.contains(active)) active.blur();
    setOwner(null);
  }, [setOwner]);
  useEffect(() => () => releaseKeyboard(), [releaseKeyboard]);
  /** Ключи запросов, что остров уже показывал: показанный раз не поднимает окно и не звучит повторно. */
  const seen = useRef(new Set<string>());
  /** Скрытые Clear ключи Done: память острова до перезапуска, при переподключении не сбрасывается. */
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());
  /** Ключи Done, что остров уже показал и держит до конца показа, даже когда сессия стала `idle`; модель от них зависит. */
  const [held, setHeld] = useState<Set<string>>(() => new Set());
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
          releaseKeyboard();
          useIslandRequests.getState().clear();
          useConsentsStore.getState().replace([]);
          // После переподключения всё ещё ждущая карточка — новая: возвращает окно, выбирается и звучит.
          seen.current.clear();
        }
      }),
    [bridge, releaseKeyboard],
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
        const store = useAssistantStore.getState();
        if (over && store.open && store.collapsed) store.expand(true);
        if (!over && store.byHover) store.collapse();
        // Курсор ушёл — показ кончился: просмотренные сессии больше не держат свои строки Done.
        if (!over) setHeld(releaseHeld);
      }),
    [bridge],
  );
  useEffect(() => {
    if (connected) useIslandRequests.getState().sync(entries, byRef);
  }, [connected, entries, byRef]);

  const withCard = useMemo(() => new Set(items.filter((item) => item.inWindow).map((item) => refKey(item.ref))), [items]);
  const model = useMemo(() => islandModel(entries, byRef, withCard, cleared, held), [entries, byRef, withCard, cleared, held]);
  const doneRows = useMemo(
    () => model.groups.flatMap((group) => group.rows).filter((row): row is DoneRow => row.kind === 'session' && row.state === 'done'),
    [model],
  );
  /** Непросмотренные Done: их число показывает убранный остров (`✅ N`). */
  const unseenDone = doneRows.filter((row) => !row.seen).length;
  const labels = useMemo(() => sessionLabels(entries), [entries]);
  const configRef = useRef(config);
  configRef.current = config;
  const assistant = useAssistantStore();
  const busy = assistantBusy(assistant);

  useEffect(() => {
    if (!connected) return;
    useAssistantStore.getState().configure({
      call: bridge.call,
      keyboard: (on) => {
        if (on) setOwner('assistant');
        else if (ownerRef.current === 'assistant') releaseKeyboard();
      },
      ownsKeyboard: () => ownerRef.current === 'assistant',
      config: () => configRef.current.assistant,
      listen: (hooks) => {
        const settings = configRef.current.assistant;
        if (!settings.voice.enabled || settings.voice.model === null) return null;
        return listen({
          record: (onLevel) => startRecording(onLevel, browserRecorderDeps()),
          transcribe: (request) => bridge.island.voice.transcribe(request),
          micStatus: () => bridge.island.voice.micStatus(),
          requestMic: () => bridge.island.voice.requestMic(),
          now: Date.now,
          model: settings.voice.model,
          language: settings.language,
          ...hooks,
        });
      },
    });
    void bridge.call('assistant.state', {}).then((state) => useAssistantStore.getState().applyHost(state)).catch(() => {});
    const off = bridge.on('assistant.changed', (state) => useAssistantStore.getState().applyHost(state));
    const offOpen = bridge.island.onAssistantOpen((request) => useAssistantStore.getState().openMode(request));
    const offBlur = bridge.island.onKeyboardBlur(() => {
      if (ownerRef.current === 'assistant') hideAssistant();
      releaseKeyboard();
    });
    return () => {
      off();
      offOpen();
      offBlur();
    };
  }, [connected, bridge, setOwner, releaseKeyboard]);

  // Карточки согласия: начальный список и изменения хоста (как у помощника). Подписка раньше списка: событие, пришедшее
  // следом за запросом, не потеряется; карточки хоста переживают его перезапуск, и после переподключения список снова новый.
  useEffect(() => {
    if (!connected) return undefined;
    useConsentsStore.getState().configure({ call: bridge.call });
    const off = bridge.on('consents.changed', (change) => useConsentsStore.getState().apply(change));
    void bridge.call('consents.list', {}).then((result) => useConsentsStore.getState().replace(result.items)).catch(() => {});
    return off;
  }, [connected, bridge]);

  const idle = !model.active && items.length === 0 && consents.length === 0 && !assistant.open && !busy;
  /** Убран ли остров: в покое при открытии — да, при работе или очереди — нет. */
  const [retracted, setRetracted] = useState(idle);
  // `hovered` здесь не трогаем: его ведёт только main, и локальный сброс разошёлся бы с ним, пока курсор над зоной нажатия.
  const retract = useCallback(() => {
    releaseKeyboard();
    setRetracted(true);
    setListOpen(false);
  }, [releaseKeyboard]);

  // Удержание строк Done: пока остров выдвинут, непросмотренные строки, что он показывает, копятся в `held` (удержанные
  // уже там, а после очистки вернулись бы, пока ещё видны в том же кадре). Новых ключей нет — состояние то же, иначе
  // модель, зависящая от `held`, перерисовывалась бы по кругу.
  useEffect(() => {
    if (retracted) return;
    const keys = doneRows.filter((row) => !row.seen).map((row) => row.doneKey);
    setHeld((current) => (keys.every((key) => current.has(key)) ? current : new Set([...current, ...keys])));
  }, [retracted, doneRows]);
  // Остров убрался — очистка `held` после того, как форма сжалась в брусок. Выдвинули раньше срока — показ всё равно
  // кончился, очищаем в тот же миг.
  useEffect(() => {
    if (!retracted) return undefined;
    const timer = setTimeout(() => setHeld(releaseHeld), RETRACT_MORPH_MS);
    return () => {
      clearTimeout(timer);
      setHeld(releaseHeld);
    };
  }, [retracted]);
  useEffect(() => {
    // Новые запросы встают в очередь по времени, а на экране мог остаться прежний — показываем первый из новых.
    let firstFresh = -1;
    items.forEach((item, at) => {
      if (seen.current.has(item.key)) return;
      seen.current.add(item.key);
      if (firstFresh === -1) firstFresh = at;
    });
    // Новая карточка согласия (id `c-NN` не пересекается с ключами запросов) выдвигает остров и звучит так же.
    let freshConsent = false;
    for (const card of consents) {
      if (seen.current.has(card.id)) continue;
      seen.current.add(card.id);
      freshConsent = true;
    }
    if (firstFresh === -1 && !freshConsent) return;
    // Новый pending не уводит выбор, пока человек работает клавиатурой внутри острова.
    if (firstFresh !== -1 && !shapeRef.current?.contains(document.activeElement)) useIslandRequests.getState().select(firstFresh);
    setRetracted(false);
    if (config.sound) bridge.island.beep();
  }, [items, consents, config.sound, bridge]);
  // Агенты начали работу — остров выдвигается. Эффект идёт только при смене признака: стрелка среди работы его не возвращает.
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
  // Подключён — окно видно всегда: убранный остров лишь сжимается в брусок (или в `✅ N`) под прозрачной зоной нажатия.
  useEffect(
    () => bridge.island.setVisible(connected && (config.islandEnabled || assistant.open || busy)),
    [connected, bridge, config.islandEnabled, assistant.open, busy],
  );
  // Режим помощника открыт при убранном острове — форма выдвигается, иначе вида не видно.
  useEffect(() => {
    if (assistant.open) setRetracted(false);
  }, [assistant.open]);
  useEffect(() => {
    if (!assistant.open && keyboardOwner === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return;
      if (ownerRef.current === 'request') {
        event.preventDefault();
        releaseKeyboard();
      } else if (assistant.open) useAssistantStore.getState().close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assistant.open, keyboardOwner, releaseKeyboard]);
  const shown = connected && !retracted;
  const requestVisible = shown && config.islandEnabled && !(assistant.open && !assistant.collapsed) && consents.length === 0;
  const requestAvailable = shown && config.islandEnabled && !(assistant.open && !assistant.collapsed) && (consents.length > 0 || selectedKey !== null);
  useEffect(() => {
    if ((keyboardOwner === 'request' && !requestAvailable) ||
      (keyboardOwner === 'assistant' && (!connected || !config.assistant.enabled || !assistant.open || assistant.collapsed))) releaseKeyboard();
  }, [keyboardOwner, requestAvailable, connected, config.assistant.enabled, assistant.open, assistant.collapsed, releaseKeyboard]);
  const takeRequestKeyboard = (): void => {
    if (!requestAvailable || ownerRef.current === 'request') return;
    setOwner('request');
    if (requestVisible) useIslandRequests.getState().revalidate();
  };
  useEffect(() => {
    if (!requestVisible || selectedKey === null) return undefined;
    const refresh = (): void => useIslandRequests.getState().revalidate();
    refresh();
    const timer = setInterval(refresh, 1000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [requestVisible, selectedKey, bridge]);
  // Номер показа растёт при каждом переходе «убран → выдвинут» и считается прямо при отрисовке: карточка, оставшаяся
  // на экране с прошлого показа, не успевает мелькнуть с уже взведёнными кнопками.
  const [show, setShow] = useState({ visible: false, id: 0 });
  if (show.visible !== shown) setShow({ visible: shown, id: shown ? show.id + 1 : show.id });

  const tabRef = useRef<HTMLButtonElement>(null);
  /** Последняя область, отправленная main: равную ей не шлём повторно (`undefined` — ещё ничего не слали). */
  const sentHitRect = useRef<IslandHitRect | null | undefined>(undefined);
  // Область под мышь: форма у выдвинутого острова, зона нажатия у убранного, ничего — пока хост не подключён (окно спрятано).
  const reportHitRect = useCallback(() => {
    const target = !connected ? null : retracted ? tabRef.current : shapeRef.current;
    const box = target?.getBoundingClientRect();
    const next: IslandHitRect | null = box === undefined ? null : { x: box.x, y: box.y, width: box.width, height: box.height };
    const last = sentHitRect.current;
    if (last !== undefined && sameRect(last, next)) return;
    sentHitRect.current = next;
    bridge.island.setHitRect(next);
  }, [bridge, connected, retracted]);
  // Область меняется при монтировании, смене вида, размере формы или зоны нажатия и при смене места в кадре (точка,
  // отступ под чёлку); переход, что размера формы не меняет (отступ сверху у бруска), ловит `transitionend` на корне.
  useLayoutEffect(() => {
    reportHitRect();
    const observer = new ResizeObserver(reportHitRect);
    if (shapeRef.current !== null) observer.observe(shapeRef.current);
    if (tabRef.current !== null) observer.observe(tabRef.current);
    return () => observer.disconnect();
  }, [reportHitRect, config.anchor, config.topInset]);

  // Clear: строки уходят с острова сразу, а ещё не просмотренные сессии отмечаются просмотренными в хосте.
  const clearDone = (): void => {
    setCleared((current) => new Set([...current, ...doneRows.map((row) => row.doneKey)]));
    const unseenRefs = doneRows.filter((row) => !row.seen).map((row) => row.ref);
    for (const batch of markSeenBatches(unseenRefs)) bridge.island.markSeen(batch);
  };

  const assistantProps: IslandAssistantProps | null = !config.assistant.enabled
    ? null
    : {
        open: assistant.open,
        collapsed: assistant.collapsed,
        busy,
        mini: miniLabel(assistant.host, assistant.input, assistant.sending !== null),
        onOpen: () => useAssistantStore.getState().openMode({ listen: false }),
        view: {
          host: assistant.host,
          input: assistant.input,
          level: assistant.level,
          listenStartedAt: assistant.listenStartedAt,
          draft: assistant.draft,
          notice: assistant.notice,
          cardError: assistant.cardError,
          sending: assistant.sending?.text ?? null,
          queue: assistant.queue,
          history: assistant.history,
          deciding: assistant.deciding,
          hotkey: config.assistant.hotkey,
          pending: pendingFor(items.length === 0 ? null : (labels.get(sessionKeyOf(items[0]!))?.session ?? ''), items.length, assistant.host.proposal),
          onDraft: (text) => useAssistantStore.getState().setDraft(text),
          onSubmit: (text) => void useAssistantStore.getState().submit(text),
          onMic: () => useAssistantStore.getState().toggleListening(),
          onDecide: (decision) => void useAssistantStore.getState().decide(decision),
          onTakeKeyboard: () => useAssistantStore.getState().takeKeyboard(),
          onUnqueue: (id) => useAssistantStore.getState().unqueue(id),
          onShowRequests: () => useAssistantStore.getState().close(),
        },
      };

  return (
    <div className={`fixed inset-0 flex items-start ${ANCHOR_CLASS[config.anchor]}`} onTransitionEnd={reportHitRect}>
      <IslandView
        model={model}
        items={items}
        index={index}
        config={config}
        listOpen={listOpen}
        retracted={retracted}
        doneCount={unseenDone}
        hovered={hovered}
        showId={show.id}
        labels={labels}
        api={bridge.island}
        requestKeyboard={keyboardOwner === 'request'}
        onTakeRequestKeyboard={takeRequestKeyboard}
        shapeRef={shapeRef}
        onDragStart={() => setDragging(true)}
        onDragEnd={() => setDragging(false)}
        onToggleList={setListOpen}
        onHide={() => {
          if (hideAssistant()) return;
          retract();
        }}
        onClearDone={clearDone}
        onSelect={(next) => useIslandRequests.getState().select(next)}
        onDecide={(key, decision) => void useIslandRequests.getState().decide(key, decision)}
        assistant={assistantProps}
        consent={
          consents[0] === undefined
            ? null
            : { card: consents[0], deciding: consentDeciding === consents[0].id, note: consentNote, onDecide: (id, decision) => void useConsentsStore.getState().decide(id, decision) }
        }
      />
      {retracted ? (
        <IslandTab
          anchorClass={ANCHOR_CLASS[config.anchor]}
          topInset={config.topInset}
          doneCount={unseenDone}
          tabRef={tabRef}
          onExpand={() => setRetracted(false)}
        />
      ) : null}
    </div>
  );
}
