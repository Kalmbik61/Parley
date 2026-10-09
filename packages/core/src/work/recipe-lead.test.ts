import { describe, expect, it } from 'vitest';
import { unreadFor } from './letters.js';
import { addSession, parseMap, transitionSession } from './map.js';
import { leadRecipeBlock, recipeLeadBlock, reconcileRecipeLeads, recipeLeadsPending } from './recipe-lead.js';
import { addRoom } from './rooms.js';
import { HUMAN, PARLEY, type WorkMap } from './types.js';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: { id: 'w-0001', title: 'рецепты', goal: '', status: 'active', createdAt: '2026-10-04T10:00:00.000Z', updatedAt: '2026-10-04T10:00:00.000Z' },
  sessions: [],
  messages: [],
  rooms: [],
});
const recipe = { id: 'project:pay', name: 'Payments', playbook: 'Step one.\nStep two.' };

/** Комната с рецептом и тремя сессиями: s-01 ведёт, s-02 и s-03 участвуют. */
function roomWithRecipe(): WorkMap {
  const map = emptyMap();
  for (const label of ['a', 'b', 'c']) addSession(map, { provider: 'claude', label, task: 'x' });
  const room = addRoom(map, { title: 'R', creator: HUMAN, members: ['s-01', 's-02', 's-03'], lead: 's-01', recipe });
  room.recipeLeadNotified = 's-01';
  return map;
}
const close = (map: WorkMap, id: string): void => {
  transitionSession(map, id, 'active');
  transitionSession(map, id, 'closed');
};

describe('блок рецепта в слое', () => {
  it('начинается строкой с названием, дальше снимок плейбука', () => {
    expect(recipeLeadBlock(recipe)).toBe('Recipe: Payments — you lead this room.\nStep one.\nStep two.');
  });

  it('есть только у нынешнего ведущего комнаты со снимком', () => {
    const map = roomWithRecipe();
    expect(leadRecipeBlock(map, 's-01')).toContain('Step one.');
    expect(leadRecipeBlock(map, 's-02')).toBeNull();
    expect(leadRecipeBlock(map, 's-99')).toBeNull();
  });

  it('архивная комната блока не даёт', () => {
    const map = roomWithRecipe();
    map.rooms[0]!.archivedAt = '2026-10-08T12:00:00.000Z';
    expect(leadRecipeBlock(map, 's-01')).toBeNull();
  });

  it('комната без рецепта блока не даёт', () => {
    const map = roomWithRecipe();
    map.rooms[0]!.recipe = null;
    expect(leadRecipeBlock(map, 's-01')).toBeNull();
  });
});

describe('reconcileRecipeLeads', () => {
  it('ведущий не менялся — писем нет, карта не требует записи', () => {
    const map = roomWithRecipe();
    expect(recipeLeadsPending(map)).toBe(false);
    expect(reconcileRecipeLeads(map)).toEqual([]);
    expect(map.messages).toEqual([]);
  });

  it('прежний ведущий закрыт: новый получает исходный снимок письмом от parley ровно один раз', () => {
    const map = roomWithRecipe();
    close(map, 's-01');
    expect(recipeLeadsPending(map)).toBe(true);
    const sent = reconcileRecipeLeads(map, '2026-10-04T11:00:00.000Z');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: PARLEY, to: ['s-02'], roomId: 'r-01', kind: 'note', text: recipeLeadBlock(recipe) });
    expect(unreadFor(map, 's-02')).toHaveLength(1);
    expect(unreadFor(map, 's-03')).toHaveLength(0);
    expect(map.rooms[0]!.recipeLeadNotified).toBe('s-02');
    // Повторный проход, в том числе после перезапуска хоста (карта читается с диска), письма не множит.
    expect(recipeLeadsPending(map)).toBe(false);
    expect(reconcileRecipeLeads(map)).toEqual([]);
    const reread = parseMap(JSON.stringify(map), 'map.json');
    expect(recipeLeadsPending(reread)).toBe(false);
    expect(reconcileRecipeLeads(reread)).toEqual([]);
    expect(reread.messages).toHaveLength(1);
  });

  it('письмо несёт снимок, а не нынешнюю правку каталога', () => {
    const map = roomWithRecipe();
    close(map, 's-01');
    const [letter] = reconcileRecipeLeads(map);
    expect(letter?.text).toContain('Step two.');
    expect(map.rooms[0]!.recipe).toEqual(recipe);
  });

  it('следующая смена ведущего — следующее письмо новому, прежним не повторяется', () => {
    const map = roomWithRecipe();
    close(map, 's-01');
    reconcileRecipeLeads(map);
    close(map, 's-02');
    const sent = reconcileRecipeLeads(map);
    expect(sent.map((row) => row.to)).toEqual([['s-03']]);
    expect(map.messages).toHaveLength(2);
  });

  it('комната закрыта целиком или без рецепта — писем нет', () => {
    const map = roomWithRecipe();
    for (const id of ['s-01', 's-02', 's-03']) close(map, id);
    expect(reconcileRecipeLeads(map)).toEqual([]);
    const plain = roomWithRecipe();
    plain.rooms[0]!.recipe = null;
    close(plain, 's-01');
    expect(recipeLeadsPending(plain)).toBe(false);
    expect(reconcileRecipeLeads(plain)).toEqual([]);
  });

  it('комната без отметки (ведущий запущен до комнаты): плейбук уходит ему письмом один раз', () => {
    const map = roomWithRecipe();
    delete map.rooms[0]!.recipeLeadNotified;
    expect(recipeLeadsPending(map)).toBe(true);
    const sent = reconcileRecipeLeads(map);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: PARLEY, to: ['s-01'], text: recipeLeadBlock(recipe) });
    expect(map.rooms[0]!.recipeLeadNotified).toBe('s-01');
    expect(reconcileRecipeLeads(map)).toEqual([]);
  });

  it('архивная комната: письма новому ведущему нет, записи карта не требует', () => {
    const map = roomWithRecipe();
    close(map, 's-01');
    map.rooms[0]!.archivedAt = '2026-10-08T12:00:00.000Z';

    expect(recipeLeadsPending(map)).toBe(false);
    expect(reconcileRecipeLeads(map)).toEqual([]);
    expect(map.messages).toEqual([]);
  });

  it('длинный плейбук в письме обрезается по строке с меткой', () => {
    const map = roomWithRecipe();
    map.rooms[0]!.recipe = { ...recipe, playbook: 'first\n' + 'x'.repeat(40000) };
    close(map, 's-01');
    const [letter] = reconcileRecipeLeads(map);
    expect(Buffer.byteLength(letter!.text)).toBeLessThanOrEqual(32768);
    expect(letter!.text.endsWith('[Playbook is cut at 32 KB by Parley]')).toBe(true);
  });
});
