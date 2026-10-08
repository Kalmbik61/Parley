import { expect, it, vi, beforeEach } from 'vitest';
import { createCapabilitiesPluginActions, parseClaudePluginComposition } from './plugin-actions.js';
import { createCapabilitiesMcpActions } from './actions.js';
import { createProviderScheduler } from './scheduler.js';
import { allow, deny } from './native-targets.js';
import type { SafeCapabilitiesService, SnapshotContext } from './snapshot.js';
import type { NativePluginInventory, NativePluginTarget } from './native-plugin-inventory.js';
import type { McpExecutor } from './actions.js';
const context: SnapshotContext={projectPath:'/fixture/project',homeDir:'/fixture/home',binaries:{claude:'/fixture/claude',codex:'/fixture/codex'},env:{SECRET:'SECRET_ENV'}};
let inventory: NativePluginInventory, installed: NativePluginTarget, available: NativePluginTarget, service: SafeCapabilitiesService;
let executor: ReturnType<typeof vi.fn<McpExecutor>>;
const params={projectPath:context.projectPath,provider:'claude' as const,revision:1};
const composition={skills:null,agents:null,mcp:null,hooks:null,tokenEstimate:null};
const target=(kind:'installed'|'available'):NativePluginTarget=>{
 const id=kind==='installed'?'opaque-installed':'opaque-available';
 const actions={install:kind==='available'?allow():deny(),uninstall:kind==='installed'?allow():deny(),enable:deny(),disable:kind==='installed'?allow():deny(),details:kind==='installed'?allow():deny('native-only')};
 return{id,kind,nativeId:'SECRET_NATIVE@market',scope:kind==='installed'?'user':null,fingerprint:'known',sourceFingerprint:kind==='available'?'known-local-closure':null,actions,
 summary:{id,kind,provider:'claude',name:'[redacted]',pluginId:'[redacted]',description:null,version:'1.0.0',scope:kind==='installed'?'user':null,enabled:null,composition,actions}};
};
beforeEach(()=>{
 installed=target('installed');available=target('available');
 inventory={provider:'claude',contextFingerprint:'bound',signature:'bound',executionBinary:'/fixture/claude',binaryIdentity:{canonicalPath:'/fixture/claude',sha256:'known',size:1},targets:[installed,available],marketplaceNames:[],installScopes:{user:allow(),project:allow(),local:allow()},marketplaceAdd:{user:allow(),project:allow(),local:allow()},catalog:allow(),partial:false};
 service={get:vi.fn(),refresh:vi.fn(),recordMcpCheck:vi.fn(),dispose:vi.fn(),prepareMcpAction:vi.fn(),preparePluginAction:vi.fn(async(request)=>({ok:true as const,context,inventory,target:'catalogId' in request?available:'presenceId' in request||'target' in request?installed:undefined,isCurrent:()=>true}))} as unknown as SafeCapabilitiesService;
 executor=vi.fn(async(_binary,args)=>({code:'ok' as const,exitCode:0,stdout:Buffer.from(JSON.stringify({command:args[1],outcome:'ok',pluginId:installed.nativeId,scope:'user',message:'SECRET_OUTPUT'}))}));
});
it('executes the private owned identity and explicit scope instead of a redacted display name',async()=>{
 const actions=createCapabilitiesPluginActions(service,executor);
 expect(await actions.uninstall({...params,presenceId:installed.id,confirmDataLoss:true})).toEqual({outcome:'ok',code:'ok'});
 expect(executor.mock.calls[0]![1]).toEqual(['plugin','uninstall','SECRET_NATIVE@market','--scope','user','--json']);
 expect(service.refresh).toHaveBeenCalledOnce();actions.dispose();
});
it('requires data-loss confirmation before preparation or execution',async()=>{
 const actions=createCapabilitiesPluginActions(service,executor);
 expect(await actions.uninstall({...params,presenceId:installed.id,confirmDataLoss:false} as never)).toEqual({outcome:'denied',code:'invalid-input'});
 expect(executor).not.toHaveBeenCalled();expect(service.preparePluginAction).not.toHaveBeenCalled();actions.dispose();
});
it('does not approve source commands through --yes/hash flags and does not execute denied sources',async()=>{
 available.actions.install=deny();const actions=createCapabilitiesPluginActions(service,executor);
 expect((await actions.install({...params,catalogId:available.id,scope:'user'})).outcome).toBe('unavailable');
 expect(executor).not.toHaveBeenCalled();actions.dispose();
});
it('treats semantic failure with exit zero as a safe failure without raw output',async()=>{
 executor.mockResolvedValue({code:'ok',exitCode:0,stdout:Buffer.from(JSON.stringify({command:'uninstall',outcome:'failed',message:'SECRET_OUTPUT',failureCode:'SECRET_CODE'}))});
 const actions=createCapabilitiesPluginActions(service,executor);const result=await actions.uninstall({...params,presenceId:installed.id,confirmDataLoss:true});
 expect(result).toEqual({outcome:'failed',code:'cli-error'});expect(JSON.stringify(result)).not.toContain('SECRET');expect(service.refresh).toHaveBeenCalledOnce();actions.dispose();
});
it('rejects a successful-looking result for a different native selector or scope',async()=>{
 executor.mockResolvedValue({code:'ok',stdout:Buffer.from(JSON.stringify({command:'uninstall',outcome:'ok',pluginId:'other@market',scope:'project'}))});
 const actions=createCapabilitiesPluginActions(service,executor);
 expect((await actions.uninstall({...params,presenceId:installed.id,confirmDataLoss:true})).code).toBe('invalid-output');actions.dispose();
});
it('keeps available composition unknown and uses no unsupported Codex details/toggle command',async()=>{
 installed.actions.details=deny('native-only');installed.actions.disable=deny('native-only');const actions=createCapabilitiesPluginActions(service,executor);
 const details=await actions.details({...params,provider:'codex',target:{kind:'installed',presenceId:installed.id}});
 expect(details.entry?.composition).toEqual(composition);expect(details.reason).toBe('native-only');
 expect((await actions.disable({...params,provider:'codex',presenceId:installed.id})).outcome).toBe('unavailable');expect(executor).not.toHaveBeenCalled();actions.dispose();
});
it('publishes only whitelisted details counts/cost and never its description or paths',async()=>{
 executor.mockResolvedValue({code:'ok',stdout:Buffer.from('SECRET_NATIVE 1.0.0\nDescription: SECRET_OUTPUT /fixture/cache\nComponent inventory\n  Skills (1) fixture\n  Agents (0)\n  Hooks (0)\n  MCP servers (0)\nProjected token cost\n  Always-on: ~10 tok\n')});
 const actions=createCapabilitiesPluginActions(service,executor);const result=await actions.details({...params,target:{kind:'installed',presenceId:installed.id}});
 expect(result.entry?.composition).toEqual({skills:1,agents:0,hooks:0,mcp:0,tokenEstimate:10});expect(JSON.stringify(result)).not.toContain('SECRET');expect(JSON.stringify(result)).not.toContain('/fixture');actions.dispose();
});
it('unknown/ambiguous details never become invented zero counts',()=>{
 expect(parseClaudePluginComposition(Buffer.from('exit zero no inventory'))).toBeNull();
 expect(parseClaudePluginComposition(Buffer.from('Skills (0)\nSkills (1)\nAgents (0)\nHooks (0)\nMCP servers (0)\n'))).toBeNull();
});
it('bounds assembled multibyte catalogs before delivering them',async()=>{
 const big={...available,summary:{...available.summary,description:'日本語'.repeat(2730)}};
 inventory.targets=Array.from({length:200},()=>big);
 const actions=createCapabilitiesPluginActions(service,executor);const result=await actions.available(params);
 expect(result.entries).toEqual([]);expect(result.reason).toBe('output-limit');expect(JSON.stringify(result)).not.toContain('SECRET');actions.dispose();
});
it('serializes MCP and plugins across projects through one scheduler and revalidates only after waiting',async()=>{
 const scheduler=createProviderScheduler();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 executor.mockImplementationOnce(async()=>{await gate;return{code:'ok',stdout:Buffer.from('')}});
 service.prepareMcpAction=vi.fn<SafeCapabilitiesService['prepareMcpAction']>(async()=>({ok:true,context,inventory:{contextFingerprint:'bound',signature:'bound',names:[],targets:[{id:'mcp',provider:'claude',name:'fixture',scope:'user',fingerprint:'bound',remove:allow(),check:deny()}],add:{user:allow(),project:allow(),local:allow()}},target:{id:'mcp',provider:'claude',name:'fixture',scope:'user',fingerprint:'bound',remove:allow(),check:deny()},checkProof:null,isCurrent:()=>true}));
 const mcp=createCapabilitiesMcpActions(service,executor,scheduler),plugins=createCapabilitiesPluginActions(service,executor,scheduler);
 const running=mcp.remove({...params,presenceId:'mcp'});await vi.waitFor(()=>expect(executor).toHaveBeenCalledOnce());
 const pending=plugins.uninstall({...params,projectPath:'/other/project',presenceId:installed.id,confirmDataLoss:true});
 expect(service.preparePluginAction).not.toHaveBeenCalled();release();await running;await pending;
 expect(service.preparePluginAction).toHaveBeenCalledOnce();expect(executor).toHaveBeenCalledTimes(2);scheduler.dispose();mcp.dispose();plugins.dispose();
});
it('cancels active/queued actions on shutdown without refresh or late results',async()=>{
 const scheduler=createProviderScheduler();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 executor.mockImplementation(async()=>{await gate;return{code:'ok',stdout:Buffer.from('{}')}});
 const actions=createCapabilitiesPluginActions(service,executor,scheduler);
 const active=actions.uninstall({...params,presenceId:installed.id,confirmDataLoss:true});await vi.waitFor(()=>expect(executor).toHaveBeenCalledOnce());
 const queued=actions.install({...params,catalogId:available.id,scope:'user'});scheduler.dispose();actions.dispose();
 expect(await active).toEqual({outcome:'cancelled',code:'shutdown'});expect(await queued).toEqual({outcome:'cancelled',code:'shutdown'});
 release();await Promise.resolve();expect(executor).toHaveBeenCalledOnce();expect(service.refresh).not.toHaveBeenCalled();
});
it('fresh context/winner rejection prevents execution without exposing internal errors',async()=>{
 service.preparePluginAction=vi.fn<SafeCapabilitiesService['preparePluginAction']>(async()=>({ok:false,code:'context-changed'}));
 const actions=createCapabilitiesPluginActions(service,executor);
 expect(await actions.uninstall({...params,presenceId:installed.id,confirmDataLoss:true})).toEqual({outcome:'denied',code:'context-changed'});expect(executor).not.toHaveBeenCalled();actions.dispose();
});

