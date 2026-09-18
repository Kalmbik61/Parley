/**
 * События карты для строки статуса: что изменилось между двумя чтениями работ
 * (дизайн координации TUI, таблица в разделе 5).
 */

import {
  DEFAULT_CONFIG,
  participantLabel,
  RATE_WINDOW_MS,
  type Message,
  type WorkEntry,
} from '@harnas/core';
import type { Glyphs } from './glyphs.js';
import type { StatusEventInit, StatusSource } from './use-status.js';
import { providerMarkOf, workKey } from './work-rows.js';

/** Столько знаков цитаты помещается в строку статуса рядом с остальным. */
const QUOTE = 20;

const quote = (text: string, g: Glyphs): string =>
  // Пробел перед знаком усечения выглядит опечаткой — режем по последнему слову.
  text.length > QUOTE ? `«${text.slice(0, QUOTE).trimEnd()}${g.ellipsis}»` : `«${text}»`;

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

/** Письма, появившиеся между двумя чтениями карты. */
const fresh = (before: WorkEntry, after: WorkEntry): Message[] => {
  const known = new Set(before.map.messages.map((message: Message) => message.id));
  return after.map.messages.filter((message) => !known.has(message.id));
};

/** Источник события письма — сессия получателя: событие гаснет, подключившись к ней. */
const toSource = (after: WorkEntry, sessionId: string): StatusSource => ({
  projectPath: after.projectPath,
  workId: after.map.work.id,
  sessionId,
});

function messageEvents(before: WorkEntry, after: WorkEntry, g: Glyphs): StatusEventInit[] {
  const label = (id: string): string => participantLabel(after.map, id);
  return (
    fresh(before, after)
      // Решение показывается своей строкой ниже: две строки об одном письме
      // раздували бы счётчик `⚑N` (макет 6.1 показывает ровно одно событие).
      .filter((message) => message.readAt === null && message.kind !== 'decision')
      .map((message) => ({
        text: `${g.mail} ${label(message.from)} → ${label(message.to)}: ${quote(message.text, g)}`,
        source: toSource(after, message.to),
      }))
  );
}

/**
 * Решение треда — событие строки статуса (6.4). Непрочитанность здесь не
 * условие, в отличие от письма: со звонком адресат просыпается сам и успевает
 * забрать письмо `check_inbox` раньше, чем карта дойдёт до TUI, а договорённость
 * человек должен увидеть в любом случае.
 */
function decisionEvents(before: WorkEntry, after: WorkEntry, g: Glyphs): StatusEventInit[] {
  return fresh(before, after)
    .filter((message) => message.kind === 'decision')
    .map((message) => ({
      text: `${g.done} ${participantLabel(after.map, message.from)}: решение ${quote(
        message.text,
        g,
      )}`,
      source: toSource(after, message.to),
    }));
}

/**
 * Потолок переписки (4.7): TUI считает то же скользящее окно, что и
 * `send_message`, — письма отправителя за час по полю `at` всей карты. Событие
 * поднимается ровно на письме, которым окно заполнилось. Выше потолка писем не
 * создаётся, поэтому подряд событие не повторяется; но окно скользит, и стоит
 * старому письму выпасть из часа, как следующее удачное снова упирается в
 * потолок и снова даёт `⚑` (приёмка 8.38). Так и задумано: человек видит, что
 * переписка всё ещё бьётся о лимит. Состояния не нужно — всё из двух карт.
 */
function rateEvents(before: WorkEntry, after: WorkEntry, rate: number): StatusEventInit[] {
  const events: StatusEventInit[] = [];
  for (const message of fresh(before, after)) {
    const at = Date.parse(message.at);
    const window = after.map.messages.filter((other) => {
      const when = Date.parse(other.at);
      return other.from === message.from && when <= at && at - when < RATE_WINDOW_MS;
    });
    if (window.length !== rate) continue;
    events.push({
      // `⚑` рисует сама строка статуса, в тексте события его нет.
      text: `слишком частые письма · ${participantLabel(after.map, message.from)}`,
      source: toSource(after, message.from),
    });
  }
  return events;
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
  // Обе настройки правят только тексты, поэтому идут одним мешком: позиционным
  // пятым аргументом они бы путались — число и флаг рядом не читаются.
  {
    /** Потолок писем одной сессии за час: тот же, что считает `send_message` (4.7). */
    rate = DEFAULT_CONFIG.messageRate,
    /** Включён ли автозапуск `pending` от агента: тогда подсказка «запустить» лишняя. */
    autoLaunch = false,
  }: { rate?: number; autoLaunch?: boolean } = {},
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
      ...decisionEvents(was, entry, g),
      ...rateEvents(was, entry, rate),
    );
  }
  return events;
}
