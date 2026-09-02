/**
 * Содержимое диалогов левой колонки (дизайн координации TUI, 4.1–4.4).
 *
 * Здесь только текст и поля: файловой системы и Ink нет, поэтому макеты
 * проверяются тестами без запуска чего бы то ни было.
 */

import { workPaths, type WorkSession } from '@harnas/core';
import path from 'node:path';
import type { DialogField } from './components/dialog.js';
import { formatClock, truncate, truncateLeft, withHome } from './format.js';
import { statusGlyph, type Glyphs } from './glyphs.js';
import type { ProviderOption } from './work-launch.js';
import { providerLabel, providerMarkOf, type WorkRowSession } from './work-rows.js';

export interface DialogSpec {
  /** Заголовок нижней левой панели на время диалога. */
  title: string;
  fields: DialogField[];
  info: string[];
  /** Тело-цитата: первые строки брифа (4.3). */
  quote: string[];
  footer: string;
}

/** Сколько знаков резюме показывается в диалоге возобновления. */
const SUMMARY = 40;

/**
 * С этой ширины в заголовок помещается полное имя провайдера; уже — двухсимвольная
 * марка или ничего (макеты 4.3 и 4.4: 26 знаков на 80×24, 41 на 120×40).
 */
const WIDE = 30;

/** 4.1. Проект не выбирается: работа всегда создаётся в cwd харнесса (решение №9). */
export function newWorkDialog(projectPath: string): DialogSpec {
  return {
    title: 'НОВАЯ РАБОТА',
    fields: [
      { key: 'title', label: 'Заголовок' },
      { key: 'goal', label: 'Цель', optional: true, multiline: true },
    ],
    info: [`Проект: ${withHome(projectPath)}`],
    quote: [],
    footer: 'Enter — создать · Esc — отмена',
  };
}

/**
 * 4.2. Провайдер — селектор по реестру. Недоступный виден в самом кольце
 * вариантов с пометкой, почему он не выбирается: отдельной строкой не понять,
 * где в кольце пропуск.
 */
export function newSessionDialog(workTitle: string, providers: ProviderOption[]): DialogSpec {
  return {
    title: `НОВАЯ СЕССИЯ · ${workTitle}`,
    fields: [
      {
        key: 'provider',
        label: 'Провайдер',
        options: providers.map((item) => ({
          id: item.id,
          label: item.label,
          ...(item.available
            ? {}
            : { disabled: true, ...(item.note === undefined ? {} : { note: item.note }) }),
        })),
      },
      { key: 'label', label: 'Роль' },
      { key: 'task', label: 'Задача', multiline: true },
    ],
    info: [],
    quote: [],
    footer: 'Enter — создать (pending) · Esc',
  };
}

/**
 * Путь брифа: от корня проекта, пока помещается в строку, иначе короткая форма
 * `briefs/<id>.md` (макеты 4.3, усечение путей слева — 6.4).
 */
function briefLine(row: WorkRowSession, width: number, g: Glyphs): string {
  const head = 'бриф: ';
  const dir = path.relative(row.projectPath, workPaths(row.projectPath, row.workId).briefs);
  const full = path.join(dir, `${row.session.id}.md`);
  const room = Math.max(0, width - head.length);
  const short = path.join(path.basename(dir), `${row.session.id}.md`);
  return `${head}${full.length <= room ? full : truncateLeft(short, room, g.ellipsis)}`;
}

/**
 * 4.3. Тело — первые строки брифа. Править бриф из TUI нельзя: диалог
 * показывает путь, файл правится своим редактором и перечитывается при `Enter`.
 */
export function launchDialog(
  row: WorkRowSession,
  brief: string,
  g: Glyphs,
  width: number,
): DialogSpec {
  const { session } = row;
  const provider =
    width >= WIDE ? providerLabel(session.provider) : providerMarkOf(session.provider);
  return {
    title: `ЗАПУСК ${g.pending} ${session.label} (${provider})`,
    fields: [],
    info: [briefLine(row, width, g)],
    quote: brief.split('\n'),
    footer: 'Enter — запустить · Esc — позже',
  };
}

/** Как выглядит команда возобновления: `codex resume 7fa0e1…` (макет 4.4). */
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
      : last?.exitCode === undefined
        ? null
        : `код ${last.exitCode}`;
  const head = session.status === 'exited' ? 'вышел' : 'завершилась';
  return mark === null ? `${head} ${at}` : `${head} ${at} · ${mark}`;
}

/** Прежнее резюме остаётся в карте до нового `report` — но будет перезаписано. */
function summaryLine(session: WorkSession, g: Glyphs): string {
  if (session.summary === null) return 'отчёта не было · резюме: нет';
  return `резюме: «${truncate(session.summary, SUMMARY, g.ellipsis)}» (будет перезаписано)`;
}

/** 4.4. Тот же диалог для `○ exited` и для завершённых `✓` / `✗`. */
export function resumeDialog(
  row: WorkRowSession,
  command: string,
  g: Glyphs,
  width: number,
): DialogSpec {
  const { session } = row;
  // На узкой колонке провайдера в заголовке нет вовсе: место занимает роль,
  // а провайдер и так виден в команде возобновления строкой ниже (макет 4.4).
  const provider = width >= WIDE ? ` (${providerLabel(session.provider)})` : '';
  return {
    title: `ВОЗОБНОВИТЬ ${statusGlyph(session.status, g)} ${session.label}${provider}`,
    fields: [],
    info: [command, exitLine(session), summaryLine(session, g)],
    quote: [],
    footer: 'Enter — возобновить · Esc',
  };
}
