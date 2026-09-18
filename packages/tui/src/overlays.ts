/**
 * Содержимое оверлеев-списков: детали сессии, пикеры работ и истории, справка,
 * настройки (макеты TUI v2, 4.1–4.4 и 4.14).
 *
 * Здесь только текст: ни файловой системы, ни Ink, ни состояния — поэтому
 * макеты проверяются тестами без запуска чего бы то ни было. Рамку и прокрутку
 * рисует `components/overlay.tsx`, состояние держит `use-overlays.ts`.
 */

import {
  ENV_NAMES,
  participantLabel,
  type HarnasConfig,
  type SessionActivity,
  type SessionIndex,
  type TokenTotals,
  type WorkEntry,
  type WorkSession,
} from '@harnas/core';
import {
  DETAILS_WIDTH,
  PICKER_WIDTH,
  type OverlayLine,
  type OverlayView,
} from './components/overlay.js';
import { dotGlyph, type DotState } from './components/activity-dot.js';
import {
  formatClock,
  formatDuration,
  formatRelative,
  formatTokenPair,
  formatTokens,
  truncate,
  truncateLeft,
  withHome,
  wrapText,
} from './format.js';
import { statusGlyph, type Glyphs } from './glyphs.js';
import type { ThreadView } from './thread-view.js';

/** Ширина тела внутри рамки: рамка минус два бока. */
const bodyWidth = (frame: number): number => frame - 2;

/** Колонка подписи в деталях: `ЗАДАЧА   `, `ВХОДЯЩИЕ ` (макет 4.1). */
const LABEL = 9;

/** Сколько прочитанных сообщений видно после непрочитанных (макет 4.1). */
const READ_SHOWN = 5;

/** Курсор ввода в поле фильтра и в правке цели (§6). */
const cursor = (g: Glyphs): string => (g.ascii ? '_' : '▌');

/** Строка подписи с телом: подпись слева, дальше — перенесённый текст. */
function field(
  label: string,
  text: string,
  width: number,
  maxLines: number,
  g: Glyphs,
): OverlayLine[] {
  const rows = wrapText(text, width - LABEL - 1, maxLines, g.ellipsis);
  return (rows.length === 0 ? ['—'] : rows).map((row, at) => ({
    text: ` ${(at === 0 ? label : '').padEnd(LABEL - 1)} ${row}`,
  }));
}

/** Токены по четырём счётчикам: пара и кэш (макет 4.1). */
function tokensLine(tokens: TokenTotals | null, g: Glyphs): string {
  if (tokens === null) return '—';
  const pair = `${g.up}${formatTokens(tokens.input)} ${g.down}${formatTokens(tokens.output)}`;
  return `${pair} · кэш чт ${formatTokens(tokens.cacheRead)} зп ${formatTokens(tokens.cacheWrite)}`;
}

/** Последняя ступень истории в нынешнем статусе: из неё время и код выхода. */
const lastStep = (session: WorkSession): WorkSession['history'][number] | undefined =>
  [...session.history].reverse().find((entry) => entry.status === session.status);

/**
 * СОСТ.: у живой — activity, длительность и время с последнего события любой
 * оси; у вышедшей — время выхода и код текстом (макет 4.1).
 */
function stateLine(
  session: WorkSession,
  state: DotState,
  activity: SessionActivity | null,
  atHarness: boolean,
  lastRecordAt: string | null,
  now: number,
  g: Glyphs,
): string {
  const glyph = dotGlyph(state, g);
  const step = lastStep(session);
  if (session.status === 'pending') return `${glyph} pending`;

  if (session.status === 'active') {
    const started = session.startedAt === null ? null : now - Date.parse(session.startedAt);
    // «Молчит Nм» считается от последнего события любой оси (4.3); секунды здесь
    // важны, поэтому берётся длительность, а не короткая форма «сейчас». Событий
    // не было вовсе — молчим: «событие — назад» не сообщает ничего.
    const event = activity?.lastEventAt ?? lastRecordAt;
    const since =
      event === null ? '' : ` · последнее событие ${formatDuration(now - Date.parse(event))} назад`;
    const outside = atHarness ? '' : ' · вне харнесса';
    return `${glyph} ${state}${outside} · ${formatDuration(started)}${since}`;
  }

  const at = formatClock(step?.at ?? session.endedAt);
  const code =
    step?.signal !== undefined && step.signal !== 0
      ? ` · сигнал ${step.signal}`
      : // Кода нет вовсе или он `null` — процесс завершился без харнесса (5.4).
        typeof step?.exitCode === 'number'
        ? ` · код ${step.exitCode}`
        : '';
  const duration =
    session.metrics === null ? '' : ` · ${formatDuration(session.metrics.durationMs)}`;
  return `${glyph} ${session.status} ${at}${duration}${code}`;
}

