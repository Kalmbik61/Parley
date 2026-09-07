/**
 * Содержимое подтверждений: запуск, возобновление, дозаказ резюме, закрытие,
 * удаление сессии и выход (макеты TUI v2, 4.5–4.11; прежний дизайн 4.3–4.5).
 *
 * Здесь только текст: файловой системы и Ink нет, поэтому макеты проверяются
 * тестами без запуска чего бы то ни было. Рамку рисует `components/overlay.tsx`,
 * тело — существующий `dialog.tsx`.
 */

import { workPaths, type WorkSession } from '@harnas/core';
import path from 'node:path';
import { formatClock, truncate, truncateLeft } from './format.js';
import { statusGlyph, type Glyphs } from './glyphs.js';

export interface DialogSpec {
  /** Заголовок в верхней рамке оверлея. */
  title: string;
  /** Строки над телом: путь брифа, команда возобновления, код выхода. */
  info: string[];
  /** Тело-цитата: первые строки брифа, листается `↑↓` (макет 4.5). */
  quote: string[];
  footer: string;
}

/** Сколько знаков резюме показывается в диалоге возобновления. */
const SUMMARY = 40;

/**
 * Путь брифа: от корня проекта, пока помещается в строку, иначе короткая форма
 * `briefs/<id>.md` (макет 4.5, усечение путей слева — 6.4).
 */
function briefLine(
  projectPath: string,
  workId: string,
  sessionId: string,
  width: number,
  g: Glyphs,
): string {
  const head = 'бриф: ';
  const dir = path.relative(projectPath, workPaths(projectPath, workId).briefs);
  const full = path.join(dir, `${sessionId}.md`);
  const room = Math.max(0, width - head.length);
  const short = path.join(path.basename(dir), `${sessionId}.md`);
  return `${head}${full.length <= room ? full : truncateLeft(short, room, g.ellipsis)}`;
}

/**
 * 4.5. Тело — первые строки брифа. Править бриф из TUI нельзя: оверлей
 * показывает путь, файл правится своим редактором и перечитывается при `Enter`.
 */
export function launchDialog(
  projectPath: string,
  workId: string,
  session: WorkSession,
  brief: string,
  g: Glyphs,
  width: number,
): DialogSpec {
  return {
    title: `запуск ${g.pending} ${session.label}`,
    info: [
      briefLine(projectPath, workId, session.id, width, g),
      // Каким будет старт: с задачей — бриф первым сообщением, без неё бриф
      // уходит контекстом, и агент ждёт запроса (план от 2026-09-06, B).
      `старт: ${session.task === '' ? 'ждёт ваш запрос' : 'по брифу'}`,
    ],
    quote: brief.split('\n'),
    footer: 'Enter — запустить · Esc — позже',
  };
}

/** Как выглядит команда возобновления: `claude --resume 7fa0e1…` (макет 4.6). */
export function resumePreview(
  command: string,
  args: readonly string[],
  providerSessionId: string | null,
): string {
  const at = providerSessionId === null ? -1 : args.indexOf(providerSessionId);
  if (at === -1) return `${command}: id у провайдера нет — новый процесс по брифу`;
  return `${command} ${args.slice(0, at + 1).join(' ')}`;
}

/** Как сессия закончилась: время, код выхода или сигнал (решение №11). */
function exitLine(session: WorkSession): string {
  const last = [...session.history].reverse().find((entry) => entry.status === session.status);
  const at = formatClock(last?.at ?? session.endedAt);
  const mark =
    last?.signal !== undefined && last.signal !== 0
      ? `сигнал ${last.signal}`
      : // Кода нет вовсе или он `null` — процесс завершился без харнесса (5.4).
        typeof last?.exitCode === 'number'
        ? `код ${last.exitCode}`
        : null;
  const head = session.status === 'exited' ? 'вышла' : 'завершилась';
  return mark === null ? `${head} ${at}` : `${head} ${at} · ${mark}`;
}

