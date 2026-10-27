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
 * меняется сразу, а размер, отступ сверху, скругление и тень доезжают одним CSS-переходом сжатия, поэтому большое чёрное
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
 *
 * Карточка согласия на папку (спека 2026-10-21, 4.4) держит запуск Codex, поэтому встаёт раньше карточек ленты, пока
 * помощник не раскрыт (`ConsentView`, свой стор `consents/store.ts`).
 *
 * Остров в вырезе (#9 §12, план 3b B28): с `config.notch` форма стоит у верхнего края по центру выреза (сдвиг до
 * половины точки — у обёртки, там же вогнутые плечи). Три облика (B26 F-B26-3, решение человека): нечего показывать —
 * ровно вырез; есть фон (агенты работают, непросмотренный Done, помощник свёрнут или говорит, его ошибка) — капсула
 * высотой выреза (`NotchCapsule`), и у убранного острова тоже; открыт список (клик, язычок, хоткей перехода), раскрыт
 * помощник, запрос, согласие, предложение комнаты или переход к ждущему — форма выдвигается вниз: содержимое ниже выреза, ширина не меньше
 * выреза с полями. Наведение в вырезе форму не выдвигает. Клик по вырезу или капсуле — `onOpen`. Скругление снизу —
 * 10 px у голого выреза, 14 px у капсулы, 22 px у выдвинутых видов. Смена выреза (другой дисплей, новый замер) меняет
 * форму мгновенно: два кадра у формы нет класса перехода (§12.4).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type Ref } from 'react';
import { ChevronUp } from 'lucide-react';
import type { FeedDecision } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import type { FocusTarget } from '../../shared/bridge.js';
import type { IslandApi, IslandConfig } from '../../shared/island.js';
import { alwaysRules } from '../chat/cards/always-rules.js';
import { AgentIcon } from '../components/AgentIcon.js';
import { AgentStateDot } from '../components/AgentStateDot.js';
import { relativeTime } from '../lib/relative-time.js';
import { Button } from '../ui/button.js';
import { CARD_ARM_MS } from './arm.js';
import { AssistantView, type AssistantViewProps } from './assistant/AssistantView.js';
import { ConsentView, type ConsentViewProps } from './consents/ConsentView.js';
import { useShapeDrag } from './drag.js';
import type { IslandModel, IslandRow } from './model.js';
import { useIslandReplies } from './replies.js';
import type { IslandRequest } from './requests.js';
import { EMPTY_QUESTION_FORM_DRAFT, QuestionForm, type QuestionFormDraft } from './QuestionForm.js';
import { PlanView } from './PlanView.js';
import { Swarm } from './swarm/Swarm.js';
import { ProgressView } from './ProgressView.js';
import type { ProgressState } from './progress.js';
import { HOST_IDLE } from './assistant/store.js';
import { REACTION_FOR, swarmSpecFor, type SwarmPulse } from './swarm/spec.js';
import { droppedMinWidth, notchShift } from './notch.js';
import { CapsuleSwarm, capsuleContent, NotchCapsule } from './NotchCapsule.js';

/** Пауза кнопок решения после показа карточки — в `arm.ts` (её же берёт карточка согласия); здесь для импортов вида. */
export { CARD_ARM_MS };

/**
 * Что под видом помощника должно остаться в кадре: ряд стрелки ⌃ (`pt-1.5` + `h-5` + `pb-2` = 34 px) и запас на тень
 * `shadow-lg` выдвинутой формы. Вид не выше кадра за вычетом чёлки и этого запаса — длинный ответ прокручивается внутри.
 */
const BOTTOM_RESERVE_PX = 34 + 16;

export interface IslandAssistantProps {
  view: Omit<AssistantViewProps, 'maxHeight' | 'reducedMotion'>;
  open: boolean;
  collapsed: boolean;
  busy: boolean;
  mini: string | null;
  /** Реакция мини-роя (#9 §4.1–§4.3): события агентов, наведение и фазы помощника; новый объект на каждое событие. */
  pulse?: SwarmPulse | null;
  onOpen(): void;
}

