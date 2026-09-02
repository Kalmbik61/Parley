import {
  loadSessionTree,
  type SessionIndex,
  type Subsession,
  type WorkflowInfo,
} from '@harnas/core';
import { useEffect, useState } from 'react';

export interface SubsessionsState {
  subsessions: Subsession[];
  /** Запуски workflow этой сессии — заголовки групп в списке. */
  workflows: WorkflowInfo[];
  loading: boolean;
}

/**
 * Подсессии выбранной сессии. Читаются лениво — при старте разбирается только
 * индекс, дерево только по выбору (specs/ui.md).
 */
export function useSubsessions(session: SessionIndex | undefined, root: string): SubsessionsState {
  const [state, setState] = useState<SubsessionsState>({
    subsessions: [],
    workflows: [],
    loading: false,
  });
  const file = session?.file;

  useEffect(() => {
    if (file === undefined) {
      setState({ subsessions: [], workflows: [], loading: false });
      return;
    }

    let cancelled = false;
    setState({ subsessions: [], workflows: [], loading: true });

    loadSessionTree(file, root)
      .then((tree) => {
        if (!cancelled) {
          setState({ subsessions: tree.subsessions, workflows: tree.workflows, loading: false });
        }
      })
      .catch(() => {
        // Файл мог исчезнуть между выбором и чтением — показываем пусто, не падаем.
        if (!cancelled) setState({ subsessions: [], workflows: [], loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [file, root]);

  return state;
}
