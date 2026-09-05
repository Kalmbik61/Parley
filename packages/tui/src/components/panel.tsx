/**
 * Панель: экран живого агента, а без него — карточка выбранной сессии
 * (дизайн TUI v2, 2.2; макеты §2). Это единственное место, где харнесс рисует
 * поверх области гостя, и подтверждения (макеты 4.8, 4.9) живут здесь же.
 */

import { workPaths, type WorkEntry, type WorkSession } from '@harnas/core';
import { Box, Text } from 'ink';
import path from 'node:path';
import type { ReactNode } from 'react';
import { formatClock, truncate } from '../format.js';
import { glyphs } from '../glyphs.js';
import type { TerminalSnapshot } from '../pty/terminal-buffer.js';
import type { DialogSpec } from '../work-dialogs.js';
import { dotColor, dotGlyph, type DotState } from './activity-dot.js';
import { Dialog } from './dialog.js';
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
  return { session, state, parent, brief, prefix };
}

/** Как сессия закончилась: время и код выхода из последней ступени истории. */
function exitTail(session: WorkSession): string {
  const last = [...session.history].reverse().find((entry) => entry.status === session.status);
  const at = formatClock(last?.at ?? session.endedAt);
  if (last?.signal !== undefined && last.signal !== 0) return `${at} · сигнал ${last.signal}`;
  return last?.exitCode === undefined ? at : `${at} · код ${last.exitCode}`;
}

/** Строки карточки по состоянию сессии (макеты §2). */
export function cardLines(
  { session, state, parent, brief, prefix }: CardProps,
  glyph: string,
): string[] {
  if (session === null) {
    return ['сессий нет', `${prefix} c — новая сессия · ${prefix} g — возобновить из истории`];
  }
  const head = `${glyph} ${session.label}`;

  // Живая сессия попадает в карточку только одна: та, чей PTY не у харнесса (5.4).
  if (session.status === 'active') {
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

  return [
    `${head} · ${session.status} ${exitTail(session)}`,
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
  /** Открытое подтверждение: пока оно на экране, ввод принадлежит ему (2.4). */
  dialog: { id: number; spec: DialogSpec } | null;
  onSubmit: () => void;
  onCancel: () => void;
  /** Экран живого агента; `undefined` — панель показывает карточку. */
  screen: TerminalSnapshot | undefined;
  card: CardProps;
  width: number;
  height: number;
}

export function Panel({
  dialog,
  onSubmit,
  onCancel,
  screen,
  card,
  width,
  height,
}: PanelProps): ReactNode {
  if (dialog !== null) {
    return (
      <Box flexDirection="column">
        <Text bold>{dialog.spec.title}</Text>
        <Dialog
          key={dialog.id}
          info={dialog.spec.info}
          footer={dialog.spec.footer}
          width={width}
          height={Math.max(1, height - 1)}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </Box>
    );
  }
  if (screen !== undefined) return <TerminalView snapshot={screen} height={height} />;
  return <Card card={card} width={width} />;
}
