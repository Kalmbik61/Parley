/**
 * Проводка острова (спека 2026-10-12, раздел 6): статус хоста, сторы работ и активности, очередь запросов, настройки,
 * видимость окна и область под мышь. Хост не подключён — очередь пуста (удержанные хуки хост снимает сам), сторы не
 * поднимаются. Новый запрос выдвигает убранный остров, выбирается в карточке и звучит сигналом острова (`useIslandCues`).
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
 *
 * Речь помощника (план 3b B22): проигрыватель окна (`createSpeaker`) и мост голоса уходят в стор вместе с остальными
 * зависимостями. Порт голоса остров просит сам (`speech.connect`), когда уже слушает сообщения окна: preload передаёт
 * его сообщением с `data === ISLAND_TTS_PORT`, и чужое сообщение порт не подменит. Анализ голоса для лица берёт частоту
 * графа окна и уменьшенное движение — системное или настройку Parley. Пока голос звучит, сигналы острова идут по
 * правилам речи (#9 §6.4).
 *
 * Виды помощника (план 3b B24, Р10): лицо получает эмоцию звучащего предложения и геттер кадра голоса из стора, значок
 * динамика — «Speak answers» и `toggleSpeak`. Реакции роёв (#9 §4.1–§4.3) — одноразовые `pulse`: мини-рой отвечает на
 * начало работы, исходы показа, наведение и фазы помощника, большой рой — только на фазы помощника.
 *
 * Остров в вырезе (#9 §12, план 3b B28; B26 F-B26-3): с `config.notch` наведение остров не открывает. Открывают клик по
 * вырезу или капсуле и язычок (`openFromNotch`: свёрнутый помощник раскрывается, иначе открывается список) и хоткеи;
 * уход курсора закрывает открытое так же, как наведение в полосе. Область под мышь — по форме: вырез, капсула или
 * выдвинутый вид у выдвинутого острова, у убранного — зона нажатия по вырезу или капсуле. Новый вырез (другой дисплей,
 * новый замер) сдвигает форму, поэтому область замеряется заново.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { refKey, type AssistantProposal, type AssistantState, type SessionRef } from '@parley/protocol';
import { ISLAND_TTS_PORT, markSeenBatches, parseVisibilitySnapshot, type IslandBridge, type IslandConfig, type IslandHitRect, type IslandPresentationOutcome, type IslandTtsMessage } from '../../shared/island.js';
import { DEFAULT_VOICE } from '../../shared/tts-types.js';
import type { IslandAnchor } from '../../shared/ui-types.js';
import { isoMs } from '../lib/iso-time.js';
import { useActivityStore } from '../store/activity.js';
import { useProvidersStore } from '../store/providers.js';
import { useWorksStore } from '../store/works.js';
import { browserRecorderDeps } from '../voice/browser-recorder.js';
import { startRecording } from '../voice/recorder.js';
import { listen } from './assistant/listen.js';
import { miniLabel } from './assistant/labels.js';
import { createSpeaker } from './assistant/speaker.js';
import { assistantBusy, useAssistantStore } from './assistant/store.js';
import { createVoiceAnalysis, type VoiceFrame } from './assistant/voice-features.js';
import { useConsentsStore } from './consents/store.js';
import { IslandTab } from './IslandTab.js';
import { IslandView, sessionKeyOf, type IslandAssistantProps } from './IslandView.js';
import { capsuleContent } from './NotchCapsule.js';
import { islandModel, sessionLabels, type IslandRow } from './model.js';
import { useIslandReplies } from './replies.js';
import { useIslandRequests } from './requests.js';
import { createProgressPoller, type ProgressState } from './progress.js';
import { islandSound } from './sound/graph.js';
import { CUE_PRIORITY } from './sound/cues.js';
import { REACTION_FOR, type SwarmEvent, type SwarmPulse } from './swarm/spec.js';
import { OUTCOME_SIGNAL, useIslandCues } from './useIslandCues.js';
import { movePendingSelection, pendingKeyCommand, pendingNavigation, pendingRoomNavigation, reconcilePendingNavigation, type PendingNavigationState } from './navigation.js';

/** Через сколько покоя (ничего не идёт, очереди нет, курсор не над формой, форму не тащат) остров убирается сам. */
export const IDLE_RETRACT_MS = 4000;
/** То же, но пока на острове есть строки Done: их надо успеть заметить. */
export const DONE_HOLD_MS = 20000;
/** Сколько форма сжимается в брусок: та же длительность, что у перехода сжатия `island-morph-shrink` (`island.css`). */
export const RETRACT_MORPH_MS = 300;

