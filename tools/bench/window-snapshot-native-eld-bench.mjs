#!/usr/bin/env node
/* global Buffer, setImmediate, setTimeout, structuredClone */
// M4 final native-page cooperative ELD evidence. No service, database, provider calls, or production changes.
// node tools/bench/window-snapshot-native-eld-bench.mjs [--out file]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cpus } from 'node:os';
import { performance, monitorEventLoopDelay, createHistogram } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { addSession } from '../../packages/core/dist/work/map.js';
import { mailWorkMap } from '../../packages/core/dist/work/context-pages.js';
import { mapLetterReader } from '../../packages/core/dist/work/letter-store.js';
import { encodeLine } from '../../packages/protocol/dist/index.js';
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = path.resolve(outIdx < 0 ? 'docs/research/data/window-snapshot-native-eld-m4.json' : args[outIdx + 1]);
const PAGE = 128 * 1024;
function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}
const WORDS =
  'alpha beta gamma delta epsilon zeta theta iota kappa lambda sigma omega plan build check merge review cache frame window snapshot session task result'.split(
    ' ',
  );
function text(seed, bytes) {
  const rnd = lcg(seed);
  let out = '';
  while (out.length < bytes)
    out += WORDS[Math.floor(rnd() * WORDS.length)] + (rnd() < 0.1 ? '.\n' : ' ');
  return out.slice(0, bytes);
}

const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length === 0 ? null : a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
};
const stat = (arr) => ({
  n: arr.length,
  p50: round(pct(arr, 50)),
  p95: round(pct(arr, 95)),
  max: round(Math.max(...arr)),
});
const round = (v) => (v === null ? null : Math.round(v * 1000) / 1000);

