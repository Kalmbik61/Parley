#!/usr/bin/env node
// M4 dense-case stage diagnosis only. No service, database, provider calls, or production changes.
// node tools/bench/window-snapshot-diagnose-bench.mjs [--sparse-control | --test-hypothesis [--evolving-control]] [--out file]
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { addSession } from '../../packages/core/dist/work/map.js';
import { mailWorkMap } from '../../packages/core/dist/work/context-pages.js';
import { mapLetterReader } from '../../packages/core/dist/work/letter-store.js';
import { encodeLine } from '../../packages/protocol/dist/index.js';
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = path.resolve(outIdx < 0 ? `docs/research/data/window-snapshot-${args.includes('--test-hypothesis') ? 'hypothesis' : 'diagnose'}-m4.json` : args[outIdx + 1]);
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

// Retained byte counts describe UTF-8 encoded row payloads, not V8 object/Map overhead.
function makeCache(rows, workId = 'w') {
  const ids = [], objs = new Map(), enc = new Map(), bytes = new Map();
  let encodedBytes = 0;
  for (const row of rows) {
    const json = JSON.stringify(row), n = Buffer.byteLength(json);
    ids.push(row.id); objs.set(row.id, row); enc.set(row.id, json); bytes.set(row.id, n);
    encodedBytes += n;
  }
  return { workId, ids, objs, enc, bytes, encodedBytes };
}

async function pagedDeltaOf(cache, rows, yieldMs = 0, startedAt = performance.now()) {
  const counts = { projectedRows: rows.length, compared: 0, encodedRows: 0, reusedRows: 0, yields: 0 };
  const next = { workId: cache.workId, ids: [], objs: new Map(), enc: new Map(), bytes: new Map(), encodedBytes: 0 };
  const tokens = [];
  let sliceStart = startedAt, maxSliceMs = 0;
  const pause = async () => {
    maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceStart);
    counts.yields += 1;
    await new Promise(r => setImmediate(r));
    sliceStart = performance.now();
  };
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i], prev = cache.objs.get(row.id);
    let json, n;
    if (prev !== undefined) {
      counts.compared += 1;
      if (isDeepStrictEqual(prev, row)) {
        json = cache.enc.get(row.id); n = cache.bytes.get(row.id); counts.reusedRows += 1;
      }
    }
    if (json === undefined) {
      json = JSON.stringify(row); n = Buffer.byteLength(json); counts.encodedRows += 1;
      tokens.push({ kind: 'upsert', json, bytes: n });
    }
    next.ids.push(row.id); next.objs.set(row.id, row); next.enc.set(row.id, json);
    next.bytes.set(row.id, n); next.encodedBytes += n;
    if (yieldMs > 0 && i % 16 === 15 && performance.now() - sliceStart >= yieldMs) await pause();
  }
  const sameOrder = next.ids.length === cache.ids.length && next.ids.every((id, i) => id === cache.ids[i]);
  for (const id of cache.ids) if (!next.objs.has(id)) {
    const json = JSON.stringify(id); tokens.push({ kind: 'remove', json, bytes: Buffer.byteLength(json) });
  }
  if (!sameOrder) for (const id of next.ids) {
    const json = JSON.stringify(id); tokens.push({ kind: 'order', json, bytes: Buffer.byteLength(json) });
  }
  const frames = [], frameBytes = [];
  let seq = 0, groups = { upsert: [], remove: [], order: [] };
  const prefix = done => JSON.stringify({ event: 'works.delta.page', data: {
    revision: 2, workId: cache.workId, version: 2, seq,
    cursor: done ? null : String(seq + 1).padStart(10, '0'), done,
    resetOrder: !sameOrder && seq === 0,
  } }).slice(0, -2);
  const suffix = () => ',"upsert":[' + groups.upsert.join(',') + '],"remove":[' +
    groups.remove.join(',') + '],"order":[' + groups.order.join(',') + ']}}\n';
  const emptySuffixBytes = Buffer.byteLength(',"upsert":[],"remove":[],"order":[]}}\n');
  let size = Buffer.byteLength(prefix(false)) + emptySuffixBytes;
  const flush = done => {
    const frame = prefix(done) + suffix();
    const n = Buffer.byteLength(frame); // Actual final frame, including all escaping and trailing newline.
    if (n > PAGE) throw new Error(`frame ${seq} over budget: ${n}`);
    frames.push(frame); frameBytes.push(n); seq += 1;
    groups = { upsert: [], remove: [], order: [] };
    size = Buffer.byteLength(prefix(false)) + emptySuffixBytes;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    let extra = token.bytes + (groups[token.kind].length ? 1 : 0);
    if (size + extra > PAGE) {
      if (Object.values(groups).every(a => a.length === 0)) throw new Error('single token exceeds page budget');
      flush(false); extra = token.bytes;
      if (size + extra > PAGE) throw new Error('single token exceeds page budget');
    }
    groups[token.kind].push(token.json); size += extra;
    if (yieldMs > 0 && i % 16 === 15 && performance.now() - sliceStart >= yieldMs) await pause();
  }
  flush(true);
  maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceStart);
  return { frames, frameBytes, next, counts, maxSliceMs };
}

