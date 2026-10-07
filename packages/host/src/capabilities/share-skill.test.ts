import { mkdtemp, mkdir, writeFile, readFile, readlink, lstat, rm, realpath, symlink, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveSkillCatalog } from '@parley/core';
import type { NativeSkill } from '@parley/core';
import type { SnapshotContext } from './snapshot.js';
import { prepareSkillShare, shareSkill, unshareSkill, skillShareAvailability, publishSkillLink } from './share-skill.js';
const io = vi.hoisted(() => ({ onClose: null as ((file: string) => Promise<void>) | null }));
vi.mock('node:fs/promises', async importOriginal => {
 const actual = await importOriginal<typeof import('node:fs/promises')>();
 return { ...actual, open: async (...args: Parameters<typeof actual.open>) => { const handle = await actual.open(...args); const close = handle.close.bind(handle); handle.close = async () => { await close(); await io.onClose?.(String(args[0])); }; return handle; } };
});
let root: string; let context: SnapshotContext; let skill: NativeSkill;
const sourceText = '---\nname: shared-native\ndescription: Native fixture\n---\nOriginal instructions.\n';
beforeEach(async () => {
 root = await realpath(await mkdtemp('/private/tmp/parley-p19-fixture-'));
 const project=path.join(root,'project'),home=path.join(root,'home');
 await mkdir(home);await mkdir(path.join(project,'.claude/skills/folder-name'),{recursive:true});
 const document=path.join(project,'.claude/skills/folder-name/SKILL.md');await writeFile(document,sourceText);
 context={projectPath:project,homeDir:home,env:{},binaries:{claude:null,codex:null}};
 skill={provider:'claude',documentKind:'skill',name:'shared-native',description:'Native fixture',source:'project',path:document,modelAvailable:false,unavailableReason:'load-tool-unavailable'};
});
afterEach(async()=>{io.onClose=null;await rm(root,{recursive:true,force:true});});
async function target(value=skill, protection={builtin:false,separateCopies:false}){
 const prepared=await prepareSkillShare(context,value,protection);expect(prepared.ok).toBe(true);
 if(!prepared.ok)throw new Error('fixture preparation');return prepared.target;
}
it('project share is relative, keeps original bytes and roundtrips through the existing Codex resolver without availability promotion',async()=>{
 const prepared=await target();expect(await shareSkill(prepared,()=>true)).toMatchObject({outcome:'ok',code:'ok',scope:'project'});
 expect(await readlink(prepared.destination)).toBe('../../.claude/skills/folder-name');
 expect(await readFile(skill.path,'utf8')).toBe(sourceText);
 const catalog=await resolveSkillCatalog({provider:'codex',cwd:context.projectPath,homeDir:context.homeDir});
 expect(catalog.skills.some(row=>row.documentKind==='skill'&&row.name==='shared-native'&&row.path===skill.path)).toBe(true);
 expect((await skillShareAvailability(prepared)).unshare).toBe(true);
 expect((await lstat(prepared.receipt)).mode&0o777).toBe(0o600);
});
it('user share is absolute only for explicit action; ordinary inventory preparation makes no writes',async()=>{
 const folder=path.join(context.homeDir,'.claude/skills/folder-name');await mkdir(folder,{recursive:true});
 const document=path.join(folder,'SKILL.md');await writeFile(document,sourceText);
 const prepared=await target({...skill,source:'user',path:document});
 await expect(lstat(path.join(context.homeDir,'.agents'))).rejects.toMatchObject({code:'ENOENT'});
 expect((await shareSkill(prepared,()=>true)).outcome).toBe('ok');expect(await readlink(prepared.destination)).toBe(folder);
 expect((await unshareSkill(prepared,()=>true)).outcome).toBe('ok');expect(await readFile(document,'utf8')).toBe(sourceText);
});
it('occupied folder and foreign link are never replaced or removed',async()=>{
 const prepared=await target();await mkdir(prepared.destination,{recursive:true});await writeFile(path.join(prepared.destination,'human.txt'),'Keep');
 expect((await shareSkill(prepared,()=>true)).code).toBe('occupied');expect((await unshareSkill(prepared,()=>true)).code).toBe('receipt-unverified');
 expect(await readFile(path.join(prepared.destination,'human.txt'),'utf8')).toBe('Keep');
 await rm(prepared.destination,{recursive:true});await symlink(prepared.original,prepared.destination,'dir');
 expect((await shareSkill(prepared,()=>true)).code).toBe('occupied');expect((await unshareSkill(prepared,()=>true)).code).toBe('receipt-unverified');expect((await lstat(prepared.destination)).isSymbolicLink()).toBe(true);
});
it('builtin, plugin, command kind and separate copies fail before receipt/native writes',async()=>{
 for(const [record,protection] of [[skill,{builtin:true,separateCopies:false}],[skill,{builtin:false,separateCopies:true}],[{...skill,source:'plugin'}, {builtin:false,separateCopies:false}],[{...skill,documentKind:'command'},{builtin:false,separateCopies:false}]] as const)
  expect((await prepareSkillShare(context,record,protection)).ok).toBe(false);
 await expect(lstat(path.join(context.projectPath,'.parley'))).rejects.toMatchObject({code:'ENOENT'});
});
it('source alias and replaced parent are not fabricated as native source proof',async()=>{
 const outside=path.join(root,'outside');await mkdir(outside);await writeFile(path.join(outside,'SKILL.md'),sourceText);
 expect((await prepareSkillShare(context,{...skill,path:path.join(outside,'SKILL.md')},{builtin:false,separateCopies:false})).ok).toBe(false);
 const prepared=await target();await mkdir(path.join(context.projectPath,'.agents'));const outsideRoot=path.join(root,'other');await mkdir(outsideRoot);await symlink(outsideRoot,path.join(context.projectPath,'.agents/skills'));
 expect((await shareSkill(prepared,()=>true)).outcome).not.toBe('ok');expect(await readFile(skill.path,'utf8')).toBe(sourceText);await expect(lstat(path.join(outsideRoot,'folder-name'))).rejects.toMatchObject({code:'ENOENT'});
});
it('stale or amended source refuses before receipt and native changes',async()=>{
 const prepared=await target();expect((await shareSkill(prepared,()=>false)).code).toBe('stale');
 await writeFile(skill.path,'Human amended');expect((await shareSkill(prepared,()=>true)).code).toBe('context-changed');
 await expect(lstat(prepared.receipt)).rejects.toMatchObject({code:'ENOENT'});await expect(lstat(prepared.destination)).rejects.toMatchObject({code:'ENOENT'});
});
it('normal original text edits allow removing only the unchanged owned link; replacement same-target link is foreign',async()=>{
 const prepared=await target();await shareSkill(prepared,()=>true);await writeFile(skill.path,'Human edit');
 expect((await unshareSkill(prepared,()=>true)).outcome).toBe('ok');expect(await readFile(skill.path,'utf8')).toBe('Human edit');
 const fresh=await target();await shareSkill(fresh,()=>true);await rm(fresh.destination);await symlink(path.relative(fresh.destinationRoot,fresh.original),fresh.destination,'dir');
 expect((await unshareSkill(fresh,()=>true)).code).toBe('receipt-unverified');expect((await lstat(fresh.destination)).isSymbolicLink()).toBe(true);
});
it('receipt failure blocks create and symlink failure never copies the original',async()=>{
 const prepared=await target();await writeFile(path.join(context.projectPath,'.parley'),'Occupied');
 expect((await shareSkill(prepared,()=>true)).code).toBe('receipt-unverified');await expect(lstat(prepared.destination)).rejects.toMatchObject({code:'ENOENT'});
 await rm(path.join(context.projectPath,'.parley'));
 expect((await shareSkill(prepared,()=>true,async()=>{throw new Error('unsupported');})).code).toBe('symlink-error');
 await expect(lstat(prepared.destination)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(skill.path,'utf8')).toBe(sourceText);
 expect((await lstat(prepared.receipt)).isFile()).toBe(true);
});

