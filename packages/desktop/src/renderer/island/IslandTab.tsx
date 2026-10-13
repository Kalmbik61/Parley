/**
 * Язычок убранного острова (итерация 2026-10-12): форма уехала вверх за кадр окна, а у верхнего края остался тонкий
 * язычок на том же месте по горизонтали (`anchorClass` — то же выравнивание, что у формы) и под чёлкой (`topInset`).
 * Видна чёрная полоска 40×5 со светлой обводкой (видна и на светлом, и на тёмном фоне под прозрачным окном), ловит мышь невидимая область 64×16.
 * Пока на острове есть строки Done (`done`), полоска зелёная (`--state-done`, обводка та же), а подпись и подсказка говорят, что агенты закончили.
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
  done,
  tabRef,
  onExpand,
}: {
  anchorClass: string;
  topInset: number;
  /** На острове есть строки Done: язычок красится в цвет «закончено». */
  done: boolean;
  /** Ссылка на кнопку: по ней `IslandApp` замеряет область, которую язычок ловит мышью. */
  tabRef: Ref<HTMLButtonElement>;
  onExpand(): void;
}): JSX.Element {
  /** Высота курсора на экране в момент нажатия; `null` — язычок не зажат. */
  const pressY = useRef<number | null>(null);
  const label = done ? S.island.doneTab : S.island.showIsland;
  return (
    <div className={`absolute inset-x-0 flex ${anchorClass}`} style={{ top: topInset }}>
      <button
        ref={tabRef}
        type="button"
        data-testid="island-tab"
        aria-label={label}
        title={label}
        className="flex h-4 w-16 cursor-pointer items-start justify-center"
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
        <span className={`mt-0.5 h-[5px] w-10 rounded-full ring-1 ring-white/50 ${done ? 'bg-[var(--state-done)]' : 'bg-black'}`} />
      </button>
    </div>
  );
}