function verifyPages(cache, result, targetRows) {
  const byId = new Map(cache.objs), ordered = [];
  let resetOrder = false, decodedRows = 0;
  result.frames.forEach((frame, seq) => {
    const message = JSON.parse(frame), d = message.data;
    if (message.event !== 'works.delta.page' || d.workId !== cache.workId || d.seq !== seq ||
        d.done !== (seq === result.frames.length - 1) ||
        d.cursor !== (d.done ? null : String(seq + 1).padStart(10, '0')) ||
        Buffer.byteLength(frame) !== result.frameBytes[seq] || !frame.endsWith('\n') ||
        result.frameBytes[seq] > PAGE) throw new Error('page framing/byte/sequence/cursor invariant failed');
    if (d.resetOrder) { if (seq !== 0) throw new Error('late order reset'); resetOrder = true; }
    for (const row of d.upsert) { byId.set(row.id, row); decodedRows += 1; }
    for (const id of d.remove) byId.delete(id);
    ordered.push(...d.order);
  });
  const ids = resetOrder ? ordered : cache.ids.filter(id => byId.has(id));
  const rebuilt = ids.map(id => byId.get(id));
  if (!isDeepStrictEqual(rebuilt, JSON.parse(JSON.stringify(targetRows)))) throw new Error('decoded pages do not reproduce target');
  if (decodedRows !== result.counts.encodedRows) throw new Error('dropped/duplicated rows');
  if (result.next.ids.some(id => result.next.enc.get(id) !== JSON.stringify(result.next.objs.get(id)))) throw new Error('next cache encoding mismatch');
  if (result.next.encodedBytes !== [...result.next.enc.values()].reduce((n, json) => n + Buffer.byteLength(json), 0)) throw new Error('cache byte count mismatch');
  return rebuilt;
}

function phase(stages, name, fn) {
  const cpu = process.cpuUsage(), start = performance.now();
  const value = fn();
  const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
  stages[name] = { elapsedMs, processCpuMs: (used.user + used.system) / 1000 };
  return value;
}

