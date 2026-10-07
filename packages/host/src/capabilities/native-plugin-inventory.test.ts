import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { readNativePluginInventory } from './native-plugin-inventory.js';
import { CLAUDE_ACTION_BUILD } from './native-targets.js';
import type { SnapshotContext, SnapshotReaderOptions } from './snapshot.js';
let root: string; let context: SnapshotContext;
let available: Record<string, unknown>[]; let installed: Record<string, unknown>[]; let marketplaces: Record<string, unknown>[];
let options: SnapshotReaderOptions;
beforeEach(async () => {
  root = await realpath(await mkdtemp('/private/tmp/parley-plugin-inventory-'));
  const project = path.join(root,'project'), home = path.join(root,'home'), config = path.join(home,'.claude');
  const market = path.join(root,'market'), plugin = path.join(market,'plugins/fixture');
  await Promise.all([mkdir(project),mkdir(config,{recursive:true}),mkdir(path.join(market,'.claude-plugin'),{recursive:true}),mkdir(path.join(plugin,'.claude-plugin'),{recursive:true})]);
  await writeFile(path.join(config,'settings.json'),JSON.stringify({enabledPlugins:{'owned@market':true}}));
  await writeFile(path.join(market,'.claude-plugin/marketplace.json'),JSON.stringify({name:'market',plugins:[{name:'fixture',source:'./plugins/fixture',version:'1.0.0'}]}));
  await writeFile(path.join(plugin,'.claude-plugin/plugin.json'),JSON.stringify({name:'fixture',version:'1.0.0'}));
  context={projectPath:project,homeDir:home,env:{HOME:home},binaries:{claude:path.join(root,'claude'),codex:null},claude:{mainCheckout:project}};
  marketplaces=[{name:'market',source:'directory',path:market,installLocation:market}];
  available=[{pluginId:'fixture@market',name:'fixture',marketplaceName:'market',source:'./plugins/fixture',version:'1.0.0'}];
  installed=[{id:'owned@market',scope:'user',enabled:true,version:'1.0.0',installPath:path.join(root,'owned-cache')}];
  options={readBinaryIdentity:async()=>({canonicalPath:context.binaries.claude!,sha256:CLAUDE_ACTION_BUILD.sha256,size:CLAUDE_ACTION_BUILD.size}),readNative:async(_binary,args)=>({status:'valid',data:args.includes('marketplace')?marketplaces:{installed,available}})};
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it('binds owned human target and registered local source without publishing paths or selectors as ids',async()=>{
  const inventory=await readNativePluginInventory(context,'claude',options);
  const target=inventory.targets.find(value=>value.kind==='installed')!;
  expect(target.actions.uninstall.allowed).toBe(true);expect(target.actions.disable.allowed).toBe(true);
  expect(target.id).toMatch(/^[a-f0-9]{64}$/);expect(inventory.targets.find(value=>value.kind==='available')!.actions.install.allowed).toBe(true);
  expect(JSON.stringify(inventory.targets.map(value=>value.summary))).not.toContain(root);
  expect(target.summary.composition).toEqual({skills:null,agents:null,mcp:null,hooks:null,tokenEstimate:null});
});
it('does not adopt an installed cache when the exact human scope entry is absent',async()=>{
  await writeFile(path.join(context.homeDir,'.claude/settings.json'),'{}');
  const inventory=await readNativePluginInventory(context,'claude',options);
  expect(inventory.targets.find(value=>value.kind==='installed')!.actions.uninstall.allowed).toBe(false);
});
it('disables only uncertain install branches while preserving independently owned remove',async()=>{
  available[0]!.source={source:'command',command:'SECRET_SOURCE_COMMAND'};
  const inventory=await readNativePluginInventory(context,'claude',options);
  expect(inventory.targets.find(value=>value.kind==='available')!.actions.install.allowed).toBe(false);
  expect(inventory.targets.find(value=>value.kind==='installed')!.actions.uninstall.allowed).toBe(true);
  expect(JSON.stringify(inventory.targets.map(value=>value.summary))).not.toContain('SECRET_SOURCE_COMMAND');
});
it('refuses a helper or unknown dependency closure even if native source previously granted consent',async()=>{
  const file=path.join(root,'market/.claude-plugin/marketplace.json');
  for(const extra of [{headersHelper:'SECRET_HELPER'},{dependencies:['missing@other']}]) {
    await writeFile(file,JSON.stringify({name:'market',plugins:[{name:'fixture',source:'./plugins/fixture',...extra}]}));
    expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.kind==='available')!.actions.install.allowed).toBe(false);
  }
});
it('denies ambiguous same-name details and mutation while retaining separate inventory entries',async()=>{
  installed.push({...installed[0],installPath:path.join(root,'different-copy')});
  const targets=(await readNativePluginInventory(context,'claude',options)).targets.filter(value=>value.kind==='installed');
  expect(targets).toHaveLength(2);expect(targets.every(target=>!target.actions.uninstall.allowed && !target.actions.details.allowed)).toBe(true);
});
it('keeps metadata visible but every Claude write unavailable for an unaudited artifact',async()=>{
  options.readBinaryIdentity=async()=>({canonicalPath:context.binaries.claude!,sha256:'f'.repeat(64),size:10});
  const inventory=await readNativePluginInventory(context,'claude',options);
  expect(inventory.targets).toHaveLength(2);expect(inventory.targets.every(target=>!target.actions.install.allowed && !target.actions.uninstall.allowed)).toBe(true);
  expect(inventory.marketplaceAdd.user.allowed).toBe(false);
});
it('Codex supports positively owned user remove/local install while keeping native unsupported commands denied',async()=>{
  const codexHome=path.join(context.homeDir,'.codex');await mkdir(codexHome);const configFile=path.join(codexHome,'config.toml');await writeFile(configFile,'# isolated fixture');
  context.binaries.codex=path.join(root,'codex');context.codex={codexHome};
  installed=[{pluginId:'owned@market',enabled:true,installed:true,installedPath:path.join(root,'owned')}];
  available=[{pluginId:'fixture@market',name:'fixture',source:{source:'local',path:path.join(root,'market/plugins/fixture')},marketplaceSource:{sourceType:'local',source:path.join(root,'market')},authPolicy:'ON_INSTALL',installPolicy:'AVAILABLE'}];
  marketplaces=[{name:'market',root:path.join(root,'market'),marketplaceSource:{sourceType:'local',source:path.join(root,'market')}}];
  options.readBinaryIdentity=async()=>({canonicalPath:context.binaries.codex!,sha256:'a'.repeat(64),size:123});
  options.readNative=async(_binary,args)=>({status:'valid',data:args.includes('marketplace')?{marketplaces}:{installed,available}});
  options.readCodexContext=async()=>({config:{layers:[{name:{type:'user',file:configFile},version:'user1',config:{plugins:{'owned@market':{enabled:true}}}}]},requirements:{requirements:null}});
  const inventory=await readNativePluginInventory(context,'codex',options);
  const target=inventory.targets.find(value=>value.kind==='installed')!;
  expect(target.scope).toBe('user');expect(target.actions.uninstall.allowed).toBe(true);expect(target.actions.disable.allowed).toBe(false);expect(target.actions.details.allowed).toBe(false);
  expect(inventory.targets.find(value=>value.kind==='available')!.actions.install.allowed).toBe(true);expect(inventory.marketplaceAdd.user.allowed).toBe(true);expect(inventory.marketplaceAdd.project.allowed).toBe(false);
  available[0]!.authPolicy='UNKNOWN_OAUTH';expect((await readNativePluginInventory(context,'codex',options)).targets.find(value=>value.kind==='available')!.actions.install.allowed).toBe(false);available[0]!.authPolicy='ON_INSTALL';
  await writeFile(path.join(root,'market/plugins/fixture/.mcp.json'),'{}');expect((await readNativePluginInventory(context,'codex',options)).targets.find(value=>value.kind==='available')!.actions.install.allowed).toBe(false);await rm(path.join(root,'market/plugins/fixture/.mcp.json'));
  options.readCodexContext=async()=>({config:{layers:[{name:{type:'user',file:configFile},version:'user1',config:{plugins:{'owned@market':{enabled:true}}}},{name:{type:'project',file:path.join(context.projectPath,'.codex/config.toml')},version:'project1',config:{plugins:{'owned@market':{enabled:false},'fixture@market':{enabled:false}}}}]},requirements:{requirements:null}});
  const shadowed=await readNativePluginInventory(context,'codex',options);
  expect(shadowed.targets.every(value=>!value.actions.install.allowed && !value.actions.uninstall.allowed)).toBe(true);
});
it('does not leak copied local paths or source commands through a description',async()=>{
  available[0]!.description=path.join(root,'market')+' SECRET_SOURCE_COMMAND';available[0]!.source={source:'command',command:'SECRET_SOURCE_COMMAND'};
  const inventory=await readNativePluginInventory(context,'claude',options);const json=JSON.stringify(inventory.targets.map(value=>value.summary));
  expect(json).not.toContain(root);expect(json).not.toContain('SECRET_SOURCE_COMMAND');
});

