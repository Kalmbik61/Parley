/**
 * Вид острова (спека 2026-10-12, раздел 4): пилюля, список «в работе» или карточка запроса. Чистый вид: всё
 * приходит пропсами, решения и переходы — колбэками. Остров всегда тёмный (чёрный, как чёлка).
 */

import { useEffect, useState } from 'react';
import type { FeedDecision } from '@parley/core';
import { S } from '../../shared/strings.js';
import type { FocusTarget } from '../../shared/bridge.js';
import type { IslandApi, IslandConfig } from '../../shared/island.js';
import { alwaysRules } from '../chat/cards/always-rules.js';
import { AgentIcon } from '../components/AgentIcon.js';
import { AgentStateDot } from '../components/AgentStateDot.js';
import { Button } from '../ui/button.js';
import { DragHandle } from './DragHandle.js';
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
  /** Номер показа острова: растёт каждый раз, когда окно из скрытого становится видимым (`IslandApp`). */
  showId: number;
  labels: ReadonlyMap<string, { session: string; work: string; project: string }>;
  api: IslandApi;
  onToggleList(open: boolean): void;
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
    <button type="button" aria-label={S.island.hide} title={S.island.hide} onClick={onHide} className="px-1 text-neutral-400 hover:text-neutral-100">
      ×
    </button>
  );
}

function Pill(props: IslandViewProps): JSX.Element {
  const { model, api, onToggleList, onHide } = props;
  return (
    // Список — по наведению или клику (спека, раздел 4); уход курсора с острова закрывает его (`IslandApp`).
    <div data-testid="island-pill" className="flex items-center gap-2 whitespace-nowrap px-3 py-1.5 text-xs" onMouseEnter={() => onToggleList(true)}>
      <DragHandle api={api} />
      {/* Клик только открывает список: наведение открыло его мгновением раньше, и «переключатель» тут же закрывал бы. */}
      <button type="button" className="flex items-center gap-1.5" onClick={() => onToggleList(true)}>
        {model.providers.map((provider) => (
          <AgentIcon key={provider} provider={provider} size={14} />
        ))}
        <span>{S.island.pill(model.working, model.waiting)}</span>
      </button>
      <HideButton onHide={onHide} />
    </div>
  );
}

function List({ model, api }: IslandViewProps): JSX.Element {
  return (
    <div data-testid="island-list" className="flex max-h-80 w-[360px] flex-col gap-2 overflow-y-auto px-3 pb-3 text-xs">
      {model.groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <div className="text-neutral-400">
            {group.title} <span className="text-neutral-500">· {group.project}</span>
          </div>
          {group.rows.map((row) => (
            <button key={row.key} type="button" className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10" onClick={() => api.open(rowTarget(row))}>
              {/* Точка — та же, что в сайдбаре: ждущая сессия «blocked», остальное (в работе, комната) — «working». */}
              <AgentStateDot state={row.kind === 'session' && row.state === 'needs-you' ? 'blocked' : 'working'} size="sm" />
              <span className="min-w-0 flex-1 truncate">{row.kind === 'session' ? row.label : row.title}</span>
              {row.kind === 'session' && row.inTerminal ? <span className="text-neutral-400">{S.island.waitingInTerminal}</span> : null}
              {row.kind === 'room' ? <span className="text-neutral-400">{S.island.roomBusy(row.busy)}</span> : null}
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
    <Button data-testid="island-open" size="sm" variant="outline" onClick={open}>
      {S.island.openInParley}
    </Button>
  );
  if (!item.inWindow) return openButton;
  if (card.kind === 'permission') {
    const rules = alwaysRules(card.suggestions);
    return (
      <>
        <Button data-testid="island-allow" size="sm" disabled={disabled} onClick={() => onDecide(item.key, { kind: 'permission', behavior: 'allow' })}>
          {S.island.allow}
        </Button>
        {rules !== null ? (
          <Button data-testid="island-always" size="sm" variant="outline" title={rules.join(', ')} disabled={disabled} onClick={() => onDecide(item.key, { kind: 'permission', behavior: 'allow', always: true })}>
            {S.island.always}
          </Button>
        ) : null}
        <Button data-testid="island-deny" size="sm" variant="outline" disabled={disabled} onClick={() => onDecide(item.key, { kind: 'permission', behavior: 'deny' })}>
          {S.island.deny}
        </Button>
      </>
    );
  }
  const simple = simpleChoices(card);
  if (simple !== null) {
    return (
      <>
        {simple.options.map((label) => (
          <Button key={label} data-testid="island-option" size="sm" variant="outline" disabled={disabled} onClick={() => onDecide(item.key, { kind: 'question', answers: { [simple.question]: label } })}>
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
    <div data-testid="island-card" className="flex w-[380px] flex-col gap-2 px-3 pb-3 pt-1.5 text-xs">
      <div className="flex items-center gap-2">
        <DragHandle api={api} />
        <span className="min-w-0 flex-1 truncate">
          {label === undefined ? null : `${label.session} · ${label.work}`}
          {label === undefined ? null : <span className="text-neutral-500"> · {label.project}</span>}
        </span>
        {items.length > 1 ? (
          <span className="flex items-center gap-1 text-neutral-400">
            <button type="button" aria-label={S.island.previous} onClick={() => onSelect(index - 1)} disabled={index === 0}>
              ‹
            </button>
            <span>{S.island.of(index + 1, items.length)}</span>
            <button type="button" aria-label={S.island.next} onClick={() => onSelect(index + 1)} disabled={index >= items.length - 1}>
              ›
            </button>
          </span>
        ) : null}
        <HideButton onHide={onHide} />
      </div>
      <div title={item.summary} className="truncate font-mono text-[12px]">
        {item.summary}
      </div>
      {item.note === 'elsewhere' ? <div className="text-neutral-400">{S.island.answeredElsewhere}</div> : null}
      {item.note === 'failed' ? <div className="text-[var(--status-warning-text)]">{S.island.failed}</div> : null}
      <div className="flex flex-wrap gap-2">
        <Actions item={item} armed={armed} api={api} onDecide={onDecide} />
      </div>
    </div>
  );
}

export function IslandView(props: IslandViewProps): JSX.Element {
  const { items, listOpen, config, onHintDone } = props;
  return (
    <div data-testid="island" className="rounded-b-[18px] bg-black text-neutral-100 shadow-lg" style={{ paddingTop: config.topInset }}>
      {!config.hintShown ? (
        <div className="flex items-center gap-2 whitespace-nowrap px-3 pt-1.5 text-[11px] text-neutral-300">
          <span>{S.island.hint}</span>
          <button type="button" className="underline" onClick={onHintDone}>
            {S.island.gotIt}
          </button>
        </div>
      ) : null}
      {items.length > 0 ? <Card {...props} /> : (
        <>
          <Pill {...props} />
          {listOpen ? <List {...props} /> : null}
        </>
      )}
    </div>
  );
}
