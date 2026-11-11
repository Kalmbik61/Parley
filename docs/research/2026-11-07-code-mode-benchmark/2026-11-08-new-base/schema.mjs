import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const out=path.dirname(new URL(import.meta.url).pathname);
const source=fs.realpathSync(process.argv[2]??path.join(out,'source'));
const depsArg=process.argv[3]??process.env.BASELINE_DEPS;
if(!depsArg)throw Error('provide dependency root as argument 3 or BASELINE_DEPS');
const deps=fs.realpathSync(depsArg);
const revision='19b4444e2c526131433dab3f1d5d3eccadefedd7';
const tokenizerRoot=process.env.TOKENIZER_ROOT;
if(!tokenizerRoot)throw Error('provide external TOKENIZER_ROOT');
const {build}=require(deps+'/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild');
const tokenizer=require(tokenizerRoot);
const enc=tokenizer.getEncoding('o200k_base');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const versions={node:process.version,esbuild:JSON.parse(fs.readFileSync(deps+'/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/package.json')).version,sdk:JSON.parse(fs.readFileSync(deps+'/packages/core/node_modules/@modelcontextprotocol/sdk/package.json')).version,tokenizer:JSON.parse(fs.readFileSync(tokenizerRoot+'/package.json')).version,encoder:'o200k_base'};
if(versions.esbuild!=='0.25.12'||versions.sdk!=='1.30.0'||versions.tokenizer!=='1.0.21')throw Error('dependency version drift');
const entry=`
export {TOOLS,FIND_SKILL,CLAUDE_NAMES_ONLY,CODEX_NO_LIST_NO_NAMES} from './packages/core/src/mcp/tools.ts';
export {BROWSER_TOOLS} from './packages/core/src/mcp/browser-tools.ts';
export {CREATE_SESSION_TOOL,REQUEST_AGENT_SWITCH_TOOL} from './packages/core/src/mcp/session-tools.ts';
export {CREATE_SWARM_TOOL,SWARM_ADD_TOOL} from './packages/core/src/mcp/swarm-tools.ts';
export {SHORT_PROFILE_HIDDEN_TOOLS} from './packages/core/src/work/mcp-config.ts';
import {createParleyServer} from './packages/core/src/mcp/tools.ts';
import {createWork,updateMap,workPaths} from './packages/core/src/work/store.ts';
import {addSession,transitionSession} from './packages/core/src/work/map.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {mkdtemp,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
globalThis.fetch=()=>{throw Error('network prohibited in offline baseline');};
export async function contextOf(profile,agent,navigator){
 const root=await mkdtemp(path.join(tmpdir(),'s291-offline-list-'));process.env.PARLEY_HOME=path.join(root,'home');
 const project=path.join(root,'project');await mkdir(project);
 const workId=(await createWork(project,{title:'Offline schema fixture'})).work.id;
 await updateMap(project,workId,map=>{transitionSession(map,addSession(map,{provider:'claude',label:'fixture',task:'Offline tools/list'}).id,'active');});
 return {projectPath:project,workId,workDir:workPaths(project,workId).dir,sessionId:'s-01',channel:false,...(profile==='short'?{toolProfile:'short'}:{}),...(agent?{agent:{url:'http://127.0.0.1:1',token:'synthetic-offline-only'}}:{}),...(navigator?{skillNavigator:true}:{})};
}
export async function runtimeProbe(profile,agent,navigator){const server=createParleyServer(await contextOf(profile,agent,navigator));const client=new Client({name:'offline-baseline',version:'0'});const[a,b]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(a),server.connect(b)]);try{return(await client.listTools()).tools;}finally{await client.close();await server.close();}}
if(process.argv[2]==='--baseline-stdio')await createParleyServer(await contextOf(process.argv[3],process.argv[4]==='true',process.argv[5]==='true')).connect(new StdioServerTransport());
`;
const built=await build({stdin:{contents:entry,resolveDir:source,sourcefile:'baseline-entry.ts'},bundle:true,write:false,platform:'node',format:'esm',metafile:true,absWorkingDir:source,banner:{js:"import {createRequire as baselineRequire} from 'node:module';const require=baselineRequire(import.meta.url);"},nodePaths:[deps+'/packages/core/node_modules',deps+'/node_modules'],plugins:[{name:'measurement-exports',setup(b){b.onLoad({filter:/\/mcp\/tools\.ts$/},args=>({contents:fs.readFileSync(args.path,'utf8')+'\nexport {FIND_SKILL,CLAUDE_NAMES_ONLY,CODEX_NO_LIST_NO_NAMES};',loader:'ts'}));}}]});
fs.writeFileSync(out+'/source-bundle.mjs',built.outputFiles[0].text);
const m=await import('./source-bundle.mjs');
const descriptionBytes=x=>Array.isArray(x)?x.reduce((n,y)=>n+descriptionBytes(y),0):x&&typeof x==='object'?Object.entries(x).reduce((n,[k,v])=>n+(k==='description'&&typeof v==='string'?Buffer.byteLength(v):descriptionBytes(v)),0):0;
fs.mkdirSync(out+'/corpus',{recursive:true});
const stats=(name,tools)=>{const json=JSON.stringify(tools);fs.writeFileSync(out+'/corpus/'+name+'.json',json);return{name,toolCount:tools.length,utf8Bytes:Buffer.byteLength(json),o200kTokens:enc.encode(json,[],[]).length,descriptionBytes:descriptionBytes(tools),sha256:sha(json)};};
const session=[m.CREATE_SESSION_TOOL,m.REQUEST_AGENT_SWITCH_TOOL,m.CREATE_SWARM_TOOL,m.SWARM_ADD_TOOL];
const rows=[stats('create-session',[m.CREATE_SESSION_TOOL]),stats('session-level',session),stats('browser',m.BROWSER_TOOLS),stats('navigator-base',[m.FIND_SKILL]),stats('navigator-claude-reduced',[{...m.FIND_SKILL,description:m.FIND_SKILL.description+m.CLAUDE_NAMES_ONLY}]),stats('navigator-codex-reduced-unavailable',[{...m.FIND_SKILL,description:m.FIND_SKILL.description+m.CODEX_NO_LIST_NO_NAMES}])];
const parity=[],wire=[];
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
async function wireProbe(profile,agent,navigator){return new Promise((resolve,reject)=>{
const child=spawn(process.execPath,[out+'/source-bundle.mjs','--baseline-stdio',profile,String(agent),String(navigator)],{stdio:['pipe','pipe','pipe'],env:{...process.env,HOME:out+'/isolated-home',PARLEY_HOME:out+'/isolated-home/parley'}});let pending='',stderr='',ended=false;const timer=setTimeout(()=>finish(Error('stdio timeout')),15000);
function finish(error,value){if(ended)return;ended=true;clearTimeout(timer);child.kill();error?reject(error):resolve(value);}
child.on('error',finish);child.on('exit',code=>{if(!ended)finish(Error('stdio exit '+code+': '+stderr));});child.stderr.on('data',x=>stderr+=x.toString());
child.stdout.on('data',data=>{pending+=data.toString();let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i+1);pending=pending.slice(i+1);let x;try{x=JSON.parse(line);}catch(e){return finish(e);}if(x.id===1){child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})+'\n');}if(x.id===2)return finish(null,{line,tools:x.result.tools});}});
child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'offline-baseline',version:'0'}}})+'\n');});}
for(const profile of ['full','short']){
 const core=m.TOOLS.filter(t=>profile==='full'||!m.SHORT_PROFILE_HIDDEN_TOOLS.includes(t.name));
 rows.push(stats(profile+'-legacy-size-corpus',[...core,m.CREATE_SESSION_TOOL]));
 for(const agent of [false,true])for(const navigator of [false,true]){
  const name=profile+(agent?'-server-agent':'-runner')+(navigator?'-navigator-base':'');
  const expected=[...core,...(navigator?[m.FIND_SKILL]:[]),...(agent?[...m.BROWSER_TOOLS,...session]:[])];rows.push(stats(name,expected));
  const actual=await m.runtimeProbe(profile,agent,navigator);
  if(JSON.stringify(canonical(expected))!==JSON.stringify(canonical(actual)))throw Error('SDK parity '+name);
  parity.push({name,semanticMatch:true,exactJsonMatch:JSON.stringify(actual)===JSON.stringify(expected),sdkParsedOrder:stats(name+'-sdk',actual)});
  const captured=await wireProbe(profile,agent,navigator);if(JSON.stringify(captured.tools)!==JSON.stringify(expected))throw Error('wire parity '+name);
  fs.writeFileSync(out+'/corpus/'+name+'.jsonrpc',captured.line);wire.push({name,sourceOrderMatch:true,utf8Bytes:Buffer.byteLength(captured.line),o200kTokens:enc.encode(captured.line,[],[]).length,sha256:sha(captured.line)});
 }
}
const loaded=Object.keys(built.metafile.inputs).map(p=>path.resolve(source,p)).filter(p=>fs.existsSync(p));
const sourceHashes={},dependencyHashes={};
for(const p of loaded){const hash=sha(fs.readFileSync(p));if(p.startsWith(source+'/')){const rel=path.relative(source,p);const git=execFileSync('git',['-C',deps,'show',revision+':'+rel]);if(hash!==sha(git))throw Error('source mismatch '+rel);sourceHashes[rel]=hash;}else {if(!p.startsWith(deps+'/'))throw Error('unexpected dependency root');dependencyHashes['<dependency-root>/'+path.relative(deps,p)]=hash;}}
const required=['tools.ts','tools-size.test.ts','server.ts','server-profile.test.ts','browser-tools.ts','plan-tools.ts','session-tools.ts'];for(const name of required){const rel='packages/core/src/mcp/'+name;sourceHashes[rel]=sha(fs.readFileSync(source+'/'+rel));}
for(const rel of ['packages/core/src/work/mcp-config.ts','packages/host/src/agent/tools-endpoint.ts','pnpm-lock.yaml'])sourceHashes[rel]=sha(fs.readFileSync(source+'/'+rel));
const packet={revision,versions,serialization:'JSON.stringify(toolArray), no whitespace/newline; encode(text, [], [])',scope:'offline fresh source bundle, tools/list only, synthetic isolated Claude session; no business calls or paid runs',rows,parity,wire,sourceHashes,dependencyHashes,tokenizerEntrySha256:sha(fs.readFileSync(require.resolve(tokenizerRoot))),encoderDataSha256:sha(fs.readFileSync(tokenizerRoot+'/dist/ranks/o200k_base.cjs')),bundleSha256:sha(built.outputFiles[0].text)};
fs.writeFileSync(out+'/schema-evidence.json',JSON.stringify(packet,null,2));console.log(JSON.stringify({versions,rows,parityCases:parity.length,wireCases:wire.length,sourceFiles:Object.keys(sourceHashes).length,dependencyFiles:Object.keys(dependencyHashes).length},null,2));