it('requires exact versions and denies a canonical cache alias for a different native id',async()=>{
  available[0]!.version='2.0.0';
  expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.kind==='available')!.actions.install.allowed).toBe(false);
  available[0]!.version='1.0.0';installed[0]!.installPath=path.join(root,'market/plugins/fixture');
  expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.kind==='available')!.actions.install.allowed).toBe(false);
});
it('rejects a source escaping registration through a symlink and case-fold ambiguous registrations',async()=>{
  const outside=path.join(root,'outside');await mkdir(path.join(outside,'.claude-plugin'),{recursive:true});await writeFile(path.join(outside,'.claude-plugin/plugin.json'),JSON.stringify({name:'fixture',version:'1.0.0'}));
  await rm(path.join(root,'market/plugins/fixture'),{recursive:true});await symlink(outside,path.join(root,'market/plugins/fixture'));
  expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.kind==='available')!.actions.install.allowed).toBe(false);
  marketplaces.push({...marketplaces[0],name:'MARKET'});
  expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.kind==='available')!.actions.install.allowed).toBe(false);
});
it('marks dropped native identities partial rather than claiming a complete catalog',async()=>{
  available.push({pluginId:'invalid/private/path',name:'invalid'});
  const inventory=await readNativePluginInventory(context,'claude',options);
  expect(inventory.partial).toBe(true);expect(inventory.targets).toHaveLength(2);
});
it('supports a fully registered local dependency closure but revokes it after a helper is introduced',async()=>{
 const market=path.join(root,'market'),dependency=path.join(market,'plugins/dependency');await mkdir(path.join(dependency,'.claude-plugin'),{recursive:true});
 await writeFile(path.join(dependency,'.claude-plugin/plugin.json'),JSON.stringify({name:'dependency',version:'1.0.0'}));
 const entries=[{name:'fixture',source:'./plugins/fixture',version:'1.0.0',dependencies:['dependency@market']},{name:'dependency',source:'./plugins/dependency',version:'1.0.0'}];
 await writeFile(path.join(market,'.claude-plugin/marketplace.json'),JSON.stringify({name:'market',plugins:entries}));
 available.push({pluginId:'dependency@market',source:'./plugins/dependency',version:'1.0.0'});
 expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.nativeId==='fixture@market')!.actions.install.allowed).toBe(true);
 installed.push({id:'dependency@market',scope:'user',enabled:true,installPath:path.join(root,'prior-command-cache')});
 expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.nativeId==='fixture@market')!.actions.install.allowed).toBe(false);installed.pop();
 await writeFile(path.join(dependency,'.claude-plugin/plugin.json'),JSON.stringify({name:'dependency',version:'1.0.0',headersHelper:'SECRET_HELPER'}));
 expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.nativeId==='fixture@market')!.actions.install.allowed).toBe(false);
});
it('redacts newly observed MCP secrets from a fresh catalog even without a prior snapshot reader',async()=>{
 await writeFile(path.join(context.homeDir,'.claude.json'),JSON.stringify({mcpServers:{fixture:{command:'node',env:{TOKEN:'FRESH_SECRET'}}}}));
 available[0]!.description='Contains FRESH_SECRET';
 const inventory=await readNativePluginInventory(context,'claude',options);
 expect(JSON.stringify(inventory.targets.map(value=>value.summary))).not.toContain('FRESH_SECRET');
});
it('bounds aggregate manifest reads while keeping proven entries and reporting a partial inventory',async()=>{
 const entries=[];available=[];
 for(let index=0;index<33;index++){
  const name=`fixture-${index}`,plugin=path.join(root,'market/plugins',name);await mkdir(path.join(plugin,'.claude-plugin'),{recursive:true});
  await writeFile(path.join(plugin,'.claude-plugin/plugin.json'),JSON.stringify({name,version:'1.0.0'}));
  entries.push({name,source:`./plugins/${name}`,version:'1.0.0'});available.push({pluginId:`${name}@market`,source:`./plugins/${name}`,version:'1.0.0'});
 }
 await writeFile(path.join(root,'market/.claude-plugin/marketplace.json'),JSON.stringify({name:'market',plugins:entries}));
 const inventory=await readNativePluginInventory(context,'claude',options);
 expect(inventory.partial).toBe(true);expect(inventory.targets.find(value=>value.nativeId==='fixture-0@market')!.actions.install.allowed).toBe(true);
 expect(inventory.targets.find(value=>value.nativeId==='fixture-32@market')!.actions.install.allowed).toBe(false);
});

