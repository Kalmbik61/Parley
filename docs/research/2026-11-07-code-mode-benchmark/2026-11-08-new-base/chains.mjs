import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const tokenizerRoot=process.env.TOKENIZER_ROOT;
if(!tokenizerRoot)throw Error('provide external TOKENIZER_ROOT');
const {getEncoding}=require(tokenizerRoot);const enc=getEncoding('o200k_base');
if(JSON.parse(fs.readFileSync(tokenizerRoot+'/package.json')).version!=='1.0.21')throw Error('tokenizer version drift');
const selection=JSON.parse(fs.readFileSync(new URL('./chain-selection.json',import.meta.url)));
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const stats=x=>{const text=JSON.stringify(x);return{utf8Bytes:Buffer.byteLength(text),o200kTokens:enc.encode(text,[],[]).length,sha256:sha(text)};};
const transcriptMapPath=process.env.TRANSCRIPT_MAP;
if(!transcriptMapPath)throw Error('provide private external TRANSCRIPT_MAP');
const transcriptPaths=JSON.parse(fs.readFileSync(transcriptMapPath));
const files=new Map();let candidatePairCount=0,overviewV3PairCount=0;
function parsedPayload(b){const c=b.content;const strings=typeof c==='string'?[c]:Array.isArray(c)?c.filter(x=>x.type==='text').map(x=>x.text):[];for(const s of strings){try{const x=JSON.parse(s);if(x&&typeof x==='object'&&!Array.isArray(x))return x;}catch{}}return null;}
for(const p of selection.scanFiles){
 const raw=fs.readFileSync(transcriptPaths[p.transcriptId]).subarray(0,p.prefixBytes);if(raw.length!==p.prefixBytes||sha(raw)!==p.prefixSha256)throw Error('transcript prefix changed '+p.transcriptId);
 const records=raw.toString('utf8').trimEnd().split('\n');if(records.length!==p.lineCount)throw Error('line count');
 const calls=[],results=new Map();
 records.forEach((line,index)=>{const x=JSON.parse(line);if(!Array.isArray(x.message?.content))return;x.message.content.forEach((b,block)=>{if(b.type==='tool_use')calls.push({line:index+1,block,b,timestamp:x.timestamp,messageId:x.message.id});else if(b.type==='tool_result')results.set(b.tool_use_id,{line:index+1,block,b,timestamp:x.timestamp});});});
 const overview=c=>parsedPayload(results.get(c.b.id)?.b??{})?.map?.schemaVersion===3;
 for(let i=0;i<calls.length-1;i++){const pair=calls.slice(i,i+2);if(!pair.every(c=>c.b.name.startsWith('mcp__parley__')&&c.timestamp&&c.timestamp>=selection.scanSince&&results.has(c.b.id)))continue;if(results.get(pair[0].b.id).line>=pair[1].line)continue;candidatePairCount++;if(pair.some(overview))overviewV3PairCount++;}
 files.set(p.transcriptId,{calls,results});
}
if(candidatePairCount!==selection.candidatePairCount||overviewV3PairCount!==selection.overviewV3PairCount)throw Error('selection search does not reproduce');
const schema=JSON.parse(fs.readFileSync(new URL('./corpus/full-server-agent.json',import.meta.url)));
const dependencyRoot=process.env.BASELINE_DEPS;
if(!dependencyRoot)throw Error('provide external BASELINE_DEPS');
const Ajv=require(dependencyRoot+'/packages/core/node_modules/ajv');
const validatorVersion=JSON.parse(fs.readFileSync(dependencyRoot+'/packages/core/node_modules/ajv/package.json')).version;
const ajv=new Ajv({strict:false,coerceTypes:false,useDefaults:false,removeAdditional:false});
const checks=new Map(schema.map(t=>[t.name,ajv.compile(t.inputSchema)]));
const chains=selection.selected.map(s=>{
 const f=files.get(s.transcriptId);const chosen=s.lines.map(n=>{const found=f.calls.filter(c=>c.line===n);if(found.length!==1)throw Error('ambiguous line');return found[0];});
 for(let i=1;i<chosen.length;i++)if(f.calls.indexOf(chosen[i])!==f.calls.indexOf(chosen[i-1])+1)throw Error('non-adjacent');
 const calls=chosen.map((c,i)=>{const r=f.results.get(c.b.id);if(i<chosen.length-1&&r.line>=chosen[i+1].line)throw Error('non-sequential');const method=c.b.name.replace('mcp__parley__','');const check=checks.get(method);if(!check)throw Error('method absent from new-base list');const valid=check(c.b.input);const body=parsedPayload(r.b);return{name:c.b.name,callLine:c.line,callBlock:c.block,callId:c.b.id,messageId:c.messageId,timestamp:c.timestamp,resultLine:r.line,resultBlock:r.block,resultTimestamp:r.timestamp,isError:r.b.is_error??false,input:stats(c.b.input),resultContent:stats(r.b.content),newBaseInputSchemaValid:valid,inputValidationKeywords:valid?[]:check.errors.map(e=>e.keyword),shape:{requestBranch:method==='get_map'?(c.b.input.field?'field:'+c.b.input.field:c.b.input.session?'session':c.b.input.room?'room':valid?'overview':'invalid-request'):method,resultTopKeys:body?Object.keys(body):[],inputKeys:Object.keys(c.b.input),overviewSchemaVersion:body?.map?.schemaVersion??null,overviewCollectionNames:Object.keys(body?.map?.collections??{})}};});
 return{label:s.label,transcriptId:s.transcriptId,adjacentAcrossAllToolCalls:true,resultsBeforeNextCall:true,hostRevision:'unknown',newBaseExecutionProof:false,calls,sumInputTokens:calls.reduce((n,c)=>n+c.input.o200kTokens,0),sumResultTokens:calls.reduce((n,c)=>n+c.resultContent.o200kTokens,0),intermediateResultTokens:calls.slice(0,-1).reduce((n,c)=>n+c.resultContent.o200kTokens,0)};
});
const evidence={tokenizer:'js-tiktoken@1.0.21',encoder:'o200k_base',node:process.version,serialization:'JSON.stringify(tool_use.input) and JSON.stringify(tool_result.content); encode(text, [], [])',hostRevision:'unknown',executionProof:false,sourceComparisonRevision:'19b4444e2c526131433dab3f1d5d3eccadefedd7',inputValidator:{package:'ajv',version:validatorVersion,options:{strict:false,coerceTypes:false,useDefaults:false,removeAdditional:false},entrySha256:sha(fs.readFileSync(require.resolve(dependencyRoot+'/packages/core/node_modules/ajv'))),schemaCorpusSha256:sha(fs.readFileSync(new URL('./corpus/full-server-agent.json',import.meta.url)))},candidatePairCount,overviewV3PairCount,provenance:selection.scanFiles,chains};
fs.writeFileSync(new URL('./chain-evidence.json',import.meta.url),JSON.stringify(evidence,null,2));console.log(JSON.stringify({candidatePairCount,overviewV3PairCount,chains:chains.map(c=>({label:c.label,shape:c.calls.map(x=>x.shape),inputTokens:c.sumInputTokens,resultTokens:c.sumResultTokens,inputValid:c.calls.every(x=>x.newBaseInputSchemaValid)}))},null,2));
