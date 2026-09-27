/**
 * Цикл ⌃Tab/⌃⇧Tab по недавним вкладкам работы (кусок 6.1a) — перенос как есть из
 * `layout/LayoutView.tsx` (раунд исправлений 1 куска 2.4), без стора и слушателей.
 *
 * ⌃ держат зажатым, как в VS Code/Orca: повторные Tab идут по СНИМКУ MRU на первое
 * нажатие. Живой MRU (`layout/store.ts#updateMru`) переставляет каждый промежуточный
 * `focusTab`, и без снимка при MRU [C, B, A] второй ⌃Tab вернул бы C — до A не дойти.
 * Итог фиксируется на отпускании ⌃ или потере фокуса окна (`commit`).
 */

export interface MruCycle {
  /**
   * ⌃Tab (1) или ⌃⇧Tab (−1). Первый шаг снимает снимок mru работы, следующие идут по снимку.
   * Возвращает вкладку для focusTab; null — в снимке меньше двух записей.
   */
  step(workKey: string, mru: readonly string[], step: 1 | -1): string | null;
  /**
   * Конец цикла: новый mru работы — снятая вкладка первой, остальные снимка следом.
   * null — цикла не было или он шёл в другой работе: снимок отбрасывается без записи.
   */
  commit(activeWorkKey: string | null): { workKey: string; mru: string[] } | null;
}

/** Индекс по кругу: `step` может увести и вперёд, и назад за границы массива. */
function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

export function createMruCycle(): MruCycle {
  let cycle: { workKey: string; snapshot: readonly string[]; index: number } | null = null;

  return {
    step(workKey, mru, step) {
      // Снимок другой работы (активную сменили посреди удержания ⌃) ей не принадлежит —
      // цикл начинается заново, как раньше при смене активной `LayoutView`.
      if (cycle === null || cycle.workKey !== workKey) {
        // 0 — сама текущая вкладка (MRU обновляется на каждый фокус): цикл имеет смысл от двух записей.
        if (mru.length < 2) {
          cycle = null;
          return null;
        }
        cycle = { workKey, snapshot: [...mru], index: 0 };
      }
      cycle.index = wrapIndex(cycle.index + step, cycle.snapshot.length);
      return cycle.snapshot[cycle.index] ?? null;
    },

    commit(activeWorkKey) {
      const done = cycle;
      cycle = null;
      if (done === null || done.workKey !== activeWorkKey) return null;
      const target = done.snapshot[done.index];
      if (target === undefined) return null;
      // Та же форма, что `history.ts#touchMru`, только по индексу снимка, а не по живому списку.
      const rest = done.snapshot.filter((_, index) => index !== done.index);
      return { workKey: done.workKey, mru: [target, ...rest] };
    },
  };
}
