/**
 * Экран, когда работ нет вовсе (кусок 2.3, спека 5.10): логотип-плитка,
 * заголовок и два действия. Занимает только центр — заголовок и строка
 * статуса вокруг остаются в `AppShell.tsx`: без области перетаскивания
 * пустое окно при `hiddenInset` было бы нечем утащить.
 */

import { useUiStore } from '../store/ui.js';
import { Button } from '../ui/button.js';

export function Landing(): JSX.Element {
  const openNewWorkDialog = useUiStore((state) => state.openNewWorkDialog);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);

  return (
    <div data-testid="landing" className="flex flex-1 flex-col items-center justify-center gap-4">
      <div className="flex size-20 items-center justify-center rounded-2xl bg-primary text-2xl font-semibold text-primary-foreground">
        H
      </div>
      <h1 className="text-lg font-medium text-foreground">Harnas</h1>
      <div className="flex gap-2">
        <Button type="button" onClick={() => openNewWorkDialog()}>
          Новая работа
          <kbd className="ml-1.5 rounded bg-black/10 px-1.5 py-0.5 text-[10px] dark:bg-white/10">⌘N</kbd>
        </Button>
        <Button type="button" variant="outline" onClick={() => setPaletteOpen(true)}>
          Палитра
          <kbd className="ml-1.5 rounded bg-black/10 px-1.5 py-0.5 text-[10px] dark:bg-white/10">⌘K</kbd>
        </Button>
      </div>
    </div>
  );
}