/** СВОДКА: чей отчёт и есть ли он вообще (макет 4.1). */
function summaryLine(session: WorkSession, prefix: string, summarizing: boolean): string {
  // Дозаказ уже идёт: пометка стоит здесь, а не только в строке статуса (4.1).
  if (summarizing) return 'авто-резюме: считается…';
  if (session.summary === null) {
    return session.status === 'exited' ? `(отчёта нет) · ${prefix} R — дозаказать` : '(отчёта нет)';
  }
  const mark =
    session.summarySource === 'auto' ? 'авто: ' : session.status === 'active' ? 'progress: ' : '';
  return `${mark}«${session.summary}»`;
}

export interface DetailsOptions {
  entry: WorkEntry;
  session: WorkSession;
  state: DotState;
  activity: SessionActivity | null;
  /** Запись индекса логов: из неё токены и время последней записи. */
  index: SessionIndex | undefined;
  /** PTY сессии держит харнесс: иначе у состояния пометка «вне харнесса». */
  atHarness: boolean;
  /** Открытая правка цели работы: строка ЦЕЛЬ становится полем (решение №8). */
  editing: string | null;
  /** Авто-резюме для этой сессии уже заказано и ещё считается (макет 4.1). */
  summarizing?: boolean;
  prefix: string;
  g: Glyphs;
  now?: number;
}

/** 4.1. Детали сессии: секции по порядку макета, многострочные — до трёх строк. */
export function detailsView({
  entry,
  session,
  state,
  activity,
  index,
  atHarness,
  editing,
  summarizing = false,
  prefix,
  g,
  now = Date.now(),
}: DetailsOptions): OverlayView {
  const width = bodyWidth(DETAILS_WIDTH);
  const lines: OverlayLine[] = [];
  const add = (label: string, text: string, maxLines = 3): void => {
    lines.push(...field(label, text, width, maxLines, g));
  };

  add('ЗАДАЧА', session.task === '' ? '—' : session.task);
  // Роль показывается только у тех, кто с ней запущен: у сессии без агента
  // поля нет вовсе, чтобы прочерк не выглядел настройкой (5.1).
  if (session.agent !== null) add('АГЕНТ', session.agent, 1);
  add('СОСТ.', stateLine(session, state, activity, atHarness, index?.endedAt ?? null, now, g), 2);
  add('ТОКЕНЫ', tokensLine(session.metrics?.tokens ?? index?.tokens ?? null, g), 2);
  add('СВОДКА', summaryLine(session, prefix, summarizing));

  // ВХОДЯЩИЕ: непрочитанные с `▤` первыми, затем последние прочитанные (dim).
  const inbox = entry.map.messages.filter((message) => message.to === session.id);
  const unread = inbox.filter((message) => message.readAt === null);
  const read = inbox.filter((message) => message.readAt !== null).slice(-READ_SHOWN);
  const shown = [...unread, ...read.reverse()];
  if (shown.length === 0) add('ВХОДЯЩИЕ', '—', 1);
  for (const [at, message] of shown.entries()) {
    const mark = message.readAt === null ? `${g.mail} ` : '';
    // Подпись участника одна на бриф, тред, события и детали (решение D9):
    // у удалённой сессии ярлыка в карте уже нет, и её след подписан «(удалена)».
    const from = participantLabel(entry.map, message.from);
    const text = `${mark}${from} ${formatClock(message.at)} «${message.text}»`;
    const rows = field(at === 0 ? 'ВХОДЯЩИЕ' : '', text, width, 1, g);
    lines.push(...rows.map((row) => ({ ...row, dim: message.readAt !== null })));
  }

  if (session.artifacts.length === 0) add('АРТЕФ.', '—', 1);
  for (const [at, artifact] of session.artifacts.entries()) {
    const room = width - LABEL - 1 - artifact.kind.length - 2;
    const text = `${artifact.kind}: ${truncateLeft(artifact.path, room, g.ellipsis)}`;
    lines.push(...field(at === 0 ? 'АРТЕФ.' : '', text, width, 1, g));
  }

  const subagents = activity?.subagents ?? 0;
  add('СУБАГ.', subagents === 0 ? '—' : `${g.subagent} ${subagents} живых`, 1);
  add(
    'ИСТОРИЯ',
    session.history
      .map((step) => `${statusGlyph(step.status, g)} ${formatClock(step.at)}`)
      .join(` ${g.arrow} `),
    2,
  );

  if (editing === null) {
    add('ЦЕЛЬ', entry.map.work.goal === '' ? '—' : entry.map.work.goal);
  } else {
    lines.push({
      text: ` ${'ЦЕЛЬ'.padEnd(LABEL - 1)} ${truncateLeft(`${editing}${cursor(g)}`, width - LABEL - 1, g.ellipsis)}`,
    });
  }

  return {
    title: `детали · ${session.label}`,
    desired: DETAILS_WIDTH,
    lines,
    footer:
      editing === null
        ? ` ${g.up}${g.down} — прокрутка · e — цель · Esc — закрыть`
        : ' Enter — сохранить цель · Esc — отмена',
  };
}