/** Карточка согласия на папку (спека 2026-10-21, 4.4): ждущая первая и состояние решения по ней. */
export type IslandConsentProps = ConsentViewProps;

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
  requestKeyboard: boolean;
  navigationKey?: string | null;
  navigationEmpty?: boolean;
  onTakeRequestKeyboard(): void;
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
  /** Реакция мини-роя для капсулы в вырезе: события агентов есть и при выключенном помощнике. */
  miniPulse?: SwarmPulse | null;
  /** Клик по вырезу или капсуле (B26 F-B26-3): открыть остров; наведение в вырезе его не открывает. */
  onOpen?(): void;
  /** Карточка согласия (держит запуск Codex): показывается раньше карточек ленты; `null` — ждущих нет. */
  consent: IslandConsentProps | null;
  progress?: { selected: SessionRef | null; state: ProgressState; onSelect(ref: SessionRef): void; onClose(): void };
}

/** Направление перехода формы: класс `island-morph-grow` или `island-morph-shrink` в `island.css`. */
type Morph = 'grow' | 'shrink';

export const sessionKeyOf = (item: IslandRequest): string => item.key.slice(0, item.key.lastIndexOf('\u0000'));

function rowTarget(row: IslandRow): FocusTarget {
  return row.kind === 'session'
    ? { kind: 'session', ref: row.ref }
    : { kind: 'room', projectPath: row.projectPath, workId: row.workId, roomId: row.roomId };
}

/**
 * Мини-рой в кнопке пилюли: canvas 28 px лежит в кнопке 26 px, как `.dotbtn` макета; 30 кадров/с только пока помощник
 * занят. Пока помощник говорит — лицо капсулы выреза (`CapsuleSwarm`): рот идёт по голосу, эмоция — по предложению.
 */
function MiniSwarm({ assistant, reducedMotion }: { assistant: IslandAssistantProps; reducedMotion: boolean }): JSX.Element {
  const { host, input } = assistant.view;
  const sentenceMood = assistant.view.sentenceMood ?? undefined;
  const spec = useMemo(() => swarmSpecFor(host, input, true, sentenceMood), [host.phase, host.mood, input, sentenceMood]);
  if (input === 'speaking') return <CapsuleSwarm assistant={assistant} face pulse={assistant.pulse ?? null} reducedMotion={reducedMotion} height={32} />;
  return (
    <Swarm spec={spec} souls={150} width={28} height={28} d={17} cy={14} k={0.15} minPx={1.5} seed={5} fps={assistant.busy ? 30 : 0} pulse={assistant.pulse ?? null} reducedMotion={reducedMotion} />
  );
}

/** Облик «места»: сфера с янтарным кольцом подтверждения и без вращения (`rot = 0`), как `confirm` макета. */
const SEAT_SPEC = swarmSpecFor({ ...HOST_IDLE, phase: 'awaiting-confirm' }, 'idle', true);

/**
 * «Место» в шапке карточки (#9 §4.2, T7): рой 30 px держит кольцо, пока карточка открыта, а на её показ отвечает
 * реакцией вида запроса (разрешение и план — подскок, вопрос — кивок, терминал без карточки — как разрешение). В
 * покое 0 к/с (§5): кадры идут только на реакцию. Монтируется заново с каждой показанной карточкой (ключ `Card`),
 * поэтому реакция одна на показ.
 */
