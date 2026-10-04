import { mkdtemp, mkdir, writeFile, realpath, rm, lstat, readFile, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveSkillCatalog } from '@parley/core';
import { createCapabilitiesSkillActions } from './skill-actions.js';
import { createProviderScheduler } from './scheduler.js';
import { createSafeCapabilitiesService } from './snapshot.js';
import type { SnapshotContext, SafeCapabilitiesService } from './snapshot.js';
import { projectSkills, skillSharingCatalogKnown } from './redact.js';
let root: string; let context: SnapshotContext; let service: SafeCapabilitiesService;
let scheduler: ReturnType<typeof createProviderScheduler>; let actions: ReturnType<typeof createCapabilitiesSkillActions>;
const body='---\nname: folder\ndescription: Manual fixture\n---\nOriginal\n';
beforeEach(async()=>{
 root=await realpath(await mkdtemp('/private/tmp/parley-p19-actions-'));
 await mkdir(path.join(root,'home'));await mkdir(path.join(root,'project/.claude/skills/folder'),{recursive:true});
 await writeFile(path.join(root,'project/.claude/skills/folder/SKILL.md'),body);
 context={projectPath:path.join(root,'project'),homeDir:path.join(root,'home'),env:{},binaries:{claude:null,codex:null}};
 const read=async(provider:'claude'|'codex')=>{const catalog=await resolveSkillCatalog({provider,cwd:context.projectPath,homeDir:context.homeDir});return{entries:projectSkills(catalog),skillSharingContext:skillSharingCatalogKnown(catalog),diagnostics:[],phase:'ready' as const};};
 service=createSafeCapabilitiesService({context:async()=>context,readers:{claude:()=>read('claude'),codex:()=>read('codex')}});
 scheduler=createProviderScheduler();actions=createCapabilitiesSkillActions(service,scheduler);
 service.get(context.projectPath);await ready();
});
afterEach(async()=>{actions.dispose();scheduler.dispose();service.dispose();await rm(root,{recursive:true,force:true});});
async function ready(){await vi.waitFor(()=>{const snapshot=service.get(context.projectPath);expect(snapshot.columns.claude.phase).toBe('ready');expect(snapshot.columns.codex.phase).toBe('ready');});}
function params(){const snapshot=service.get(context.projectPath);const entry=snapshot.rows.find(row=>row.kind==='skill'&&row.name==='folder')!.claude[0]!;return{projectPath:context.projectPath,revision:snapshot.revision,provider:'claude' as const,presenceId:entry.id};}
it('manual opaque source uses current private catalog, refreshes and removes only its owned link without changing model policy',async()=>{
 const before=service.get(context.projectPath),presence=before.rows.find(row=>row.kind==='skill')!.claude[0]!;
 expect(presence.modelAvailable).toBe(false);expect(presence.skillActions?.share.allowed).toBe(true);
 expect(JSON.stringify(before)).not.toContain('nativeSkill');expect(JSON.stringify(before)).not.toContain('contentHash');
 expect(await actions.share(params())).toEqual({outcome:'ok',code:'ok',scope:'project'});await ready();
 const after=service.get(context.projectPath);expect(after.revision).toBeGreaterThan(before.revision);
 expect(after.columns.claude.phase).toBe('ready');expect(after.columns.codex.phase).toBe('ready');
 expect(after.rows.find(row=>row.kind==='skill')!.codex.some(item=>item.documentPath===path.join(context.projectPath,'.claude/skills/folder/SKILL.md'))).toBe(true);
 expect(after.rows.find(row=>row.kind==='skill')!.claude[0]!.modelAvailable).toBe(false);
 expect(after.rows.find(row=>row.kind==='skill')!.claude[0]!.skillActions?.unshare.allowed).toBe(true);
 await writeFile(path.join(context.projectPath,'.claude/skills/folder/SKILL.md'),body+'Human text edit');
 expect(await actions.unshare(params())).toEqual({outcome:'ok',code:'ok',scope:'project'});
 await expect(lstat(path.join(context.projectPath,'.agents/skills/folder'))).rejects.toMatchObject({code:'ENOENT'});
 expect(await readFile(path.join(context.projectPath,'.claude/skills/folder/SKILL.md'),'utf8')).toBe(body+'Human text edit');
});
it('queue dispatch rechecks revision; stale queued action does not reserve or create',async()=>{
 let release!:()=>void;const held=scheduler.run('codex',()=>new Promise<void>(resolve=>{release=resolve;}));
 void held.catch(()=>{});
 const queued=actions.share(params());service.refresh(context.projectPath);await ready();release();await held;
 expect(await queued).toEqual({outcome:'denied',code:'stale'});
 await expect(lstat(path.join(context.projectPath,'.parley/skill-share-receipts'))).rejects.toMatchObject({code:'ENOENT'});
});
it('fresh metadata and same-name separate-copy changes close old opaque authorization without IO',async()=>{
 const request=params();await writeFile(path.join(context.projectPath,'.claude/skills/folder/SKILL.md'),body.replace('Manual fixture','Human replacement'));
 expect(await actions.share(request)).toEqual({outcome:'denied',code:'context-changed'});
 service.refresh(context.projectPath);await ready();const latest=params();
 await mkdir(path.join(context.projectPath,'.agents/skills/other'),{recursive:true});await writeFile(path.join(context.projectPath,'.agents/skills/other/SKILL.md'),body);
 expect(await actions.share(latest)).toEqual({outcome:'denied',code:'ambiguous'});
 await expect(lstat(path.join(context.projectPath,'.parley/skill-share-receipts'))).rejects.toMatchObject({code:'ENOENT'});
});
it('direct malformed and shutdown calls return fixed safe refusal before private source admission',async()=>{
 expect(await actions.share({...params(),source:'/secret'} as never)).toEqual({outcome:'denied',code:'unverified'});
 actions.dispose();expect(await actions.share(params())).toEqual({outcome:'denied',code:'shutdown'});
});

