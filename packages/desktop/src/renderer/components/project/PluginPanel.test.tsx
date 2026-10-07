import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {CapabilityPluginSummary,CapabilitySnapshot} from '@parley/protocol';
import {PluginPanel} from './PluginPanel.js';
import {useHostStore} from '../../store/host.js';
import {createFakeBridge,type FakeBridge} from '../../test-utils/fake-bridge.js';
const yes={allowed:true,reason:null} as const;const no={allowed:false,reason:'native-only'} as const;
const METHODS=['available','details','install','uninstall','enable','disable','addMarketplace'].map(name=>`capabilities.plugins.${name}`);
let bridge:FakeBridge;const composition={skills:null,agents:null,mcp:null,hooks:null,tokenEstimate:null};
const catalogEntry=(id='opaque-available'):CapabilityPluginSummary=>({id,provider:'claude',kind:'available',name:'Fixture',pluginId:'display@market',description:'Searchable safe description',scope:null,version:'1',enabled:null,composition,actions:{install:yes,uninstall:no,enable:no,disable:no,details:no}});
const snapshot=(revision=7,projectPath='/project'):CapabilitySnapshot=>({projectPath,revision,columns:{claude:{phase:'ready',diagnostics:[],pluginCatalog:yes,pluginMarketplaceAdd:{user:yes,project:yes,local:no}},codex:{phase:'partial',diagnostics:[],pluginCatalog:no,pluginMarketplaceAdd:{user:no,project:no,local:no}}},rows:[{id:'plugin',kind:'plugin',name:'Installed fixture',description:null,separateCopies:false,claude:[{id:'opaque-installed',scope:'project',source:null,documentPath:null,description:null,installed:true,enabled:null,status:'unknown',summary:null,modelAvailable:null,unavailableReason:null,pluginActions:{details:yes,uninstall:yes,enable:yes,disable:no}}],codex:[{id:'opaque-unverified',scope:null,source:null,documentPath:null,description:null,installed:true,enabled:null,status:'unknown',summary:null,modelAvailable:null,unavailableReason:null,pluginActions:{details:no,uninstall:no,enable:no,disable:no}}]}]});
const renderPresence=()=> <span>Safe presence metadata</span>;
const claude=()=>within(screen.getByRole('region',{name:'Claude Plugins'}));
beforeEach(()=>{bridge=createFakeBridge();useHostStore.setState({status:{state:'connected',hostVersion:'fixture',methods:METHODS},connections:1});bridge.setHandler('capabilities.plugins.available',p=>({revision:p.revision,provider:p.provider,phase:'ready',partial:false,reason:null,entries:[catalogEntry()]}));bridge.setHandler('capabilities.plugins.install',()=>({outcome:'ok',code:'ok'}));bridge.setHandler('capabilities.plugins.uninstall',()=>({outcome:'ok',code:'ok'}));bridge.setHandler('capabilities.plugins.enable',()=>({outcome:'ok',code:'ok'}));bridge.setHandler('capabilities.plugins.addMarketplace',()=>({outcome:'ok',code:'ok'}));});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function mount(value=snapshot()){return render(<PluginPanel snapshot={value} bridge={bridge} renderPresence={renderPresence} />);}
it('loads provider-qualified catalog only on request, preserves unknown composition and searches metadata',async()=>{
 mount();expect(bridge.calls).toHaveLength(0);fireEvent.click(claude().getByRole('button',{name:'Browse available plugins'}));await screen.findByText('Fixture · display@market');
 expect(bridge.calls[0]).toEqual({method:'capabilities.plugins.available',params:{projectPath:'/project',provider:'claude',revision:7}});expect(screen.getAllByText('Unknown')).toHaveLength(5);
 fireEvent.change(screen.getByRole('textbox',{name:'Search name or description'}),{target:{value:'safe description'}});expect(screen.getByRole('button',{name:'Install'})).toBeTruthy();
 fireEvent.change(screen.getByRole('textbox',{name:'Search name or description'}),{target:{value:'absent'}});expect(screen.queryByRole('button',{name:'Install'})).toBeNull();
});
it('requires explicit install scope and sends opaque ID rather than redacted plugin display name',async()=>{
 mount();fireEvent.click(claude().getByRole('button',{name:'Browse available plugins'}));await screen.findByText('Fixture · display@market');fireEvent.click(screen.getByRole('button',{name:'Install'}));
 expect(bridge.calls.some(c=>c.method==='capabilities.plugins.install')).toBe(false);expect(screen.getByRole('button',{name:'Install plugin'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(screen.getByLabelText('Native scope'),{target:{value:'local'}});fireEvent.click(screen.getByRole('button',{name:'Install plugin'}));await screen.findByText('Done');
 expect(bridge.calls.at(-1)).toEqual({method:'capabilities.plugins.install',params:{projectPath:'/project',provider:'claude',revision:7,catalogId:'opaque-available',scope:'local'}});expect(screen.getByText(/Restart affected sessions/)).toBeTruthy();expect(bridge.calls.some(c=>c.method.startsWith('sessions.'))).toBe(false);
});
it('uninstall warns about persistent data, cancellation does nothing and confirmation is literal true',async()=>{
 mount();fireEvent.click(claude().getByRole('button',{name:'Uninstall…'}));expect(screen.getByText(/permanently delete plugin data/)).toBeTruthy();expect(within(screen.getByRole('group',{name:'Uninstall plugin'})).getByText('Installed fixture')).toBeTruthy();expect(bridge.calls).toHaveLength(0);fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(bridge.calls).toHaveLength(0);
 fireEvent.click(claude().getByRole('button',{name:'Uninstall…'}));fireEvent.click(screen.getByRole('button',{name:'Uninstall plugin'}));await screen.findByText('Done');expect(bridge.calls[0]).toEqual({method:'capabilities.plugins.uninstall',params:{projectPath:'/project',provider:'claude',revision:7,presenceId:'opaque-installed',confirmDataLoss:true}});
});
it('unknown/Codex unsupported actions are disabled with a truthful native recovery route',()=>{
 mount();const codex=within(screen.getByRole('region',{name:'Codex Plugins'}));expect(codex.getAllByRole('button').every(b=>b.hasAttribute('disabled'))).toBe(true);expect(codex.getByText(/native Codex plugin interface/)).toBeTruthy();expect(claude().getByRole('button',{name:'Disable'}).hasAttribute('disabled')).toBe(true);expect(bridge.calls).toHaveLength(0);
});
it('keeps old-host actions unavailable without unsupported bridge calls',()=>{
 useHostStore.setState({status:{state:'connected',hostVersion:'old',methods:[]}});mount();expect(screen.getAllByText(/host does not support plugin actions/)).toHaveLength(2);expect(screen.getAllByRole('button').every(b=>b.hasAttribute('disabled'))).toBe(true);expect(bridge.calls).toHaveLength(0);
});
it('toggles only allowed opaque identities and suppresses raw exceptions',async()=>{
 bridge.setHandler('capabilities.plugins.enable',()=>{throw new Error('SECRET_RAW_EXCEPTION');});const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});mount();fireEvent.click(claude().getByRole('button',{name:'Enable'}));await screen.findByText('The native action failed');expect(bridge.calls[0]?.params).toEqual({projectPath:'/project',provider:'claude',revision:7,presenceId:'opaque-installed'});expect(document.body.textContent).not.toContain('SECRET');expect(warn).not.toHaveBeenCalled();
});
it('adds only an explicit local source with a supported selected scope',async()=>{
 mount();fireEvent.click(claude().getByRole('button',{name:'Add local marketplace'}));fireEvent.change(screen.getByLabelText('Local marketplace folder'),{target:{value:'/fixture/market path'}});fireEvent.change(screen.getByLabelText('Native scope'),{target:{value:'project'}});fireEvent.click(screen.getByRole('button',{name:'Add marketplace'}));await screen.findByText('Done');expect(bridge.calls[0]).toEqual({method:'capabilities.plugins.addMarketplace',params:{projectPath:'/project',provider:'claude',revision:7,scope:'project',source:{kind:'local',path:'/fixture/market path'}}});
});
it('safe details show nullable cost and never load unavailable installed details',async()=>{
 bridge.setHandler('capabilities.plugins.details',p=>({revision:p.revision,partial:false,reason:null,entry:{...catalogEntry('opaque-installed'),kind:'installed',scope:'project',actions:{install:no,uninstall:yes,details:yes,enable:no,disable:no},composition:{skills:2,agents:0,mcp:null,hooks:1,tokenEstimate:null}}}));mount();fireEvent.click(claude().getByRole('button',{name:'Details'}));const details=await screen.findByRole('region',{name:'Details'});expect(within(details).getAllByText('Unknown')).toHaveLength(2);expect(bridge.calls[0]?.params).toEqual({projectPath:'/project',provider:'claude',revision:7,target:{kind:'installed',presenceId:'opaque-installed'}});
});
it.each(['revision','project','connection'] as const)('ignores late catalog completion after %s changes',async kind=>{
 let resolve!:(v:unknown)=>void;bridge.setHandler('capabilities.plugins.available',()=>new Promise(r=>{resolve=r;}) as never);const view=mount();fireEvent.click(claude().getByRole('button',{name:'Browse available plugins'}));
 if(kind==='connection')await act(async()=>{useHostStore.setState({connections:2});});else view.rerender(<PluginPanel snapshot={snapshot(kind==='revision'?8:7,kind==='project'?'/other':'/project')} bridge={bridge} renderPresence={renderPresence} />);
 await act(async()=>{resolve({revision:7,provider:'claude',partial:false,reason:null,phase:'ready',entries:[catalogEntry()]});});expect(screen.queryByText('Fixture · display@market')).toBeNull();
});
it('clears uninstall confirmation on a newer inventory instead of rebinding it to the new revision',()=>{
 const view=mount();fireEvent.click(claude().getByRole('button',{name:'Uninstall…'}));view.rerender(<PluginPanel snapshot={snapshot(8)} bridge={bridge} renderPresence={renderPresence} />);expect(screen.queryByRole('button',{name:'Uninstall plugin'})).toBeNull();expect(bridge.calls).toHaveLength(0);
});
it('partial catalog never claims absence; malformed and foreign-provider responses are fixed safe errors',async()=>{
 bridge.setHandler('capabilities.plugins.available',p=>({revision:p.revision,provider:p.provider,phase:'ready',partial:true,reason:null,entries:[]}));mount();fireEvent.click(claude().getByRole('button',{name:'Browse available plugins'}));await screen.findByText(/plugin catalog is partial/);expect(screen.queryByText('No available plugins in this catalog.')).toBeNull();
 bridge.setHandler('capabilities.plugins.available',p=>({revision:p.revision,provider:'codex',phase:'ready',partial:false,reason:null,entries:[]}));fireEvent.click(claude().getByRole('button',{name:'Browse available plugins'}));await screen.findByText('The native response could not be verified');
});
it('keeps active requests disabled and ignores action completion after unmount',async()=>{
 let resolve!:(v:unknown)=>void;bridge.setHandler('capabilities.plugins.enable',()=>new Promise(r=>{resolve=r;}) as never);const view=mount();fireEvent.click(claude().getByRole('button',{name:'Enable'}));await screen.findByText(/Waiting for the native plugin action/);expect(claude().getAllByRole('button').every(b=>b.hasAttribute('disabled'))).toBe(true);view.unmount();await act(async()=>{resolve({outcome:'ok',code:'ok'});});expect(screen.queryByText('Done')).toBeNull();
});
it('supported Codex catalog offers user-only installation without details or toggle support',async()=>{
 const value=snapshot();value.columns.codex.pluginCatalog=yes;
 bridge.setHandler('capabilities.plugins.available',p=>({revision:p.revision,provider:p.provider,phase:'ready',partial:false,reason:null,entries:[{...catalogEntry(),provider:'codex'}]}));mount(value);
 fireEvent.click(within(screen.getByRole('region',{name:'Codex Plugins'})).getByRole('button',{name:'Browse available plugins'}));await screen.findByText('Fixture · display@market');fireEvent.click(screen.getByRole('button',{name:'Install'}));
 expect((screen.getByRole('option',{name:'Project'}) as HTMLOptionElement).disabled).toBe(true);expect((screen.getByRole('option',{name:'Local'}) as HTMLOptionElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('Native scope'),{target:{value:'user'}});fireEvent.click(screen.getByRole('button',{name:'Install plugin'}));await screen.findByText('Done');expect(bridge.calls.at(-1)?.params).toEqual({projectPath:'/project',provider:'codex',revision:7,catalogId:'opaque-available',scope:'user'});
});
it('ignores a late details reply after a newer snapshot instead of displaying the wrong cost',async()=>{
 let resolve!:(v:unknown)=>void;bridge.setHandler('capabilities.plugins.details',()=>new Promise(r=>{resolve=r;}) as never);const view=mount();fireEvent.click(claude().getByRole('button',{name:'Details'}));view.rerender(<PluginPanel snapshot={snapshot(8)} bridge={bridge} renderPresence={renderPresence} />);
 await act(async()=>{resolve({revision:7,partial:false,reason:null,entry:{...catalogEntry('opaque-installed'),kind:'installed',scope:'project',actions:{install:no,uninstall:yes,enable:no,disable:no,details:yes},composition:{skills:99,agents:99,mcp:99,hooks:99,tokenEstimate:99999}}});});expect(screen.queryByRole('region',{name:'Details'})).toBeNull();expect(screen.queryByText('99999')).toBeNull();
});
it('Refresh preserves the adoption notice without inventing a running-session count',async()=>{
 const view=mount();fireEvent.click(claude().getByRole('button',{name:'Enable'}));await screen.findByText('Done');view.rerender(<PluginPanel snapshot={snapshot(8)} bridge={bridge} renderPresence={renderPresence} />);
 expect(screen.getByText('Applies to new sessions. Restart affected sessions to pick up changes.')).toBeTruthy();expect(document.body.textContent).not.toContain('0 sessions');expect(bridge.calls.some(c=>c.method.startsWith('sessions.'))).toBe(false);
});
