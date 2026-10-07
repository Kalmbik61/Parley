import type { RecipeSnapshot } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover.js';

/**
 * Чип рецепта комнаты в шапке, рядом с режимом (спека рецептов, 6.5): название рецепта на момент создания комнаты, по
 * клику — плейбук ведущего только для чтения. Показывается снимок из карты, а не файл рецепта: правка файла комнату
 * не меняет.
 */
export function RoomRecipeChip({ recipe }: { recipe: RecipeSnapshot }): JSX.Element {
  return (
    <div data-room-recipe="" className="flex min-w-0 items-center text-xs">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={S.recipes.chip(recipe.name)}
            className="inline-flex h-7 max-w-[260px] min-w-0 items-center rounded-full border border-border px-3 text-xs hover:bg-foreground/7"
          >
            <span className="truncate">{recipe.name}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          role="group"
          aria-label={S.recipes.playbookFor(recipe.name)}
          align="start"
          collisionPadding={8}
          className="max-h-[min(24rem,var(--radix-popover-content-available-height))] w-96 max-w-[calc(100vw-1rem)] space-y-2 overflow-y-auto text-xs"
        >
          <p className="m-0 break-words font-semibold">{S.recipes.playbookFor(recipe.name)}</p>
          {recipe.playbook.trim() === ''
            ? <p className="m-0 text-muted-foreground">{S.recipes.noPlaybook}</p>
            : <pre data-recipe-playbook className="m-0 whitespace-pre-wrap break-words font-sans">{recipe.playbook}</pre>}
        </PopoverContent>
      </Popover>
    </div>
  );
}