/** Одна строка пикера: ключ для выбора и уже готовый текст (макеты 4.2, 4.3). */
export interface PickerItem {
  key: string;
  text: string;
}

/** Фильтр пикера — простой поиск подстроки без регистра (макеты 4.2, 4.3). */
export function filterItems(items: readonly PickerItem[], filter: string): PickerItem[] {
  if (filter === '') return [...items];
  const needle = filter.toLowerCase();
  return items.filter((item) => item.text.toLowerCase().includes(needle));
}

/** Ширина колонки заголовка в пикере работ (макет 4.2). */
const WORK_TITLE = 18;

/**
 * 4.2. Работы глобального индекса: заголовок, проект с веткой, точка состояния.
 * Точка и заголовок не отбрасываются, путь режется слева.
 */
export function workItems(
  entries: readonly WorkEntry[],
  state: (key: string) => DotState | null,
  branch: (entry: WorkEntry) => string | null,
  key: (entry: WorkEntry) => string,
  g: Glyphs,
): PickerItem[] {
  const width = bodyWidth(PICKER_WIDTH);
  return entries
    .filter((entry) => entry.map.work.status !== 'archived')
    .map((entry) => {
      const id = key(entry);
      const dot = state(id);
      const title = truncate(entry.map.work.title, WORK_TITLE, g.ellipsis).padEnd(WORK_TITLE);
      const found = branch(entry);
      const tail = found === null ? '' : ` · ${found}`;
      const room = width - WORK_TITLE - 5;
      const place = truncateLeft(`${withHome(entry.projectPath)}${tail}`, room, g.ellipsis);
      const head = ` ${title} ${place}`;
      return {
        key: id,
        text: `${head}${' '.repeat(Math.max(0, width - head.length - 2))} ${dot === null ? ' ' : dotGlyph(dot, g)}`,
      };
    });
}

/**
 * 4.3. Сессии истории провайдера: заголовок, возраст, длительность, токены.
 * Токены отбрасываются первыми, возраст — последним (макет 4.3).
 */
