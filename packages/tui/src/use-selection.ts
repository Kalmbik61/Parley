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
  /** Есть ли у работы комната — хотя бы одно письмо (дизайн комнаты, 3). */
  room?: boolean;
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
   * Комната выбрана вместо сессии (дизайн комнаты, 3-4): `session` при этом не
   * меняется — панель и её PTY не трогаются, меняется только этот признак.
   */
  room: boolean;
  /**
   * Выбрать работу и сразу подключить панель к её сессии: к той, к которой
   * подключались в этой работе последней, иначе к самой свежей. Явная сессия —
   * для ходьбы `j`/`k` через границу работ. Панель следует за работой, как в herdr.
   * Явный выбор работы снимает признак комнаты (дизайн комнаты, 4).
   */
  selectWork: (key: string, sessionId?: string) => void;
  /**
   * Выбрать сессию, не подключаясь: ходьба по сайдбару в режиме навигации
   * (3.2). Снимает признак комнаты, как и любой явный выбор сессии (комната, 4).
   */
  selectSession: (sessionId: string) => void;
  /**
   * Выбрать сессию и подключить к ней панель. Работа берётся выбранная, а
   * явный ключ нужен там, где она родилась в этот же обработчик и в состоянии
   * выбора ещё не отразилась (5.1). Снимает признак комнаты (комната, 4).
   */
  attach: (sessionId: string, workKey?: string) => void;
  /**
   * Выбрать комнату вместо сессии (дизайн комнаты, 3-5): `session` не меняется
   * и панель не подключается заново — `onAttach` здесь не зовётся никогда. Явный
   * `key` нужен ходьбе `j`/`k`, когда она попадает в комнату чужой ещё не
   * выбранной работы: работа меняется, а сессия внутри неё чинится сама, как
   * при исчезновении прежней (см. комментарий к `useSelection`).
   */
  selectRoom: (key?: string) => void;
  /** Вернуться из комнаты к той же сессии, с которой пришли — она не менялась. */
  leaveRoom: () => void;
}

export function useSelection({ works, onAttach }: SelectionOptions): SelectionState {
  const [chosenWork, setChosenWork] = useState<string | null>(null);
  const [chosenSession, setChosenSession] = useState<string | null>(null);
  // Ключ работы, чья комната выбрана вместо сессии; сама сессия при этом не
  // меняется (комната, 3). Хранится ключ, а не флаг: признак обязан принадлежать
  // своей работе и чиниться на рендере так же, как `work` и `session`. Флаг без
  // хозяина при исчезновении работы молча переезжал на соседнюю.
  const [roomOf, setRoomOf] = useState<string | null>(null);
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
      setRoomOf(null);
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

  const selectSession = useCallback((sessionId: string) => {
    setChosenSession(sessionId);
    setRoomOf(null);
  }, []);

  const owner = work?.key ?? null;
  const attach = useCallback(
    (sessionId: string, key?: string) => {
      setChosenSession(sessionId);
      setRoomOf(null);
      const inWork = key ?? owner;
      if (inWork === null) return;
      lastAttached.current.set(inWork, sessionId);
      onAttach?.(sessionId, inWork);
    },
    [owner, onAttach],
  );

  // Комната не подключает панель заново: `onAttach` тут не зовётся никогда —
  // ни сессия, ни её PTY не трогаются (дизайн комнаты, 3-4). Явный `key`
  // переключает работу самим состоянием выбора — сессия внутри неё чинится
  // сама на рендере, тем же способом, что и пропавшая сессия прежней работы.
  const selectRoom = useCallback(
    (key?: string) => {
      const target = key ?? owner;
      if (target === null) return;
      if (key !== undefined) setChosenWork(key);
      setRoomOf(target);
    },
    [owner],
  );

  const leaveRoom = useCallback(() => setRoomOf(null), []);

  // Комната выбрана, только пока её работа выбрана и в ней есть письма:
  // считается на рендере, как `work` и `session` выше.
  const room = roomOf !== null && roomOf === work?.key && work.room === true;

  return {
    work: work?.key ?? null,
    session,
    room,
    selectWork,
    selectSession,
    attach,
    selectRoom,
    leaveRoom,
  };
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
