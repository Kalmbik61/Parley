/**
 * Вид острова (спека 2026-10-12, раздел 4): пилюля, список «в работе» или карточка запроса. Чистый вид: всё
 * приходит пропсами, решения и переходы — колбэками. Остров всегда тёмный (чёрный, как чёлка). Цвет текста — только
 * семантические токены темы (`text-foreground`, `text-muted-foreground`): рампа `neutral-*` в тёмной теме перевёрнута
 * (100 — самый тёмный), и `text-neutral-100` на чёрном фоне невидим.
 *
 * Чёрная форма плавно меняет размер, как Dynamic Island: внешний элемент (`data-testid="island"`) получает явные
 * `width`/`height` в пикселях по замеру внутреннего содержимого (`w-max`), а CSS-переход анимирует их. Окно при этом
 * не меняется — это фиксированный прозрачный кадр (`ISLAND_FRAME`), форма живёт внутри него.
 *
 * Убранный остров (`retracted`) не уезжает, а превращается в брусок, как Dynamic Island: форма — тот же элемент, содержимое
 * меняется сразу, а размер, отступ сверху, скругление и тень доезжают одним CSS-переходом (250 мс), поэтому большое чёрное
 * сжимается в маленькое. Без Done брусок — пустой блок 40×5 со скруглением `rounded-[3px]` (капсула; радиус конечный,
 * чтобы переход от 22 px шёл плавно — у `rounded-full` угол щёлкал бы) и светлой обводкой (видна и на светлом,
 * и на тёмном фоне под прозрачным окном); с непросмотренными Done (`doneCount` > 0) вместо него выглядывает форма со
 * скруглением снизу и `✅ N` внутри. У убранной формы нет тени: у верхнего края кадра она даёт серую полосу. Мышь по убранной
 * форме ловит не она, а прозрачная зона `IslandTab` поверх неё. Выдвижение — обратное превращение: брусок растёт в остров, а
 * новое содержимое проступает (`island-reveal`), пока форма растёт. Тащить остров можно за любое место формы
 * (`useShapeDrag`), кроме кнопок.
 * Убрать остров в язычок можно двумя способами, без «×» и подсказки: стрелка ⌃ по центру внизу формы (ряд внутри
 * замеряемого содержимого, только пока курсор над островом — `hovered` от main; высота формы анимируется сама) и
 * смахивание вверх (зажать мышь на острове и потянуть вверх — `onSwipeUp` хука перетаскивания).
 *
 * Строки Done (агент закончил ход, в Parley его ещё не смотрели) идут в списке после строк в работе: точка `unseen`,
 * имя сессии, время конца хода и под ними до двух строк последнего ответа агента. Текст ответа вид читает сам из
 * `useIslandReplies` по `doneKey` (единственное исключение из «всё пропсами»: стор только для чтения). Пилюля
 * показывает `✅ N done` рядом со счётчиками работы, а под списком — тихая «Clear», что прячет все видимые Done. Она стоит
 * вне прокручиваемой части списка: длинный список едет под ней, а кнопка остаётся на месте.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { ChevronUp } from 'lucide-react';
import type { FeedDecision } from '@parley/core';
import { S } from '../../shared/strings.js';
import type { FocusTarget } from '../../shared/bridge.js';
import type { IslandApi, IslandConfig } from '../../shared/island.js';
import { alwaysRules } from '../chat/cards/always-rules.js';
import { AgentIcon } from '../components/AgentIcon.js';
import { AgentStateDot } from '../components/AgentStateDot.js';
import { relativeTime } from '../lib/relative-time.js';
import { Button } from '../ui/button.js';
import { AssistantView, type AssistantViewProps } from './assistant/AssistantView.js';
import { useShapeDrag } from './drag.js';
import type { IslandModel, IslandRow } from './model.js';
import { useIslandReplies } from './replies.js';
import type { IslandRequest } from './requests.js';
import { simpleChoices } from './simple-question.js';
import { Swarm } from './swarm/Swarm.js';
import { swarmSpecFor } from './swarm/spec.js';

/**
 * Сколько кнопки решения (Allow / Always / Deny / варианты ответа) выключены после каждого показа карточки: остров
 * появляется под курсором у верхнего края экрана, а `acceptFirstMouse` пропускает первый клик — без паузы случайный
 * клик по чужому окну разрешил бы команду. Пауза — на показ и на карточку: заново после скрытия и нового появления
 * острова (`showId`) и при переходе к любой карточке, в том числе уже виденной. «Open in Parley» и стрелки не
 * защищены: они ничего не решают.
 */
