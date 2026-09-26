/**
 * Панель: экран живого агента, а без него — карточка выбранной сессии
 * (дизайн TUI v2, 2.2; макеты §2). Это единственное место, где харнесс рисует
 * поверх области гостя; оверлеи и подтверждения живут выше, в композиции.
 */

import {
  displayStatus,
  historyStatus,
  workPaths,
  type WorkEntry,
  type WorkSession,
} from '@harnas/core';
import { Box, Text } from 'ink';
import path from 'node:path';
import type { ReactNode } from 'react';
import stringWidth from 'string-width';
import { formatClock, truncate } from '../format.js';
import { glyphs } from '../glyphs.js';
import type { TerminalSnapshot } from '../pty/terminal-buffer.js';
import { pad, zoneBg } from '../theme/fill.js';
import { borderBoxProps, theme } from '../theme/index.js';
import { dotColor, dotGlyph, type DotState } from './activity-dot.js';
import { TerminalView } from './terminal-view.js';

/** Отступ карточки слева и запас справа (макеты §2). */
const INDENT = '   ';
const MARGIN = 6;

export interface CardProps {
  /** `null` — сессий нет вовсе: карточка объясняет, с чего начать. */
  session: WorkSession | null;
  state: DotState;
  /** Ярлык породившей сессии: «создана сессией «бэкенд»». */
  parent: string | null;
  /** Путь брифа от корня проекта: у `pending` показывается только он (решение №12). */
  brief: string | null;
  /** Имя префикса в подсказках карточки. */
  prefix: string;
  /**
   * PTY живой сессии у харнесса: панель просто отпустили (ходьба по сайдбару),
   * подключиться можно. Без этого карточка врала бы «запущена вне харнесса».
   */
  atHarness: boolean;
}

/**
 * Карточка выбранной сессии: ярлык родителя и путь брифа берутся из карты
 * работы, всё остальное — из самой сессии.
 */
export function cardFor(
  entry: WorkEntry | undefined,
  session: WorkSession | null,
  state: DotState,
  prefix: string,
  atHarness: boolean,
): CardProps {
  const parent =
    entry === undefined || session?.parent == null
      ? null
      : (entry.map.sessions.find((item) => item.id === session.parent)?.label ?? null);
  // У `pending` показывается только путь брифа, сам бриф — в оверлее (решение №12).
  const brief =
    entry === undefined || session === null || displayStatus(session) !== 'pending'
      ? null
      : path.join(
          path.relative(entry.projectPath, workPaths(entry.projectPath, entry.map.work.id).briefs),
          `${session.id}.md`,
        );
  return { session, state, parent, brief, prefix, atHarness };
}

/** Последняя ступень истории в нынешнем статусе: из неё время и код выхода. */
const lastStep = (session: WorkSession): WorkSession['history'][number] | undefined =>
  [...session.history].reverse().find((entry) => historyStatus(entry) === displayStatus(session));

/** Когда сессия закончилась: время последней ступени (макеты §2). */
const closedAt = (session: WorkSession): string =>
  formatClock(lastStep(session)?.at ?? session.endedAt);

/** Как вышел процесс: время и код выхода или сигнал — примета `exited`. */
function exitTail(session: WorkSession): string {
  const last = lastStep(session);
  const at = formatClock(last?.at ?? session.endedAt);
  if (last?.signal !== undefined && last.signal !== 0) return `${at} · сигнал ${last.signal}`;
  // Кода нет вовсе или он `null` (процесс завершился без харнесса) — молчим.
  return typeof last?.exitCode === 'number' ? `${at} · код ${last.exitCode}` : at;
}

/** Строки карточки по состоянию сессии (макеты §2). */
function cardLines(
  { session, state, parent, brief, prefix, atHarness }: CardProps,
  glyph: string,
): string[] {
  if (session === null) {
    return ['сессий нет', `${prefix} c — новая сессия · ${prefix} g — возобновить из истории`];
  }
  const head = `${glyph} ${session.label}`;

  // Живая сессия попадает в карточку только одна: та, чей PTY не у харнесса (5.4).
  if (displayStatus(session) === 'active') {
    // Своя же сессия, от которой панель отпустили ходьбой по сайдбару: к ней
    // можно вернуться, и карточка зовёт это сделать, а не выдумывает чужой PTY.
    if (atHarness) {
      return [
        `${head} · ${state}`,
        `pid ${session.pid ?? '—'} · запущена харнессом`,
        '',
        `${prefix} s → Enter — подключить`,
      ];
    }
    return [
      `${head} · ${state} · запущена вне харнесса`,
      `pid ${session.pid ?? '—'} · подключение невозможно: PTY не у харнесса`,
      '',
      `${prefix} i — детали`,
    ];
  }

  if (displayStatus(session) === 'pending') {
    return [
      `${head} · pending`,
      // Роль видна до запуска: пикера агентов у `prefix c` и `prefix C` нет, и
      // карточка — единственное место, где имя сверяется перед стартом (5.1).
      ...(session.agent === null ? [] : [`агент: ${session.agent}`]),
      ...(parent === null ? [] : [`создана сессией «${parent}»`]),
      ...(brief === null ? [] : [`бриф: ${brief}`]),
      // Каким будет старт: задачи нет — бриф уйдёт контекстом, и агент будет
      // ждать первого сообщения пользователя (план от 2026-09-06, B).
      `старт: ${session.task === '' ? 'ждёт ваш запрос' : 'по брифу'}`,
      '',
      'Enter — запустить (покажет бриф)',
    ];
  }

  if (displayStatus(session) === 'exited') {
    return [
      `${head} · exited ${exitTail(session)}`,
      session.summary === null ? 'отчёта не было · резюме: нет' : `резюме: «${session.summary}»`,
      `${prefix} R — дозаказать авто-резюме`,
      '',
      'Enter — возобновить',
    ];
  }

  // `done` и `failed` — отчёт агента, а не выход процесса: код здесь не при чём.
  return [
    `${head} · ${displayStatus(session)} ${closedAt(session)}`,
    session.summary === null ? 'отчёта нет' : `«${session.summary}»`,
    ...session.artifacts.map((artifact) => `арт: ${artifact.kind}: ${artifact.path}`),
    '',
    'Enter — возобновить (резюме перезапишет новый report)',
  ];
}

