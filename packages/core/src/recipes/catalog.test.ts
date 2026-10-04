import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildRoleCatalog } from '../roles/catalog.js';
import { parseProjectRecipe } from './parse.js';
import { expandRecipe, listRecipeCatalog } from './catalog.js';
let root:string,project:string,folder:string;
beforeEach(async()=>{root=await realpath(await mkdtemp('/private/tmp/parley-recipes-'));project=path.join(root,'checkout');folder=path.join(project,'.parley','recipes');await mkdir(folder,{recursive:true});});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const doc=(role='builtin:executor')=>`---\nname: Project\ndescription: Selected checkout\nmode: checklist\nagents:\n  - role: builtin:planner\n    lead: true\n  - role: ${role}\n    count: 2\n---\nOriginal lead playbook.\n`;
it('selected project files stay distinct from builtins; invalid files remain visibly unselectable',async()=>{
 await writeFile(path.join(folder,'z.md'),doc());await writeFile(path.join(folder,'a.md'),'Broken body');await writeFile(path.join(folder,'ignore.txt'),'No recipe');
 const result=await listRecipeCatalog({projectPath:project,roles:buildRoleCatalog()});expect(result.entries).toHaveLength(5);expect(result.entries[3]).toMatchObject({status:'invalid',id:'project:a',diagnostic:{code:'missing-frontmatter'}});expect(result.entries[4]).toMatchObject({status:'valid',recipe:{id:'project:z'}});expect(result.partial).toBe(false);
});
it('missing native roles remain selectable but blocked rows preserve exact identities and overrides',()=>{
 const result=parseProjectRecipe('native.md',doc('codex:missing'));expect(result.status).toBe('valid');if(result.status!=='valid')return;
 const before=structuredClone(result.recipe);const rows=expandRecipe(result.recipe,buildRoleCatalog());expect(rows.map(r=>r.status)).toEqual(['ready','role-missing','role-missing']);expect(result.recipe).toEqual(before);expect(rows[1]?.choice.role).toBe('codex:missing');
});
it('native provider conflicts and unsupported effective context block rows without guessing defaults',()=>{
 const roles=buildRoleCatalog({roles:[{id:'codex:security',source:'codex',provider:'codex',name:'security',description:'Review',path:'/explicit/native',prompt:'Native role',readOnly:true,model:'known',effort:'xhigh',sandboxMode:'read-only'}],partial:false,diagnostics:[]});
 const parsed=parseProjectRecipe('native.md',doc('codex:security'));if(parsed.status!=='valid')throw new Error('fixture');parsed.recipe.agents[1]!.provider='claude';expect(expandRecipe(parsed.recipe,roles)[1]?.status).toBe('role-provider-mismatch');delete parsed.recipe.agents[1]!.provider;roles.diagnostics.push({source:'codex',code:'context-unverified'});roles.partial=true;expect(expandRecipe(parsed.recipe,roles)[1]?.status).toBe('role-context-unverified');
});
it('rejects malformed encoding and outside symlinks, while missing recipe directory is empty and unavailable project is partial',async()=>{
 await writeFile(path.join(folder,'bad.md'),Buffer.from([0xff]));const foreign=path.join(root,'foreign.md');await writeFile(foreign,doc());await symlink(foreign,path.join(folder,'alias.md'));
 const result=await listRecipeCatalog({projectPath:project,roles:buildRoleCatalog()});expect(result.entries.slice(3).map(e=>e.status==='invalid'?e.diagnostic.code:'valid')).toEqual(['unreadable','invalid-utf8']);
 await rm(folder,{recursive:true});expect((await listRecipeCatalog({projectPath:project,roles:buildRoleCatalog()})).partial).toBe(false);
 expect((await listRecipeCatalog({projectPath:path.join(root,'missing'),roles:buildRoleCatalog()})).partial).toBe(true);
});
