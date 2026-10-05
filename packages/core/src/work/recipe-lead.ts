import type { RecipeSnapshot } from '../recipes/types.js';
import { addMessage } from './map.js';
import { truncateMarked } from './parley-md.js';
import { liveLead } from './rooms.js';
import { PARLEY, type Message, type WorkMap } from './types.js';

export const RECIPE_PLAYBOOK_MARKER = '[Playbook is cut at 32 KB by Parley]';

/** Блок рецепта для ведущего: строка-заголовок и снимок плейбука (спека рецептов, 6.3). */
export function recipeLeadBlock(recipe: Pick<RecipeSnapshot, 'name' | 'playbook'>): string {
  return `Recipe: ${recipe.name} — you lead this room.\n${recipe.playbook}`;
}

/** Блок рецепта сессии, если она сейчас ведёт комнату со снимком рецепта; иначе `null`. */
export function leadRecipeBlock(map: WorkMap, sessionId: string): string | null {
  for (const room of map.rooms) {
    if (room.recipe != null && liveLead(map, room) === sessionId) return recipeLeadBlock(room.recipe);
  }
  return null;
}

/**
 * Смена ведущего (спека рецептов, 6.4): новому живому ведущему комнаты со снимком рецепта уходит
 * исходный плейбук письмом от `parley`. Отметка `recipeLeadNotified` пишется в той же мутации карты,
 * что и письмо, поэтому повторный вызов и перезапуск хоста второго письма не создают. Письма нет только
 * у ведущего, чью отметку хост поставил при создании комнаты: он ещё не запущен и получит плейбук слоем.
 * Возвращает записанные письма: будит их адресатов обычный будильник.
 */
export function reconcileRecipeLeads(map: WorkMap, at = new Date().toISOString()): Message[] {
  const sent: Message[] = [];
  for (const room of map.rooms) {
    if (room.recipe == null) continue;
    const lead = liveLead(map, room);
    if (lead === null || room.recipeLeadNotified === lead) continue;
    const text = truncateMarked(recipeLeadBlock(room.recipe), RECIPE_PLAYBOOK_MARKER).text;
    sent.push(addMessage(map, { from: PARLEY, to: [lead], roomId: room.id, kind: 'note', text }, at));
    room.recipeLeadNotified = lead;
  }
  return sent;
}

/** Нужна ли запись: чтение без лока перед `updateMap`, чтобы не переписывать карту впустую. */
export function recipeLeadsPending(map: WorkMap): boolean {
  return map.rooms.some((room) => {
    if (room.recipe == null) return false;
    const lead = liveLead(map, room);
    return lead !== null && room.recipeLeadNotified !== lead;
  });
}