function SeatSwarm({ kind, reducedMotion }: { kind: 'permission' | 'question' | 'plan'; reducedMotion: boolean }): JSX.Element {
  const [pulse] = useState<SwarmPulse>(() => ({ reaction: REACTION_FOR[kind], at: performance.now() }));
  return <Swarm spec={SEAT_SPEC} souls={150} width={30} height={30} d={18} cy={15} k={0.15} minPx={1.5} seed={5} fps={0} pulse={pulse} reducedMotion={reducedMotion} className="-ml-1 shrink-0" />;
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
          <MiniSwarm assistant={props.assistant} reducedMotion={props.config.motion === 'reduce'} />
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
          <span>{S.island.pill(model.working, model.waiting, model.done, model.subagents, model.proposals)}</span>
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

function RoomLine({ room, api, selected }: { room: RoomRow; api: IslandApi; selected?: boolean }): JSX.Element {
  return <div data-testid="island-room" className="flex min-w-0 flex-wrap gap-1 text-[13px] text-foreground/75">
    {room.proposal === undefined ? null : <span className="min-w-0 truncate">{room.title}</span>}
    <button type="button" aria-current={selected ? 'true' : undefined} className={`min-w-0 cursor-pointer truncate rounded text-left hover:underline ${selected ? 'ring-1 ring-ring' : ''}`} onClick={() => api.open(rowTarget(room))}>
      {room.proposal === undefined ? room.title : S.island.openRoom}
    </button>
    <span className="shrink-0">· {room.proposal === undefined
      ? room.busy > 0 ? S.island.roomBusy(room.busy) : S.island.roomDone
      : <span className="rounded bg-white/10 px-1">{S.island.roomWaiting}</span>}</span>
    {room.proposal === undefined ? null : <span className="min-w-0 truncate">{room.proposal.leadLabel === null ? S.island.noLiveLead : S.island.roomLead(room.proposal.leadLabel)}</span>}
  </div>;
}

function Subagents({ row }: { row: SessionRow }): JSX.Element | null {
  const tasks = row.tasks;
  if (tasks === undefined) return null;
  const more = Math.max(0, (tasks.total ?? tasks.items.length) - tasks.items.length);
  return <div className="mb-2 ml-4 rounded border border-white/10 p-2 text-[13px]">
    <div className="flex items-center justify-between gap-2"><span>{S.island.subagentsActive}</span><span className="text-muted-foreground">{S.island.subagentsReported(tasks.reported)}</span></div>
    {tasks.total === null ? <p className="text-muted-foreground">{S.island.tasksUnknown}</p>
      : tasks.items.length === 0 ? <p className="text-muted-foreground">{S.island.tasksEmpty}</p> : null}
    <ul className="mt-1 flex flex-col gap-1">
      {tasks.items.slice(0, 8).map((task) => <li key={`${row.key}\u0000${task.id}`} data-testid="island-subagent" className="min-w-0">
        <span className="font-medium">{task.agentType ?? S.island.subagent}</span>
        {task.description === null ? null : <span className="ml-1 break-words text-muted-foreground">{task.description}</span>}
      </li>)}
    </ul>
    {more > 0 ? <p className="mt-1 text-muted-foreground">{S.island.tasksMore(more)}</p> : null}
  </div>;
}

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

function List(props: IslandViewProps): JSX.Element {
  const { model, api, onClearDone, progress } = props;
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
              .map((room) => <RoomLine key={room.key} room={room} api={api} selected={props.navigationKey === `room:${room.proposal?.key}`} />)}
            {group.rows
              .filter((row): row is SessionRow => row.kind === 'session')
              .map((row) => {
                const selected = progress?.selected != null && refKey(progress.selected) === refKey(row.ref);
                return <div key={row.key} data-testid="island-session">
                  <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                      {row.state === 'done' ? <DoneLine row={row} api={api} /> : (
                        <button type="button" className="flex w-full cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10" onClick={() => api.open(rowTarget(row))}>
                          {/* Точка — та же, что в сайдбаре: ждущая сессия «blocked», остальное (в работе) — «working». */}
                          <AgentStateDot state={row.state === 'subagents' ? 'idle' : row.state === 'needs-you' ? 'blocked' : 'working'} size="sm" />
                          <span className="min-w-0 flex-1 truncate">{row.label}</span>
                          {row.inTerminal ? <span className="text-[13px] text-muted-foreground">{S.island.waitingInTerminal}</span> : null}
                        </button>
                      )}
                    </div>
                    {progress !== undefined ? <button type="button" aria-label={S.island.progress.show} aria-expanded={selected}
                      className="cursor-pointer rounded px-2 py-1 text-muted-foreground hover:bg-white/10 hover:text-foreground"
                      onClick={() => selected ? progress.onClose() : progress.onSelect(row.ref)}>≡</button> : null}
                  </div>
                  <Subagents row={row} />
                  {selected && progress !== undefined ? <ProgressView state={progress.state} onClose={progress.onClose}
                    onOpen={() => api.open({ kind: 'session', ref: row.ref })} /> : null}
                </div>;
              })}
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
  return openButton;
}