export const CARD_ARM_MS = 500;

/**
 * Что под видом помощника должно остаться в кадре: ряд стрелки ⌃ (`pt-1.5` + `h-5` + `pb-2` = 34 px) и запас на тень
 * `shadow-lg` выдвинутой формы. Вид не выше кадра за вычетом чёлки и этого запаса — длинный ответ прокручивается внутри.
 */
const ASSISTANT_BOTTOM_RESERVE_PX = 34 + 16;

export interface IslandAssistantProps {
  view: Omit<AssistantViewProps, 'maxHeight'>;
  open: boolean;
  collapsed: boolean;
  busy: boolean;
  mini: string | null;
  onOpen(): void;
}

export interface IslandViewProps {
  model: IslandModel;
  items: readonly IslandRequest[];
  index: number;
  config: IslandConfig;
  listOpen: boolean;
  /** Остров убран: форма сжалась в брусок (или в `✅ N`), а поверх неё лежит прозрачная зона `IslandTab`. */
  retracted: boolean;
  /** Сколько на острове непросмотренных Done: у убранного больше нуля — вместо бруска выглядывает `✅ N`. */
  doneCount: number;
  /** Курсор над областью острова (от main): пока он над ней, внизу формы стрелка ⌃ «убрать остров». */
  hovered: boolean;
  /** Номер показа острова: растёт каждый раз, когда окно из скрытого становится видимым (`IslandApp`). */
  showId: number;
  labels: ReadonlyMap<string, { session: string; work: string; project: string }>;
  api: IslandApi;
  /** Ссылка на внешнюю форму: `IslandApp` по ней замеряет область, которую остров ловит мышью. */
  shapeRef: Ref<HTMLDivElement>;
  /** Перетаскивание формы началось / закончилось: пока оно идёт, остров не убирается в покое. */
  onDragStart(): void;
  onDragEnd(): void;
  onToggleList(open: boolean): void;
  /** Стрелка ⌃ или смахивание вверх: убрать остров до следующего запроса или выдвижения язычком. */
  onHide(): void;
  /** «Clear»: спрятать все видимые строки Done. */
  onClearDone(): void;
  onSelect(index: number): void;
  onDecide(key: string, decision: FeedDecision): void;
  /** Помощник (спека 2026-10-14, раздел 8); `null` — выключен в настройках. */
  assistant: IslandAssistantProps | null;
}

export const sessionKeyOf = (item: IslandRequest): string => item.key.slice(0, item.key.lastIndexOf('\u0000'));

function rowTarget(row: IslandRow): FocusTarget {
  return row.kind === 'session'
    ? { kind: 'session', ref: row.ref }
    : { kind: 'room', projectPath: row.projectPath, workId: row.workId, roomId: row.roomId };
}

/** Мини-рой в кнопке пилюли: canvas 28 px лежит в кнопке 26 px, как `.dotbtn` макета; 30 кадров/с только пока помощник занят. */
function MiniSwarm({ assistant }: { assistant: IslandAssistantProps }): JSX.Element {
  const { host, input } = assistant.view;
  const spec = useMemo(() => swarmSpecFor(host, input, true), [host.phase, input]);
  return <Swarm spec={spec} souls={150} width={28} height={28} d={17} cy={14} k={0.15} minPx={1.5} seed={5} fps={assistant.busy ? 30 : 0} />;
}

