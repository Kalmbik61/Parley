/**
 * Что человек узнаёт о запуске Code Mode (план T8h, §7). Если процесс MCP не поднялся, у агента может не быть ни `report`, ни почты, и больше никто
 * об этом не скажет. Раз в 30 с сервис читает у живых PTY решение запуска и запись об экспозиции и говорит один раз. Только уведомление: ничего не
 * перезапускает и не меняет. Решение пишет лаунчер (T12a). Классика молчит, кроме удержанного прогона и отказа детектора (T12a, слайс D): `provider-unproven`
 * и прочие причины видны в строке состояния под переключателем и в метке сессии, а не уведомлением.
 *
 * Нет записи с нонсом этого запуска — «не подтверждено», а не «сбой»: запись появляется при первом списке, а на старт сервера Codex сам отводит 30 с,
 * так что тик может сказать это зря. Память сервиса — только его процесс: после перезапуска хоста то же самое может прозвучать ещё раз.
 */

import { CODE_MODE_REASONS, exposureStatus, readExposureRecord, readLaunchDecision, workPaths } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { HostNotice, SessionRef } from '@parley/protocol';
import type { PtyManager } from '../pty/pty-manager.js';

export const CODE_MODE_NOTICE_TICK_MS = 30_000;
/** Сколько ждать запись об экспозиции от начала запуска, прежде чем сказать «не подтверждено». */
export const CODE_MODE_CONFIRM_MS = 30_000;

export interface CodeModeNoticeDeps {
  pty: Pick<PtyManager, 'list'>;
  notify: (notice: HostNotice) => void;
  now?: () => number;
  tickMs?: number;
}

/**
 * Текст уведомления по решению и записи этого запуска; `null` — говорить не о чем (или пока рано). Ключ — один раз на состояние запуска или на удержание
 * сессии: `failed` после «не подтверждено» сказать обязательно, иначе человек не узнает причину, а прежний текст останется неправдой.
 */
export function codeModeNoticeOf(ref: SessionRef, now: number): { key: string; text: string } | null {
  const { dir } = workPaths(ref.projectPath, ref.workId);
  const read = readLaunchDecision(dir, ref.sessionId);
  if (read.kind !== 'decision') return null;
  const { decision } = read;
  if (decision.effective === 'classic') {
    if (decision.reason === 'held-run') return { key: 'held', text: `An earlier Code Mode run in session ${ref.sessionId} may still be finishing or was not accounted for: it runs with its direct tools.` };
    return detectorNotice(ref, decision.reason);
  }
  const status = exposureStatus(decision, readExposureRecord(dir, ref.sessionId));
  if (status.status === 'failed') return { key: `${decision.nonce}:failed`, text: `Code Mode failed to start in session ${ref.sessionId} (${status.reason}): it may have no Parley tools. Resume starts it again.` };
  if (status.status === 'unknown' && !(now - Date.parse(decision.at) < CODE_MODE_CONFIRM_MS)) return { key: `${decision.nonce}:unknown`, text: `Code Mode is not confirmed in session ${ref.sessionId}: its server has not reported yet.` };
  return null;
}

/**
 * Отказ детектора при запуске (T12a, слайс D): правило или хук на инструменты Parley, или источник, который не прочитать. Один раз на сессию и причину:
 * следующий запуск с той же причиной молчит, другая причина говорит снова. Класс источника — из фиксированной грамматики решения, не свободный текст.
 */
function detectorNotice(ref: SessionRef, reason: string | null): { key: string; text: string } | null {
  const tail = `Code Mode is off for this launch of session ${ref.sessionId}: it runs with its direct tools, and a relaunch checks again.`;
  if (reason === 'detector') return { key: 'refused:detector', text: `${CODE_MODE_REASONS.detector} ${tail}` };
  const uninspected = reason === null ? null : /^uninspected-source:([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(reason);
  if (uninspected !== null) return { key: `refused:${reason}`, text: `${CODE_MODE_REASONS['uninspected-source'].replace(/\.$/, '')} (${uninspected[1]}). ${tail}` };
  return null;
}

/** Запускает тик; возвращает остановку для `onShutdown`. */
export function startCodeModeNotices(deps: CodeModeNoticeDeps): () => Promise<void> {
  const now = deps.now ?? Date.now;
  /** Что уже сказано: сессия и ключ уведомления. Запись на запуск, пока жив хост. */
  const told = new Set<string>();
  const tick = (): void => {
    for (const { ref } of deps.pty.list()) {
      const notice = codeModeNoticeOf(ref, now());
      if (notice === null) continue;
      const said = `${refKey(ref)} ${notice.key}`;
      if (told.has(said)) continue;
      told.add(said);
      deps.notify({ kind: 'code-mode-failed', ref, text: notice.text, at: new Date(now()).toISOString() });
    }
  };
  const timer = setInterval(tick, deps.tickMs ?? CODE_MODE_NOTICE_TICK_MS);
  timer.unref();
  return async () => { clearInterval(timer); };
}