export function historyItems(
  sessions: readonly SessionIndex[],
  g: Glyphs,
  now: number = Date.now(),
): PickerItem[] {
  const width = bodyWidth(PICKER_WIDTH);
  return sessions.map((item) => {
    const full = item.title ?? item.id;
    const parts = [
      formatRelative(item.endedAt, now),
      formatDuration(item.durationMs),
      formatTokenPair(item.tokens),
    ];
    const room = (): number => width - parts.join(' · ').length - 3;
    // Заголовок важнее хвоста: пока он не помещается целиком, хвост укорачивается
    // с конца — токены первыми, возраст последним (макет 4.3).
    while (parts.length > 1 && full.length > room()) parts.pop();
    const tail = parts.join(' · ');
    const title = truncate(full, room(), g.ellipsis);
    const head = ` ${title}`;
    return {
      key: item.id,
      text: `${head}${' '.repeat(Math.max(1, width - head.length - tail.length - 1))}${tail}`,
    };
  });
}

/** Строка фильтра и линейка под ней — общая шапка пикеров (макеты 4.2–4.4). */
const filterHead = (filter: string, g: Glyphs): OverlayLine[] => [
  { text: ` > ${filter}${cursor(g)}` },
  { text: '', rule: true },
];

export interface PickerOptions {
  title: string;
  items: readonly PickerItem[];
  filter: string;
  /** Индекс выбранной строки среди отфильтрованных. */
  at: number;
  footer: string;
  g: Glyphs;
}

/** Общий вид пикера: фильтр, линейка, строки, подсказка (макеты 4.2 и 4.3). */
export function pickerView({ title, items, filter, at, footer, g }: PickerOptions): OverlayView {
  const lines: OverlayLine[] = filterHead(filter, g);
  if (items.length === 0) lines.push({ text: ' ничего не нашлось', dim: true });
  for (const [index, item] of items.entries()) {
    lines.push({ text: item.text, selected: index === at });
  }
  return { title, desired: PICKER_WIDTH, lines, footer };
}

/** Привязки справки в порядке макета 4.4. */
const BINDINGS: ReadonlyArray<readonly [string, string]> = [
  ['c', 'новая сессия Claude в выбранной работе'],
  ['C', 'дочерняя сессия выбранной: бриф контекстом, ждёт ваш запрос'],
  ['w', 'пикер работ'],
  ['g', 'пикер истории (возобновление)'],
  ['i', 'детали выбранной сессии'],
  ['j / k', 'следующая / предыдущая сессия'],
  ['1..9', 'выбрать работу по номеру'],
  ['s', 'фокус в сайдбар'],
  ['b', 'спрятать / показать сайдбар'],
  ['t', 'тред выбранной сессии справа от панели'],
  ['x', 'закрыть выбранную сессию'],
  ['d', 'удалить выбранную сессию (с подтверждением)'],
  ['D', 'удалить выбранную работу целиком (с подтверждением)'],
  ['r', 'возобновить выбранную сессию'],
  ['R', 'дозаказать резюме (exited)'],
  [',', 'настройки'],
  ['?', 'эта справка'],
  ['q', 'выйти из харнесса'],
];

/**
 * 6.1. Тред-запасник: на узком терминале док не влезает, и та же лента
 * показывается оверлеем. Вид сюда приходит готовым — тот самый, что у дока
 * (приёмка 8.41), уже нарезанный `use-thread.ts` по телу рамки (`overlayRoom`)
 * и по общей прокрутке. Резать окно ещё раз здесь нельзя: `Overlay` отсчитывает
 * своё от начала списка, и лента открывалась бы с самых старых писем (6.3).
 */
export function threadOverlayView(view: ThreadView, width: number, g: Glyphs): OverlayView {
  // Те же пометки, что в заголовке дока: непрочитанные и хвост ленты (6.3).
  const marks = [
    view.unread > 0 ? `${g.mail}${view.unread}` : '',
    view.below > 0 ? `${g.down}${view.below}` : '',
  ].filter((mark) => mark !== '');
  return {
    title: [view.title, ...marks].join(' '),
    desired: width + 2,
    lines: view.lines,
    footer: ` ${g.up}${g.down} — прокрутка · Esc — закрыть`,
  };
}

/**
 * 4.4. Справка: первой строкой — как сменить префикс, если его перехватывает
 * терминал; ниже фильтр и все привязки.
 */