const project = map => mailWorkMap(map, mapLetterReader(map), {});
const AT4 = '2026-11-01T00:00:00.000Z';
function fixture() {
  const map={schemaVersion:2,work:{id:'w-0',title:'m2-0',goal:text(0,200),status:'active',createdAt:AT4,updatedAt:AT4},sessions:[],messages:[],rooms:[]};
  for(let i=0;i<3000;i+=1){
    const row=addSession(map,{provider:'codex',label:`s${i}`,task:text(i,4096)},AT4);
    row.summary=text(i+7,4096);row.summarySource='agent';
  }
  return map;
}
function objectCache(rows, workId) {
  return {workId,ids:rows.map(r=>r.id),objs:new Map(rows.map(r=>[r.id,r]))};
}
async function nativeArrayPages(cache, input) {
  let sliceStart=performance.now(),maxSyncSliceMs=0,yields=0;
  const pause=async()=>{
    maxSyncSliceMs=Math.max(maxSyncSliceMs,performance.now()-sliceStart);yields+=1;
    await new Promise(r=>setImmediate(r));sliceStart=performance.now();
  };
  const projected=project(input),rows=projected.sessions;
  const changed=[];
  for(let i=0;i<rows.length;i+=1){
    if(!isDeepStrictEqual(cache.objs.get(rows[i].id),rows[i]))changed.push(rows[i]);
    if(i%16===15&&performance.now()-sliceStart>=4)await pause();
  }
  const next=objectCache(rows,cache.workId);
  if(!isDeepStrictEqual(next.ids,cache.ids))throw new Error('M4 alternative restricted to same ids/order');
  const frames=[],frameBytes=[];
  const counts={changedRows:changed.length,rowSerializationOccurrences:0,pageEncodeAttempts:0,oversizedAttempts:0,retrySerializedRows:0,retainedPerRowEncodedBytes:0};
  const encodeBatch=async(batch,last)=>{
    const seq=frames.length;
    counts.pageEncodeAttempts+=1;counts.rowSerializationOccurrences+=batch.length;
    const frame=encodeLine({event:'works.delta.page',data:{revision:2,workId:cache.workId,version:2,seq,
      cursor:last?null:String(seq+1).padStart(10,'0'),done:last,resetOrder:false,upsert:batch,remove:[],order:[]}});
    const n=Buffer.byteLength(frame);
    if(n>PAGE){
      counts.oversizedAttempts+=1;counts.retrySerializedRows+=batch.length;
      if(batch.length<=1)throw new Error('native single row exceeds page budget');
      const middle=Math.floor(batch.length/2);
      if(performance.now()-sliceStart>=4)await pause();
      await encodeBatch(batch.slice(0,middle),false);await encodeBatch(batch.slice(middle),last);return;
    }
    frames.push(frame);frameBytes.push(n);
    if(performance.now()-sliceStart>=4)await pause();
  };
  // 14 is the observed M3 page capacity of this fixed 4KiB+4KiB fixture,
  // not a trusted byte bound. Every actual frame is checked; overflow splits/re-encodes.
  if(!changed.length)await encodeBatch([],true);
  for(let i=0;i<changed.length;i+=14)await encodeBatch(changed.slice(i,i+14),i+14>=changed.length);
  maxSyncSliceMs=Math.max(maxSyncSliceMs,performance.now()-sliceStart);
  return {projected,frames,frameBytes,next,counts:{...counts,projectedRows:rows.length,comparedRows:rows.length,yields},maxSyncSliceMs};
}
function verifyNative(cache,result,target){
  const byId=new Map(cache.objs);let decoded=0;
  result.frames.forEach((frame,i)=>{
    const m=JSON.parse(frame),d=m.data;
    if(m.event!=='works.delta.page'||d.workId!==cache.workId||d.seq!==i||d.done!==(i===result.frames.length-1)||
      d.cursor!==(d.done?null:String(i+1).padStart(10,'0'))||d.resetOrder||d.remove.length||d.order.length||
      !frame.endsWith('\n')||Buffer.byteLength(frame)!==result.frameBytes[i]||result.frameBytes[i]>PAGE)throw new Error('native page invariant');
    d.upsert.forEach(row=>{byId.set(row.id,row);decoded+=1;});
  });
  if(decoded!==result.counts.changedRows||!isDeepStrictEqual(cache.ids.map(id=>byId.get(id)),JSON.parse(JSON.stringify(target.sessions))))throw new Error('native decoded mismatch');
  if(!isDeepStrictEqual({...JSON.parse(JSON.stringify(target)),sessions:cache.ids.map(id=>byId.get(id))},JSON.parse(JSON.stringify(target))))throw new Error('native full map mismatch');
  if([...result.next.objs.values()].some((row,i)=>row!==result.projected.sessions[i]))throw new Error('native retained-cache mismatch');
}
function fullReference(input){
  const projected=project(input),entry={projectPath:'bench',map:projected,version:1};
  JSON.stringify(entry);
  const frame=encodeLine({event:'works.changed',data:{entries:[entry],branches:{},revision:2}});
  return {projected,frame,bytes:Buffer.byteLength(frame)};
}
const WARMUP=5,SAMPLES=20,TRIALS=5;
async function run(){
  const base=fixture(),baseProjection=project(base),baseJson=JSON.stringify(baseProjection);
  const taskEdits=[text(9100000,4096),text(9200000,4096)];
  const denseEdits=[0,1].map(state=>base.sessions.map((_,i)=>text(8900000+state*10000+i,4096)));
  const report={kind:'M4 final evidence: same native bounded-array/projected-object candidate with cooperative4ms scheduling',generatedAt:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,platform:`${process.platform}-${process.arch}`,trials:TRIALS,samplesPerTrial:SAMPLES,warmupPerTrial:WARMUP,yieldTargetMs:4,pageBudgetBytes:PAGE,
    method:'Five alternating paired trials for1w/3k dense/task/status only. Every operation receives a fresh clone prepared outside timing. Dense alternates between two complete task sets; task edits toggle one task; status toggles active/pending with startedAt. Each actual candidate next-cache feeds the next operation, including warmup→measured. Reference always projects and entry-stringifies then full-snapshot encodeLine (hypothetical >gate frame). Native transport/14row batches/retry splitting/object cache are unchanged from M4, only4ms scheduler added: compare budget every16rows, encode budget after each page/rejected attempt. Projection/cache construction/one JSON batch remain uninterruptible. CPU=process.cpuUsage user+system over awaited operation; completion=performance.now includes yield waits. Fresh1ms ELD histogram/trial,5ms prime/reset, operation then setImmediate,2ms drain. Entire result frames/projected rows retained until monitor disabled; every output then decoded against its target/cache before next trial. This excludes decoding from CPU/ELD but increases retained memory/GC; CPU includes any process background GC. No forcedGC or renderer/IPC/service measurement. ELD pooled from empirical-rank native HDR samples as prior evidence. maxSyncSlice measured within operation, not guaranteed scheduler latency.',cases:{}};
  for(const kind of ['dense','task','status']){
    const acc=Object.fromEntries(['existing','candidate'].map(name=>[name,{cpu:[],completion:[],slices:[],yields:[],eld:createHistogram(),trials:[],counts:null}]));
    const prepare=()=>Array.from({length:WARMUP+SAMPLES},(_,i)=>{
      const m=structuredClone(base),state=i%2;
      if(kind==='dense')m.sessions.forEach((r,j)=>r.task=denseEdits[state][j]);
      if(kind==='task')m.sessions[0].task=taskEdits[state];
      if(kind==='status'){
        // First operation must differ from pending baseline, then toggle each call.
        m.sessions[0].lifecycle=state===0?'active':'pending';
        m.sessions[0].startedAt=state===0?AT4:null;
      }
      return m;
    });
    for(let trial=0;trial<TRIALS;trial+=1){
      const order=trial%2?['candidate','existing']:['existing','candidate'];
      for(const name of order){
        const inputs=prepare();
        let previous=objectCache(baseProjection.sessions,base.work.id);
        const operate=async input=>{
          const baseline=previous;
          const result=name==='candidate'?await nativeArrayPages(baseline,input):fullReference(input);
          if(name==='candidate')previous=result.next;
          return {input,baseline,result};
        };
        const verify=({input,baseline,result})=>{
          const target=project(input);
          if(name==='candidate'){
            verifyNative(baseline,result,target);
            if(result.counts.changedRows!==(kind==='dense'?3000:1))throw new Error('changed-row count');
            if(target.sessions.some(r=>r===baseline.objs.get(r.id)))throw new Error('projected row alias');
            if(result.counts.oversizedAttempts!==0)throw new Error('unexpected normal-fixture retry');
          }else if(!isDeepStrictEqual(JSON.parse(result.frame).data.entries[0].map,JSON.parse(JSON.stringify(target))))throw new Error('reference target mismatch');
        };
        for(let i=0;i<WARMUP;i+=1)verify(await operate(inputs[i]));
        const eld=monitorEventLoopDelay({resolution:1});eld.enable();
        await new Promise(r=>setTimeout(r,5));eld.reset();
        const raw=[],pending=[];
        for(let i=0;i<SAMPLES;i+=1){
          const c0=process.cpuUsage(),t0=performance.now();
          const op=await operate(inputs[WARMUP+i]);
          const completionMs=performance.now()-t0,used=process.cpuUsage(c0);
          const cpuMs=(used.user+used.system)/1000;
          raw.push({completionMs,cpuMs,maxSyncSliceMs:name==='candidate'?op.result.maxSyncSliceMs:completionMs,yields:name==='candidate'?op.result.counts.yields:0});
          pending.push(op);
          await new Promise(r=>setImmediate(r));
        }
        await new Promise(r=>setTimeout(r,2));eld.disable();
        const rankSamplesNs=Array.from({length:eld.count},(_,i)=>eld.percentile(100*(i+1)/eld.count));
        for(const ns of rankSamplesNs)acc[name].eld.record(Math.max(1,ns));
        for(let i=0;i<pending.length;i+=1){
          const op=pending[i];verify(op);
          raw[i].transport=name==='candidate'?{
            frames:op.result.frames.length,maxFrameBytes:Math.max(...op.result.frameBytes),
            totalFrameBytes:op.result.frameBytes.reduce((n,b)=>n+b,0),
            rowSerializationOccurrences:op.result.counts.rowSerializationOccurrences,
            pageEncodeAttempts:op.result.counts.pageEncodeAttempts,oversizedAttempts:op.result.counts.oversizedAttempts,
          }:{frames:1,maxFrameBytes:op.result.bytes,totalFrameBytes:op.result.bytes,rowSerializationOccurrences:6000};
        }
        const last=pending[pending.length-1].result;
        acc[name].counts=name==='candidate'?{
          ...last.counts,frames:last.frames.length,maxFrameBytes:Math.max(...last.frameBytes),totalFrameBytes:last.frameBytes.reduce((n,b)=>n+b,0)
        }:{projectedRows:3000,rowSerializationOccurrences:6000,frames:1,maxFrameBytes:last.bytes,totalFrameBytes:last.bytes};
        for(const sample of raw){acc[name].cpu.push(sample.cpuMs);acc[name].completion.push(sample.completionMs);acc[name].slices.push(sample.maxSyncSliceMs);acc[name].yields.push(sample.yields);}
        acc[name].trials.push({trial:trial+1,order,raw,eldRankSamplesNs:rankSamplesNs,eldSamples:eld.count,eldMs:{p50:round(eld.percentile(50)/1e6),p95:round(eld.percentile(95)/1e6),max:round(eld.max/1e6)}});
      }
    }
    const summary=name=>({transport:{maxFrameBytes:Math.max(...acc[name].trials.flatMap(t=>t.raw.map(s=>s.transport.maxFrameBytes))),framesPerCall:stat(acc[name].trials.flatMap(t=>t.raw.map(s=>s.transport.frames))),totalFrameBytesPerCall:stat(acc[name].trials.flatMap(t=>t.raw.map(s=>s.transport.totalFrameBytes)))},processCpuMs:stat(acc[name].cpu),completionMs:stat(acc[name].completion),maxSyncSliceMs:stat(acc[name].slices),yieldsPerCall:stat(acc[name].yields),activeLoopDelayMs:{samples:acc[name].eld.count,p50:round(acc[name].eld.percentile(50)/1e6),p95:round(acc[name].eld.percentile(95)/1e6),max:round(acc[name].eld.max/1e6)},counts:acc[name].counts,perTrial:acc[name].trials});
    report.cases[kind]={assertions:{everyWarmupAndMeasuredOutputDecodedExact:true,evolvingCache:true,freshInputRows:true,allCandidateFramesWithinBudget:true,exactRowCounts:true},existing:summary('existing'),candidate:summary('candidate')};
  }
  if(JSON.stringify(baseProjection)!==baseJson)throw new Error('initial cache mutated');
  await mkdir(path.dirname(outPath),{recursive:true});await writeFile(outPath,JSON.stringify(report,null,2)+'\n');process.stderr.write(`wrote ${outPath}\n`);
}
await run();