import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
it('uses supported Codex user add/remove with exact selectors and refuses semantic failures',async()=>{
 const actions=createCapabilitiesPluginActions(service,executor);
 executor.mockResolvedValue({code:'ok',stdout:Buffer.from(JSON.stringify({pluginId:available.nativeId,authPolicy:'ON_INSTALL'}))});
 expect(await actions.install({...params,provider:'codex',catalogId:available.id,scope:'user'})).toEqual({outcome:'ok',code:'ok'});
 expect(executor.mock.calls[0]![1]).toEqual(['plugin','add',available.nativeId,'--json']);
 executor.mockResolvedValue({code:'ok',stdout:Buffer.from(JSON.stringify({pluginId:installed.nativeId}))});
 expect(await actions.uninstall({...params,provider:'codex',presenceId:installed.id,confirmDataLoss:true})).toEqual({outcome:'ok',code:'ok'});
 expect(executor.mock.calls[1]![1]).toEqual(['plugin','remove',installed.nativeId,'--json']);
 executor.mockResolvedValue({code:'ok',stdout:Buffer.from(JSON.stringify({pluginId:installed.nativeId,success:false,error:'SECRET_NATIVE_ERROR'}))});
 expect((await actions.uninstall({...params,provider:'codex',presenceId:installed.id,confirmDataLoss:true})).outcome).toBe('failed');actions.dispose();
});
it('passes a freshly validated local marketplace as one argv value and rejects duplicate registration',async()=>{
 const root=await realpath(await mkdtemp('/private/tmp/parley-p18-local-market-'));const market=path.join(root,'market with spaces');await mkdir(path.join(market,'.claude-plugin'),{recursive:true});await writeFile(path.join(market,'.claude-plugin/marketplace.json'),JSON.stringify({name:'local-fixture',plugins:[]}));
 const actions=createCapabilitiesPluginActions(service,executor);
 try {
  executor.mockResolvedValue({code:'ok',stdout:Buffer.from(JSON.stringify({command:'marketplace-add',outcome:'ok',marketplace:'local-fixture'}))});
  expect(await actions.addMarketplace({...params,scope:'project',source:{kind:'local',path:market}})).toEqual({outcome:'ok',code:'ok'});
  expect(executor.mock.calls[0]![1]).toEqual(['plugin','marketplace','add',market,'--scope','project','--json']);
  inventory.marketplaceNames.push('LOCAL-FIXTURE');
  expect(await actions.addMarketplace({...params,scope:'project',source:{kind:'local',path:market}})).toEqual({outcome:'denied',code:'conflict'});expect(executor).toHaveBeenCalledOnce();
 }finally{actions.dispose();await rm(root,{recursive:true,force:true});}
});

