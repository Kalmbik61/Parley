import { createHash } from 'node:crypto';
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

it('plan and build distinguishes independent inspection from executable verification', () => {
 const recipe = BUILTIN_RECIPES[0]!;
 expect(recipe.playbook).toContain('Independent assessment may use inspection');
 expect(recipe.playbook).toContain('assign executable checks explicitly');
 expect(recipe.agents.some(agent => agent.role === 'builtin:verifier')).toBe(false);
});

it('the three builtin playbooks are byte-identical (T8c goldens, recorded on f96965f0 before any T8c edit)',()=>{
 const sha=(text:string):string=>`${Buffer.byteLength(text,'utf8')} ${createHash('sha256').update(text).digest('hex')}`;
 expect(Object.fromEntries(BUILTIN_RECIPES.map(r=>[r.id,sha(r.playbook)]))).toEqual({
  'builtin:plan-build':'985 611ece90bd1788efd8b4618c890a1532a0f78decc73c519c052d9f4c1357a573',
  'builtin:review':'575 9fc771e4956a6585c495d9cdba1ed4cbcba26c517a4bd1ba3208cda15f6a826b',
  'builtin:debug':'568 c21099e2f20ec92801711d0e3630904a1c38ac30dbf95b4b4bcd936265e34c8f',
 });
});