function stagedDense(cache, input) {
  const stages = {};
  const projected = phase(stages, 'projection', () => project(input));
  const rows = projected.sessions;
  const changed = phase(stages, 'comparison', () => rows.map(row => !isDeepStrictEqual(cache.objs.get(row.id), row)));
  const strings = phase(stages, 'rowStringify', () => rows.map((row, i) => changed[i] ? JSON.stringify(row) : cache.enc.get(row.id)));
  const lengths = phase(stages, 'rowByteCounts', () => strings.map((json, i) => changed[i] ? Buffer.byteLength(json) : cache.bytes.get(rows[i].id)));
  const { next, tokens } = phase(stages, 'nextCacheAndTokens', () => {
    const next = { workId: cache.workId, ids: [], objs: new Map(), enc: new Map(), bytes: new Map(), encodedBytes: 0 };
    const tokens = [];
    rows.forEach((row, i) => {
      next.ids.push(row.id); next.objs.set(row.id, row); next.enc.set(row.id, strings[i]);
      next.bytes.set(row.id, lengths[i]); next.encodedBytes += lengths[i];
      if (changed[i]) tokens.push({ json: strings[i], bytes: lengths[i] });
    });
    if (!isDeepStrictEqual(next.ids, cache.ids)) throw new Error('diagnosis is dense same-id/order only');
    return { next, tokens };
  });
  const frames = phase(stages, 'packingAndConcatenation', () => {
    const frames = [];
    let seq = 0, jsons = [];
    const prefix = done => JSON.stringify({event:'works.delta.page',data:{revision:2,workId:cache.workId,version:2,seq,
      cursor:done?null:String(seq+1).padStart(10,'0'),done,resetOrder:false}}).slice(0,-2);
    const suffix = () => ',"upsert":[' + jsons.join(',') + '],"remove":[],"order":[]}}\n';
    const emptyBytes = Buffer.byteLength(',"upsert":[],"remove":[],"order":[]}}\n');
    let bytes = Buffer.byteLength(prefix(false)) + emptyBytes;
    const flush = done => {
      frames.push(prefix(done)+suffix());seq+=1;jsons=[];
      bytes=Buffer.byteLength(prefix(false))+emptyBytes;
    };
    for(const token of tokens){
      let extra=token.bytes+(jsons.length?1:0);
      if(bytes+extra>PAGE){if(!jsons.length)throw new Error('oversized diagnostic row');flush(false);extra=token.bytes;}
      if(bytes+extra>PAGE)throw new Error('oversized diagnostic row');
      jsons.push(token.json);bytes+=extra;
    }
    flush(true);return frames;
  });
  const frameBytes = phase(stages, 'finalFrameByteValidation', () => frames.map(frame => {
    const n=Buffer.byteLength(frame);if(n>PAGE)throw new Error('diagnostic frame over bound');return n;
  }));
  return { frames, frameBytes, next, counts:{ encodedRows:changed.filter(Boolean).length }, projected, stages };
}
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
async function timed(fn) {
  const cpu=process.cpuUsage(),start=performance.now();
  const result=await fn();
  const elapsedMs=performance.now()-start,used=process.cpuUsage(cpu);
  return {result,elapsedMs,processCpuMs:(used.user+used.system)/1000};
}
const metric = samples => ({elapsedMs:stat(samples.map(s=>s.elapsedMs)),processCpuMs:stat(samples.map(s=>s.processCpuMs))});
const counters = r => ({frames:r.frames.length,maxFrameBytes:Math.max(...r.frameBytes),totalFrameBytes:r.frameBytes.reduce((n,b)=>n+b,0),encodedRows:r.counts.encodedRows});
async function diagnose() {
  const base=fixture();
  const dense=structuredClone(base);dense.sessions.forEach((r,i)=>r.task=text(8900000+i,4096));
  const sparseControl=args.includes('--sparse-control');
  const baseline=project(sparseControl?dense:base),cache=makeCache(baseline.sessions,base.work.id);
  if(sparseControl)dense.sessions[0].task=text(9100000,4096);
  const samples=8,warmup=2,records={original:[],staged:[]};
  for(let i=0;i<warmup;i+=1){
    const a=structuredClone(dense);await pagedDeltaOf(cache,project(a).sessions);
    const b=structuredClone(dense);stagedDense(cache,b);
  }
  for(let i=0;i<samples;i+=1){
    for(const name of i%2?['staged','original']:['original','staged']){
      const input=structuredClone(dense);
      const run=await timed(()=>name==='original'?pagedDeltaOf(cache,project(input).sessions):stagedDense(cache,input));
      const target=project(dense);
      if(run.result.counts.encodedRows!==(sparseControl?1:3000))throw new Error('diagnostic change count');
      verifyPages(cache,run.result,target.sessions);
      if(!isDeepStrictEqual({...JSON.parse(JSON.stringify(baseline)),sessions:verifyPages(cache,run.result,target.sessions)},JSON.parse(JSON.stringify(target))))throw new Error('full map mismatch');
      records[name].push({elapsedMs:run.elapsedMs,processCpuMs:run.processCpuMs,...counters(run.result),...(name==='staged'?{stages:run.result.stages}:{})});
      await new Promise(r=>setImmediate(r));
    }
  }
  const stageNames=Object.keys(records.staged[0].stages);
  const stages=Object.fromEntries(stageNames.map(name=>[name,metric(records.staged.map(r=>r.stages[name]))]));
  const report={kind:`M4 diagnosis only, 1w/3000 ${sparseControl?'single-edit sparse control':'allChanged'}; no final performance claim`,sparseControl,generatedAt:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,samples,warmup,
    method:'Eight alternating original-M3/staged pairs, two warmups; fresh cloned selected dense/sparse inputs outside timing. CPU=process.cpuUsage user+system, elapsed=performance.now. Seven batched phase probes avoid per-row timer calls but split the original interleaved row loop into passes and move final byte validation after packing. Additional arrays, changed allocation/GC/layout and 7x CPU/timer probes perturb totals; difference is not a pure instrumentation-overhead estimate. No ELD measurement; this small diagnostic locates stage cost only. Projection/compare/encoding/cache/frames all included; correctness outside timing.',
    original:metric(records.original),staged:metric(records.staged),stages,raw:records};
  await mkdir(path.dirname(outPath),{recursive:true});await writeFile(outPath,JSON.stringify(report,null,2)+'\n');
  process.stderr.write(`wrote ${outPath}\n`);
}
// One evidence-supported alternative: native array pages, projected objects retained,
// per-row strings not eagerly materialized. Same-id/order diagnosis only.
function objectCache(rows, workId) {
  return {workId,ids:rows.map(r=>r.id),objs:new Map(rows.map(r=>[r.id,r]))};
}
function nativeArrayPages(cache, input) {
  const projected=project(input),rows=projected.sessions;
  const changed=rows.filter(row=>!isDeepStrictEqual(cache.objs.get(row.id),row));
  const next=objectCache(rows,cache.workId);
  if(!isDeepStrictEqual(next.ids,cache.ids))throw new Error('M4 alternative restricted to same ids/order');
  const frames=[],frameBytes=[];
  const counts={changedRows:changed.length,rowSerializationOccurrences:0,pageEncodeAttempts:0,oversizedAttempts:0,retrySerializedRows:0,retainedPerRowEncodedBytes:0};
  const encodeBatch=(batch,last)=>{
    const seq=frames.length;
    counts.pageEncodeAttempts+=1;counts.rowSerializationOccurrences+=batch.length;
    const frame=encodeLine({event:'works.delta.page',data:{revision:2,workId:cache.workId,version:2,seq,
      cursor:last?null:String(seq+1).padStart(10,'0'),done:last,resetOrder:false,upsert:batch,remove:[],order:[]}});
    const n=Buffer.byteLength(frame);
    if(n>PAGE){
      counts.oversizedAttempts+=1;counts.retrySerializedRows+=batch.length;
      if(batch.length<=1)throw new Error('native single row exceeds page budget');
      const middle=Math.floor(batch.length/2);
      encodeBatch(batch.slice(0,middle),false);encodeBatch(batch.slice(middle),last);return;
    }
    frames.push(frame);frameBytes.push(n);
  };
  // 14 is the observed M3 page capacity of this fixed 4KiB+4KiB fixture,
  // not a trusted byte bound. Every actual frame is checked; overflow splits/re-encodes.
  if(!changed.length)encodeBatch([],true);
  for(let i=0;i<changed.length;i+=14)encodeBatch(changed.slice(i,i+14),i+14>=changed.length);
  return {projected,frames,frameBytes,next,counts};
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
async function testHypothesis(){
  const base=fixture(),baseProjection=project(base);
  const rowCache=makeCache(baseProjection.sessions,base.work.id);
  const objCache=objectCache(baseProjection.sessions,base.work.id);
  const dense=structuredClone(base);dense.sessions.forEach((r,i)=>r.task=text(8900000+i,4096));
  const sparse=structuredClone(dense);sparse.sessions[0].task=text(9100000,4096);
  const operationKinds=args.includes('--evolving-control')?['dense','none','sparse']:['dense','sparse'];
  const inputMaps={dense,none:dense,sparse};
  const targets=Object.fromEntries(operationKinds.map(kind=>[kind,project(inputMaps[kind])]));
  const variants=['m3','nativeArray','fullReference'],records=Object.fromEntries(variants.map(k=>[k,[]]));
  const countsOf=(name,result)=>name==='nativeArray'?{...result.counts,frames:result.frames.length,maxFrameBytes:Math.max(...result.frameBytes),totalFrameBytes:result.frameBytes.reduce((n,b)=>n+b,0)}:
    name==='m3'?{...counters(result),rowSerializationOccurrences:result.counts.encodedRows,retainedPerRowEncodedBytes:result.next.encodedBytes}:
      {frames:1,maxFrameBytes:result.bytes,totalFrameBytes:result.bytes,rowSerializationOccurrences:6000};
  const chain=async(name,record)=>{
    // All clones prepared before timing; each actual next-cache feeds the next operation.
    const inputs=Object.fromEntries(operationKinds.map(kind=>[kind,structuredClone(inputMaps[kind])]));
    let previous=name==='m3'?rowCache:objCache;
    const summary={};
    for(const kind of operationKinds){
      const baseline=previous;
      const run=await timed(()=>name==='m3'?pagedDeltaOf(baseline,project(inputs[kind]).sessions):name==='nativeArray'?nativeArrayPages(baseline,inputs[kind]):fullReference(inputs[kind]));
      if(name==='m3'){
        const rebuilt=verifyPages(baseline,run.result,targets[kind].sessions);
        if(!isDeepStrictEqual({...JSON.parse(JSON.stringify(targets[kind])),sessions:rebuilt},JSON.parse(JSON.stringify(targets[kind]))))throw new Error('M3 full map mismatch');
        if(run.result.counts.encodedRows!==(kind==='dense'?3000:kind==='none'?0:1))throw new Error('M3 change count');
        previous=run.result.next;
      }else if(name==='nativeArray'){
        verifyNative(baseline,run.result,targets[kind]);
        if(run.result.counts.changedRows!==(kind==='dense'?3000:kind==='none'?0:1))throw new Error('native change count');
        previous=run.result.next;
      }else if(!isDeepStrictEqual(JSON.parse(run.result.frame).data.entries[0].map,JSON.parse(JSON.stringify(targets[kind]))))throw new Error('reference map mismatch');
      summary[kind]={elapsedMs:run.elapsedMs,processCpuMs:run.processCpuMs,...countsOf(name,run.result)};
    }
    summary.total=Object.fromEntries(['elapsedMs','processCpuMs'].map(metric=>[metric,operationKinds.reduce((n,kind)=>n+summary[kind][metric],0)]));
    if(record)records[name].push(summary);
  };
  for(let i=0;i<2;i+=1)for(const name of variants)await chain(name,false);
  for(let i=0;i<8;i+=1){for(const name of i%2?[...variants].reverse():variants)await chain(name,true);await new Promise(r=>setImmediate(r));}
  // Force retry/split with multibyte escaped text; count rejected encodes too.
  const from=Array.from({length:14},(_,i)=>({id:`s-${i}`,task:'baseline'}));
  const largeRows=from.map(r=>({...r,task:'🌟"\n\\'.repeat(1800)}));
  const fake=rows=>({schemaVersion:2,work:{id:'w-retry',title:'x',goal:'',status:'active',createdAt:AT4,updatedAt:AT4},sessions:rows.map(r=>({...base.sessions[0],...r})),rooms:[],messages:[]});
  const retryBase=project(fake(from)),retryTarget=project(fake(largeRows)),retryCache=objectCache(retryBase.sessions,'w-retry');
  const retry=nativeArrayPages(retryCache,fake(largeRows));verifyNative(retryCache,retry,retryTarget);
  if(!retry.counts.oversizedAttempts||retry.counts.rowSerializationOccurrences<=14)throw new Error('retry fixture did not retry');
  let oversizedRejected=false;
  // Text fields are capped by the actual projection. Use many short context ids
  // and preserve ids/order to exercise the page limit rather than the scope guard.
  const huge=fake([{...from[0],contextFrom:Array.from({length:25000},()=> 'long-id')}]);
  try{nativeArrayPages(objectCache(retryBase.sessions.slice(0,1),'w-retry'),huge);}
  catch(e){if(!String(e).includes('native single row exceeds page budget'))throw e;oversizedRejected=true;}
  if(!oversizedRejected)throw new Error('oversized native row not rejected');
  const summary=Object.fromEntries(variants.map(name=>[name,Object.fromEntries([...operationKinds,'total'].map(kind=>[kind,metric(records[name].map(r=>r[kind]))]))]));
  const report={kind:'M4 single dominant-hypothesis test; diagnostic, not final performance gate',generatedAt:new Date().toISOString(),node:process.version,samples:8,warmup:2,operationKinds,
    hypothesis:'Per-row JSON.stringify dominates; bounded native-array pages (14-row maximum, exact-byte check and recursive retry/split) with retained projected-object cache avoid eager per-row JSON cache. Actual next-cache feeds every subsequent operation in operationKinds, including nochange when selected. Per-row encodings remain unmaterialized because this delta path needs only changed objects; sparse re-encodes only its changed row. This does not measure full resync, cold snapshot, removals/order, other entities or later consumers needing per-row strings.',
    method:'Eight alternating forward/reverse chains across M3/native-array/full-reference, 2warmups, fresh cloned inputs for every operation prepared outside timing; every next-cache is the next operation baseline, including nochange when selected. CPU process.cpuUsage and elapsed performance.now measured separately per update, summed without correctness/clone waits. Exact decode/bounds/cache/count checks outside timing for every measured/warmup chain. No ELD; not a replacement for full paired gate. Full reference unbounded frame is hypothetical as in M1/M3.',
    summary,raw:records,fixtures:{retrySplit:{ok:true,...countsOf('nativeArray',retry)},oversizedRowRejected:{ok:oversizedRejected}}};
  await mkdir(path.dirname(outPath),{recursive:true});
  await writeFile(outPath,JSON.stringify(report,null,2)+'\n');process.stderr.write(`wrote ${outPath}\n`);
}

if(args.includes('--test-hypothesis')) await testHypothesis();
else await diagnose();
