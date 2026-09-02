import { modelBadge, silenceMs, type HistoryEntry, type Subsession } from '@harnas/core';
import { Box, Text } from 'ink';
import { useEffect, type ReactNode } from 'react';
import {
  formatClock,
  formatDuration,
  formatTokens,
  truncate,
  truncateLeft,
  visibleWindow,
  wrapText,
} from '../format.js';
import { glyphs, statusColor, statusGlyph, type Glyphs } from '../glyphs.js';
import {
  providerLabel,
  workTail,
  type InboxMessage,
  type WorkRow,
  type WorkRowSession,
  type WorkRowWork,
} from '../work-rows.js';
import { badges } from './subsession-list.js';

export interface DetailsPaneProps {
  /** Выбранный ряд списка работ; `undefined` — список пуст. */
  row: WorkRow | undefined;
  width: number;
  /** Сколько строк помещается в панели: содержимое листается окном (дизайн 3). */
  height: number;
  /** Строка прокрутки: панель фокусируется по Tab, листается `↑↓`/`jk`. */
  selected: number;
  /** Подсессии выбранной сессии — секция СУБАГЕНТЫ. */
  subsessions?: Subsession[];
  /** Точка отсчёта «молчит Nм»; задаётся в тестах. */
  now?: number;
  /** Сколько строк вышло: по этому числу навигация ограничивает прокрутку. */
  onLines?: (count: number) => void;
  /** Дозаказ резюме уже запущен: до готовности в СВОДКЕ так и написано (4.5). */
  summaryPending?: boolean;
}

/** Ширина колонки ярлыков в секционной раскладке (макет 2.2: `ВХОДЯЩИЕ` — 8 знаков). */
const GUTTER = 9;
/** С этой ширины раскладка секционная (2.2), уже — компактная (2.1). */
const WIDE_WIDTH = 36;
/** Прочитанных сообщений показывается не больше (решение №10). */
const READ_LIMIT = 5;
/** Короче этого текст сообщения не режется — дальше не остаётся смысла. */
const MIN_TEXT = 4;

/**
 * Строка панели. `label` рисуется только в секционной раскладке; пустой — это
 * продолжение предыдущей секции.
 */
interface DetailLine {
  key: string;
  label: string;
  node: ReactNode;
  dim?: boolean;
}

interface Layout {
  g: Glyphs;
  wide: boolean;
  /** Ширина содержимого: в секционной раскладке колонка ярлыков уже вычтена. */
  width: number;
  now: number;
  subsessions: readonly Subsession[];
  summaryPending: boolean;
}

const line = (key: string, label: string, node: ReactNode, dim = false): DetailLine => ({
  key,
  label,
  node,
  ...(dim ? { dim } : {}),
});

/** Многострочное поле: первая строка с ярлыком, остальные — продолжением (6.4). */
function field(key: string, label: string, text: string, layout: Layout): DetailLine[] {
  const rows = wrapText(text, layout.width, layout.wide ? 3 : 2, layout.g.ellipsis);
  if (rows.length === 0) return [line(key, label, '—')];
  return rows.map((row, at) => line(`${key}-${at}`, at === 0 ? label : '', row));
}

/** Код выхода из истории: сигнал важнее кода — снятый процесс вышел не сам (6.1). */
function exitMark(entry: HistoryEntry | undefined): string | null {
  if (entry === undefined) return null;
  if (entry.signal !== undefined && entry.signal !== 0) return `сигнал ${entry.signal}`;
  return entry.exitCode === undefined ? null : `код ${entry.exitCode}`;
}

const FINAL = new Set(['exited', 'done', 'failed']);

/** СТАТУС: глиф, статус, время выхода, длительность, молчание и код (дизайн 3). */
function statusLine(row: WorkRowSession, layout: Layout): DetailLine {
  const { session, live } = row;
  const { g } = layout;
  const last = [...session.history].reverse().find((entry) => entry.status === session.status);
  const final = FINAL.has(session.status);
  // Время выхода помещается только в секционную раскладку (макеты 2.2 и раздел 3).
  const at = final && layout.wide ? ` ${formatClock(last?.at ?? session.endedAt)}` : '';

  const parts = [formatDuration(live.durationMs)];
  if (session.status === 'idle') {
    const silence = silenceMs(live.lastRecordAt, layout.now);
    if (silence !== null) parts.push(`молчит ${formatDuration(silence)}`);
  }
  const mark = final ? exitMark(last) : null;
  if (mark !== null) parts.push(mark);

  return line(
    'status',
    'СТАТУС',
    <>
      <Text {...statusColor(session.status)}>{statusGlyph(session.status, g)}</Text>
      {` ${session.status}${at} · ${parts.join(' · ')}`}
    </>,
  );
}

