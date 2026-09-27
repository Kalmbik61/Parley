/**
 * Одна отправка окна агенту (кусок 5.4, спека 8.6) — на 5.4, 8.x и 9.x: `pty.send`, тост по
 * таблице 8.6 и его кнопки. Отправка — только явным действием человека (бросок, вставка,
 * кнопка тоста): никаких автоповторов. При `blocked` хост текст не вставляет, окно лишь
 * предлагает скопировать его и открыть сессию.
 */

import { toast } from 'sonner';
import type { WorkSession } from '@harnas/core';
import type { SendResult, SessionRef } from '@harnas/protocol';
import type { HarnasBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { displayStatus } from '../lib/dot-state.js';
import { sessionTag } from '../lib/participant.js';

export type SendOutcome = SendResult | { error: 'not_found' | 'failed'; message: string };

/** Отказ вызова разбирает decodeIpcError (E.1): код not_found → not_found, прочее → failed. */
export async function sendToAgent(bridge: HarnasBridge, ref: SessionRef, text: string, submit: boolean): Promise<SendOutcome> {
  try {
    return await bridge.call('pty.send', { ref, text, submit });
  } catch (error) {
    const { code, message } = decodeIpcError(error);
    // Текст хоста (может быть русским) — только в консоль, человеку — английский тост.
    console.warn('[harnas] pty.send', message);
    return { error: code === 'not_found' ? 'not_found' : 'failed', message };
  }
}

/**
 * Тот же набор, что `RESUMABLE` меню сессии (`sidebar/SessionRowMenu.tsx`): у активной без PTY
 * хост поднял бы второй процесс.
 */
const RESUMABLE: ReadonlySet<string> = new Set(['exited', 'done', 'failed']);

/** «Resume» уместна: status exited, done или failed и lifecycle не closed — как RESUMABLE меню сессии. */
export function canResume(session: WorkSession): boolean {
  // У закрытой `sessions.resume` падает (host/sessions/sessions-service.ts).
  return session.lifecycle !== 'closed' && RESUMABLE.has(displayStatus(session));
}

export interface SendToast {
  text: string;
  actions: Array<'copy' | 'open' | 'retry' | 'resume'>;
  error: boolean;
}

/** Таблица спеки 8.6; null — тоста нет: вставлено без Enter по просьбе (submit: false, reason: null). */
export function sendToast(outcome: SendOutcome, label: string, resumable: boolean): SendToast | null {
  if ('error' in outcome) {
    if (outcome.error === 'not_found') return { text: S.send.notRunning(label), actions: resumable ? ['resume'] : [], error: true };
    return { text: errorText('failed', S.errors.actions.assignToAgent), actions: [], error: true };
  }
  switch (outcome.reason) {
    case null:
      return outcome.submitted ? { text: S.send.sent(label), actions: [], error: false } : null;
    case 'draft':
      return { text: S.send.insertedDraft(label), actions: [], error: false };
    case 'input':
      return { text: S.send.insertedInput(label), actions: [], error: false };
    case 'restarted':
      return { text: S.send.insertedRestarted(label), actions: [], error: false };
    case 'blocked':
      return { text: S.send.blocked(label), actions: ['copy', 'open'], error: true };
    case 'busy':
      return { text: S.send.busy(label), actions: ['retry'], error: true };
    case 'no-paste-mode':
      return { text: S.send.noPasteMode(label), actions: ['copy'], error: true };
  }
}

export interface SendWithToastDeps {
  bridge: HarnasBridge;
  /** Сессия из снимка работ (useWorksStore) — для canResume; null — её нет. */
  session(ref: SessionRef): WorkSession | null;
  /**
   * «Open S02»: applyFocusTarget({ kind: 'session', ref }, …) из 4.3 — работа, вкладка и фокус терминала;
   * зависимости — как у обработчика onFocusTarget в App.tsx.
   */
  openSession(ref: SessionRef): void;
  /**
   * Исход каждой попытки — первой и каждого Retry из тоста. Исход Retry вызывающему иначе не дойти:
   * по нему 8.4b ставит заметкам sentAt (сверка этапа 8, I2).
   */
  onOutcome?(outcome: SendOutcome): void;
}

interface ToastButton {
  label: string;
  onClick: () => void;
}

/**
 * Одна отправка окна на 5.4, 8.x и 9.x: sendToAgent, тост sendToast через sonner (ярлык — sessionTag) и его
 * кнопки: Copy — исходный текст в буфер, Open — openSession, Retry — тот же вызов, Resume — sessions.resume.
 * Возвращает исход первой попытки; исходы всех попыток, включая Retry, — в deps.onOutcome.
 */
export async function sendWithToast(deps: SendWithToastDeps, ref: SessionRef, text: string, submit: boolean): Promise<SendOutcome> {
  const outcome = await sendToAgent(deps.bridge, ref, text, submit);
  deps.onOutcome?.(outcome);
  const label = sessionTag(ref.sessionId);
  const session = deps.session(ref);
  const shown = sendToast(outcome, label, session !== null && canResume(session));
  if (shown === null) return outcome;

  const buttons: Record<SendToast['actions'][number], ToastButton> = {
    copy: {
      label: S.common.copy,
      onClick: () => {
        navigator.clipboard.writeText(text).catch((error: unknown) => console.warn('[harnas] clipboard', error));
      },
    },
    open: { label: S.send.openSession(label), onClick: () => deps.openSession(ref) },
    // Повтор — тем же путём и с теми же deps: его исход тоже уходит в onOutcome.
    retry: { label: S.common.retry, onClick: () => void sendWithToast(deps, ref, text, submit) },
    resume: {
      label: S.sidebar.sessionMenu.resume,
      onClick: () => {
        deps.bridge.call('sessions.resume', { ref }).catch((error: unknown) => console.warn('[harnas] sessions.resume', error));
      },
    },
  };
  // У sonner две кнопки: `action` и `cancel` — таблице 8.6 больше двух не нужно.
  const [first, second] = shown.actions.map((action) => buttons[action]);
  const options = {
    ...(first === undefined ? {} : { action: first }),
    ...(second === undefined ? {} : { cancel: second }),
  };
  if (shown.error) toast.error(shown.text, options);
  else toast(shown.text, options);
  return outcome;
}
