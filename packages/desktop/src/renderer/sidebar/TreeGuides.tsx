/**
 * Линии дерева сессий в карточке работы: тонкая вертикаль из-под значка состояния родителя вниз и скруглённый угол
 * вправо к строке ребёнка, как в сайдбаре Claude desktop. Метки считает `sort.ts#treeGuides`, здесь они рисуются:
 * `start` — ствол под значком родителя до низа его строки, `pass` — ствол сквозь строку между родителем и ребёнком,
 * `elbow` — у строки ребёнка ствол доходит до середины и поворачивает к краю её подсветки. Несколько детей дают у
 * промежуточных строк `pass` и `elbow` вместе — «├»; у последнего ствол кончается изгибом.
 *
 * Все размеры — здесь, одной правкой подкручиваются: отступ уровня (`TREE_STEP`, им же `SessionRow` и `RoomRow` сдвигают
 * строку через `marginLeft`, а не `paddingLeft`, поэтому заливка строки начинается после изгиба), ось ствола, середина
 * строки, радиус угла. Колонка ствола — глубина строки родителя: ось стоит в `column·STEP + TRUNK_X` от левого края
 * блока строк, а координата `left` считается от левого края самой строки, отсюда поправка на её глубину и отрицательные
 * значения (строка лежит внутри карточки, `overflow-hidden` её не режет: ось не левее 14px от края блока).
 * Линии — абсолютные `span` без событий указателя: раскладку строки (flex) не двигают, клики и перетаскивание не берут.
 * Строка, куда они вложены, — `relative`.
 */

import { cn } from '../lib/cn.js';
import type { TreeGuide } from './sort.js';

/** Отступ строки на уровень дерева, px (был 12). */
export const TREE_STEP = 20;
/** Ось ствола от левого края колонки уровня: центр значка состояния 12px при `paddingLeft` 8. */
const TRUNK_X = 14;
/** Середина строки по высоте: строка сессии 26px, шапка строки комнаты — `pt 4` и половина 18px. */
const MID_Y = 13;
/** Радиус угла: от оси ствола до края подсветки ребёнка на соседнем уровне (`TREE_STEP - TRUNK_X`). */
const RADIUS = 6;
/** Низ значка состояния 12px (он занимает 7–19) и пиксель воздуха: отсюда начинается ствол родителя. */
const START_Y = 20;
/** Зазор между строками (`gap-px` блока строк): линия заходит в него, чтобы не рваться между строками. */
const GAP = 1;

export interface TreeGuidesProps {
  guides: readonly TreeGuide[];
  /** Глубина самой строки — на столько уровней она сдвинута `marginLeft`. */
  depth: number;
}

export function TreeGuides({ guides, depth }: TreeGuidesProps): JSX.Element | null {
  if (guides.length === 0) return null;
  return (
    <>
      {guides.map(({ kind, column }) => {
        const left = (column - depth) * TREE_STEP + TRUNK_X;
        const common = 'pointer-events-none absolute border-l border-work-sidebar-tree-line';
        if (kind === 'elbow') {
          // Горизонталь — до левого края подсветки строки (внутренний край её `marginLeft`); при соседних уровнях это RADIUS.
          const width = -left;
          return (
            <span
              key={`${kind}-${column}`}
              aria-hidden="true"
              data-tree-guide={kind}
              className={cn(common, 'border-b')}
              style={{ left: `${left}px`, top: 0, width: `${width}px`, height: `${MID_Y}px`, borderBottomLeftRadius: `${Math.min(RADIUS, width)}px` }}
            />
          );
        }
        return (
          <span
            key={`${kind}-${column}`}
            aria-hidden="true"
            data-tree-guide={kind}
            className={common}
            style={
              kind === 'start'
                ? { left: `${left}px`, top: `${START_Y}px`, bottom: `-${GAP}px` }
                : { left: `${left}px`, top: 0, bottom: `-${GAP}px` }
            }
          />
        );
      })}
    </>
  );
}
