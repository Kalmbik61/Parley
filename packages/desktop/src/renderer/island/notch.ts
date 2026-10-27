/**
 * Остров в вырезе (#9 §12, план 3b B28; B26 F-B26-1): вырез дисплея и сдвиг формы к его центру. Ушей нет: в покое
 * форма — ровно вырез, выдвигается она только по явному открытию или запросу к человеку.
 */

import type { IslandConfig } from '../../shared/island.js';

/** Вырез дисплея острова (`IslandConfig.notch`): ширина, высота и центр от левого края кадра окна, pt. */
export type Notch = NonNullable<IslandConfig['notch']>;

/**
 * Сдвиг формы от середины кадра окна к центру выреза. Кадр стоит в целых точках, а центр выреза может прийтись на
 * половину точки (на 14″ — 755,5): её держит этот сдвиг.
 */
export const notchShift = (notch: Notch): number => notch.centerX - window.innerWidth / 2;

/** Наименьшая ширина выдвинутого вида: вырез и по полю `h + 4` с каждой стороны — форма не уже выреза с запасом. */
export const droppedMinWidth = (notch: Notch): number => notch.width + 2 * (notch.height + 4);
