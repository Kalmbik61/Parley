import { unreadFor } from '../work/letters.js';
import { readMap, workPaths } from '../work/store.js';
import { participantLabel } from '../work/thread.js';
import type { Message } from '../work/types.js';
import type { McpContext } from './context.js';
import { waitForMap } from './watch-map.js';

/*
 * Сторож входящих (разговор агентов 2026-09-08, 4.2; решения D8, D16). Только
 * читает карту и звонит — письмо агент забирает сам своим `check_inbox`,
 * поэтому `readBy` остаётся честным, а гонок с `check_inbox` и `wait_for` нет:
 *
 *   while (!stopped)
 *     found = await waitForMap(map, probe, waitMs, pollMs)
 *             probe: unreadFor(me) && id ∉ rung
 *                    (пусто → null: ждём дальше), звонок собирается тут же —
 *                    по тому же снимку карты
 *     for letter of found:
 *       rung.add(id)                ← звоним про письмо один раз
 *       await notify(звонок)        ← сорвалось: rung.delete(id), позвоним позже
 *
 *   состояния письма (карту меняет только агент своими инструментами)
 *     непрочитано ──звонок──▶ непрочитано, звонок сделан
 *          │                             │
 *          └────check_inbox / wait_for───┴──▶ прочитано (readBy[me])
 *
 * Множество `rung` живёт в памяти процесса: после перезапуска непрочитанное
 * письмо позвонит ещё раз, и это правильно — агент его так и не забрал.
 */

/**
 * Звонок: что пришло и от кого, без текста — текст агент заберёт `check_inbox`.
 * Псевдоним, а не интерфейс: у интерфейса нет неявной индексной сигнатуры, и
 * `params` уведомления SDK его бы не принял.
 */
export type Ring = {
  content: string;
  /** Ключи — только идентификаторы: остальные Claude Code молча выбросит (4.2). */
  meta: Record<string, string>;
};

export interface InboxWatchOptions {
  notify: (ring: Ring) => Promise<void>;
  /** Как часто перечитывать карту, если `fs.watch` промолчал. */
  pollMs: number;
  /** Ожидание в `waitForMap` за один оборот; тесты укорачивают. */
  waitMs?: number;
}

/** Оборот сторожа: час без писем — просто новый заход, агент этого не видит. */
const LONG_MS = 60 * 60 * 1000;

/** Письмо и готовый звонок про него: оба собраны по одному снимку карты. */
interface Call {
  letter: Message;
  ring: Ring;
}

export function ringFor(letter: Message, fromLabel: string, unread: number): Ring {
  return {
    content: `Новое письмо от ${fromLabel} (${letter.kind}): позови check_inbox.`,
    meta: {
      message_id: letter.id,
      from: letter.from,
      from_label: fromLabel,
      kind: letter.kind,
      // Сколько заберёт один `check_inbox`: агенту не нужно звать его по письму.
      unread: String(unread),
    },
  };
}

/** Запускает сторож входящих; возвращает функцию остановки. */
export function watchInbox(
  context: McpContext & { sessionId: string },
  { notify, pollMs, waitMs = LONG_MS }: InboxWatchOptions,
): () => void {
  const rung = new Set<string>();
  let stopped = false;
  const mapFile = workPaths(context.projectPath, context.workId).map;

  /**
   * Заход по карте: и письма, и звонки про них считаются по одному снимку.
   * Второе чтение карты ради `unread` показало бы «0 непрочитанных» в звонке
   * про письмо, которое агент успел забрать сам, — и звонок спорил бы сам с
   * собой. Заодно всё, что умеет бросить, остаётся внутри пробы: отказ ловит
   * `catch` вокруг `waitForMap`, и цикл сторожа его переживает.
   */
  const probe = async (): Promise<Call[] | null> => {
    // Пустой список будит `waitForMap` и гасит его таймеры: иначе закрытый
    // транспорт оставил бы процесс ждать своего часа.
    if (stopped) return [];
    const map = await readMap(context.projectPath, context.workId);
    const mine = unreadFor(map, context.sessionId);
    const letters = mine
      .filter((message) => !rung.has(message.id))
      .sort((a, b) => a.at.localeCompare(b.at));
    if (letters.length === 0) return null;
    return letters.map((letter) => ({
      letter,
      ring: ringFor(letter, participantLabel(map, letter.from), mine.length),
    }));
  };

  void (async () => {
    while (!stopped) {
      let found: Call[] | null = null;
      try {
        found = await waitForMap(mapFile, probe, waitMs, pollMs);
      } catch {
        // Карта не парсится или исчезла (работу снесли живьём): подождём
        // следующего изменения.
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      if (stopped || found === null) continue;
      let failed = false;
      for (const { letter, ring } of found) {
        rung.add(letter.id);
        try {
          await notify(ring);
        } catch {
          // Звонок не дошёл (транспорт закрыт, клиент занят): позвоним снова.
          rung.delete(letter.id);
          failed = true;
        }
      }
      // Письмо осталось непрочитанным, и следующий заход нашёл бы его сразу:
      // без паузы сорвавшийся звонок крутил бы цикл вхолостую.
      if (failed) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  })();

  return () => {
    stopped = true;
  };
}
