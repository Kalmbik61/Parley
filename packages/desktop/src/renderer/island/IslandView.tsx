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
 * Убранный остров (`retracted`) уезжает вверх за кадр: сдвигает обёртка формы (`island-slide`), а не сама форма —
 * у размера и сдвига разная длительность. Тащить остров можно за любое место формы (`useShapeDrag`), кроме кнопок.
 */

import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { FeedDecision } from '@parley/core';
import { S } from '../../shared/strings.js';
import type { FocusTarget } from '../../shared/bridge.js';
import type { IslandApi, IslandConfig } from '../../shared/island.js';
import { alwaysRules } from '../chat/cards/always-rules.js';
import { AgentIcon } from '../components/AgentIcon.js';
import { AgentStateDot } from '../components/AgentStateDot.js';
import { Button } from '../ui/button.js';
import { useShapeDrag } from './drag.js';
import type { IslandModel, IslandRow } from './model.js';
import type { IslandRequest } from './requests.js';
import { simpleChoices } from './simple-question.js';

/**
 * Сколько кнопки решения (Allow / Always / Deny / варианты ответа) выключены после каждого показа карточки: остров
 * появляется под курсором у верхнего края экрана, а `acceptFirstMouse` пропускает первый клик — без паузы случайный
 * клик по чужому окну разрешил бы команду. Пауза — на показ и на карточку: заново после скрытия и нового появления
 * острова (`showId`) и при переходе к любой карточке, в том числе уже виденной. «Open in Parley» и стрелки не
 * защищены: они ничего не решают.
 */
export const CARD_ARM_MS = 500;

export interface IslandViewProps {
  model: IslandModel;
  items: readonly IslandRequest[];
  index: number;
  config: IslandConfig;
  listOpen: boolean;
  /** Остров убран: форма уехала вверх за кадр окна, на её месте — язычок (`IslandTab`). */
  retracted: boolean;
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
  /** «×»: убрать остров до следующего запроса или выдвижения язычком. */
  onHide(): void;
  onSelect(index: number): void;
  onDecide(key: string, decision: FeedDecision): void;
  onHintDone(): void;
}

const sessionKeyOf = (item: IslandRequest): string => item.key.slice(0, item.key.lastIndexOf('\u0000'));

function rowTarget(row: IslandRow): FocusTarget {
  return row.kind === 'session'
    ? { kind: 'session', ref: row.ref }
    : { kind: 'room', projectPath: row.projectPath, workId: row.workId, roomId: row.roomId };
}

function HideButton({ onHide }: { onHide(): void }): JSX.Element {
  return (
    <button type="button" aria-label={S.island.tuckAway} title={S.island.tuckAway} onClick={onHide} className="cursor-pointer px-1 text-muted-foreground hover:text-foreground">
      ×
    </button>
  );
}

function Pill(props: IslandViewProps): JSX.Element {
  const { model, onToggleList, onHide } = props;
  return (
    // Список — по наведению или клику (спека, раздел 4): наведение приходит от main (`IslandApp`), он же закрывает список
    // при уходе курсора. Строка занимает всю ширину содержимого, а при открытом списке оно растёт до 400 px:
    // содержимое строки по центру, чтобы пилюля не уезжала вбок из-под курсора.
    <div data-testid="island-pill" className="flex items-center justify-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm">
      {model.active ? (
        // Клик только открывает список: наведение открыло его мгновением раньше, и «переключатель» тут же закрывал бы.
        // Не кнопка: за кнопку остров не тащится, а счётчики — самое большое место пилюли.
        <div data-testid="island-counters" className="flex items-center gap-1.5" onClick={() => onToggleList(true)}>
          {model.providers.map((provider) => (
            <AgentIcon key={provider} provider={provider} size={14} />
          ))}
          <span>{S.island.pill(model.working, model.waiting)}</span>
        </div>
      ) : (
        <span data-testid="island-idle" className="text-muted-foreground">
          {S.island.idle}
        </span>
      )}
      <HideButton onHide={onHide} />
    </div>
  );
}

type RoomRow = Extract<IslandRow, { kind: 'room' }>;
type SessionRow = Extract<IslandRow, { kind: 'session' }>;

function List({ model, api }: IslandViewProps): JSX.Element {
  return (
    <div data-testid="island-list" className="island-reveal flex max-h-[360px] w-[400px] flex-col gap-2 overflow-y-auto px-3 pb-3 text-sm">
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
                <span className="shrink-0">· {S.island.roomBusy(room.busy)}</span>
              </div>
            ))}
          {group.rows
            .filter((row): row is SessionRow => row.kind === 'session')
            .map((row) => (
              <button key={row.key} type="button" className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10" onClick={() => api.open(rowTarget(row))}>
                {/* Точка — та же, что в сайдбаре: ждущая сессия «blocked», остальное (в работе) — «working». */}
                <AgentStateDot state={row.state === 'needs-you' ? 'blocked' : 'working'} size="sm" />
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                {row.inTerminal ? <span className="text-[13px] text-muted-foreground">{S.island.waitingInTerminal}</span> : null}
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}

function Actions({ item, armed, api, onDecide }: { item: IslandRequest; armed: boolean; api: IslandApi; onDecide: IslandViewProps['onDecide'] }): JSX.Element {
  const { card } = item;
  const open = (): void => api.open(item.inWindow ? { kind: 'session', ref: item.ref, cardId: card.cardId } : { kind: 'session', ref: item.ref });
  // Решение выключено, пока оно уходит, и первые `CARD_ARM_MS` после показа запроса.
  const disabled = item.deciding || !armed;
  const openButton = (
    <Button data-testid="island-open" size="default" variant="outline" className="cursor-pointer text-sm" onClick={open}>
      {S.island.openInParley}
    </Button>
  );
  if (!item.inWindow) return openButton;
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
  const { items, index, showId, labels, api, onSelect, onDecide, onHide } = props;
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
        <HideButton onHide={onHide} />
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
  const { model, items, listOpen, config, retracted, shapeRef, api, onDragStart, onDragEnd, onHintDone } = props;
  const drag = useShapeDrag(api, { onDragStart, onDragEnd });
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
  return (
    // Убранный остров уезжает вверх на свою высоту плюс 40 px и без тени (иначе у верхнего края кадра остаётся серая полоса); без `retracted` обёртка стоит на месте.
    <div
      data-testid="island-slide"
      data-retracted={retracted}
      aria-hidden={retracted || undefined}
      className={`transition-transform duration-300 ease-out motion-reduce:transition-none ${retracted ? '-translate-y-[calc(100%_+_40px)]' : ''}`}
    >
      <div
        ref={shapeRef}
        data-testid="island"
        className={`overflow-hidden rounded-b-[22px] bg-black text-sm text-foreground ${retracted ? 'shadow-none' : 'shadow-lg'} transition-[width,height] duration-[250ms] ease-out motion-reduce:transition-none ${drag.dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={size ?? undefined}
        {...drag.handlers}
      >
        <div ref={contentRef} data-testid="island-content" className="w-max" style={{ paddingTop: config.topInset }}>
          {!config.hintShown ? (
            <div className="flex items-center gap-2 whitespace-nowrap px-3 pt-1.5 text-xs text-muted-foreground">
              <span>{S.island.hint}</span>
              <button type="button" className="cursor-pointer underline" onClick={onHintDone}>
                {S.island.gotIt}
              </button>
            </div>
          ) : null}
          {items.length > 0 ? <Card {...props} /> : (
            <>
              <Pill {...props} />
              {listOpen && model.groups.length > 0 ? <List {...props} /> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