/** Явное взаимодействие берёт клавиатуру; новая identity фокусирует контейнер только у текущего owner. */
function useRequestFocus(identity: string | null, owned: boolean, takeKeyboard: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const previousIdentity = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    if (owned) ref.current?.focus({ preventScroll: true });
  }, [identity, owned]);
  const isButton = (target: EventTarget): boolean => target instanceof Element && target.closest('button, [role="button"]') !== null;
  const guardButtonKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!owned && isButton(event.target) && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
  };
  return {
    ref,
    tabIndex: -1,
    onFocusCapture: (event: FocusEvent<HTMLDivElement>): void => {
      if (!isButton(event.target)) takeKeyboard();
    },
    onKeyDownCapture: guardButtonKeyboard,
    onKeyUpCapture: guardButtonKeyboard,
    onPointerDownCapture: (event: PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0 || isButton(event.target)) return;
      takeKeyboard();
      if (!(event.target instanceof Element) || event.target.closest('button, input, textarea, select, [contenteditable]') === null) event.currentTarget.focus({ preventScroll: true });
    },
  };
}

function ConsentRequest({ consent, showId, owned, selected, takeKeyboard }: { consent: IslandConsentProps; showId: number; owned: boolean; selected: boolean; takeKeyboard(): void }): JSX.Element {
  const { card } = consent;
  const identity = JSON.stringify([showId, card.id, card.kind, card.folder, card.projectPath, card.requestedBy]);
  const focus = useRequestFocus(identity, owned, takeKeyboard);
  return <div {...focus} data-testid="island-consent-request" aria-current={selected ? 'true' : undefined} className={selected ? 'rounded ring-1 ring-ring' : undefined}><ConsentView key={identity} {...consent} /></div>;
}

