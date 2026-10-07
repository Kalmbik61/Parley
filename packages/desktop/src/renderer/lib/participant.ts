/**
 * Подпись сессии в строке сайдбара и в уведомлениях: короткий номер (`s-03` →
 * `S03`) плюс ярлык. `sessionTag` перенесена из `@parley/core`
 * (`work/thread.ts`) значением, а не импортом типа: рендерер в песочнице
 * (`contextIsolation`, `sandbox`, без `nodeIntegration` — `window.ts`) не
 * может тянуть рантайм core — тот на верхнем уровне модуля трогает `node:fs`
 * и `node:url` (`work/mcp-config.ts`). Импорт типов из `@parley/core` стирается
 * сборкой и безопасен, импорт значений — нет.
 */

import type { WorkEntry } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';

/** Номер в id вида `s-01`, `s-12`; чужая форма id не трогается (дизайн комнаты, 4). */
const SESSION_ID = /^s-(\d+)$/;

/** Короткий номер сессии: `s-01` → `S01`. */
export function sessionTag(id: string): string {
  const match = SESSION_ID.exec(id);
  return match === null ? id : `S${match[1]}`;
}

/**
 * Те же литералы, что `NEW_LABEL` и `UNTITLED_WORK` в `core/work/launch.ts`: из core рендерер берёт только
 * типы. Core пишет метки в карту по-английски, окно показывает свои тексты. Сборки до перевода текстов писали
 * их по-русски, и такие карты лежат на диске, поэтому окно узнаёт и прежнюю запись.
 */
const NEW_LABEL = 'new session';
const RUSSIAN_NEW_LABEL = 'новая сессия'; // cyrillic-ok: метка-страж core в картах старых сборок
const UNTITLED_WORK = 'untitled';
const RUSSIAN_UNTITLED_WORK = 'без названия'; // cyrillic-ok: метка-страж core в картах старых сборок

/**
 * Указатель на письма — те же выражения, что в `isPointerText` (`core/work/delivery.ts`): целиком и обрезанный
 * `oneLine`. Автозаголовок сборок до 0.7.0 включительно делал его ярлыком агента комнаты (и заголовком безымянной
 * работы); это не имя, и окно показывает такую метку как новую, пока хост не вернул её в карте (`resetPointerLabel`).
 */
const POINTER_TEXT = /^\s*New messages \(\d+\)(?: in r-[\s\S]*)?\. Call check_inbox\.\s*$/;
const CUT_POINTER_TEXT = /^\s*New messages \(\d+\) in r-[\s\S]*…$/;
const isPointerText = (text: string): boolean => POINTER_TEXT.test(text) || CUT_POINTER_TEXT.test(text);

/** Ярлык сессии для окна: метка новой сессии из core и указатель на письма — «New session», остальные как есть. */
export function sessionLabelText(label: string): string {
  return label === NEW_LABEL || label === RUSSIAN_NEW_LABEL || isPointerText(label) ? S.participants.newSession : label;
}

/** Название работы для окна: метка безымянной работы из core и указатель — «Untitled workspace», остальные как есть. */
export function workTitleText(title: string): string {
  return title === UNTITLED_WORK || title === RUSSIAN_UNTITLED_WORK || isPointerText(title)
    ? S.participants.untitledWorkspace
    : title;
}

/** `S03 бэкенд` — то, что видно в строке дерева сессий. */
export function sessionRowLabel(sessionId: string, label: string): string {
  const tag = sessionTag(sessionId);
  return label === '' ? tag : `${tag} ${sessionLabelText(label)}`;
}

/**
 * Ярлык сессии по адресу из снимка работ — для `noticeText` в строке статуса
 * (`shell/AppShell.tsx`), раунд
 * исправлений 1 куска E.1. `ref: null` (уведомления о карте, не о сессии) или
 * сессия/работа уже пропали из снимка — `undefined`: `noticeText` тогда даёт
 * фразу без ярлыка, а не подставляет что попало.
 */
export function sessionLabelFor(entries: readonly WorkEntry[], ref: SessionRef | null): string | undefined {
  if (ref === null) return undefined;
  const entry = entries.find((item) => item.projectPath === ref.projectPath && item.map.work.id === ref.workId);
  const session = entry?.map.sessions.find((candidate) => candidate.id === ref.sessionId);
  return session === undefined ? undefined : sessionRowLabel(session.id, session.label);
}