it('does not publish a command repeated only in registered private metadata',async()=>{
 available[0]!.description='Contains PRIVATE_METADATA_COMMAND';
 await writeFile(path.join(root,'market/.claude-plugin/marketplace.json'),JSON.stringify({name:'market',plugins:[{name:'fixture',source:'./plugins/fixture',sourceCommand:'PRIVATE_METADATA_COMMAND'}]}));
 const inventory=await readNativePluginInventory(context,'claude',options);
 expect(JSON.stringify(inventory.targets.map(value=>value.summary))).not.toContain('PRIVATE_METADATA_COMMAND');
});
it('does not assign human project ownership when native inventory belongs to another project',async()=>{
 installed=[{...installed[0],scope:'project',projectPath:root}];
 const target=(await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.kind==='installed')!;
 expect(target.scope).toBeNull();expect(target.actions.uninstall.allowed).toBe(false);expect(target.actions.details.allowed).toBe(false);
});

it('denies only an unreadable or invalid selected human destination while preserving independent scope proof',async()=>{
 await mkdir(path.join(context.projectPath,'.claude'));await writeFile(path.join(context.projectPath,'.claude/settings.json'),'{ invalid');
 const inventory=await readNativePluginInventory(context,'claude',options);
 expect(inventory.installScopes.project.allowed).toBe(false);expect(inventory.installScopes.user.allowed).toBe(true);
 expect(inventory.targets.find(value=>value.kind==='available')!.actions.install.allowed).toBe(true);
});