/**
 * Хвостовая добивка строки карточки до ширины панели: только при
 * `theme().fills` (5.1) — иначе кадр обязан остаться прежним, а строки
 * карточки сегодня останавливаются на `room`, не доходя до `width`.
 */
function cardTail(used: number, width: number): string {
  return theme().fills ? pad(used, width) : '';
}

/** Экспортирован для прямой проверки заливки строк без рамки `Panel`. */
export function Card({ card, width }: { card: CardProps; width: number }): ReactNode {
  const g = glyphs();
  const glyph = dotGlyph(card.state, g);
  const room = Math.max(10, width - MARGIN);
  const [first = '', ...rest] = cardLines(card, glyph);
  const firstText =
    card.session === null
      ? truncate(first, room, g.ellipsis)
      : `${glyph}${truncate(first.slice(glyph.length), room - glyph.length, g.ellipsis)}`;

  return (
    <Box flexDirection="column">
      <Text {...zoneBg(theme().bg.panel)}>{theme().fills ? pad(0, width) : ' '}</Text>
      <Text wrap="truncate" {...zoneBg(theme().bg.panel)}>
        {INDENT}
        {card.session === null ? (
          firstText
        ) : (
          <>
            <Text {...dotColor(card.state)}>{glyph}</Text>
            {truncate(first.slice(glyph.length), room - glyph.length, g.ellipsis)}
          </>
        )}
        {cardTail(INDENT.length + stringWidth(firstText), width)}
      </Text>
      {rest.map((line, at) => {
        const text = line === '' ? ' ' : `${INDENT}${truncate(line, room, g.ellipsis)}`;
        return (
          <Text key={at} wrap="truncate" {...theme().fg.muted} {...zoneBg(theme().bg.panel)}>
            {text}
            {cardTail(stringWidth(text), width)}
          </Text>
        );
      })}
    </Box>
  );
}

export interface PanelProps {
  /** Экран живого агента; `undefined` — панель показывает карточку. */
  screen: TerminalSnapshot | undefined;
  card: CardProps;
  /**
   * Размеры ЭКРАНА ГОСТЯ, без рамки: ровно те, что ушли в `node-pty`. Рамку
   * панель добавляет к ним сама (план рамок, задача 6). Так у бюджета один
   * источник: считать его вторым разом здесь — значит однажды разойтись
   * с тем, что выставлено самому псевдотерминалу.
   */
  width: number;
  height: number;
  /** Слушает ли панель ввод: рамка cyan, когда `false`, иначе dim — приём граней сайдбара (план рамок, задача 6). */
  navigating: boolean;
}

/** Рамка панели: по ячейке с каждой стороны. */
export const PANEL_FRAME = 1;

/**
 * Рамка по всем четырём сторонам через штатный `Box`: у панели, в отличие от
 * сайдбара, нет контракта «номер строки ↔ цель клика», ради которого сайдбар
 * рисует грани символами (план рамок, задача 6). Цвет — тот же приём, что и у
 * граней сайдбара: активная зона cyan, неактивная — dim.
 */
export function Panel({ screen, card, width, height, navigating }: PanelProps): ReactNode {
  const g = glyphs();
  const active = !navigating;
  return (
    <Box
      flexDirection="column"
      width={width + 2 * PANEL_FRAME}
      height={height + 2 * PANEL_FRAME}
      borderStyle={g.ascii ? 'classic' : 'round'}
      {...borderBoxProps(active ? theme().border.active : theme().border.idle)}
    >
      {screen !== undefined ? (
        <TerminalView snapshot={screen} height={height} />
      ) : (
        <Card card={card} width={width} />
      )}
    </Box>
  );
}
