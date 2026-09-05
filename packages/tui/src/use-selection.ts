/**
 * Выбор в сайдбаре: какая работа открыта и какая её сессия подключена к панели
 * (дизайн TUI v2, 2.1 и 4.1).
 *
 * Состояние здесь только клиентское: в карту не пишется ничего. Выбор чинится
 * сам — работа могла закончиться, а сессия исчезнуть из карты, пока на них
 * смотрели.
 */

import { useCallback, useState } from 'react';

export interface SelectionWork {
  key: string;
  /** Id сессий работы в порядке дерева. */
  sessions: readonly string[];
}

export interface SelectionOptions {
  works: readonly SelectionWork[];
  /** Подключение к панели: сессия просмотрена, `unseen` гаснет (раздел 4.1). */
  onAttach?: (sessionId: string) => void;
}

export interface SelectionState {
  work: string | null;
  session: string | null;
  selectWork: (key: string) => void;
  /** Выбрать сессию, не подключаясь: ходьба по сайдбару в режиме навигации (3.2). */
  selectSession: (sessionId: string) => void;
  /** Выбрать сессию и подключить к ней панель. */
  attach: (sessionId: string) => void;
}

export function useSelection({ works, onAttach }: SelectionOptions): SelectionState {
  const [chosenWork, setChosenWork] = useState<string | null>(null);
  const [chosenSession, setChosenSession] = useState<string | null>(null);

  // Выбор считается на рендере, а не чинится эффектом: иначе один кадр показывал
  // бы работу, которой уже нет.
  const work = works.find((item) => item.key === chosenWork) ?? works[0] ?? null;
  const sessions = work?.sessions ?? [];
  const session =
    chosenSession !== null && sessions.includes(chosenSession)
      ? chosenSession
      : (sessions[0] ?? null);

  const selectWork = useCallback((key: string) => {
    setChosenWork(key);
    // Сессия выбирается заново: у новой работы своё дерево.
    setChosenSession(null);
  }, []);

  const selectSession = useCallback((sessionId: string) => setChosenSession(sessionId), []);

  const attach = useCallback(
    (sessionId: string) => {
      setChosenSession(sessionId);
      onAttach?.(sessionId);
    },
    [onAttach],
  );

  return { work: work?.key ?? null, session, selectWork, selectSession, attach };
}
