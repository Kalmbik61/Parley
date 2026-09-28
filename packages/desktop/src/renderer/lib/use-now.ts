/**
 * Текущее время для относительных меток сайдбара (спека 6.3). Один таймер на сайдбар:
 * `WorkSidebar` зовёт хук один раз и раздаёт `now` карточкам — таймер на каждую
 * карточку при сотнях работ дал бы сотни перерисовок вразнобой.
 */

import { useEffect, useState } from 'react';

/** Текущее время, обновляется раз в periodMs; WorkSidebar зовёт один раз и раздаёт карточкам. */
export function useNow(periodMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}
