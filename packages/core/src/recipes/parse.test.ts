import { expect, it } from 'vitest';
import { parseProjectRecipe } from './parse.js';
export const document = (agents = '  - role: builtin:planner\n    lead: true\n  - role: builtin:executor', mode = 'verified') => `---\nname: Sample\ndescription: Bounded recipe\nmode: ${mode}\nagents:\n${agents}\n---\nKeep the human requirements.\n`;
it('uses full YAML and preserves body bytes, BOM and CRLF', () => {
 const text='\uFEFF'+document().replace('description: Bounded recipe','description: >-\n  Bounded\n  recipe').replaceAll('\n','\r\n');
 const result=parseProjectRecipe('sample.md',text);expect(result.status).toBe('valid');
 if(result.status==='valid'){expect(result.recipe.description).toBe('Bounded recipe');expect(result.recipe.playbook).toBe('Keep the human requirements.\r\n');expect(result.recipe.id).toBe('project:sample');}
});
it.each([
 ['lead: true','lead: false','invalid-lead'],['lead: true','lead: true\n    count: 2','invalid-lead'],
 ['builtin:executor','builtin:no-such-role','invalid-role'],['builtin:executor','unknown:executor','invalid-role'],
 ['builtin:executor','"codex:"','invalid-role'],['mode: verified','mode: unknown','invalid-schema'],
 ['mode: verified','mode: {toString: broken}','invalid-schema'],['name: Sample','name: true','invalid-schema'],
 ['lead: true','lead: true\n    skill: secret','invalid-schema'],['builtin:executor','builtin:executor\n    count: "2"','invalid-count'],
 ['builtin:executor','builtin:executor\n    count: null','invalid-count'],['builtin:executor','builtin:executor\n    count: 4','invalid-count'],
 ['builtin:executor','builtin:executor\n    count: 0','invalid-count'],
])('strictly rejects %s changed to %s', (before,after,code)=>{expect(parseProjectRecipe('sample.md',document().replace(before,after))).toMatchObject({status:'invalid',diagnostic:{code}});});
it('requires two expanded agents and exactly one lead without coercion',()=>{
 expect(parseProjectRecipe('one.md',document('  - role: builtin:planner\n    lead: true'))).toMatchObject({status:'invalid',diagnostic:{code:'too-few-agents'}});
 expect(parseProjectRecipe('two.md',document().replace('  - role: builtin:executor','  - role: builtin:executor\n    lead: true'))).toMatchObject({status:'invalid',diagnostic:{code:'invalid-lead'}});
});
it('rejects duplicate YAML keys without exposing secret source excerpts',()=>{
 const result=parseProjectRecipe('sample.md',document().replace('name: Sample','name: TOP_SECRET\nname: OTHER_PRIVATE'));
 expect(result).toMatchObject({status:'invalid',diagnostic:{code:'invalid-yaml',line:3}});expect(JSON.stringify(result)).not.toContain('SECRET');
});
it('preserves long playbooks for explicit later marked processing and rejects invalid raw encoding',()=>{
 const text=document()+'😀'.repeat(20000);const result=parseProjectRecipe('long.md',text);
 expect(result.status).toBe('valid');if(result.status==='valid')expect(result.recipe.playbook).toContain('😀'.repeat(20000));
 expect(parseProjectRecipe('bad.md',document()+'\ud800')).toMatchObject({status:'invalid',diagnostic:{code:'invalid-utf8'}});
 expect(parseProjectRecipe('big.md',document()+'a'.repeat(1024*1024))).toMatchObject({status:'invalid',diagnostic:{code:'file-too-large'}});
});
it('rejects path traversal IDs while keeping native names as exact data',()=>{
 expect(parseProjectRecipe('../sample.md',document())).toMatchObject({status:'invalid',diagnostic:{code:'invalid-id'}});
 expect(parseProjectRecipe('native.md',document().replace('builtin:executor','"codex:\uFEFF security:审计"'))).toMatchObject({status:'valid',recipe:{agents:[{role:'builtin:planner'},{role:'codex:\uFEFF security:审计'}]}});
});
