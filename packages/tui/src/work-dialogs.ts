/**
 * Содержимое диалогов левой колонки (дизайн координации TUI, 4.1–4.4).
 *
 * Здесь только текст и поля: файловой системы и Ink нет, поэтому макеты
 * проверяются тестами без запуска чего бы то ни было.
 */

import type { WorkSession } from '@harnas/core';
import type { DialogField } from './components/dialog.js';
import { formatClock, truncate, withHome } from './format.js';
import { statusGlyph, type Glyphs } from './glyphs.js';
import type { ProviderOption } from './work-launch.js';
import { providerLabel, type WorkRowSession } from './work-rows.js';

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

/** 4.2. Провайдер — селектор по реестру; недоступные в PATH не выбираются. */
export function newSessionDialog(workTitle: string, providers: ProviderOption[]): DialogSpec {
  const missing = providers.filter((item) => !item.available).map((item) => item.label);
  return {
    title: `НОВАЯ СЕССИЯ · ${workTitle}`,
    fields: [
      {
        key: 'provider',
        label: 'Провайдер',
        options: providers.map((item) => ({
          id: item.id,
          label: item.label,
          ...(item.available ? {} : { disabled: true }),
        })),
      },
      { key: 'label', label: 'Роль' },
      { key: 'task', label: 'Задача', multiline: true },
    ],
    info: missing.length === 0 ? [] : [`нет в PATH: ${missing.join(', ')}`],
    quote: [],
    footer: 'Enter — создать (pending) · Esc',
  };
}

/**
 * 4.3. Тело — первые строки брифа. Править бриф из TUI нельзя: диалог
 * показывает путь, файл правится своим редактором и перечитывается при `Enter`.
 */
export function launchDialog(row: WorkRowSession, brief: string, g: Glyphs): DialogSpec {
  const { session } = row;
  return {
    title: `ЗАПУСК ${g.pending} ${session.label} (${providerLabel(session.provider)})`,
    fields: [],
    info: [`бриф: briefs/${session.id}.md`],
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
export function resumeDialog(row: WorkRowSession, command: string, g: Glyphs): DialogSpec {
  const { session } = row;
  return {
    title: `ВОЗОБНОВИТЬ ${statusGlyph(session.status, g)} ${session.label} (${providerLabel(
      session.provider,
    )})`,
    fields: [],
    info: [command, exitLine(session), summaryLine(session, g)],
    quote: [],
    footer: 'Enter — возобновить · Esc',
  };
}