it('Codex original in the accepted project root shares relatively into Claude native folder discovery',async()=>{
 const folder=path.join(context.projectPath,'.agents/skills/codex-folder');await mkdir(folder,{recursive:true});const document=path.join(folder,'SKILL.md');await writeFile(document,sourceText);
 const prepared=await target({...skill,provider:'codex',path:document});expect((await shareSkill(prepared,()=>true)).outcome).toBe('ok');expect(await readlink(prepared.destination)).toBe('../../.agents/skills/codex-folder');
 const catalog=await resolveSkillCatalog({provider:'claude',cwd:context.projectPath,homeDir:context.homeDir});expect(catalog.skills.some(row=>row.documentKind==='skill'&&row.name==='codex-folder'&&row.path===document)).toBe(true);
 expect(await readFile(document,'utf8')).toBe(sourceText);expect((await unshareSkill(prepared,()=>true)).outcome).toBe('ok');
});

it('an observed source replacement during link creation cannot acquire a finalized ownership receipt',async()=>{
 const prepared=await target();const changed=sourceText+'Human change during create';
 expect(await shareSkill(prepared,()=>true,async(...args)=>{await writeFile(skill.path,changed);return publishSkillLink(String(args[0]),String(args[1]));})).toEqual({outcome:'failed',code:'context-changed'});
 expect(await readFile(skill.path,'utf8')).toBe(changed);expect((await skillShareAvailability(prepared)).unshare).toBe(false);
});

