/**
 * Панель: экран живого агента, а без него — карточка выбранной сессии
 * (дизайн TUI v2, 2.2; макеты §2). Это единственное место, где харнесс рисует
 * поверх области гостя; оверлеи и подтверждения живут выше, в композиции.
 */

import { workPaths, type WorkEntry, type WorkSession } from '@harnas/core';
import { Box, Text } from 'ink';
import path from 'node:path';
import type { ReactNode } from 'react';
import { formatClock, truncate } from '../format.js';
import { glyphs } from '../glyphs.js';
import type { TerminalSnapshot } from '../pty/terminal-buffer.js';
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
    entry === undefined || session === null || session.status !== 'pending'
      ? null
      : path.join(
          path.relative(entry.projectPath, workPaths(entry.projectPath, entry.map.work.id).briefs),
          `${session.id}.md`,
        );
  return { session, state, parent, brief, prefix, atHarness };
}

/** Последняя ступень истории в нынешнем статусе: из неё время и код выхода. */
const lastStep = (session: WorkSession): WorkSession['history'][number] | undefined =>
  [...session.history].reverse().find((entry) => entry.status === session.status);

/** Когда сессия закончилась: время последней ступени (макеты §2). */
const closedAt = (session: WorkSession): string =>
  formatClock(lastStep(session)?.at ?? session.endedAt);

/** Как вышел процесс: время и код выхода или сигнал — примета `exited`. */
function exitTail(session: WorkSession): string {
  const last = lastStep(session);
  const at = formatClock(last?.at ?? session.endedAt);
  if (last?.signal !== undefined && last.signal !== 0) return `${at} · сигнал ${last.signal}`;
  return last?.exitCode === undefined ? at : `${at} · код ${last.exitCode}`;
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
  if (session.status === 'active') {
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

  if (session.status === 'pending') {
    return [
      `${head} · pending`,
      ...(parent === null ? [] : [`создана сессией «${parent}»`]),
      ...(brief === null ? [] : [`бриф: ${brief}`]),
      '',
      'Enter — запустить (покажет бриф)',
    ];
  }

  if (session.status === 'exited') {
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
    `${head} · ${session.status} ${closedAt(session)}`,
    session.summary === null ? 'отчёта нет' : `«${session.summary}»`,
    ...session.artifacts.map((artifact) => `арт: ${artifact.kind}: ${artifact.path}`),
    '',
    'Enter — возобновить (резюме перезапишет новый report)',
  ];
}

function Card({ card, width }: { card: CardProps; width: number }): ReactNode {
  const g = glyphs();
  const glyph = dotGlyph(card.state, g);
  const room = Math.max(10, width - MARGIN);
  const [first = '', ...rest] = cardLines(card, glyph);

  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text wrap="truncate">
        {INDENT}
        {card.session === null ? (
          truncate(first, room, g.ellipsis)
        ) : (
          <>
            <Text {...dotColor(card.state)}>{glyph}</Text>
            {truncate(first.slice(glyph.length), room - glyph.length, g.ellipsis)}
          </>
        )}
      </Text>
      {rest.map((line, at) => (
        <Text key={at} wrap="truncate" dimColor>
          {line === '' ? ' ' : `${INDENT}${truncate(line, room, g.ellipsis)}`}
        </Text>
      ))}
    </Box>
  );
}

export interface PanelProps {
  /** Экран живого агента; `undefined` — панель показывает карточку. */
  screen: TerminalSnapshot | undefined;
  card: CardProps;
  width: number;
  height: number;
}

export function Panel({ screen, card, width, height }: PanelProps): ReactNode {
  if (screen !== undefined) return <TerminalView snapshot={screen} height={height} />;
  return <Card card={card} width={width} />;
}
