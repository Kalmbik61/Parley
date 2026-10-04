import { expect, it } from 'vitest';
import { buildRoleCatalog } from '../roles/catalog.js';
import { BUILTIN_RECIPES } from './builtin.js';
import { expandRecipe, snapshotRecipe } from './catalog.js';
it('three original English recipes match builtin roles and required composition/modes',()=>{
 expect(BUILTIN_RECIPES.map(r=>[r.id,r.mode])).toEqual([['builtin:plan-build','verified'],['builtin:review','free'],['builtin:debug','checklist']]);
 for(const recipe of BUILTIN_RECIPES){expect(recipe.playbook.split('\n').length).toBeLessThanOrEqual(30);expect([...recipe.playbook].every(character=>character.codePointAt(0)!<128)).toBe(true);const rows=expandRecipe(recipe,buildRoleCatalog());expect(rows.length).toBeGreaterThanOrEqual(2);expect(rows.filter(row=>row.choice.lead)).toHaveLength(1);expect(rows.every(row=>row.status==='ready')).toBe(true);}
 expect(expandRecipe(BUILTIN_RECIPES[1]!,buildRoleCatalog()).every(r=>r.resolved?.readOnly)).toBe(true);
 expect(BUILTIN_RECIPES[2]!.agents[0]?.worktree).toBe(true);
});
it('snapshot contains only original recipe identity/playbook and cannot change with the catalog',()=>{
 const recipe=structuredClone(BUILTIN_RECIPES[0]!);const snapshot=snapshotRecipe(recipe);recipe.playbook='Changed file';recipe.name='Later';expect(snapshot.playbook).not.toBe(recipe.playbook);expect(Object.keys(snapshot)).toEqual(['id','name','playbook']);
 const rows=expandRecipe(BUILTIN_RECIPES[0]!,buildRoleCatalog());expect(rows[0]?.resolved?.provider).toBe('claude');expect(rows[1]?.resolved?.provider).toBe('codex');expect(rows[0]?.choice.model).toBeUndefined();
});