/** ТОКЕНЫ: все четыре счётчика — кэш в список не выводится никогда (6.3). */
function tokensLine(row: WorkRowSession, layout: Layout): DetailLine {
  const { tokens } = row.live;
  const { g } = layout;
  if (tokens === null) return line('tokens', 'ТОКЕНЫ', '—', true);

  const pair = `${g.up}${formatTokens(tokens.input)} ${g.down}${formatTokens(tokens.output)}`;
  const cache = layout.wide
    ? `· кэш чт ${formatTokens(tokens.cacheRead)} зп ${formatTokens(tokens.cacheWrite)}`
    : `${g.cache}${formatTokens(tokens.cacheRead)}/${formatTokens(tokens.cacheWrite)}`;
  return line('tokens', 'ТОКЕНЫ', `${pair} ${cache}`, true);
}

/** СВОДКА: у отчёта виден источник, у его отсутствия — подсказка про `s` (дизайн 3). */
function summaryText(row: WorkRowSession, pending: boolean): string {
  const { summary, summarySource, status } = row.session;
  // Заказ уже сделан: другой индикации у дозаказа нет (дизайн 4.5).
  if (pending) return 'авто-резюме: считается…';
  if (summary === null) {
    return status === 'exited' ? '(отчёта нет — s дозаказать)' : '(отчёта нет)';
  }
  if (summarySource === 'auto') return `авто: «${summary}»`;
  // Отчёт агента до завершения — это промежуточный `progress`, а не итог.
  return FINAL.has(status) ? `«${summary}»` : `progress: «${summary}»`;
}

function inboxLine(message: InboxMessage, layout: Layout): DetailLine {
  const { g } = layout;
  const head = `${message.read ? '' : `${g.mail} `}${message.from} ${formatClock(message.at)} `;
  const text = truncate(
    message.text,
    Math.max(MIN_TEXT, layout.width - head.length - 2),
    g.ellipsis,
  );
  const tail = `${message.from} ${formatClock(message.at)} «${text}»`;

  return line(
    `msg-${message.id}`,
    '',
    message.read ? (
      tail
    ) : (
      <>
        <Text color="magenta" bold>
          {g.mail}
        </Text>
        {` ${tail}`}
      </>
    ),
    message.read,
  );
}

/** ИСТОРИЯ: цепочка переходов; на узкой ширине — два последних (дизайн 3). */
function historyLine(row: WorkRowSession, layout: Layout): DetailLine {
  const { g } = layout;
  const items = layout.wide ? row.session.history : row.session.history.slice(-2);
  if (items.length === 0) return line('history', 'ИСТОРИЯ', layout.wide ? '—' : 'ист: —', true);

  return line(
    'history',
    'ИСТОРИЯ',
    <>
      {layout.wide ? '' : 'ист: '}
      {items.map((entry, at) => (
        <Text key={`${entry.status}-${entry.at}-${at}`}>
          {at === 0 ? '' : ` ${g.arrow} `}
          <Text {...statusColor(entry.status)}>{statusGlyph(entry.status, g)}</Text>
          <Text dimColor>{` ${formatClock(entry.at)}`}</Text>
        </Text>
      ))}
    </>,
  );
}

/** Строка субагента — та же, что в списке подсессий: задача, длительность, модель. */
const subsessionText = (item: Subsession): string =>
  `${item.task ?? item.agentType ?? item.agentId} · ${formatDuration(item.durationMs)} · ${badges(item)}`;

