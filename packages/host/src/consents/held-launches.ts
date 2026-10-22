/**
 * Что хост делает с удержанным запуском после решения человека (спека 2026-10-21, 4.2): `allow` продолжает запуск,
 * `deny` отказывает. Сервис согласий (`consents-service.ts`) только хранит карточки и зовёт эти два действия.
 */

import { addMessage, sessionTag, setResult, SYSTEM, updateMap } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { HeldLaunch } from './consents-service.js';

export interface HeldLaunchDeps {
  /** Запуск сессии (`SessionsService.launch`). */
  launch(ref: SessionRef, mode: HeldLaunch['mode'], options: { by: string }): Promise<unknown>;
  /** Закрытие сессии насовсем (`SessionsService.close` — тот же путь, что у метода `sessions.close`). */
  close(ref: SessionRef): Promise<void>;
  /** Пересчёт сессии будильником (`WakeService.retry`). */
  retry(ref: SessionRef): void;
}

export function createHeldLaunchActions(deps: HeldLaunchDeps): {
  continueLaunch(hold: HeldLaunch): Promise<void>;
  refuseLaunch(hold: HeldLaunch): Promise<void>;
} {
  return {
    // Новая сессия — обычный запуск; подъём письмом — через будильник (его письма так и лежат непрочитанными, а
    // `launch` без них ничего не подняло бы с указателем), прочий подъём (ручной resume, прерванные после падения
    // хоста) — сразу.
    async continueLaunch(hold) {
      if (hold.mode === 'resume' && hold.by === 'wake') {
        deps.retry(hold.ref);
        return;
      }
      await deps.launch(hold.ref, hold.mode, { by: hold.by });
    },

    // Новая сессия закрывается с итогом `failed`, создателю-агенту — системное письмо; спящая не поднимается: её письма
    // ждут, пока человек не решит иначе.
    async refuseLaunch(hold) {
      if (hold.mode !== 'launch') return;
      const { ref } = hold;
      let open = false;
      await updateMap(ref.projectPath, ref.workId, (map) => {
        const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
        // Сессии уже нет или её закрыли за время ожидания: отказывать нечему.
        if (session === undefined || session.lifecycle === 'closed') return;
        open = true;
        setResult(map, ref.sessionId, 'failed');
        // Создатель — родитель записи или тот, чей id пришёл как `by` (`create_session` ставит его); у запуска человека
        // `by` — `human`, такой сессии нет, и письма нет.
        const creator = session.parent ?? hold.by;
        if (creator !== ref.sessionId && map.sessions.some((candidate) => candidate.id === creator && candidate.lifecycle !== 'closed')) {
          addMessage(map, { from: SYSTEM, to: [creator], text: `launch refused: folder not trusted (${sessionTag(ref.sessionId)})` });
        }
      });
      if (open) await deps.close(ref);
    },
  };
}
