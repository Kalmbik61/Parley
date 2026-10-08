import { afterEach, expect, it, vi } from 'vitest';
import type { WorkEntry } from '@parley/core';
import type { WorksService } from '../works/works-service.js';
import { createHistoryService } from './history-service.js';
import type { HistoryServiceIO } from './history-service.js';
const entry = (): WorkEntry => ({projectPath:'/project',map:{schemaVersion:2,work:{id:'w-01',title:'Human work',goal:'',status:'active',createdAt:'2026-10-04',updatedAt:'2026-10-04'},sessions:[],rooms:[{id:'r-01',title:'Human room',creator:'human',members:[],lead:null,mode:'free',createdAt:'2026-10-04',proposal:null}],messages:[]}});
function fixture(value = entry()) {
 let entries = [value]; let listener = ():void=>{};
 const works: Pick<WorksService,'snapshot'|'entry'|'onChange'> = {
  snapshot:()=>({entries,branches:{}}), entry:()=>entries[0],
  onChange: fn=>{listener=()=>fn(works.snapshot(),works.snapshot());return ()=>{listener=()=>{};};},
 };
 const io: HistoryServiceIO = {
  rebuild:vi.fn(async ()=>({sharedAt:null,diagnostics:[]})),
  remove:vi.fn(async (_p,_w,ids)=>({removed:ids.length,failed:[]})), deleted:vi.fn(async()=>true),
 };
 const failure=vi.fn();const service=createHistoryService(works,{io,debounceMs:100,onFailure:failure});
 return {service,io,failure,changed:()=>listener(),gone:()=>{entries=[];listener();},back:()=>{entries=[value];listener();}};
}
afterEach(()=>vi.useRealTimers());
it('derivative updates debounce source changes and never rewrite an unchanged source', async()=>{
 vi.useFakeTimers();const value=entry(),f=fixture(value);f.service.start();f.changed();f.changed();
 await vi.advanceTimersByTimeAsync(100);expect(f.io.rebuild).toHaveBeenCalledTimes(1);
 f.changed();await vi.advanceTimersByTimeAsync(1000);expect(f.io.rebuild).toHaveBeenCalledTimes(1);
 value.map.rooms[0]!.title='New title';f.changed();await vi.advanceTimersByTimeAsync(100);expect(f.io.rebuild).toHaveBeenCalledTimes(2);f.service.stop();
});
it('no-room single-session work starts no history task or timer',async()=>{
 vi.useFakeTimers();const value=entry();value.map.rooms=[];const f=fixture(value);f.service.start();f.changed();
 await vi.advanceTimersByTimeAsync(1000);expect(f.io.rebuild).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);f.service.stop();
});
it('deleted source cleanup passes captured IDs; a corrupt or untracked existing map is never deletion',async()=>{
 vi.useFakeTimers();const f=fixture();f.service.start();await vi.advanceTimersByTimeAsync(100);
 vi.mocked(f.io.deleted).mockResolvedValue(false);f.gone();await vi.advanceTimersByTimeAsync(100);expect(f.io.remove).not.toHaveBeenCalled();
 vi.mocked(f.io.deleted).mockResolvedValue(true);await f.service.removeWork('/project','w-01',['r-01','r-01']);expect(f.io.remove).toHaveBeenCalledWith('/project','w-01',['r-01']);f.service.stop();
});
it('reappearing entry during deletion proof cancels removal',async()=>{
 const f=fixture();f.gone();vi.mocked(f.io.deleted).mockImplementation(async()=>{f.back();return true;});
 await f.service.removeWork('/project','w-01',['r-01']);expect(f.io.remove).not.toHaveBeenCalled();f.service.stop();
});
it('work disappears before debounce, or stop occurs, so no late rebuild is dispatched',async()=>{
 vi.useFakeTimers();const f=fixture();f.service.start();f.gone();await vi.advanceTimersByTimeAsync(100);expect(f.io.rebuild).not.toHaveBeenCalled();expect(f.io.remove).toHaveBeenCalledOnce();
 const next=fixture();next.service.start();next.service.stop();await vi.advanceTimersByTimeAsync(1000);expect(next.io.rebuild).not.toHaveBeenCalled();f.service.stop();
});
it('foreign-file/resource failures are retained and reported only as deduplicated safe counts',async()=>{
 vi.useFakeTimers();const value=entry(),f=fixture(value);vi.mocked(f.io.rebuild).mockRejectedValue(new Error('secret raw native output'));
 f.service.start();await vi.advanceTimersByTimeAsync(100);value.map.rooms[0]!.title='Another';f.changed();await vi.advanceTimersByTimeAsync(100);
 expect(f.failure).toHaveBeenCalledOnce();expect(f.failure).toHaveBeenCalledWith({projectPath:'/project',workId:'w-01',count:1});f.service.stop();
});


it('fresh deletion room IDs survive a stale no-room cache until watcher convergence', async () => {
  vi.useFakeTimers(); const value = entry(); value.map.rooms = []; const f = fixture(value);
  f.service.start();
  await f.service.removeWork('/project', 'w-01', ['r-01']);
  expect(f.io.remove).not.toHaveBeenCalled();
  f.gone(); await vi.advanceTimersByTimeAsync(100);
  expect(f.io.remove).toHaveBeenCalledWith('/project', 'w-01', ['r-01']); f.service.stop();
});

it('deferred captured cleanup still refuses corrupt or restored source and rejects unbounded IDs', async () => {
  vi.useFakeTimers(); const value = entry(); value.map.rooms = []; const f = fixture(value); f.service.start();
  await f.service.removeWork('/project', 'w-01', ['r-01']);
  vi.mocked(f.io.deleted).mockResolvedValue(false); f.gone(); await vi.advanceTimersByTimeAsync(100);
  expect(f.io.remove).not.toHaveBeenCalled();
  f.back(); await f.service.removeWork('/project', 'w-01', ['r-01']);
  expect(f.io.remove).not.toHaveBeenCalled();
  await expect(f.service.removeWork('/project', 'w-01', Array(30001).fill('r-01'))).rejects.toThrow('invalid history room IDs');
  f.service.stop();
});
