/**
 * Метаданные вкладки для строки вкладок (спека 5.3, кусок 2.4): заголовок,
 * значок и данные для точки состояния — из `TabSpec` и текущего снимка
 * работы. Чистая функция, как и `layout/tree.ts`: сама раскладка ничего не
 * знает про сессии/комнаты, только про их id, поэтому заголовок собирается
 * заново на каждый рендер из свежего `WorkEntry`, а не хранится в `TabSpec`.
 */

import type { WorkEntry, WorkSession } from '@harnas/core';
import type { TabSpec } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { sessionRowLabel, sessionTag } from '../lib/participant.js';

export interface TabMeta {
  title: string;
  icon: 'terminal' | 'mail' | 'room' | 'diff' | 'file' | 'browser';
  /** Для точки состояния и значка агента (`Tab.tsx`, спека 4.2) — только у `terminal`. */
  session: WorkSession | null;
  /** В этапе 2 всегда `false` — подключит этап 4. */
  unread: boolean;
  /** В этапе 2 всегда `false` — подключит кусок 7.3. */
  dirty: boolean;
  /** В этапе 2 всегда `null` — подключит кусок 9.2. */
  favicon: string | null;
}

/** Предел заголовка вкладки (план, «Числа»): 40 кодовых точек, дальше «…». */
const TITLE_MAX = 40;

/**
 * Обрезка ПО КОДОВЫМ ТОЧКАМ, не по code unit: `Array.from` разбивает строку на
 * code points (суррогатная пара считается одним элементом), поэтому эмодзи вне
 * BMP не рвётся пополам на непарный суррогат посреди обрезки.
 */
export function truncateTitle(title: string, max: number = TITLE_MAX): string {
  const codePoints = Array.from(title);
  if (codePoints.length <= max) return title;
  return `${codePoints.slice(0, max).join('')}…`;
}

function findSession(entry: WorkEntry | null, sessionId: string): WorkSession | null {
  return entry?.map.sessions.find((session) => session.id === sessionId) ?? null;
}

/** Имя файла из относительного пути вкладки — без учёта совпадений имён (папка добавится, когда вкладки `file` станут открываемыми, этап 7). */
function fileBaseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export function tabMeta(tab: TabSpec, entry: WorkEntry | null): TabMeta {
  const empty = { unread: false, dirty: false, favicon: null } as const;

  switch (tab.kind) {
    case 'terminal': {
      const session = findSession(entry, tab.sessionId);
      const title = session === null ? sessionTag(tab.sessionId) : sessionRowLabel(session.id, session.label);
      return { title: truncateTitle(title), icon: 'terminal', session, ...empty };
    }
    case 'mail':
      return { title: truncateTitle(S.tabs.mail), icon: 'mail', session: null, ...empty };
    case 'room': {
      const room = entry?.map.rooms.find((candidate) => candidate.id === tab.roomId) ?? null;
      return { title: truncateTitle(room?.title ?? S.rooms.fallbackTitle), icon: 'room', session: null, ...empty };
    }
    case 'diff': {
      const shortHash = tab.commit === null ? null : tab.commit.slice(0, 7);
      const title = S.tabs.diffTitle(sessionTag(tab.sessionId), shortHash);
      return { title: truncateTitle(title), icon: 'diff', session: null, ...empty };
    }
    case 'file':
      return { title: truncateTitle(fileBaseName(tab.path)), icon: 'file', session: null, ...empty };
    case 'browser':
      return { title: truncateTitle(tab.url), icon: 'browser', session: null, ...empty };
  }
}