it('binds user ownership to the actual CLAUDE_CONFIG_DIR even when caller omits its redundant configDir field',async()=>{
 const config=path.join(root,'explicit config');await mkdir(config);context.env={HOME:context.homeDir,CLAUDE_CONFIG_DIR:config};
 expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.kind==='installed')!.actions.uninstall.allowed).toBe(false);
 await writeFile(path.join(config,'settings.json'),JSON.stringify({enabledPlugins:{'owned@market':true}}));
 expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.kind==='installed')!.actions.uninstall.allowed).toBe(true);
});

it('denies actual Claude special-source branches without filtering ordinary official marketplace identities',async()=>{
 for(const market of ['builtin','INLINE','skills-dir','synced','anthropic.plugin.directory']){
  const id=`fixture@${market}`;installed=[{id,scope:'user',enabled:true}];await writeFile(path.join(context.homeDir,'.claude/settings.json'),JSON.stringify({enabledPlugins:{[id]:true}}));
  const target=(await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.kind==='installed')!;
  expect(target.actions.uninstall.allowed).toBe(false);expect(target.actions.disable.allowed).toBe(false);expect(target.actions.details.allowed).toBe(false);
 }
 installed=[{id:'fixture@claude-plugins-official',scope:'user',enabled:true}];await writeFile(path.join(context.homeDir,'.claude/settings.json'),JSON.stringify({enabledPlugins:{'fixture@claude-plugins-official':true}}));
 expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.kind==='installed')!.actions.uninstall.allowed).toBe(true);
 marketplaces.push({name:'claude-plugins-official',source:'claudeai'});
 expect((await readNativePluginInventory(context,'claude',options)).targets.find(value=>value.kind==='installed')!.actions.uninstall.allowed).toBe(false);
});

it('allows Claude marketplace addition only in verified empty human/plugin context',async()=>{
 expect((await readNativePluginInventory(context,'claude',options)).marketplaceAdd.user.allowed).toBe(false);
 installed=[];await writeFile(path.join(context.homeDir,'.claude/settings.json'),'{}');
 expect((await readNativePluginInventory(context,'claude',options)).marketplaceAdd.user.allowed).toBe(true);
 await mkdir(path.join(context.projectPath,'.claude'));await writeFile(path.join(context.projectPath,'.claude/settings.json'),JSON.stringify({enabledPlugins:{'missing@market':false}}));
 expect((await readNativePluginInventory(context,'claude',options)).marketplaceAdd.user.allowed).toBe(false);
});