/** Прежнее резюме остаётся в карте до нового `report` — но будет перезаписано. */
function summaryLine(session: WorkSession, g: Glyphs): string {
  if (session.summary === null) return 'отчёта не было · резюме: нет — R закажет авто-резюме';
  return `резюме: «${truncate(session.summary, SUMMARY, g.ellipsis)}» (будет перезаписано)`;
}

/** 4.6. Тот же оверлей для `○ exited` и для завершённых `✓` / `✗`. */
export function resumeDialog(session: WorkSession, command: string, g: Glyphs): DialogSpec {
  return {
    title: `возобновить ${statusGlyph(session.status, g)} ${session.label}`,
    info: [command, exitLine(session), summaryLine(session, g)],
    quote: [],
    footer: 'Enter — возобновить · Esc',
  };
}

/**
 * 4.7. Дозаказ резюме для сессии, вышедшей без отчёта: оверлей объясняет, чем
 * оно считается и как запишется, и подтверждает заказ.
 */
export function summaryDialog(session: WorkSession, g: Glyphs): DialogSpec {
  return {
    title: `резюме для ${statusGlyph(session.status, g)} ${session.label}`,
    info: ['один вызов claude -p по транскрипту', 'результат — сводка с пометкой «авто»'],
    quote: [],
    footer: 'Enter — заказать · Esc',
  };
}

/**
 * 4.8. Закрытие живой сессии: процессу уйдёт SIGHUP, транскрипт останется у
 * провайдера — карту и историю харнесс не трогает.
 */
export function closeSessionDialog(session: WorkSession, g: Glyphs): DialogSpec {
  return {
    title: `закрыть ${statusGlyph(session.status, g)} ${session.label}`,
    info: [
      `процессу будет послан SIGHUP${session.pid === null ? '' : ` · pid ${session.pid}`}`,
      'транскрипт останется в ~/.claude',
    ],
    quote: [],
    footer: 'Enter — закрыть · Esc',
  };
}

/**
 * 4.10. Удаление сессии: запись, бриф и журнал уходят с диска, транскрипт у
 * провайдера остаётся, а дети поднимаются к родителю удалённой (план от
 * 2026-09-06, раздел C).
 */
export function deleteSessionDialog(
  session: WorkSession,
  children: readonly string[],
  g: Glyphs,
  width: number,
): DialogSpec {
  const info = ['запись, бриф и журнал событий будут удалены', 'транскрипт в ~/.claude останется'];
  if (children.length > 0) {
    info.push(
      truncate(`дочерние: ${children.join(', ')} → поднимутся на уровень`, width, g.ellipsis),
    );
  }
  return {
    title: `удалить ${statusGlyph(session.status, g)} ${session.label}`,
    info,
    quote: [],
    footer: 'Enter — удалить · Esc',
  };
}

/**
 * 4.11. Отказ удалить живую сессию, чей процесс не у харнесса: закрыть её нечем,
 * а удалённая запись оставила бы работающий процесс без места в карте. Такая
 * сессия — CLI-сессия (`pid: null`, свежий журнал) или пережившая перезапуск
 * харнесса (раздел C).
 */
export function deleteBlockedDialog(session: WorkSession, g: Glyphs): DialogSpec {
  return {
    title: `удалить ${statusGlyph(session.status, g)} ${session.label}`,
    info: [
      `сессия жива, но её процесс не у харнесса${session.pid === null ? '' : ` · pid ${session.pid}`}`,
      'закройте её там, где она запущена, и повторите',
    ],
    quote: [],
    footer: 'Esc — понятно',
  };
}

/** 4.9. Выход при живых сессиях: их процессы получают SIGHUP (решение №5). */
export function exitDialog(live: readonly string[]): DialogSpec {
  return {
    title: 'выход',
    info: [`живые сессии: ${live.join(', ')}`, 'их процессы будут завершены'],
    quote: [],
    footer: 'Enter — выйти · Esc — остаться',
  };
}