function Pill(props: IslandViewProps): JSX.Element {
  const { model, onToggleList } = props;
  return (
    // Список — по наведению или клику (спека, раздел 4): наведение приходит от main (`IslandApp`), он же закрывает список
    // при уходе курсора. Строка занимает всю ширину содержимого, а при открытом списке оно растёт до 400 px:
    // содержимое строки по центру, чтобы пилюля не уезжала вбок из-под курсора.
    <div data-testid="island-pill" className="island-reveal flex items-center justify-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm">
      {props.assistant === null ? null : (
        <button type="button" data-testid="assistant-dot" aria-label={S.assistant.ask} className="grid size-[26px] -ml-1 cursor-pointer place-items-center overflow-visible rounded-full hover:bg-white/10" onClick={props.assistant.onOpen}>
          <MiniSwarm assistant={props.assistant} />
        </button>
      )}
      {props.assistant?.collapsed === true && props.assistant.mini !== null ? (
        <span data-testid="assistant-mini">{props.assistant.mini}</span>
      ) : model.active || model.done > 0 ? (
        // Клик только открывает список: наведение открыло его мгновением раньше, и «переключатель» тут же закрывал бы.
        // Не кнопка: за кнопку остров не тащится, а счётчики — самое большое место пилюли. Значки провайдеров — про
        // идущую работу, у одних Done их нет.
        <div data-testid="island-counters" className="flex items-center gap-1.5" onClick={() => onToggleList(true)}>
          {model.providers.map((provider) => (
            <AgentIcon key={provider} provider={provider} size={14} />
          ))}
          <span>{S.island.pill(model.working, model.waiting, model.done)}</span>
        </div>
      ) : (
        <span data-testid="island-idle" className="text-muted-foreground">
          {S.island.idle}
        </span>
      )}
    </div>
  );
}

type RoomRow = Extract<IslandRow, { kind: 'room' }>;
type SessionRow = Extract<IslandRow, { kind: 'session' }>;

/** Строка Done: имя и время конца хода, под ними последний ответ агента (если снимок ленты его нашёл). */
function DoneLine({ row, api }: { row: Extract<SessionRow, { state: 'done' }>; api: IslandApi }): JSX.Element {
  const reply = useIslandReplies((state) => state.texts[row.doneKey] ?? null);
  return (
    <button type="button" data-testid="island-done" className="flex cursor-pointer flex-col gap-0.5 rounded px-1 py-0.5 text-left hover:bg-white/10" onClick={() => api.open(rowTarget(row))}>
      <span className="flex w-full items-center gap-2">
        <AgentStateDot state="unseen" size="sm" />
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        {row.turnEndedAt !== null ? <span className="shrink-0 text-[13px] text-muted-foreground">{relativeTime(row.turnEndedAt, new Date())}</span> : null}
      </span>
      {reply !== null ? (
        <span title={reply} className="line-clamp-2 text-[13px] text-foreground/75">
          {reply}
        </span>
      ) : null}
    </button>
  );
}