function Card(props: IslandViewProps & { questionDraft: QuestionFormDraft; onQuestionDraft(next: QuestionFormDraft): void; onQuestionSubmit(decision: Extract<FeedDecision, { kind: 'question' }>): void }): JSX.Element | null {
  const { items, index, showId, labels, api, onSelect, onDecide } = props;
  const item = items[index] ?? items[0];
  // Взведённая пара «показ + карточка» ровно одна: любая смена пары (другая карточка, в том числе виденная раньше,
  // или новый показ) снимает взвод в очистке эффекта и ставит паузу заново.
  const showKey = item === undefined ? null : `${showId}\u0000${item.key}\u0000${item.fingerprint ?? JSON.stringify([item.card, item.inWindow])}`;
  const focus = useRequestFocus(showKey, props.requestKeyboard, props.onTakeRequestKeyboard);
  const [planBodyHeight, setPlanBodyHeight] = useState(280);
  useLayoutEffect(() => {
    if (item?.card?.kind !== 'plan') return undefined;
    const element = focus.ref.current;
    const body = element?.querySelector<HTMLElement>('[role="region"]');
    if (element === null || body === null || body === undefined) return undefined;
    const measure = (): void => {
      // Всё кроме прокручиваемого текста: header, summary, кнопки, заметки, gaps и padding.
      const chrome = Math.max(0, element.getBoundingClientRect().height - body.getBoundingClientRect().height);
      setPlanBodyHeight(Math.max(0, Math.min(280, window.innerHeight - props.config.topInset - BOTTOM_RESERVE_PX - chrome)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element); observer.observe(body);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [showKey, item?.card?.kind, item?.note, props.config.topInset, focus.ref]);
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
    <div
      key={showKey}
      {...focus}
      data-testid="island-card"
      aria-current={props.navigationKey === `feed:${item.key}` ? 'true' : undefined}
      className={`island-reveal flex min-h-0 w-[440px] flex-col gap-2 px-3 pb-3 pt-1.5 text-sm ${props.navigationKey === `feed:${item.key}` ? 'rounded ring-1 ring-ring' : ''}`}
      style={item.card?.kind === 'question' || item.card?.kind === 'plan' ? { maxHeight: `calc(100vh - ${props.config.topInset + BOTTOM_RESERVE_PX}px)` } : undefined}
    >
      <div className="flex shrink-0 items-center gap-2">
        <SeatSwarm kind={item.card?.kind ?? 'permission'} reducedMotion={props.config.motion === 'reduce'} />
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
      <div title={item.summary} className="shrink-0 truncate font-mono text-sm">
        {item.summary}
      </div>
      {item.note === 'elsewhere' ? <div className="text-muted-foreground">{S.island.answeredElsewhere}</div> : null}
      {item.note === 'failed' ? <div className="text-[var(--status-warning-text)]">{S.island.failed}</div> : null}
      {item.card?.kind === 'plan' ? (
        <PlanView
          card={item.card}
          disabled={!armed || item.deciding || item.note === 'elsewhere'}
          canDecide={item.inWindow}
          maxBodyHeight={planBodyHeight}
          labels={{ plan: S.chat.cardKind.plan, approveAuto: S.chat.card.approveAuto, approveManual: S.chat.card.approveManual, changeInTerminal: S.island.planChangeInTerminal, truncated: S.island.planTruncated, terminalOnly: S.island.planTerminalOnly, openInParley: S.island.openInParley }}
          onDecide={(choice) => onDecide(item.key, { kind: 'plan', choice })}
          onOpenTerminal={() => api.open({ kind: 'session', ref: item.ref, view: 'terminal' })}
          onOpenInParley={() => api.open({ kind: 'session', ref: item.ref, cardId: item.card!.cardId })}
        />
      ) : item.card?.kind === 'question' && item.note !== 'elsewhere' ? (
        item.inWindow && item.card.state === 'pending' ? (
          <QuestionForm
            card={item.card}
            draft={props.questionDraft}
            onDraftChange={props.onQuestionDraft}
            disabled={!armed || item.deciding}
            onTakeKeyboard={props.onTakeRequestKeyboard}
            onSubmit={props.onQuestionSubmit}
            onOpenInParley={() => api.open({ kind: 'session', ref: item.ref, cardId: item.card!.cardId })}
            labels={{ ...S.chat.card, ...S.island.question, openInParley: S.island.openInParley }}
          />
        ) : (
          <>
            <div data-no-drag className="min-h-0 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
              {item.card.questions.map((question, at) => <div key={at}><p>{question.question}</p>{question.options.map((option, index) => <p key={index}>{option.label}{option.description === null ? '' : ` — ${option.description}`}</p>)}</div>)}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2"><Actions item={item} armed={armed} api={api} onDecide={onDecide} /></div>
          </>
        )
      ) : item.note === 'elsewhere' && item.card?.kind === 'question' ? null : (
        <div className="flex flex-wrap gap-2"><Actions item={item} armed={armed} api={api} onDecide={onDecide} /></div>
      )}
    </div>
  );
}

export function IslandView(props: IslandViewProps): JSX.Element {
  const { model, items, listOpen, config, retracted, doneCount, hovered, shapeRef, api, onDragStart, onDragEnd, onHide, assistant, consent, showId } = props;
  // Один draft выбранного вопроса живёт выше условного Card. showId не входит в identity: уборка и перекрытие не стирают ввод.
  const selected = items[props.index] ?? items[0];
  const question = selected?.inWindow && selected.note !== 'elsewhere' && selected.card?.kind === 'question' && selected.card.state === 'pending' ? selected.card : null;
  const identity = question === null ? null : JSON.stringify([refKey(selected!.ref), question.cardId, question.questions]);
  const generation = useRef({ identity, epoch: 0 });
  if (generation.current.identity !== identity) generation.current = { identity, epoch: generation.current.epoch + 1 };
  const epoch = generation.current.epoch;
  const [questionState, setQuestionState] = useState<{ identity: string | null; draft: QuestionFormDraft }>(() => ({ identity, draft: EMPTY_QUESTION_FORM_DRAFT }));
  if (questionState.identity !== identity) setQuestionState({ identity, draft: EMPTY_QUESTION_FORM_DRAFT });
  const questionDraft = questionState.identity === identity ? questionState.draft : EMPTY_QUESTION_FORM_DRAFT;
  const onQuestionDraft = (draft: QuestionFormDraft): void => {
    setQuestionState((current) => generation.current.epoch === epoch && identity !== null && current.identity === identity ? { identity, draft } : current);
  };
  const onQuestionSubmit = (decision: Extract<FeedDecision, { kind: 'question' }>): void => {
    if (generation.current.epoch === epoch && identity !== null && selected !== undefined) props.onDecide(selected.key, decision);
  };
  const drag = useShapeDrag(api, { onDragStart, onDragEnd, onSwipeUp: onHide });
  const contentRef = useRef<HTMLDivElement>(null);
  /**
   * Размер содержимого в пикселях (до первого замера `null` — у формы нет явных `width`/`height`) и направление
   * перехода к нему (#9 §4.4): площадь выросла — рост, упала — сжатие, та же — прежнее.
   */
  const [shape, setShape] = useState<{ size: { width: number; height: number } | null; morph: Morph }>({ size: null, morph: 'grow' });
  const notch = config.notch ?? null;
  const notchKey = notch === null ? null : `${notch.width}x${notch.height}@${notch.centerX}`;
  // Смена выреза (#9 §12.4): новый размер сразу и без класса перехода. Класс возвращается через два кадра после
  // последней смены размера, когда форма уже стоит в новом размере.
  const [snap, setSnap] = useState({ key: notchKey, on: false });
  if (snap.key !== notchKey) setSnap({ key: notchKey, on: true });
  useEffect(() => {
    if (!snap.on) return undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setSnap((current) => ({ ...current, on: false })));
    });
    return () => cancelAnimationFrame(frame);
  }, [snap.on, shape.size]);
  // Уборка и выдвижение меняют отступ сверху и скругление сразу, а размер — лишь после замера: направление ставится в
  // том же кадре, иначе отступ и скругление поехали бы кривой прошлого перехода.
  const [morphRetracted, setMorphRetracted] = useState(retracted);
  if (morphRetracted !== retracted) {
    setMorphRetracted(retracted);
    setShape((current) => ({ ...current, morph: retracted ? 'shrink' : 'grow' }));
  }
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (element === null) return undefined;
    const measure = (): void => {
      const width = Math.ceil(element.offsetWidth);
      const height = Math.ceil(element.offsetHeight);
      // Нулевой размер — страница ещё не разложена: форма схлопнулась бы и потом росла «из точки».
      if (width === 0 || height === 0) return;
      setShape((current) => {
        const { size } = current;
        if (size !== null && size.width === width && size.height === height) return current;
        const area = width * height;
        const before = size === null ? 0 : size.width * size.height;
        return { size: { width, height }, morph: area > before ? 'grow' : area < before ? 'shrink' : current.morph };
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
    // Смена выреза замеряется сразу, в том же кадре: форма встаёт в новый размер без морфа.
  }, [notchKey]);
  // Три облика одной формы. Выдвинутая: чёрное под чёлкой (отступ внутри содержимого), тень. Брусок: форма под чёлкой и на
  // 2 px ниже края. `✅ N`: сразу под чёлкой. У убранных обводка вместо тени.
  const peek = retracted && doneCount > 0;
  const assistantBig = assistant !== null && assistant.open && !assistant.collapsed;
  // В вырезе: выдвинутый вид, капсула фона или голый вырез. Наведение форму не выдвигает: открывают клик, язычок и
  // хоткеи (`listOpen`, помощник), а запросы к человеку — сами, и предложение комнаты тоже (B26 F-B26-3).
  const dropped = !retracted && (listOpen || assistantBig || consent !== null || items.length > 0 || (model.proposals ?? 0) > 0 ||
    props.navigationKey != null || props.navigationEmpty === true);
  const capsule = notch === null || dropped ? null : capsuleContent(model, doneCount, assistant);
  const notchView = notch === null ? null : dropped ? 'dropped' : capsule !== null ? 'capsule' : 'bare';
  const look =
    notchView !== null ? (notchView === 'dropped' ? 'rounded-b-[22px] shadow-lg' : notchView === 'capsule' ? 'rounded-b-[14px] shadow-none' : 'rounded-b-[10px] shadow-none')
      : !retracted ? 'rounded-b-[22px] shadow-lg' : peek ? 'rounded-b-[14px] shadow-none ring-1 ring-white/50' : 'rounded-[3px] shadow-none ring-1 ring-white/50';
  const marginTop = notchView !== null || !retracted ? 0 : peek ? config.topInset : config.topInset + 2;
  const paddingTop = notch !== null ? (notchView === 'dropped' ? notch.height : 0) : retracted ? 0 : config.topInset;
  const minWidth = notch !== null && notchView === 'dropped' ? droppedMinWidth(notch) : undefined;
  // «Reduce motion» Parley — как системный reduced motion: класса перехода нет, а `data-motion` гасит появление внутри.
  const morph = config.motion === 'reduce' || snap.on ? '' : `island-morph-${shape.morph}`;
  return (
    // Обёртка без выреза не участвует в раскладке (`contents`): форма — прямой элемент flex-корня `IslandApp`, `shrink-0`,
    // чтобы узкий кадр не сжимал её. В вырезе обёртка сдвигает форму к центру выреза и держит плечи.
    <div data-testid="island-frame" className={notch === null ? 'contents' : 'relative shrink-0'} style={notch === null ? undefined : { left: notchShift(notch) }}>
      {notch === null ? null : (
        <>
          <i aria-hidden className="island-shoulder island-shoulder-left" />
          <i aria-hidden className="island-shoulder island-shoulder-right" />
        </>
      )}
      <div
        ref={shapeRef}
        data-testid="island"
        data-navigation-key={props.navigationKey ?? undefined}
        tabIndex={props.requestKeyboard ? -1 : undefined}
        data-retracted={retracted}
        data-motion={config.motion}
        aria-hidden={retracted || undefined}
        className={`shrink-0 overflow-hidden bg-black text-sm text-foreground ${look} ${morph} ${drag.dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{ ...shape.size, marginTop }}
        {...drag.handlers}
      >
        <div ref={contentRef} data-testid="island-content" className="w-max" style={{ paddingTop, minWidth }}>
          {notch !== null && notchView === 'bare' ? (
            <div data-testid="island-notch" className="cursor-pointer" style={{ width: notch.width, height: notch.height }} onClick={props.onOpen} />
          ) : notch !== null && capsule !== null ? (
            <NotchCapsule notch={notch} content={capsule} assistant={assistant} pulse={props.miniPulse ?? null} reducedMotion={config.motion === 'reduce'} onOpen={() => props.onOpen?.()} />
          ) : retracted ? (
            // Содержимое убранной формы меняется сразу, а форма доезжает до него переходом.
            peek ? (
              <div className="whitespace-nowrap px-3 py-1 text-sm">{S.island.donePeek(doneCount)}</div>
            ) : (
              <div className="h-[5px] w-10" />
            )
          ) : (
            <>
              {assistantBig ? (
                <AssistantView {...assistant.view} maxHeight={`calc(100vh - ${config.topInset + BOTTOM_RESERVE_PX}px)`} reducedMotion={config.motion === 'reduce'} />
              ) : consent !== null ? (
                <ConsentRequest consent={consent} showId={showId} owned={props.requestKeyboard} selected={props.navigationKey === `consent:${consent.card.id}`} takeKeyboard={props.onTakeRequestKeyboard} />
              ) : props.navigationKey?.startsWith('room:') ? (
                <><Pill {...props} />{model.groups.length > 0 ? <List {...props} /> : null}</>
              ) : items.length > 0 ? (
                <Card {...props} questionDraft={questionDraft} onQuestionDraft={onQuestionDraft} onQuestionSubmit={onQuestionSubmit} />
              ) : (
                <>
                  <Pill {...props} />
                  {listOpen && model.groups.length > 0 ? <List {...props} /> : null}
                </>
              )}
              {!assistantBig && props.navigationEmpty ? <p data-testid="island-no-pending" role="status" className="px-3 pb-2 text-xs text-muted-foreground">{S.island.noPending}</p> : null}
              {!assistantBig && (consent !== null || items.length > 0) && (model.proposals ?? 0) > 0 ? (
                <div className="flex max-w-[400px] flex-col gap-1 px-3 pb-3">
                  {model.groups.flatMap((group) => group.rows).filter((row): row is RoomRow => row.kind === 'room' && row.proposal !== undefined)
                    .map((room) => <RoomLine key={room.key} room={room} api={api} />)}
                </div>
              ) : null}
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
    </div>
  );
}
