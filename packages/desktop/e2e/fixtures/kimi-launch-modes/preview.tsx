import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { KIMI_LAUNCH_MODES_FEATURE, type KimiConfigOption } from '@parley/protocol';
import type { ParleyBridge } from '../../../src/shared/bridge.js';
import { KimiConfigMenu } from '../../../src/renderer/chat/KimiConfigMenu.js';
import { AgentRowsEditor, type AgentRowsEditorProps } from '../../../src/renderer/components/dialogs/AgentRowsEditor.js';
import { blankRow, type ProviderOption } from '../../../src/renderer/components/dialogs/agent-rows.js';
import { useHostStore } from '../../../src/renderer/store/host.js';
import { TooltipProvider } from '../../../src/renderer/ui/tooltip.js';
import './preview.css';

const ref = { projectPath: '/fixture', workId: 'w-0001', sessionId: 's-01' };
const kimi: ProviderOption = {
  id: 'kimi', label: 'Kimi Code', available: true, needs: null, version: '2.7.3', effort: true,
  models: [{ id: 'kimi-for-coding', label: 'Kimi for Coding', efforts: [{ id: 'high', label: 'High' }] }],
};
let config: KimiConfigOption[] = [
  { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'kimi-for-coding',
    options: [{ value: 'kimi-for-coding', name: 'Kimi for Coding' }] },
  { id: 'mode', category: 'mode', name: 'Mode', type: 'select', currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' }, { value: 'yolo', name: 'Yolo' },
      { value: 'auto', name: 'Auto' }, { value: 'plan', name: 'Plan' },
    ] },
];
useHostStore.setState({
  status: { state: 'connected', hostVersion: 'fixture', methods: ['kimi.getState', 'kimi.setConfig'],
    features: [KIMI_LAUNCH_MODES_FEATURE] },
  connections: 1,
});

function Fixture() {
  const [agents, setAgents] = useState(() => [blankRow(1, 'kimi')]);
  const [providerCard, setProviderCard] = useState<AgentRowsEditorProps['providerCard']>(null);
  const [lastAction, setLastAction] = useState('No Chat action sent');
  const [bridge] = useState(() => ({
    on: () => () => {},
    call: async (method: string, params?: { configId: string; value: string }) => {
      if (method === 'kimi.getState') return { config, requests: [] };
      if (method === 'kimi.setConfig' && params !== undefined) {
        config = config.map((option) => option.id === params.configId && option.type === 'select'
          ? { ...option, currentValue: params.value } : option);
        setLastAction(`Mocked Chat change: ${params.configId} = ${params.value}`);
        return { config };
      }
      throw new Error(`${method} is not available in this fixture`);
    },
  }) as unknown as ParleyBridge);

  return (
    <TooltipProvider>
      <main className="mx-auto grid max-w-3xl gap-4 px-4 py-6">
        <header>
          <h1 className="text-2xl font-semibold">Kimi launch-mode fixture</h1>
          <p className="text-muted-foreground">Production controls, fake connection. No session or provider turn can start here.</p>
        </header>
        <section aria-labelledby="launch-title" className="grid min-w-0 gap-3 rounded-xl border p-4">
          <h2 id="launch-title" className="text-lg font-semibold">New session</h2>
          <AgentRowsEditor
            agents={agents} env={{ roles: [], providers: [kimi], defaultId: 'kimi' }} results={{}} lead={null}
            showRowWorktree={false} worktreeAvailable={false} worktree={false} busy={false}
            groupLocked={false} minRows={1} providerCard={providerCard}
            onProviderCard={setProviderCard} reloadProviders={async () => {}} onLead={() => {}}
            onUpdate={(key, patch) => setAgents((rows) => rows.map((row) => row.key === key ? { ...row, ...patch } : row))}
            onRemove={(key) => setAgents((rows) => rows.filter((row) => row.key !== key))}
            onAdd={() => setAgents((rows) => [...rows, blankRow((rows.at(-1)?.key ?? 0) + 1, 'kimi')])}
            onClearError={() => {}}
          />
          <output aria-label="Fixture launch request" className="text-muted-foreground">
            {agents[0]?.kimiPermissionMode === undefined
              ? 'Mock launch would omit kimiPermissionMode.'
              : `Mock launch would send kimiPermissionMode = ${agents[0].kimiPermissionMode}.`}
          </output>
        </section>
        <section aria-labelledby="chat-title" className="grid min-w-0 gap-3 rounded-xl border p-4">
          <h2 id="chat-title" className="text-lg font-semibold">Chat</h2>
          <div className="flex"><KimiConfigMenu bridge={bridge} sessionRef={ref} disabledReason={null} /></div>
          <output aria-label="Fixture Chat request" className="text-muted-foreground">{lastAction}</output>
        </section>
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