export function helpView(
  prefix: string,
  filter: string,
  configFile: string,
  g: Glyphs,
): OverlayView {
  const width = bodyWidth(PICKER_WIDTH);
  const rows: PickerItem[] = [...BINDINGS, [prefix, `отправить ${prefix} агенту`] as const].map(
    ([key, text]) => ({
      key,
      text: ` ${key.padEnd(9)}${text}`,
    }),
  );
  const lines: OverlayLine[] = [
    { text: ' префикс перехватывает терминал? смените его:' },
    {
      text: truncate(` HARNAS_PREFIX=w или "prefix" в ${withHome(configFile)}`, width, g.ellipsis),
    },
    { text: '', rule: true },
    ...filterHead(filter, g).slice(0, 1),
    ...filterItems(rows, filter).map((row) => ({ text: row.text })),
  ];
  return {
    title: `привязки · префикс ${prefix}`,
    desired: PICKER_WIDTH,
    lines,
    footer: ` ${g.up}${g.down} — прокрутка · Esc — закрыть`,
  };
}

/** Порядок строк — порядок полей в файле из дизайна 3.4. */
export const SETTINGS: ReadonlyArray<{ key: keyof HarnasConfig; hint: string }> = [
  { key: 'prefix', hint: 'буква префикса, ctrl+<буква>' },
  { key: 'sidebarWidth', hint: 'ширина сайдбара, колонок' },
  { key: 'mouseCapture', hint: 'харнесс ловит мышь сам' },
  { key: 'ascii', hint: 'ASCII-глифы вместо Unicode' },
  { key: 'silenceThresholdMs', hint: 'порог молчания лога, мс' },
  { key: 'channelPush', hint: 'звонок адресату через channel' },
  { key: 'messageRate', hint: 'потолок писем сессии за час' },
  { key: 'threadWidth', hint: 'ширина треда, колонок' },
  { key: 'autoLaunch', hint: 'pending от агента стартует сама' },
];

/** Колонки строки настройки: ключ и значение (макет 4.14). */
const SETTING_KEY = 20;
const SETTING_VALUE = 7;

export interface SettingsOptions {
  config: HarnasConfig;
  fromEnv: ReadonlyArray<keyof HarnasConfig>;
  /** Выбранная строка (индекс в SETTINGS). */
  at: number;
  /** Открытый ввод: текст с курсором вместо значения выбранной строки. */
  editing: string | null;
  configFile: string;
  g: Glyphs;
}

/**
 * 4.14. Настройки: путь к файлу в шапке, строки в порядке дизайна 3.4.
 * Перекрытая окружением строка тусклая и вместо подсказки называет переменную:
 * файл её не перекроет (решение плана от 2026-09-18).
 */
export function settingsView({
  config,
  fromEnv,
  at,
  editing,
  configFile,
  g,
}: SettingsOptions): OverlayView {
  const width = bodyWidth(PICKER_WIDTH);
  const lines: OverlayLine[] = [
    { text: truncate(` ${withHome(configFile)}`, width, g.ellipsis) },
    { text: '', rule: true },
  ];

  for (const [index, { key, hint }] of SETTINGS.entries()) {
    const value = config[key];
    const shown =
      editing !== null && index === at
        ? `${editing}${cursor(g)}`
        : typeof value === 'boolean'
          ? value
            ? 'да'
            : 'нет'
          : String(value);
    const overridden = fromEnv.includes(key);
    const head = ` ${key.padEnd(SETTING_KEY)}${shown.padEnd(SETTING_VALUE)}`;
    const tail = overridden ? `задано ${ENV_NAMES[key]}` : hint;
    lines.push({
      text: `${head}${truncate(tail, width - head.length, g.ellipsis)}`,
      selected: index === at,
      dim: overridden,
    });
  }

  return {
    title: 'настройки',
    desired: PICKER_WIDTH,
    lines,
    footer:
      editing === null ? ' Enter — изменить · Esc — закрыть' : ' Enter — сохранить · Esc — отмена',
  };
}