it('explicit policy disable blocks new sharing but permits cleanup of an unchanged owned link after Refresh',async()=>{
 const original=path.join(context.projectPath,'.claude/skills/folder/SKILL.md');
 expect((await actions.share(params())).outcome).toBe('ok');await ready();
 const disabled=body.replace('description: Manual fixture','description: Manual fixture\ndisable-model-invocation: true');await writeFile(original,disabled);
 service.refresh(context.projectPath);await ready();
 const presence=service.get(context.projectPath).rows.find(row=>row.kind==='skill')!.claude[0]!;
 expect(presence.modelAvailable).toBe(false);expect(presence.skillActions?.share.allowed).toBe(false);expect(presence.skillActions?.unshare.allowed).toBe(true);
 expect(await actions.share(params())).toEqual({outcome:'denied',code:'unverified'});
 // A human replacement with the same target is still foreign, despite identical readlink bytes.
 const destination=path.join(context.projectPath,'.agents/skills/folder');const oldLink=await lstat(destination);
 await unlink(destination);await symlink('../../.claude/skills/folder',destination,'dir');
 const newLink=await lstat(destination);expect([newLink.ino,newLink.birthtimeMs]).not.toEqual([oldLink.ino,oldLink.birthtimeMs]);
 expect(await actions.unshare(params())).toEqual({outcome:'denied',code:'receipt-unverified'});
 expect(await readFile(original,'utf8')).toBe(disabled);
});
it('a disabled source is removable only through the receipt-owned link, preserving disabled content',async()=>{
 expect((await actions.share(params())).outcome).toBe('ok');await ready();
 const original=path.join(context.projectPath,'.claude/skills/folder/SKILL.md'),disabled=body.replace('description: Manual fixture','description: Manual fixture\ndisable-model-invocation: true');await writeFile(original,disabled);
 service.refresh(context.projectPath);await ready();expect(await actions.unshare(params())).toEqual({outcome:'ok',code:'ok',scope:'project'});
 expect(await readFile(original,'utf8')).toBe(disabled);await expect(lstat(path.join(context.projectPath,'.agents/skills/folder'))).rejects.toMatchObject({code:'ENOENT'});
});
it('unrelated malformed receiver catalog closes manual sharing instead of treating arbitrary partial as ownership proof',async()=>{
 await mkdir(path.join(context.projectPath,'.agents/skills/broken'),{recursive:true});await writeFile(path.join(context.projectPath,'.agents/skills/broken/SKILL.md'),'---\nname: [bad\n---\n');
 service.refresh(context.projectPath);await ready();expect(service.get(context.projectPath).rows.find(row=>row.kind==='skill'&&row.name==='folder')!.claude[0]!.skillActions?.share.allowed).toBe(false);
 expect(await actions.share(params())).toEqual({outcome:'denied',code:'unverified'});await expect(lstat(path.join(context.projectPath,'.parley/skill-share-receipts'))).rejects.toMatchObject({code:'ENOENT'});
});

it('queued shutdown refuses filesystem work before reservation and both provider inventories remain unchanged',async()=>{
 let release!:()=>void;const held=scheduler.run('codex',()=>new Promise<void>(resolve=>{release=resolve;}));void held.catch(()=>{});
 const queued=actions.share(params());actions.dispose();service.dispose();release();await held;
 expect(await queued).toEqual({outcome:'denied',code:'shutdown'});await expect(lstat(path.join(context.projectPath,'.parley/skill-share-receipts'))).rejects.toMatchObject({code:'ENOENT'});await expect(lstat(path.join(context.projectPath,'.agents/skills/folder'))).rejects.toMatchObject({code:'ENOENT'});
});