it('exclusive publication retains the prepared symlink inode and cannot adopt a same-target foreign replacement',async()=>{
 const prepared=await target();let own=0,foreign=0;
 const result=await shareSkill(prepared,()=>true,async(...args)=>{
  await publishSkillLink(String(args[0]),String(args[1]));own=(await lstat(prepared.destination)).ino;const literal=await readlink(prepared.destination);await rename(prepared.destination,path.join(root,'held-owned-link'));await symlink(literal,prepared.destination,'dir');foreign=(await lstat(prepared.destination)).ino;
 });
 expect(own).not.toBe(foreign);expect(result).toEqual({outcome:'failed',code:'context-changed'});expect((await skillShareAvailability(prepared)).unshare).toBe(false);expect((await unshareSkill(prepared,()=>true)).outcome).toBe('denied');expect((await lstat(prepared.destination)).ino).toBe(foreign);expect(await readFile(skill.path,'utf8')).toBe(sourceText);
});
it('identical initial receipt replacement after wx handle close cannot become our reservation',async()=>{
 const prepared=await target();let replaced=false;
 io.onClose=async file=>{if(file!==prepared.receipt||replaced)return;replaced=true;const raw=await readFile(file);await rename(file,path.join(root,'held-initial-receipt'));await writeFile(file,raw);};
 expect((await shareSkill(prepared,()=>true)).outcome).not.toBe('ok');expect(replaced).toBe(true);await expect(lstat(prepared.destination)).rejects.toMatchObject({code:'ENOENT'});expect(JSON.parse(await readFile(prepared.receipt,'utf8')).linkIdentity).toBeNull();
});
it.each([false,true])('foreign final receipt temp is never published or deleted, even if initial receipt concurrently changes=%s',async changeInitial=>{
 const prepared=await target();let temporary='';
 io.onClose=async file=>{if(!file.endsWith('.tmp')||temporary)return;temporary=file;await rename(file,path.join(root,'held-final-receipt'));await writeFile(file,'Human replacement temp');if(changeInitial)await writeFile(prepared.receipt,'Human replacement receipt');};
 expect((await shareSkill(prepared,()=>true)).outcome).not.toBe('ok');expect(await readFile(temporary,'utf8')).toBe('Human replacement temp');expect(await readFile(prepared.receipt,'utf8')).not.toBe('Human replacement temp');expect((await skillShareAvailability(prepared)).unshare).toBe(false);expect(await readFile(skill.path,'utf8')).toBe(sourceText);
});

it('new project state keeps receipts ignored while the explicit native project symlink remains visible to Git',async()=>{
 const env={PATH:process.env.PATH,HOME:context.homeDir,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
 execFileSync('git',['-C',context.projectPath,'init','--quiet'],{env});const prepared=await target();expect((await shareSkill(prepared,()=>true)).outcome).toBe('ok');
 const status=execFileSync('git',['-C',context.projectPath,'status','--porcelain','--untracked-files=all'],{env,encoding:'utf8'});expect(status).toContain('.agents/skills/folder-name');expect(status).not.toContain('skill-share-receipts');expect(status).not.toContain('.parley-skill-share-');
 execFileSync('git',['-C',context.projectPath,'check-ignore','--quiet',prepared.receipt],{env});expect(await readFile(path.join(context.projectPath,'.parley/.gitignore'),'utf8')).toBe('*\n');
});
it.each(['custom','missing'])('existing state ignore policy %s is preserved by explicit sharing',async kind=>{
 const state=path.join(context.projectPath,'.parley');await mkdir(state);if(kind==='custom')await writeFile(path.join(state,'.gitignore'),'Human custom rules\n');
 expect((await shareSkill(await target(),()=>true)).outcome).toBe('ok');if(kind==='custom')expect(await readFile(path.join(state,'.gitignore'),'utf8')).toBe('Human custom rules\n');else await expect(lstat(path.join(state,'.gitignore'))).rejects.toMatchObject({code:'ENOENT'});
});

it('platform publication preserves the staged inode and refuses occupied child directories and directory symlinks without grandchildren',async()=>{
 const stage=path.join(root,'publication-stage'),native=path.join(root,'publication-native'),other=path.join(root,'publication-foreign');await mkdir(stage);await mkdir(native);await mkdir(other);const source=path.join(stage,'skill'),destination=path.join(native,'skill');await symlink('../publication-foreign',source,'dir');
 await publishSkillLink(source,destination);expect((await lstat(destination)).ino).toBe((await lstat(source)).ino);expect((await lstat(destination)).isSymbolicLink()).toBe(true);await rm(destination);
 await mkdir(destination);await expect(publishSkillLink(source,destination)).rejects.toThrow();expect(await readdir(destination)).toEqual([]);await rm(destination,{recursive:true});await symlink('../publication-foreign',destination,'dir');await expect(publishSkillLink(source,destination)).rejects.toThrow();expect(await readdir(other)).toEqual([]);expect(await readlink(destination)).toBe('../publication-foreign');
 const abort=new AbortController();abort.abort();await expect(publishSkillLink(source,path.join(root,'skill'),abort.signal)).rejects.toThrow();await expect(lstat(path.join(root,'skill'))).rejects.toMatchObject({code:'ENOENT'});
});
