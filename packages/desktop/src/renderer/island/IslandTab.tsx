/**
 * Язычок убранного острова (итерация 2026-10-12): форма уехала вверх за кадр окна, а у верхнего края остался тонкий
 * язычок на том же месте по горизонтали (`anchorClass` — то же выравнивание, что у формы) и под чёлкой (`topInset`).
 * Видна чёрная полоска 40×5 со светлой обводкой (видна и на светлом, и на тёмном фоне под прозрачным окном), ловит мышь невидимая область 64×16.
 * Пока есть непросмотренные Done (`doneCount` > 0), вместо полоски убранный остров чуть выглядывает сверху: маленькая чёрная форма
 * со скруглением снизу, той же светлой обводкой и без тени (тень у верхнего края кадра даёт серую полосу), внутри `✅ N`; кнопка
 * по размеру формы, подпись и подсказка говорят, что агенты закончили.
 * Область кнопки (`tabRef`) `IslandApp` сообщает main как область острова: пока курсор над ней, main делает окно
 * ловящим мышь (иначе клик ушёл бы приложению под прозрачным кадром). Клик и потяжка вниз дальше `PULL_EXPAND_PX`
 * выдвигают остров. Потяжка — не перетаскивание окна: форма стоит на месте, пока язычок не выдвинет её.
 */

import { useRef, type Ref } from 'react';
import { S } from '../../shared/strings.js';

/** Насколько вниз надо потянуть язычок, чтобы остров выдвинулся без клика. */
export const PULL_EXPAND_PX = 8;

export function IslandTab({
  anchorClass,
  topInset,
  doneCount,
  tabRef,
  onExpand,
}: {
  anchorClass: string;
  topInset: number;
  /** Сколько на острове непросмотренных Done: больше нуля — вместо полоски выглядывающая форма `✅ N`. */
  doneCount: number;
  /** Ссылка на кнопку: по ней `IslandApp` замеряет область, которую язычок ловит мышью. */
  tabRef: Ref<HTMLButtonElement>;
  onExpand(): void;
}): JSX.Element {
  /** Высота курсора на экране в момент нажатия; `null` — язычок не зажат. */
  const pressY = useRef<number | null>(null);
  const peek = doneCount > 0;
  const label = peek ? S.island.doneTab : S.island.showIsland;
  return (
    <div className={`absolute inset-x-0 flex ${anchorClass}`} style={{ top: topInset }}>
      <button
        ref={tabRef}
        type="button"
        data-testid="island-tab"
        aria-label={label}
        title={label}
        className={peek ? 'flex cursor-pointer items-start' : 'flex h-4 w-16 cursor-pointer items-start justify-center'}
        onClick={onExpand}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          pressY.current = event.screenY;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (pressY.current === null || event.screenY - pressY.current <= PULL_EXPAND_PX) return;
          pressY.current = null;
          onExpand();
        }}
        onPointerUp={() => {
          pressY.current = null;
        }}
        onPointerCancel={() => {
          pressY.current = null;
        }}
      >
        {peek ? (
          <span className="whitespace-nowrap rounded-b-[14px] bg-black px-3 py-1 text-sm text-foreground ring-1 ring-white/50">{S.island.donePeek(doneCount)}</span>
        ) : (
          <span className="mt-0.5 h-[5px] w-10 rounded-full bg-black ring-1 ring-white/50" />
        )}
      </button>
    </div>
  );
}
