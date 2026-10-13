/**
 * Зона нажатия убранного острова (итерация 2026-10-13): убранный остров не уезжает, а сжимается в брусок прямо на месте
 * (`IslandView`), поэтому сама зона ничего не рисует. Это прозрачная кнопка поверх убранной формы (позже в DOM, `absolute`):
 * нажатия по форме ловит она, а не перетаскивание формы. Стоит на том же месте по горизонтали (`anchorClass` — то же
 * выравнивание, что у формы) и под чёлкой (`topInset`). Без Done зона 64×16 (брусок 40×5 внутри неё с запасом на попадание
 * мышью). Пока есть непросмотренные Done (`doneCount` > 0), форма выглядывает с `✅ N` и зона по её размеру: внутри тот же
 * текст с теми же отступами, но невидимый — он лишь задаёт размер. Подпись и подсказка говорят, что агенты закончили.
 * Область кнопки (`tabRef`) `IslandApp` сообщает main как область острова: пока курсор над ней, main делает окно
 * ловящим мышь (иначе клик ушёл бы приложению под прозрачным кадром). Клик и потяжка вниз дальше `PULL_EXPAND_PX`
 * выдвигают остров. Потяжка — не перетаскивание окна: форма стоит на месте, пока зона не выдвинет её.
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
  /** Сколько на острове непросмотренных Done: больше нуля — вместо бруска выглядывает форма `✅ N`, зона по её размеру. */
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
          // Тот же текст и отступы, что у формы `✅ N` в `IslandView`: невидимый, он задаёт размер зоны.
          <span aria-hidden className="whitespace-nowrap px-3 py-1 text-sm opacity-0">
            {S.island.donePeek(doneCount)}
          </span>
        ) : null}
      </button>
    </div>
  );
}