it('does not install into an unverified selected scope even when another human scope is supported',async()=>{
 inventory.installScopes.project=deny();const actions=createCapabilitiesPluginActions(service,executor);
 expect(await actions.install({...params,catalogId:available.id,scope:'project'})).toEqual({outcome:'unavailable',code:'unverified'});
 expect(executor).not.toHaveBeenCalled();actions.dispose();
});

it('does not submit a local marketplace whose complete manifest declares a command/helper or unresolved dependency',async()=>{
 const root=await realpath(await mkdtemp('/private/tmp/parley-p18-unsafe-market-'));await mkdir(path.join(root,'.claude-plugin'));const actions=createCapabilitiesPluginActions(service,executor);
 try{
  for(const value of [{name:'unsafe',plugins:[],headersHelper:'SECRET_HELPER'},{name:'unsafe',plugins:[{name:'fixture',source:{source:'command',command:'SECRET_COMMAND'}}]}]){
   await writeFile(path.join(root,'.claude-plugin/marketplace.json'),JSON.stringify(value));
   expect((await actions.addMarketplace({...params,scope:'user',source:{kind:'local',path:root}})).outcome).toBe('unavailable');
  }
  expect(executor).not.toHaveBeenCalled();
 }finally{actions.dispose();await rm(root,{recursive:true,force:true});}
});

