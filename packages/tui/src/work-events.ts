/**
 * События карты для строки статуса: что изменилось между двумя чтениями работ
 * (дизайн координации TUI, таблица в разделе 5).
 */

import type { Message, WorkEntry, WorkSession } from '@harnas/core';
import type { Glyphs } from './glyphs.js';
import type { StatusEventInit } from './use-status.js';
import { providerMarkOf, workKey } from './work-rows.js';

/** Столько знаков цитаты помещается в строку статуса рядом с остальным. */
const QUOTE = 20;

const quote = (text: string, g: Glyphs): string =>
  // Пробел перед знаком усечения выглядит опечаткой — режем по последнему слову.
  text.length > QUOTE ? `«${text.slice(0, QUOTE).trimEnd()}${g.ellipsis}»` : `«${text}»`;

const labelOf = (sessions: readonly WorkSession[], id: string): string =>
  sessions.find((session) => session.id === id)?.label ?? id;

function sessionEvents(
  before: WorkEntry,
  after: WorkEntry,
  g: Glyphs,
  prefix: string,
  autoLaunch: boolean,
): StatusEventInit[] {
  const events: StatusEventInit[] = [];
  const known = new Map(before.map.sessions.map((session) => [session.id, session]));
  const title = after.map.work.title;

  for (const session of after.map.sessions) {
    const source = {
      projectPath: after.projectPath,
      workId: after.map.work.id,
      sessionId: session.id,
    };
    const previous = known.get(session.id);

    if (previous === undefined) {
      // Работу открыл пользователь — новая запись появляется уже `pending`.
      if (session.status === 'pending') {
        const mark = providerMarkOf(session.provider);
        // Порождённую агентом при включённом автозапуске поднимет сам харнесс
        // (5.2): звать человека к Enter незачем. Заведённую человеком — по-прежнему.
        events.push(
          autoLaunch && session.parent !== null
            ? { text: `${mark}: «${session.label}» в «${title}» — запускается`, source }
            : {
                text: `${mark}: pending «${session.label}» в «${title}»`,
                hint: `${prefix} s ${g.arrow} Enter — запустить`,
                source,
              },
        );
      }
      continue;
    }

    if (previous.status !== 'exited' && session.status === 'exited' && session.summary === null) {
      events.push({
        text: `${g.exited} ${session.label} вышла без отчёта`,
        hint: `${prefix} r — возобновить`,
        source,
      });
    }

    // Дозаказ считается в фоне, и другой индикации у него нет (дизайн 4.5):
    // готовый результат приходит записью карты и отмечается здесь.
    if (
      session.summarySource === 'auto' &&
      (previous.summary !== session.summary || previous.summarySource !== 'auto')
    ) {
      events.push({ text: `авто-резюме для «${session.label}» готово`, source });
    }
  }

  return events;
}

function messageEvents(before: WorkEntry, after: WorkEntry, g: Glyphs): StatusEventInit[] {
  const known = new Set(before.map.messages.map((message: Message) => message.id));
  return after.map.messages
    .filter((message) => !known.has(message.id) && message.readAt === null)
    .map((message) => ({
      text: `${g.mail} ${labelOf(after.map.sessions, message.from)} → ${labelOf(
        after.map.sessions,
        message.to,
      )}: ${quote(message.text, g)}`,
      source: {
        projectPath: after.projectPath,
        workId: after.map.work.id,
        sessionId: message.to,
      },
    }));
}

/**
 * События между двумя списками работ. Появление самой работы событием не считается:
 * она и так видна в списке, а первое чтение иначе завалило бы строку статуса.
 */
export function worksEvents(
  previous: readonly WorkEntry[],
  next: readonly WorkEntry[],
  g: Glyphs,
  /** Имя префикса: клавиши харнесса зовутся в подсказках только через него (§3). */
  prefix: string,
  /** Включён ли автозапуск `pending` от агента: тогда подсказка «запустить» лишняя. */
  autoLaunch = false,
): StatusEventInit[] {
  const before = new Map(
    previous.map((entry) => [workKey(entry.projectPath, entry.map.work.id), entry]),
  );

  const events: StatusEventInit[] = [];
  for (const entry of next) {
    const was = before.get(workKey(entry.projectPath, entry.map.work.id));
    if (was === undefined) continue;
    events.push(
      ...sessionEvents(was, entry, g, prefix, autoLaunch),
      ...messageEvents(was, entry, g),
    );
  }
  return events;
}
