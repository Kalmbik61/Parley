/**
 * Метаданные вкладки для строки вкладок (спека 5.3, кусок 2.4): заголовок,
 * значок и данные для точки состояния — из `TabSpec` и текущего снимка
 * работы. Чистая функция, как и `layout/tree.ts`: сама раскладка ничего не
 * знает про сессии/комнаты, только про их id, поэтому заголовок собирается
 * заново на каждый рендер из свежего `WorkEntry`, а не хранится в `TabSpec`.
 */

import type { WorkEntry, WorkSession } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import type { TabSpec } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { workKey as workKeyOf } from '../../shared/work-keys.js';
import type { Attention } from '../attention/derive.js';
import { bufferKey } from '../files/buffer.js';
import { sessionRowLabel, sessionTag } from '../lib/participant.js';

/**
 * Данные хранилищ для `tabMeta` одним входом (кусок 4.2): `tabMeta` остаётся чистой, а
 * 7.3 и 9.2 наполняют свои поля, а не добавляют параметры. Собирает `useTabMetaExtras`.
 */
export interface TabMetaExtras {
  attention: Record<string /* refKey */, Attention>;   // 4.2
  dirtyTabIds: ReadonlySet<string>;                     // 7.3a: bufferKey грязных буферов — не голые id вкладок
  browser: Record<string /* tabId */, { title: string | null; favicon: string | null }>;  // 9.2a: browser/store.ts
}

export const EMPTY_EXTRAS: TabMetaExtras = { attention: {}, dirtyTabIds: new Set(), browser: {} };

export interface TabMeta {
  title: string;
  icon: 'terminal' | 'mail' | 'room' | 'diff' | 'file' | 'browser';
  /** Для точки состояния и значка агента (`Tab.tsx`, спека 4.2) — только у `terminal`. */
  session: WorkSession | null;
  /** Сессия вкладки-терминала в `needs-you` или `unseen` (спека 7.3): подложка amber-500/10. */
  unread: boolean;
  /** Сессия в `needs-you`: значок вопроса вместо точки — важнее точки (кусок 4.2). */
  needsYou: boolean;
  /** Вкладка file с несохранённым буфером своей работы (кусок 7.3a). */
  dirty: boolean;
  /** Favicon вкладки браузера — `data:` из main (9.2a); у прочих видов `null`. */
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

/** Имя файла из относительного пути вкладки — без учёта совпадений имён (их решает `fileTabTitles`). */
function fileBaseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Ближняя папка и имя: `a/b/c/index.ts` → `c/index.ts`; файл в корне — только имя. */
function withParent(path: string): string {
  const parts = path.split('/');
  return parts.length < 2 ? path : parts.slice(-2).join('/');
}

/** Заголовки вкладок file одной строки: имя; при совпадении имён — `папка/имя` (спека 5.3). */
export function fileTabTitles(tabs: readonly TabSpec[]): ReadonlyMap<string /* tabId */, string> {
  const files = tabs.filter((tab): tab is Extract<TabSpec, { kind: 'file' }> => tab.kind === 'file');
  const counts = new Map<string, number>();
  for (const tab of files) counts.set(fileBaseName(tab.path), (counts.get(fileBaseName(tab.path)) ?? 0) + 1);
  const titles = new Map<string, string>();
  for (const tab of files) {
    const name = fileBaseName(tab.path);
    titles.set(tab.id, (counts.get(name) ?? 0) > 1 ? withParent(tab.path) : name);
  }
  return titles;
}

export function tabMeta(tab: TabSpec, entry: WorkEntry | null, extras: TabMetaExtras = EMPTY_EXTRAS): TabMeta {
  const empty = { unread: false, needsYou: false, dirty: false, favicon: null } as const;

  switch (tab.kind) {
    case 'terminal': {
      const session = findSession(entry, tab.sessionId);
      const title = session === null ? sessionTag(tab.sessionId) : sessionRowLabel(session.id, session.label);
      const attention =
        entry === null
          ? undefined
          : extras.attention[refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: tab.sessionId })];
      return {
        title: truncateTitle(title),
        icon: 'terminal',
        session,
        ...empty,
        unread: attention === 'needs-you' || attention === 'unseen',
        needsYou: attention === 'needs-you',
      };
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
    case 'file': {
      // По ключу буфера, а не по id вкладки: у двух работ одного проекта id `file:p:…` одинаковый,
      // и грязный буфер одной поставил бы точку на вкладке другой.
      const dirty = entry !== null && extras.dirtyTabIds.has(bufferKey(workKeyOf(entry.projectPath, entry.map.work.id), tab.id));
      return { title: truncateTitle(fileBaseName(tab.path)), icon: 'file', session: null, ...empty, dirty };
    }
    case 'browser': {
      // Заголовок страницы, иначе адрес, без адреса — «Новая вкладка» (спека 5.3, 12.1).
      const page = extras.browser[tab.id];
      const title = page?.title !== null && page?.title !== undefined && page.title !== '' ? page.title : tab.url;
      return {
        title: truncateTitle(title === '' ? S.browser.newTab : title),
        icon: 'browser',
        session: null,
        ...empty,
        favicon: page?.favicon ?? null,
      };
    }
  }
}