it.each(['install', 'uninstall'] as const)('accepts a complete pretty native Codex %s object', async kind => {
 const actions=createCapabilitiesPluginActions(service,executor);
 const selected=kind==='install'?available:installed;
 executor.mockResolvedValue({code:'ok',exitCode:0,stdout:Buffer.from(JSON.stringify({pluginId:selected.nativeId,...(kind==='install'?{authPolicy:'ON_INSTALL'}:{}),message:'SECRET_NATIVE_OUTPUT'},null,2)+'\n')});
 const result=kind==='install'?await actions.install({...params,provider:'codex',catalogId:selected.id,scope:'user'}):await actions.uninstall({...params,provider:'codex',presenceId:selected.id,confirmDataLoss:true});
 expect(result).toEqual({outcome:'ok',code:'ok'});expect(service.refresh).toHaveBeenCalledOnce();expect(JSON.stringify(result)).not.toContain('SECRET');actions.dispose();
});
it('accepts a complete pretty Claude result while retaining its command, identity and scope proof',async()=>{
 const actions=createCapabilitiesPluginActions(service,executor);
 const payload={command:'uninstall',outcome:'ok',pluginId:installed.nativeId,scope:'user'};
 executor.mockResolvedValue({code:'ok',stdout:Buffer.from(JSON.stringify(payload,null,2))});
 expect(await actions.uninstall({...params,presenceId:installed.id,confirmDataLoss:true})).toEqual({outcome:'ok',code:'ok'});
 for(const changed of [{...payload,pluginId:'foreign@market'},{...payload,scope:'project'},{...payload,command:'install'},{...payload,outcome:'failed',failureCode:'SECRET_FAILURE'}]){
  executor.mockResolvedValue({code:'ok',stdout:Buffer.from(JSON.stringify(changed,null,2))});
  const result=await actions.uninstall({...params,presenceId:installed.id,confirmDataLoss:true});expect(result.outcome).toBe('failed');expect(JSON.stringify(result)).not.toContain('SECRET');
 }
 actions.dispose();
});
it('rejects non-JSON, multiple documents, invalid UTF8 and over-limit native output without line recovery',async()=>{
 const actions=createCapabilitiesPluginActions(service,executor);
 const good=JSON.stringify({command:'uninstall',outcome:'ok',pluginId:installed.nativeId,scope:'user'});
 for(const stdout of [Buffer.from(`SECRET_PREFIX\n${good}`),Buffer.from(`${good}\n${good}`),Buffer.concat([Buffer.from([0xff]),Buffer.from(`\n${good}`)]),Buffer.from(' '.repeat(1024*1024)+good),Buffer.from('{"private":"SECRET_OUTPUT"')]){
  executor.mockResolvedValue({code:'ok',stdout});expect(await actions.uninstall({...params,presenceId:installed.id,confirmDataLoss:true})).toEqual({outcome:'failed',code:'invalid-output'});
 }
 actions.dispose();
});