/** Системная настройка уменьшенного движения. */
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Настройки до ответа main: речь выключена, голоса нет. */
export const INITIAL_CONFIG: IslandConfig = {
  islandEnabled: true,
  assistant: {
    enabled: false,
    provider: null,
    model: null,
    language: 'en',
    hotkey: 'Alt+Space',
    voice: { enabled: false, model: null },
    speech: { enabled: false, voice: DEFAULT_VOICE, gender: 'female', available: false },
  },
  islandSound: { needs: false, finished: false, palette: 'soft', volume: 0.6, ui: false },
  motion: 'system',
  topInset: 0,
  anchor: 'center',
};

/** Кадр голоса для рта лица (Р10): рой читает его в своём кадре, а не при рендере. */
const voiceFrame = (): VoiceFrame | null => useAssistantStore.getState().voiceFrame();

/** Реакция роя на событие (#9 §4.1): новый объект на каждое событие, между событиями — тот же. */
const pulseOf = (event: SwarmEvent): SwarmPulse => ({ reaction: REACTION_FOR[event], at: performance.now() });

/**
 * Событие мини-роя на исходы `present()`. Уже виденное (переподключение) роем не отвечает. Тихий Done реагирует, только
 * если остров уже выдвинут (#9 §3.7). Из нескольких исходов разом — самый важный, в порядке сигналов (критик m-1485).
 */
export function presentationEvent(outcomes: readonly IslandPresentationOutcome[], retracted: boolean): SwarmEvent | null {
  const shown = outcomes
    .filter((outcome) => outcome.fresh && (outcome.expand || (outcome.kind === 'done' && !retracted)))
    .sort((a, b) => CUE_PRIORITY[OUTCOME_SIGNAL[b.kind]] - CUE_PRIORITY[OUTCOME_SIGNAL[a.kind]])[0];
  return shown === undefined ? null : OUTCOME_EVENT[shown.kind];
}

/** Исход показа → событие роя (#9 §4.1): согласие и терминал — как разрешение, предложение комнаты — как вопрос. */
const OUTCOME_EVENT: Readonly<Record<IslandPresentationOutcome['kind'], SwarmEvent>> = {
  permission: 'permission',
  consent: 'permission',
  'terminal-request': 'permission',
  question: 'question',
  'room-proposal': 'question',
  plan: 'plan',
  done: 'done',
};

/**
 * Событие роя по смене состояния помощника (#9 §4.1): шаг инструмента (новая фаза `tool` или новый инструмент в ней),
 * карточка подтверждения — как разрешение, ошибка; прочие фазы реакции не дают.
 */
function assistantEvent(host: AssistantState, prev: AssistantState): SwarmEvent | null {
  if (host.phase === 'tool' && (prev.phase !== 'tool' || host.detail !== prev.detail)) return 'tool';
  if (host.phase === prev.phase) return null;
  if (host.phase === 'awaiting-confirm') return 'permission';
  return host.phase === 'error' ? 'error' : null;
}

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