function sessionLines(row: WorkRowSession, layout: Layout): DetailLine[] {
  const { g, wide } = layout;
  const { session } = row;
  // Порядок задан в work-rows (непрочитанные первыми, внутри — по времени убыв.);
  // панель только обрезает хвост прочитанных (решение №10).
  const firstRead = row.inbox.findIndex((message) => message.read);
  const inbox = firstRead === -1 ? row.inbox : row.inbox.slice(0, firstRead + READ_LIMIT);

  const lines: DetailLine[] = [
    ...field('task', 'ЗАДАЧА', session.task, layout),
    statusLine(row, layout),
    tokensLine(row, layout),
    ...field('summary', 'СВОДКА', summaryText(row, layout.summaryPending), layout),
  ];

  lines.push(
    ...(inbox.length === 0
      ? [line('inbox', 'ВХОДЯЩИЕ', '—', true)]
      : inbox.map((message, at) => {
          const item = inboxLine(message, layout);
          return at === 0 ? { ...item, label: 'ВХОДЯЩИЕ' } : item;
        })),
  );

  if (wide) {
    lines.push(
      ...(session.artifacts.length === 0
        ? [line('art', 'АРТЕФ.', '—', true)]
        : session.artifacts.map((artifact, at) =>
            line(
              `art-${at}`,
              at === 0 ? 'АРТЕФ.' : '',
              // Путь усекается слева: важен хвост — имя файла (6.4).
              `${artifact.kind}: ${truncateLeft(artifact.path, Math.max(MIN_TEXT, layout.width - artifact.kind.length - 2), g.ellipsis)}`,
            ),
          )),
    );
    lines.push(
      ...(layout.subsessions.length === 0
        ? [line('sub', 'СУБАГ.', '—', true)]
        : layout.subsessions.map((item, at) =>
            line(
              `sub-${at}`,
              at === 0 ? 'СУБАГ.' : '',
              truncate(subsessionText(item), layout.width, g.ellipsis),
            ),
          )),
    );
  } else {
    // На узкой колонке артефакты и субагенты сжимаются до счётчиков (макет 2.1).
    const arts = session.artifacts.length === 0 ? '—' : String(session.artifacts.length);
    const subs = layout.subsessions.length === 0 ? '—' : String(layout.subsessions.length);
    lines.push(line('art-sub', '', `арт: ${arts} · суб: ${subs}`, true));
  }

  lines.push(historyLine(row, layout));
  return lines;
}

/** Выбрана работа — её сводка: цель и счётчики сессий (дизайн 3). */
function workLines(row: WorkRowWork, layout: Layout): DetailLine[] {
  return [
    ...field('goal', '', row.work.goal || 'цель не записана', layout),
    line('counters', '', workTail(row.counters, layout.g, layout.width)),
  ];
}

/**
 * Панель ДЕТАЛИ вместо SUBSESSIONS в режиме работ (дизайн координации TUI, 3).
 *
 * Порядок секций фиксирован: ЗАДАЧА → СТАТУС → ТОКЕНЫ → СВОДКА → ВХОДЯЩИЕ →
 * АРТЕФАКТЫ → СУБАГЕНТЫ → ИСТОРИЯ. На узкой колонке они рисуются компактно
 * (макет 2.1), на широкой — с ярлыками секций (2.2).
 */
export function DetailsPane({
  row,
  width,
  height,
  selected,
  subsessions = [],
  now = Date.now(),
  onLines,
  summaryPending = false,
}: DetailsPaneProps): ReactNode {
  const g = glyphs();
  const wide = width >= WIDE_WIDTH;
  // Колонка ярлыков — только у секций сессии: сводка работы их не имеет.
  const labels = wide && row?.kind === 'session';
  const layout: Layout = {
    g,
    wide,
    width: labels ? width - GUTTER : width,
    now,
    subsessions,
    summaryPending,
  };

  const lines =
    row === undefined
      ? []
      : row.kind === 'session'
        ? sessionLines(row, layout)
        : workLines(row, layout);
  const count = lines.length;
  useEffect(() => {
    onLines?.(count);
  }, [onLines, count]);

  if (row === undefined) return <Text dimColor>Работа не выбрана.</Text>;

  // Провайдер и модель — та же пара строк, что в списке и в заголовке правой
  // панели (дизайн 3): она не листается вместе с секциями.
  const head =
    row.kind === 'session' ? (
      <Text color="blackBright" bold wrap="truncate">
        {truncate(providerModel(row), width, g.ellipsis)}
      </Text>
    ) : null;

  const { start, end } = visibleWindow(
    count,
    selected,
    Math.max(1, height - (head === null ? 0 : 1)),
  );

  return (
    <Box flexDirection="column">
      {head}
      {lines.slice(start, end).map((item) => (
        <Text key={item.key} wrap="truncate" {...(item.dim === true ? { dimColor: true } : {})}>
          {labels ? item.label.padEnd(GUTTER) : ''}
          {item.node}
        </Text>
      ))}
    </Box>
  );
}

/** У pending модели ещё нет; у Codex бейдж модели совпадает с провайдером — не двоим. */
function providerModel(row: WorkRowSession): string {
  const provider = providerLabel(row.session.provider);
  const model = modelBadge(row.live.model);
  return row.live.model === null || model === provider ? provider : `${provider} ${model}`;
}
