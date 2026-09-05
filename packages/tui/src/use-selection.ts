/**
 * Выбор в сайдбаре: какая работа открыта и какая её сессия подключена к панели
 * (дизайн TUI v2, 2.1 и 4.1).
 *
 * Состояние здесь только клиентское: в карту не пишется ничего. Выбор чинится
 * сам — работа могла закончиться, а сессия исчезнуть из карты, пока на них
 * смотрели.
 */

import { useCallback, useRef, useState } from 'react';
import type { WorkEntry } from '@harnas/core';
import { workRunKey } from './pty/use-agent-pty.js';
import type { StatusSource } from './use-status.js';
import { workKey } from './work-rows.js';

export interface SelectionWork {
  key: string;
  /** Id сессий работы в порядке дерева. */
  sessions: readonly string[];
}

export interface SelectionOptions {
  works: readonly SelectionWork[];
  /**
   * Подключение к панели: сессия просмотрена, `unseen` гаснет (раздел 4.1).
   * Ключ работы обязателен — id сессий нумеруются внутри работы, и по голому
   * `s-01` панель уехала бы к чужому агенту.
   */
  onAttach?: (sessionId: string, workKey: string) => void;
}

export interface SelectionState {
  work: string | null;
  session: string | null;
  /**
   * Выбрать работу и сразу подключить панель к её сессии: к той, к которой
   * подключались в этой работе последней, иначе к самой свежей. Явная сессия —
   * для ходьбы `j`/`k` через границу работ. Панель следует за работой, как в herdr.
   */
  selectWork: (key: string, sessionId?: string) => void;
  /** Выбрать сессию, не подключаясь: ходьба по сайдбару в режиме навигации (3.2). */
  selectSession: (sessionId: string) => void;
  /**
   * Выбрать сессию и подключить к ней панель. Работа берётся выбранная, а
   * явный ключ нужен там, где она родилась в этот же обработчик и в состоянии
   * выбора ещё не отразилась (5.1).
   */
  attach: (sessionId: string, workKey?: string) => void;
}

export function useSelection({ works, onAttach }: SelectionOptions): SelectionState {
  const [chosenWork, setChosenWork] = useState<string | null>(null);
  const [chosenSession, setChosenSession] = useState<string | null>(null);
  // Последняя подключённая сессия каждой работы — память клиента на время процесса.
  const lastAttached = useRef(new Map<string, string>());

  // Выбор считается на рендере, а не чинится эффектом: иначе один кадр показывал
  // бы работу, которой уже нет.
  const work = works.find((item) => item.key === chosenWork) ?? works[0] ?? null;
  const sessions = work?.sessions ?? [];
  const session =
    chosenSession !== null && sessions.includes(chosenSession)
      ? chosenSession
      : (sessions[0] ?? null);

  const selectWork = useCallback(
    (key: string, sessionId?: string) => {
      setChosenWork(key);
      const tree = works.find((item) => item.key === key)?.sessions ?? [];
      const remembered = lastAttached.current.get(key);
      const target =
        sessionId ??
        (remembered !== undefined && tree.includes(remembered) ? remembered : tree.at(-1));
      setChosenSession(target ?? null);
      if (target === undefined) return;
      lastAttached.current.set(key, target);
      onAttach?.(target, key);
    },
    [works, onAttach],
  );

  const selectSession = useCallback((sessionId: string) => setChosenSession(sessionId), []);

  const owner = work?.key ?? null;
  const attach = useCallback(
    (sessionId: string, key?: string) => {
      setChosenSession(sessionId);
      const inWork = key ?? owner;
      if (inWork === null) return;
      lastAttached.current.set(inWork, sessionId);
      onAttach?.(sessionId, inWork);
    },
    [owner, onAttach],
  );

  return { work: work?.key ?? null, session, selectWork, selectSession, attach };
}

export interface AttachOptions {
  works: readonly WorkEntry[];
  /** `unseen` гаснет: сессию посмотрели своими глазами (раздел 4.1). */
  markSeen: (sessionId: string) => void;
  /** Событие строки статуса с этим источником тоже гаснет (дизайн координации, 5). */
  seen: (source: StatusSource) => void;
  /** Панель переезжает на сессию: `panel.attach` по ключу её процесса. */
  attach: (runKey: string) => void;
}

/**
 * Что делает подключение к сессии, кроме самого выбора: гасит `unseen`, гасит
 * событие её строки и переводит панель (дизайн TUI v2, 4.1 и 6).
 */
export function useAttachSession({
  works,
  markSeen,
  seen,
  attach,
}: AttachOptions): (sessionId: string, key: string) => void {
  return useCallback(
    (sessionId: string, key: string) => {
      markSeen(sessionId);
      // Сессия ищется парой (работа, id): `s-01` есть у каждой работы, и поиск
      // по голому id уводил бы панель к первой попавшейся.
      const entry = works.find(
        (item) =>
          workKey(item.projectPath, item.map.work.id) === key &&
          item.map.sessions.some((s) => s.id === sessionId),
      );
      if (entry === undefined) return;
      const workId = entry.map.work.id;
      seen({ projectPath: entry.projectPath, workId, sessionId });
      attach(workRunKey(entry.projectPath, workId, sessionId));
    },
    [works, markSeen, seen, attach],
  );
}
