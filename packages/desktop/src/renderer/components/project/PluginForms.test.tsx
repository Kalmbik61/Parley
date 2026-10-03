import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {PluginComposition,PluginScopeForm} from './PluginForms.js';
const yes={allowed:true,reason:null} as const;const no={allowed:false,reason:'unverified'} as const;
afterEach(cleanup);
it('keeps unknown composition and estimated token cost distinct from zero',()=>{
 render(<PluginComposition composition={{skills:0,agents:null,mcp:null,hooks:2,tokenEstimate:null}} />);
 expect(screen.getByText('0')).toBeTruthy();expect(screen.getAllByText('Unknown')).toHaveLength(3);expect(screen.getByText('Always-on tokens (estimate)')).toBeTruthy();
});
it('requires a chosen human scope and passes a literal local path only on submit',()=>{
 const submit=vi.fn(async()=>{});render(<PluginScopeForm provider="claude" entry={null} scopes={{user:yes,project:yes,local:no}} busy={false} submit={submit} onCancel={vi.fn()} />);
 expect(screen.getByRole('button',{name:'Add marketplace'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(screen.getByLabelText('Local marketplace folder'),{target:{value:'/fixture/market with spaces'}});expect(submit).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('Native scope'),{target:{value:'project'}});fireEvent.click(screen.getByRole('button',{name:'Add marketplace'}));expect(submit).toHaveBeenCalledWith('project','/fixture/market with spaces');
});
it('disables unsupported Codex scopes even if an unsafe caller proposes them and rejects malformed paths',()=>{
 const submit=vi.fn(async()=>{});render(<PluginScopeForm provider="codex" entry={null} scopes={{user:yes,project:yes,local:yes}} busy={false} submit={submit} onCancel={vi.fn()} />);
 expect((screen.getByRole('option',{name:'Project'}) as HTMLOptionElement).disabled).toBe(true);expect((screen.getByRole('option',{name:'Local'}) as HTMLOptionElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('Native scope'),{target:{value:'user'}});fireEvent.change(screen.getByLabelText('Local marketplace folder'),{target:{value:'\ud800'}});fireEvent.submit(screen.getByRole('form'));
 expect(submit).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toBeTruthy();
});
