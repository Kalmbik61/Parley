/**
 * Остров в вырезе (#9 §12, план 3b B28; B26 F-B26-3): вырез дисплея и сдвиг формы к его центру. Нечего показывать —
 * форма ровно по вырезу; есть фон (работа, непросмотренный Done, свёрнутый или говорящий помощник, его ошибка) —
 * капсула `capsuleWidth` высотой выреза. Вниз форма выдвигается только по явному открытию или запросу к человеку.
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

/** Поле капсулы с каждой стороны выреза (B26 F-B26-3): слева рой или лицо помощника, справа статус. */
export const CAPSULE_SIDE = 80;

/** Ширина капсулы: вырез и по полю `CAPSULE_SIDE` слева и справа, одна сплошная форма. */
export const capsuleWidth = (notch: Notch): number => notch.width + 2 * CAPSULE_SIDE;