function List({ model, api, onClearDone }: IslandViewProps): JSX.Element {
  return (
    <div data-testid="island-list" className="island-reveal flex w-[400px] flex-col text-sm">
      {/* Прокручиваются только работы; «Clear» — ниже, вне прокрутки, и с ней не уезжает. */}
      <div data-testid="island-list-scroll" className={`flex max-h-[360px] flex-col gap-2 overflow-y-auto px-3 ${model.done > 0 ? 'pb-1' : 'pb-3'}`}>
        {model.groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-1">
            <div>
              <span className="font-semibold text-foreground">{group.title}</span> <span className="text-[13px] text-muted-foreground">· {group.project}</span>
            </div>
            {/* Комнаты работы — подзаголовком под названием, по строке на комнату; имя комнаты открывает её. */}
            {group.rows
              .filter((row): row is RoomRow => row.kind === 'room')
              .map((room) => (
                <div key={room.key} data-testid="island-room" className="flex min-w-0 gap-1 text-[13px] text-foreground/75">
                  <button type="button" className="min-w-0 cursor-pointer truncate text-left hover:underline" onClick={() => api.open(rowTarget(room))}>
                    {room.title}
                  </button>
                  <span className="shrink-0">· {room.busy > 0 ? S.island.roomBusy(room.busy) : S.island.roomDone}</span>
                </div>
              ))}
            {group.rows
              .filter((row): row is SessionRow => row.kind === 'session')
              .map((row) =>
                row.state === 'done' ? (
                  <DoneLine key={row.key} row={row} api={api} />
                ) : (
                  <button key={row.key} type="button" className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10" onClick={() => api.open(rowTarget(row))}>
                    {/* Точка — та же, что в сайдбаре: ждущая сессия «blocked», остальное (в работе) — «working». */}
                    <AgentStateDot state={row.state === 'needs-you' ? 'blocked' : 'working'} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    {row.inTerminal ? <span className="text-[13px] text-muted-foreground">{S.island.waitingInTerminal}</span> : null}
                  </button>
                ),
              )}
          </div>
        ))}
      </div>
      {model.done > 0 ? (
        <div className="flex justify-end px-3 pb-3 pt-1">
          <button type="button" data-testid="island-clear" onClick={onClearDone} className="cursor-pointer px-1 text-muted-foreground hover:text-foreground">
            {S.island.clearDone}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Actions({ item, armed, api, onDecide }: { item: IslandRequest; armed: boolean; api: IslandApi; onDecide: IslandViewProps['onDecide'] }): JSX.Element {
  const { card } = item;
  const open = (): void => api.open(item.inWindow && card !== null ? { kind: 'session', ref: item.ref, cardId: card.cardId } : { kind: 'session', ref: item.ref });
  // Решение выключено, пока оно уходит, и первые `CARD_ARM_MS` после показа запроса.
  const disabled = item.deciding || !armed;
  const openButton = (
    <Button data-testid="island-open" size="default" variant="outline" className="cursor-pointer text-sm" onClick={open}>
      {item.inWindow ? S.island.openInParley : S.island.openTerminal}
    </Button>
  );
  if (!item.inWindow || card === null) return openButton;
  if (card.kind === 'permission') {
    const rules = alwaysRules(card.suggestions);
    return (
      <>
        <Button data-testid="island-allow" size="default" className="cursor-pointer text-sm" disabled={disabled} onClick={() => onDecide(item.key, { kind: 'permission', behavior: 'allow' })}>
          {S.island.allow}
        </Button>
        {rules !== null ? (
          <Button data-testid="island-always" size="default" variant="outline" className="cursor-pointer text-sm" title={rules.join(', ')} disabled={disabled} onClick={() => onDecide(item.key, { kind: 'permission', behavior: 'allow', always: true })}>
            {S.island.always}
          </Button>
        ) : null}
        <Button data-testid="island-deny" size="default" variant="outline" className="cursor-pointer text-sm" disabled={disabled} onClick={() => onDecide(item.key, { kind: 'permission', behavior: 'deny' })}>
          {S.island.deny}
        </Button>
      </>
    );
  }
  const simple = simpleChoices(card);
  if (simple !== null) {
    return (
      <>
        {/* Подписи могут повторяться или быть пустыми — ключ с номером. */}
        {simple.options.map((label, at) => (
          <Button key={`${at}:${label}`} data-testid="island-option" size="default" variant="outline" className="cursor-pointer text-sm" disabled={disabled} onClick={() => onDecide(item.key, { kind: 'question', answers: { [simple.question]: label } })}>
            {label}
          </Button>
        ))}
      </>
    );
  }
  return openButton;
}

function Card(props: IslandViewProps): JSX.Element | null {
  const { items, index, showId, labels, api, onSelect, onDecide } = props;
  const item = items[index] ?? items[0];
  // Взведённая пара «показ + карточка» ровно одна: любая смена пары (другая карточка, в том числе виденная раньше,
  // или новый показ) снимает взвод в очистке эффекта и ставит паузу заново.
  const showKey = item === undefined ? null : `${showId}\u0000${item.key}`;
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const armed = showKey !== null && armedKey === showKey;
  useEffect(() => {
    if (showKey === null) return undefined;
    const timer = setTimeout(() => setArmedKey(showKey), CARD_ARM_MS);
    return () => {
      clearTimeout(timer);
      setArmedKey(null);
    };
  }, [showKey]);
  if (item === undefined) return null;
  const label = labels.get(sessionKeyOf(item));
  return (
    // Ключ по показанному запросу: новая карточка (стрелки, новый запрос) заново проигрывает появление.
    <div key={item.key} data-testid="island-card" className="island-reveal flex w-[440px] flex-col gap-2 px-3 pb-3 pt-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          {label === undefined ? null : `${label.session} · ${label.work}`}
          {label === undefined ? null : <span className="text-[13px] text-muted-foreground"> · {label.project}</span>}
        </span>
        {items.length > 1 ? (
          <span className="flex items-center gap-1 text-muted-foreground">
            <button type="button" aria-label={S.island.previous} className="cursor-pointer disabled:cursor-default" onClick={() => onSelect(index - 1)} disabled={index === 0}>
              ‹
            </button>
            <span className="text-[13px]">{S.island.of(index + 1, items.length)}</span>
            <button type="button" aria-label={S.island.next} className="cursor-pointer disabled:cursor-default" onClick={() => onSelect(index + 1)} disabled={index >= items.length - 1}>
              ›
            </button>
          </span>
        ) : null}
      </div>
      <div title={item.summary} className="truncate font-mono text-sm">
        {item.summary}
      </div>
      {item.note === 'elsewhere' ? <div className="text-muted-foreground">{S.island.answeredElsewhere}</div> : null}
      {item.note === 'failed' ? <div className="text-[var(--status-warning-text)]">{S.island.failed}</div> : null}
      <div className="flex flex-wrap gap-2">
        <Actions item={item} armed={armed} api={api} onDecide={onDecide} />
      </div>
    </div>
  );
}

export function IslandView(props: IslandViewProps): JSX.Element {
  const { model, items, listOpen, config, retracted, doneCount, hovered, shapeRef, api, onDragStart, onDragEnd, onHide, assistant } = props;
  const drag = useShapeDrag(api, { onDragStart, onDragEnd, onSwipeUp: onHide });
  const contentRef = useRef<HTMLDivElement>(null);
  /** Размер содержимого в пикселях; до первого замера `null` — у формы нет явных `width`/`height`. */
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (element === null) return undefined;
    const measure = (): void => {
      const width = Math.ceil(element.offsetWidth);
      const height = Math.ceil(element.offsetHeight);
      // Нулевой размер — страница ещё не разложена: форма схлопнулась бы и потом росла «из точки».
      if (width === 0 || height === 0) return;
      setSize((current) => (current !== null && current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Три облика одной формы. Выдвинутая: чёрное под чёлкой (отступ внутри содержимого), тень. Брусок: форма под чёлкой и на
  // 2 px ниже края. `✅ N`: сразу под чёлкой. У убранных обводка вместо тени.
  const peek = retracted && doneCount > 0;
  const look = !retracted ? 'rounded-b-[22px] shadow-lg' : peek ? 'rounded-b-[14px] shadow-none ring-1 ring-white/50' : 'rounded-[3px] shadow-none ring-1 ring-white/50';
  const marginTop = !retracted ? 0 : peek ? config.topInset : config.topInset + 2;
  const assistantBig = assistant !== null && assistant.open && !assistant.collapsed;
  return (
    // Форма — прямой элемент flex-корня `IslandApp`: `shrink-0`, чтобы узкий кадр не сжимал её.
    <div
      ref={shapeRef}
      data-testid="island"
      data-retracted={retracted}
      aria-hidden={retracted || undefined}
      className={`shrink-0 overflow-hidden bg-black text-sm text-foreground ${look} transition-[width,height,margin-top,border-radius,box-shadow] duration-[250ms] ease-out motion-reduce:transition-none ${drag.dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={{ ...size, marginTop }}
      {...drag.handlers}
    >
      <div ref={contentRef} data-testid="island-content" className="w-max" style={{ paddingTop: retracted ? 0 : config.topInset }}>
        {retracted ? (
          // Содержимое убранной формы меняется сразу, а форма доезжает до него переходом.
          peek ? (
            <div className="whitespace-nowrap px-3 py-1 text-sm">{S.island.donePeek(doneCount)}</div>
          ) : (
            <div className="h-[5px] w-10" />
          )
        ) : (
          <>
            {assistantBig ? (
              <AssistantView {...assistant.view} maxHeight={`calc(100vh - ${config.topInset + ASSISTANT_BOTTOM_RESERVE_PX}px)`} />
            ) : items.length > 0 ? (
              <Card {...props} />
            ) : (
              <>
                <Pill {...props} />
                {listOpen && model.groups.length > 0 ? <List {...props} /> : null}
              </>
            )}
            {/* Стрелка ⌃ — только под курсором: между ней и содержимым над ней заметный отступ, и снизу до края формы тоже. */}
            {hovered ? (
              <div className="flex justify-center pb-2 pt-1.5">
                <button
                  type="button"
                  data-testid="island-tuck"
                  aria-label={S.island.tuckAway}
                  title={S.island.tuckAway}
                  onClick={onHide}
                  className="flex h-5 min-w-8 cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  <ChevronUp size={18} />
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
