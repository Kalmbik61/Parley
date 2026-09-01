import { loadSessionTree, type SessionIndex, type Subsession } from '@harnas/core';
import { useEffect, useState } from 'react';

export interface SubsessionsState {
  subsessions: Subsession[];
  loading: boolean;
}

/**
 * Подсессии выбранной сессии. Читаются лениво — при старте разбирается только
 * индекс, дерево только по выбору (specs/ui.md).
 */
export function useSubsessions(session: SessionIndex | undefined, root: string): SubsessionsState {
  const [state, setState] = useState<SubsessionsState>({ subsessions: [], loading: false });
  const file = session?.file;

  useEffect(() => {
    if (file === undefined) {
      setState({ subsessions: [], loading: false });
      return;
    }

    let cancelled = false;
    setState({ subsessions: [], loading: true });

    loadSessionTree(file, root)
      .then((tree) => {
        if (!cancelled) setState({ subsessions: tree.subsessions, loading: false });
      })
      .catch(() => {
        // Файл мог исчезнуть между выбором и чтением — показываем пусто, не падаем.
        if (!cancelled) setState({ subsessions: [], loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, [file, root]);

  return state;
}
