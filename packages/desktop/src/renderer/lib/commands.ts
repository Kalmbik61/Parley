/**
 * Команды палитры ⌘K (кусок 2.3 плана окна, спека 5.2): работы, сессии всех
 * работ и общие действия. Список пересобирается заново при каждом открытии
 * палитры (вызывающая сторона — `Workspace.tsx`, у неё есть и живой список
 * работ, и API dockview) — команд от силы пара десятков, кешировать нечего.
 *
 * Модуль, как и весь `lib/`, не знает про `zustand` и `HarnasBridge` напрямую:
 * обращения к хранилищам и хосту приходят через `actions`, которые собирает
 * вызывающий компонент. Это расходится с интерфейсом из плана куска
 * (`buildCommands(state: { works, ui, bridge })`), где палитра сама трогала
 * бы хранилище и бридж, — но `lib/` в этом проекте везде держит только
 * чистые функции (см. `panel-id.ts`, `tree-order.ts`), а связь со сторонним
 * состоянием заводят компоненты. `buildCommands` от этого проверяется без
 * монтирования React и без фейкового бриджа.
 *
 * «Вся почта работы» (действие куска 2.4) сюда пока не входит: панель `mail`
 * уже есть как заглушка (`panel-registry.tsx`), а команда для неё появится
 * вместе с моделью писем в 2.4 — раньше её нечем наполнить.
 */

import type { WorkEntry } from '@harnas/core';
import { refKey, type SessionRef } from '@harnas/protocol';
import { sessionRowLabel } from './participant.js';
import { orderedWorks } from '../store/works.js';
import { treeOrder, workKey } from './tree-order.js';

export interface Command {
  id: string;
  title: string;
  hint?: string;
  keywords: string[];
  run(): void | Promise<void>;
}

/** Действия, которые запускают команды палитры — их знает только вызывающий компонент (кусок 2.3). */
export interface CommandActions {
  /** Открыть сессию в сетке — `Workspace.tsx#openSession`/`openOrFocus`. */
  openSession(ref: SessionRef, workKey: string, title: string): void;
  closeActivePanel(): void;
  newSession(): void;
  newWork(): void;
  settings(): void;
  toggleWake(): void;
}

export interface BuildCommandsState {
  works: readonly WorkEntry[];
  /** `store/ui.ts#lastSessionByWork` — какую сессию открыть по команде «переключиться на работу». */
  lastSessionByWork: Record<string, string>;
  wakePaused: boolean | null;
  /** `store/ui.ts#recentSessionRefs` — порядок для пустого запроса: самые недавно открытые сессии первыми. */
  recentSessionRefs: readonly SessionRef[];
  actions: CommandActions;
}

export function buildCommands(state: BuildCommandsState): Command[] {
  const { works, lastSessionByWork, wakePaused, recentSessionRefs, actions } = state;
  const ordered = orderedWorks(works);

  const workCommandByKey = new Map<string, Command>();
  const sessionCommandByKey = new Map<string, Command>();
  const sessionKeysByWork = new Map<string, string[]>();

  for (const work of ordered) {
    const key = workKey(work.projectPath, work.map.work.id);
    const treeSessions = treeOrder(work.map.sessions);
    const lastSessionId = lastSessionByWork[key];
    const targetSession =
      treeSessions.find((item) => item.session.id === lastSessionId)?.session ?? treeSessions[0]?.session;

    workCommandByKey.set(key, {
      id: `work:${key}`,
      title: work.map.work.title,
      hint: 'работа',
      keywords: [work.map.work.title],
      run: () => {
        // Нет ни одной сессии — переключаться не на что (как ⌘1…⌘9 в `App.tsx`).
        if (targetSession === undefined) return;
        actions.openSession(
          { projectPath: work.projectPath, workId: work.map.work.id, sessionId: targetSession.id },
          key,
          sessionRowLabel(targetSession.id, targetSession.label),
        );
      },
    });

    const sessionKeys: string[] = [];
    for (const { session } of treeSessions) {
      const ref: SessionRef = { projectPath: work.projectPath, workId: work.map.work.id, sessionId: session.id };
      const sessionKey = refKey(ref);
      const label = sessionRowLabel(session.id, session.label);
      sessionCommandByKey.set(sessionKey, {
        id: `session:${key}:${session.id}`,
        title: label,
        hint: work.map.work.title,
        keywords: [label, work.map.work.title],
        run: () => actions.openSession(ref, key, label),
      });
      sessionKeys.push(sessionKey);
    }
    sessionKeysByWork.set(key, sessionKeys);
  }

  // Пустой запрос — сначала недавние сессии (спека 5.2). Дальше те же сессии
  // не повторяются: `used` фильтрует их из обычного порядка ниже.
  const used = new Set<string>();
  const recent: Command[] = [];
  for (const ref of recentSessionRefs) {
    const sessionKey = refKey(ref);
    if (used.has(sessionKey)) continue;
    const command = sessionCommandByKey.get(sessionKey);
    if (command === undefined) continue;
    recent.push(command);
    used.add(sessionKey);
  }

  const rest: Command[] = [];
  for (const work of ordered) {
    const key = workKey(work.projectPath, work.map.work.id);
    const workCommand = workCommandByKey.get(key);
    if (workCommand !== undefined) rest.push(workCommand);
    for (const sessionKey of sessionKeysByWork.get(key) ?? []) {
      if (used.has(sessionKey)) continue;
      const command = sessionCommandByKey.get(sessionKey);
      if (command !== undefined) rest.push(command);
    }
  }

  const actionCommands: Command[] = [
    {
      id: 'action:new-session',
      title: 'Новая сессия',
      keywords: ['новая сессия', 'создать сессию'],
      run: actions.newSession,
    },
    {
      id: 'action:new-work',
      title: 'Новая работа',
      keywords: ['новая работа', 'создать работу'],
      run: actions.newWork,
    },
    { id: 'action:settings', title: 'Настройки', keywords: ['настройки'], run: actions.settings },
    {
      id: 'action:toggle-wake',
      title: wakePaused === true ? 'Снять паузу будильника' : 'Пауза будильника',
      keywords: ['будильник', 'пауза'],
      run: actions.toggleWake,
    },
    { id: 'action:close-panel', title: 'Закрыть панель', keywords: ['закрыть панель'], run: actions.closeActivePanel },
  ];

  return [...recent, ...rest, ...actionCommands];
}