export function IslandApp({ bridge, onPresentation }: { bridge: IslandBridge; onPresentation?: (outcome: IslandPresentationOutcome) => void }): JSX.Element {
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<IslandConfig>(INITIAL_CONFIG);
  const configRef = useRef(config);
  configRef.current = config;
  /** Пришли ли настройки от main: до них «Speak answers» неизвестно, и его смена — не включение. */
  const configLoaded = useRef(false);
  const [speaker] = useState(createSpeaker);
  const [listOpen, setListOpen] = useState(false);
  const [navigationEmpty, setNavigationEmpty] = useState(false);
  const navigationEmptyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [progressSelected, setProgressSelected] = useState<SessionRef | null>(null);
  const [progressConnection, setProgressConnection] = useState<{ generation: number; methods: readonly string[] | null }>({ generation: 0, methods: null });
  const [progressDocumentVisible, setProgressDocumentVisible] = useState(!document.hidden);
  const progressScopeRef = useRef('');
  const [progressData, setProgressData] = useState<{ scope: string; state: ProgressState }>({ scope: '', state: { kind: 'loading' } });
  const progressCall = useRef(bridge.call);
  progressCall.current = bridge.call;
  const progressPoller = useMemo(() => createProgressPoller({ call: (method, params) => progressCall.current(method, params),
    onChange: (state) => setProgressData({ scope: progressScopeRef.current, state }),
  }), []);
  useEffect(() => {
    const visibility = (): void => setProgressDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);
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
    setNavSelectedKey(null);
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
  const [visibleSessions, setVisibleSessions] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let active = true;
    let version = -1;
    setVisibleSessions(new Set());
    const apply = (value: unknown, fromGetter = false): void => {
      if (!active) return;
      const snapshot = parseVisibilitySnapshot(value);
      if (snapshot === null) {
        if (!fromGetter || version < 0) setVisibleSessions(new Set());
        return;
      }
      if (snapshot.version <= version) return;
      version = snapshot.version;
      setVisibleSessions(new Set(snapshot.refs.map(refKey)));
    };
    const off = bridge.island.onVisibility(apply);
    void bridge.island.visibility().then((snapshot) => apply(snapshot, true), () => { if (active && version < 0) setVisibleSessions(new Set()); });
    return () => { active = false; off(); };
  }, [bridge]);

  useEffect(
    () =>
      bridge.onStatus((status) => {
        const ok = status.state === 'connected';
        setConnected(ok);
        setProgressConnection((current) => status.state === 'connected'
          ? { generation: current.generation + 1, methods: status.methods }
          : { ...current, methods: null });
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
    // Стор провайдеров — для значков `AgentIcon`: вендор своего провайдера узнаётся по его строке.
    const disposers = [useWorksStore.getState().init(bridge), useActivityStore.getState().init(bridge), useProvidersStore.getState().init(bridge)];
    return () => {
      useIslandRequests.getState().bind(null);
      useIslandReplies.getState().bind(null);
      for (const dispose of disposers) dispose();
      useActivityStore.setState({ byRef: {}, loaded: false });
    };
  }, [connected, bridge]);
  useEffect(() => {
    const apply = (next: IslandConfig): void => {
      configLoaded.current = true;
      setConfig(next);
    };
    void bridge.island.config().then(apply, () => undefined);
    return bridge.island.onConfig(apply);
  }, [bridge]);
  // Порт голоса: только сообщение своего окна с меткой и одним портом. Подписка — раньше просьбы, иначе порт потерялся бы.
  useEffect(() => {
    let port: MessagePort | null = null;
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window || event.data !== ISLAND_TTS_PORT || event.ports.length !== 1) return;
      port?.close();
      port = event.ports[0]!;
      port.onmessage = (message: MessageEvent<IslandTtsMessage>) => useAssistantStore.getState().speechMessage(message.data);
    };
    window.addEventListener('message', onMessage);
    bridge.island.speech.connect();
    return () => {
      window.removeEventListener('message', onMessage);
      port?.close();
    };
  }, [bridge]);
  // Наведение решает main по настоящему курсору: над областью острова список открыт, вне её — закрыт. В вырезе
  // наведение не открывает (B26 F-B26-3): открывает клик (`openFromNotch`), а уход курсора закрывает так же.
  useEffect(
    () =>
      bridge.island.onHover((over) => {
        const notch = configRef.current.notch != null;
        setHovered(over);
        if (!over || !notch) setListOpen(over);
        const store = useAssistantStore.getState();
        if (over && !notch && store.open && store.collapsed) store.expand(true);
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
  const roomRows = useMemo(() => model.groups.flatMap((group) => group.rows)
    .filter((row): row is Extract<IslandRow, { kind: 'room' }> => row.kind === 'room'), [model]);
  const roomNavItems = useMemo(() => pendingRoomNavigation(roomRows), [roomRows]);
  const navQueue = useMemo(() => pendingNavigation(consents, items, roomNavItems), [consents, items, roomNavItems]);
  const navQueueRef = useRef<PendingNavigationState>(navQueue);
  navQueueRef.current = navQueue;
  const previousNavQueueRef = useRef<PendingNavigationState>(navQueue);
  const [navSelectedKey, setNavSelectedKey] = useState<string | null>(null);
  const navKeyRef = useRef<string | null>(navSelectedKey);
  navKeyRef.current = navSelectedKey;
  useEffect(() => {
    const previous = previousNavQueueRef.current;
    setNavSelectedKey((key) => key === null ? null : reconcilePendingNavigation({ ...previous, selectedKey: key }, navQueue.items).selectedKey);
    previousNavQueueRef.current = navQueue;
  }, [navQueue.items]);
  useEffect(() => bridge.island.onNavigatePending(() => {
    if (ownerRef.current === 'request' && navQueueRef.current.items.length > 0) return;
    const first = navQueueRef.current.selectedKey;
    if (first === null) {
      setRetracted(false);
      setNavigationEmpty(true);
      if (navigationEmptyTimer.current !== null) clearTimeout(navigationEmptyTimer.current);
      navigationEmptyTimer.current = setTimeout(() => setNavigationEmpty(false), 1800);
      if (ownerRef.current === null) bridge.island.keyboard(false);
      return;
    }
    setNavigationEmpty(false);
    if (navigationEmptyTimer.current !== null) clearTimeout(navigationEmptyTimer.current);
    setRetracted(false);
    setListOpen(true);
    setOwner('request');
    navKeyRef.current = first;
    setNavSelectedKey(first);
  }), [bridge, setOwner]);
  useEffect(() => () => {
    if (navigationEmptyTimer.current !== null) clearTimeout(navigationEmptyTimer.current);
  }, []);
  const doneRows = useMemo(
    () => model.groups.flatMap((group) => group.rows).filter((row): row is DoneRow => row.kind === 'session' && row.state === 'done'),
    [model],
  );
  const pendingProposals = useMemo(() => model.groups.flatMap((group) => group.rows.flatMap((row) =>
    row.kind === 'room' && row.proposal !== undefined ? [row.proposal.key] : [])), [model]);
  /** Непросмотренные Done: их число показывает убранный остров (`✅ N`). */
  const unseenDone = doneRows.filter((row) => !row.seen).length;
  const labels = useMemo(() => sessionLabels(entries), [entries]);
  const assistant = useAssistantStore();
  useEffect(() => {
    if (keyboardOwner === 'request' && !assistant.open) requestAnimationFrame(() => shapeRef.current?.focus());
  }, [keyboardOwner, assistant.open]);
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
      speech: {
        speaker,
        api: bridge.island.speech,
        analysis: () => {
          const sampleRate = islandSound.graph()?.context.sampleRate;
          return createVoiceAnalysis({
            ...(sampleRate === undefined ? {} : { sampleRate }),
            reducedMotion: () => configRef.current.motion === 'reduce' || (typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION).matches),
          });
        },
        now: () => performance.now(),
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
  }, [connected, bridge, setOwner, releaseKeyboard, speaker]);
  // «Speak answers» сменили (значок острова или Settings): выключение глушит речь, включение греет голос.
  useEffect(() => {
    if (connected && configLoaded.current) useAssistantStore.getState().speechConfig(config.assistant.speech);
  }, [connected, config.assistant.speech]);

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
  const cues = useIslandCues({ sound: config.islandSound, active: model.active, hovered, speaking: () => speaker.speaking() });
  /** Реакции роёв: мини-рой (события агентов, наведение, фазы помощника) и большой рой помощника (только его фазы). */
  const [miniPulse, setMiniPulse] = useState<SwarmPulse | null>(null);
  const [assistantPulse, setAssistantPulse] = useState<SwarmPulse | null>(null);
  const retractedRef = useRef(retracted);
  retractedRef.current = retracted;
  const present = useCallback((outcomes: IslandPresentationOutcome[]): void => {
    if (outcomes.some((outcome) => outcome.expand)) setRetracted(false);
    const event = presentationEvent(outcomes, retractedRef.current);
    if (event !== null) setMiniPulse(pulseOf(event));
    if (onPresentation !== undefined) {
      for (const outcome of outcomes) onPresentation(outcome);
    } else cues.present(outcomes);
  }, [cues, onPresentation]);
  // Фронты «нет → да» для мини-роя: значение при монтировании — база, а не событие (как у сигналов острова).
  const pulseActive = useRef(model.active);
  useEffect(() => {
    if (model.active && !pulseActive.current) setMiniPulse(pulseOf('start'));
    pulseActive.current = model.active;
  }, [model.active]);
  const pulseHovered = useRef(hovered);
  useEffect(() => {
    if (hovered && !pulseHovered.current) setMiniPulse(pulseOf('hover'));
    pulseHovered.current = hovered;
  }, [hovered]);
  // Фазы помощника: отвечают оба роя — виден из них тот, что сейчас на острове.
  useEffect(
    () =>
      useAssistantStore.subscribe((state, prev) => {
        const event = assistantEvent(state.host, prev.host);
        if (event === null) return;
        const pulse = pulseOf(event);
        setMiniPulse(pulse);
        setAssistantPulse(pulse);
      }),
    [],
  );
  /** Клик по вырезу или капсуле и язычок в вырезе: свёрнутый помощник раскрывается до ухода курсора, иначе — список. */
  const openFromNotch = useCallback((): void => {
    const store = useAssistantStore.getState();
    if (store.open && store.collapsed) store.expand(true);
    else setListOpen(true);
  }, []);
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
    if (!connected) return;
    // Новые запросы встают в очередь по времени, а на экране мог остаться прежний — показываем первый из новых.
    let firstFresh = -1;
    const outcomes: IslandPresentationOutcome[] = [];
    items.forEach((item, at) => {
      if (seen.current.has(item.key)) return;
      seen.current.add(item.key);
      outcomes.push({ key: item.key, kind: item.card?.kind ?? 'terminal-request', fresh: true, expand: true, soundEligible: true });
      if (firstFresh === -1) firstFresh = at;
    });
    // Новая карточка согласия (id `c-NN` не пересекается с ключами запросов) выдвигает остров и звучит так же.
    for (const card of consents) {
      if (seen.current.has(card.id)) continue;
      seen.current.add(card.id);
      outcomes.push({ key: card.id, kind: 'consent', fresh: true, expand: true, soundEligible: true });
    }
    for (const key of pendingProposals) {
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      outcomes.push({ key, kind: 'room-proposal', fresh: true, expand: true, soundEligible: true });
    }
    if (outcomes.length === 0) return;
    // Вопрос сохраняет выбор и draft даже после blur/уборки; остальные запросы не уводим из-под текущего ввода.
    const selected = items.find((item) => item.key === selectedKey);
    const keepQuestion = selected?.inWindow && selected.card?.kind === 'question' && selected.card.state === 'pending' && selected.note !== 'elsewhere';
    if (firstFresh !== -1 && !keepQuestion && !shapeRef.current?.contains(document.activeElement)) useIslandRequests.getState().select(firstFresh);
    present(outcomes);
  }, [connected, items, consents, pendingProposals, present, selectedKey]);
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
    const outcomes: IslandPresentationOutcome[] = [];
    for (const row of doneRows) {
      if (seenDone.current.has(row.doneKey)) continue;
      seenDone.current.add(row.doneKey);
      const endedAt = row.turnEndedAt === null ? null : isoMs(row.turnEndedAt);
      const fresh = endedAt !== null && endedAt >= connectedAt.current;
      outcomes.push({ key: row.doneKey, kind: 'done', fresh, expand: fresh && !visibleSessions.has(refKey(row.ref)), soundEligible: false });
    }
    present(outcomes);
    if (outcomes.some((outcome) => outcome.expand)) setFreshDone((count) => count + 1);
  }, [connected, doneRows, visibleSessions, present]);
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
      const target = event.target;
      const editable = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (ownerRef.current === 'request') {
        const command = pendingKeyCommand({ key: event.key, ctrlKey: event.ctrlKey, isComposing: event.isComposing, repeat: event.repeat, editable });
        if (command === 'escape') { event.preventDefault(); releaseKeyboard(); return; }
        if (command === 'next' || command === 'previous') {
          event.preventDefault();
          const next = movePendingSelection({ ...navQueueRef.current, selectedKey: navKeyRef.current }, command === 'next' ? 1 : -1);
          navKeyRef.current = next.selectedKey;
          setNavSelectedKey(next.selectedKey);
          const selected = next.items.find((item) => item.key === next.selectedKey);
          if (selected?.kind === 'feed') {
            const key = selected.key.slice('feed:'.length);
            const at = items.findIndex((item) => item.key === key);
            if (at >= 0) useIslandRequests.getState().select(at);
          }
          return;
        }
        if (command === 'open') {
          event.preventDefault();
          const selected = navQueueRef.current.items.find((item) => item.key === navKeyRef.current);
          if (selected?.target !== undefined) bridge.island.open(selected.target);
          return;
        }
      }
      if (event.key === 'Escape' && !event.isComposing && assistant.open) useAssistantStore.getState().close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assistant.open, keyboardOwner, releaseKeyboard, items, bridge]);
  const shown = connected && !retracted;
  const progressKey = progressSelected === null ? null : refKey(progressSelected);
  const progressSession = progressSelected === null ? undefined : entries
    .find((entry) => entry.projectPath === progressSelected.projectPath && entry.map.work.id === progressSelected.workId)
    ?.map.sessions.find((session) => session.id === progressSelected.sessionId);
  const progressLifecycle = progressSession === undefined ? '' : JSON.stringify([
    progressSession.provider, progressSession.providerSessionId, progressSession.pid, progressSession.startedAtProcess,
    progressSession.lifecycle, progressSession.startedAt, progressSession.endedAt,
  ]);
  const progressScope = JSON.stringify([progressKey, progressConnection.generation, progressLifecycle]);
  const progressRowPresent = progressKey !== null && model.groups.some((group) => group.rows.some((row) => row.kind === 'session' && refKey(row.ref) === progressKey));
  const progressActive = shown && progressDocumentVisible && config.islandEnabled && listOpen && progressRowPresent &&
    progressSession !== undefined && !assistant.open && !busy && items.length === 0 && consents.length === 0 && pendingProposals.length === 0;
  const progressState: ProgressState = progressData.scope === progressScope ? progressData.state : { kind: 'loading' };
  const displayedProgress = !progressActive && progressState.kind === 'available' ? { ...progressState, delayed: true } : progressState;
  useEffect(() => {
    progressScopeRef.current = progressScope;
    const selection = { ref: progressSelected, active: progressActive, connectionGeneration: progressConnection.generation,
      lifecycle: progressLifecycle, methods: progressConnection.methods };
    progressPoller.update(selection);
    // При повторе эффекта StrictMode пауза сохраняет блокировку незавершённого IPC.
    return () => progressPoller.update({ ...selection, active: false });
  }, [progressPoller, progressSelected, progressActive, progressConnection, progressLifecycle, progressScope]);
  useEffect(() => {
    if (progressSelected !== null && !progressRowPresent) setProgressSelected(null);
  }, [progressSelected, progressRowPresent]);
  const selectedNavigation = navQueue.items.find((item) => item.key === navSelectedKey);
  const consentShown = consents.length > 0 && (navSelectedKey === null || selectedNavigation?.kind === 'consent');
  const showingFeedCard = !consentShown && items.length > 0 && (navSelectedKey === null || selectedNavigation?.kind === 'feed');
  const requestVisible = shown && config.islandEnabled && !(assistant.open && !assistant.collapsed) && showingFeedCard;
  const requestAvailable = shown && config.islandEnabled && !(assistant.open && !assistant.collapsed) &&
    (consents.length > 0 || selectedKey !== null || roomNavItems.length > 0);
  useEffect(() => {
    if ((keyboardOwner === 'request' && !requestAvailable) ||
      (keyboardOwner === 'assistant' && (!connected || !config.assistant.enabled || !assistant.open || assistant.collapsed))) releaseKeyboard();
  }, [keyboardOwner, requestAvailable, connected, config.assistant.enabled, assistant.open, assistant.collapsed, releaseKeyboard]);
  const takeRequestKeyboard = (): void => {
    if (!requestAvailable || ownerRef.current === 'request') return;
    const currentFeed = items.find((item) => item.key === selectedKey);
    const visibleConsent = consentShown ? consents[0] : undefined;
    const current = visibleConsent === undefined ? currentFeed === undefined ? navQueueRef.current.selectedKey : `feed:${currentFeed.key}` : `consent:${visibleConsent.id}`;
    navKeyRef.current = current;
    setNavSelectedKey(current);
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
  // отступ под чёлку, вырез); переход, что размера формы не меняет (отступ сверху у бруска), ловит `transitionend` на корне.
  useLayoutEffect(() => {
    reportHitRect();
    const observer = new ResizeObserver(reportHitRect);
    if (shapeRef.current !== null) observer.observe(shapeRef.current);
    if (tabRef.current !== null) observer.observe(tabRef.current);
    return () => observer.disconnect();
  }, [reportHitRect, config.anchor, config.topInset, config.notch]);

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
        pulse: miniPulse,
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
          sentenceMood: assistant.sentence?.emo ?? null,
          voice: voiceFrame,
          pulse: assistantPulse,
          speakOn: config.assistant.speech?.enabled === true,
          onToggleSpeak: () => useAssistantStore.getState().toggleSpeak(),
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
        progress={{ selected: progressSelected, state: displayedProgress,
          onSelect: (ref) => setProgressSelected({ ...ref }), onClose: () => setProgressSelected(null) }}
        retracted={retracted}
        doneCount={unseenDone}
        hovered={hovered}
        showId={show.id}
        labels={labels}
        api={bridge.island}
        requestKeyboard={keyboardOwner === 'request'}
        navigationKey={navSelectedKey}
        navigationEmpty={navigationEmpty}
        onTakeRequestKeyboard={takeRequestKeyboard}
        shapeRef={shapeRef}
        onDragStart={() => setDragging(true)}
        onDragEnd={() => setDragging(false)}
        onToggleList={setListOpen}
        onHide={() => {
          if (hideAssistant()) return;
          cues.close();
          retract();
        }}
        onClearDone={clearDone}
        onSelect={(next) => useIslandRequests.getState().select(next)}
        onDecide={(key, decision) => void useIslandRequests.getState().decide(key, decision)}
        assistant={assistantProps}
        miniPulse={miniPulse}
        onOpen={openFromNotch}
        consent={
          (consents.find((card) => `consent:${card.id}` === navSelectedKey) ?? (navSelectedKey === null ? consents[0] : undefined)) === undefined
            ? null
            : { card: (consents.find((card) => `consent:${card.id}` === navSelectedKey) ?? (navSelectedKey === null ? consents[0] : undefined))!, deciding: consentDeciding === (consents.find((card) => `consent:${card.id}` === navSelectedKey) ?? (navSelectedKey === null ? consents[0] : undefined))!.id, note: consentNote, onDecide: (id, decision) => void useConsentsStore.getState().decide(id, decision) }
        }
      />
      {retracted ? (
        <IslandTab
          anchorClass={ANCHOR_CLASS[config.anchor]}
          topInset={config.topInset}
          doneCount={unseenDone}
          notch={config.notch ?? null}
          capsule={config.notch != null && capsuleContent(model, unseenDone, assistantProps) !== null}
          tabRef={tabRef}
          onExpand={() => {
            cues.open();
            setRetracted(false);
            if (config.notch != null) openFromNotch();
          }}
        />
      ) : null}
    </div>
  );
}
