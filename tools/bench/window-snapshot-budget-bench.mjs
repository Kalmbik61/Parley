#!/usr/bin/env node
// One approved 128/512KiB native-page budget diagnostic. No service, database, provider calls, or production changes.
// node tools/bench/window-snapshot-budget-bench.mjs [--out file]
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
const outPath = path.resolve(outIdx < 0 ? 'docs/research/data/window-snapshot-budget-diagnostic-m4.json' : args[outIdx + 1]);
const BUDGETS=[{bytes:128*1024,rows:14},{bytes:512*1024,rows:56}];
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
async function nativeArrayPages(cache, input, budget) {
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
    if(n>budget.bytes){
      counts.oversizedAttempts+=1;counts.retrySerializedRows+=batch.length;
      if(batch.length<=1)throw new Error('native single row exceeds page budget');
      const middle=Math.floor(batch.length/2);
      if(performance.now()-sliceStart>=4)await pause();
      await encodeBatch(batch.slice(0,middle),false);await encodeBatch(batch.slice(middle),last);return;
    }
    frames.push(frame);frameBytes.push(n);
    if(performance.now()-sliceStart>=4)await pause();
  };
  // Batch bound scales proportionally (14 or56); actual UTF8 bytes remain authoritative.
  // Every oversized attempt is counted and only its smaller halves are retried.
  if(!changed.length)await encodeBatch([],true);
  for(let i=0;i<changed.length;i+=budget.rows)await encodeBatch(changed.slice(i,i+budget.rows),i+budget.rows>=changed.length);
  maxSyncSliceMs=Math.max(maxSyncSliceMs,performance.now()-sliceStart);
  return {projected,frames,frameBytes,next,counts:{...counts,projectedRows:rows.length,comparedRows:rows.length,yields},maxSyncSliceMs};
}
function verifyNative(cache,result,target,budget){
  const byId=new Map(cache.objs);let decoded=0;
  result.frames.forEach((frame,i)=>{
    const m=JSON.parse(frame),d=m.data;
    if(m.event!=='works.delta.page'||d.workId!==cache.workId||d.seq!==i||d.done!==(i===result.frames.length-1)||
      d.cursor!==(d.done?null:String(i+1).padStart(10,'0'))||d.resetOrder||d.remove.length||d.order.length||
      !frame.endsWith('\n')||Buffer.byteLength(frame)!==result.frameBytes[i]||result.frameBytes[i]>budget.bytes)throw new Error('native page invariant');
    d.upsert.forEach(row=>{byId.set(row.id,row);decoded+=1;});
  });
  if(decoded!==result.counts.changedRows||!isDeepStrictEqual(cache.ids.map(id=>byId.get(id)),JSON.parse(JSON.stringify(target.sessions))))throw new Error('native decoded mismatch');
  if(!isDeepStrictEqual({...JSON.parse(JSON.stringify(target)),sessions:cache.ids.map(id=>byId.get(id))},JSON.parse(JSON.stringify(target))))throw new Error('native full map mismatch');
  if([...result.next.objs.values()].some((row,i)=>row!==result.projected.sessions[i]))throw new Error('native retained-cache mismatch');
}
const summarize=samples=>Object.fromEntries(['processCpuMs','completionMs','maxSyncSliceMs','yields'].map(k=>[k,stat(samples.map(s=>s[k]))]));
const transport=result=>({frames:result.frames.length,maxFrameBytes:Math.max(...result.frameBytes),totalFrameBytes:result.frameBytes.reduce((n,b)=>n+b,0),...result.counts});
async function run(){
  const base=fixture(),baseline=project(base),baselineJson=JSON.stringify(baseline);
  const dense=structuredClone(base);dense.sessions.forEach((r,i)=>r.task=text(8900000+i,4096));
  const sparse=structuredClone(dense);sparse.sessions[0].task=text(9100000,4096);
  const targets={dense:project(dense),sparse:project(sparse)};
  const records=Object.fromEntries(BUDGETS.map(b=>[String(b.bytes),[]]));
  const histograms=Object.fromEntries(BUDGETS.map(b=>[String(b.bytes),Object.fromEntries(['dense','sparse'].map(k=>[k,createHistogram()]))]));
  const chain=async(budget,measured,pair)=>{
    const inputs={dense:structuredClone(dense),sparse:structuredClone(sparse)};
    let previous=objectCache(baseline.sessions,base.work.id);
    const sample={pair,budgetBytes:budget.bytes,batchRows:budget.rows};
    for(const kind of ['dense','sparse']){
      const cache=previous;
      const eld=monitorEventLoopDelay({resolution:1});
      if(measured){eld.enable();await new Promise(r=>setTimeout(r,5));eld.reset();}
      const c0=process.cpuUsage(),t0=performance.now();
      const result=await nativeArrayPages(cache,inputs[kind],budget);
      const completionMs=performance.now()-t0,used=process.cpuUsage(c0),processCpuMs=(used.user+used.system)/1000;
      if(measured){await new Promise(r=>setImmediate(r));await new Promise(r=>setTimeout(r,2));eld.disable();}
      previous=result.next;
      // Every produced frame is decoded after monitor stops; evolving dense cache is sparse baseline.
      verifyNative(cache,result,targets[kind],budget);
      if(result.counts.changedRows!==(kind==='dense'?3000:1))throw new Error('update row count');
      if(targets[kind].sessions.some(row=>row===cache.objs.get(row.id)))throw new Error('fresh target aliases baseline');
      const rankSamples=measured?Array.from({length:eld.count},(_,i)=>eld.percentile(100*(i+1)/eld.count)):[];
      if(measured)for(const ns of rankSamples)histograms[String(budget.bytes)][kind].record(Math.max(1,ns));
      sample[kind]={processCpuMs,completionMs,maxSyncSliceMs:result.maxSyncSliceMs,yields:result.counts.yields,transport:transport(result),eldRankSamplesNs:rankSamples,eldSamples:eld.count,
        activeLoopDelayMs:measured?{p50:round(eld.percentile(50)/1e6),p95:round(eld.percentile(95)/1e6),max:round(eld.max/1e6)}:null};
    }
    sample.total={processCpuMs:sample.dense.processCpuMs+sample.sparse.processCpuMs,completionMs:sample.dense.completionMs+sample.sparse.completionMs};
    if(measured)records[String(budget.bytes)].push(sample);
  };
  for(let i=0;i<2;i+=1)for(const budget of BUDGETS)await chain(budget,false,0);
  for(let pair=0;pair<8;pair+=1){
    const order=pair%2?[...BUDGETS].reverse():BUDGETS;
    for(const budget of order)await chain(budget,true,pair+1);
  }
  const results={};
  for(const budget of BUDGETS){
    const samples=records[String(budget.bytes)],summary={};
    for(const kind of ['dense','sparse']){
      const h=histograms[String(budget.bytes)][kind];
      summary[kind]={...summarize(samples.map(s=>s[kind])),activeLoopDelayMs:{samples:h.count,p50:round(h.percentile(50)/1e6),p95:round(h.percentile(95)/1e6),max:round(h.max/1e6)},
        transport:samples[0][kind].transport};
    }
    summary.total={processCpuMs:stat(samples.map(s=>s.total.processCpuMs)),completionMs:stat(samples.map(s=>s.total.completionMs))};
    results[String(budget.bytes)]={budgetBytes:budget.bytes,batchRows:budget.rows,summary,raw:samples};
  }
  // Force batch overflow in each budget; retries are restricted to this bounded batch and its halves.
  const retryFixtures={};
  for(const budget of BUDGETS){
    const source=structuredClone(base);source.sessions=source.sessions.slice(0,budget.rows);
    const sourceProjection=project(source),cache=objectCache(sourceProjection.sessions,base.work.id);
    source.sessions.forEach(r=>r.task='🌟"\n\\'.repeat(1800));
    const result=await nativeArrayPages(cache,source,budget);verifyNative(cache,result,project(source),budget);
    if(!result.counts.oversizedAttempts)throw new Error('retry fixture did not overflow');
    retryFixtures[String(budget.bytes)]={ok:true,...transport(result)};
  }
  if(JSON.stringify(baseline)!==baselineJson)throw new Error('baseline mutated');
  const report={kind:'One approved budget diagnostic: same native candidate 128vs512KiB, no production gate',generatedAt:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,platform:`${process.platform}-${process.arch}`,pairs:8,warmupPairs:2,yieldTargetMs:4,
    method:'Eight alternating paired dense→single-task-edit chains for two caps (128KiB/14rows,512KiB/56rows). Same deterministic1w/3000 fixture; fresh cloned identical dense/sparse inputs outside timing. Actual dense next-cache feeds sparse. Same native bounded-array/object-cache transport and4ms scheduler; only cap/batch bound change. CPU process.cpuUsage user+system, completion performance.now includes yields. Fresh1ms ELD monitor per operation,5ms prime/reset, operation+setImmediate+2ms drain then disable; exact decoded-output/bounds validation after timing. Empirical-rank HDR distributions pooled across8operations/kind/cap; raw ranks retained. Small n8 diagnostic (p95=max for operation timings), no fullmatrix/final gate. Different ELD window/result retention from final100sample128 run: compare caps within this paired run only. Projection/object-cache/native batch remain uninterruptible; no forcedGC/IPC/renderer/service measurement.',
    assertions:{everyOutputDecodedExact:true,evolvingDenseToSparseCache:true,freshClones:true,actualFrameBounds:true,sparseNotPadded:true},results,retryFixtures};
  await mkdir(path.dirname(outPath),{recursive:true});await writeFile(outPath,JSON.stringify(report,null,2)+'\n');process.stderr.write(`wrote ${outPath}\n`);
}
await run();
