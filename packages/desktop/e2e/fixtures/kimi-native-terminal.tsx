import { useLayoutStore } from '../../src/renderer/layout/store';
import { emptyLayout, findTab, openTab, updateTab } from '../../src/renderer/layout/tree';
import { createRoot } from 'react-dom/client';
import { KIMI_NATIVE_TERMINAL_FEATURE, refKey, type KimiControl } from '@parley/protocol';
import { ChatView } from '../../src/renderer/chat/ChatView';
import { useFeedStore } from '../../src/renderer/chat/store';
import { FeedSubscription } from '../../src/renderer/chat/use-feed';
import { IslandView } from '../../src/renderer/island/IslandView';
import { islandModel } from '../../src/renderer/island/model';
import { TerminalSurface } from '../../src/renderer/terminal/TerminalSurface';
import { Button } from '../../src/renderer/ui/button';
import { useHostStore } from '../../src/renderer/store/host';
import { useProvidersStore } from '../../src/renderer/store/providers';
import { useUiStore } from '../../src/renderer/store/ui';
import { useWorksStore } from '../../src/renderer/store/works';
import { createFakeBridge } from '../../src/renderer/test-utils/fake-bridge';
import { makeSession, makeWork } from '../../src/renderer/test-utils/work-fixtures';
import '../../src/renderer/styles.css';
import '../../src/renderer/island/island.css';

const bridge = createFakeBridge();
const ref = { projectPath: '/tmp/kimi-ownership', workId: 'w-01', sessionId: 's-01' };
const key = refKey(ref);
const workKey = `${ref.projectPath} ${ref.workId}`;
const tab = { id: 'terminal:s-01', kind: 'terminal' as const, sessionId: ref.sessionId };
const noop = () => {};
const fixtureParams = new URLSearchParams(location.search);
let control: KimiControl = fixtureParams.get('owner') === 'terminal' ? { owner: 'terminal' }
  : fixtureParams.get('owner') === 'exited' ? { owner: 'exited' } : { owner: 'chat', canTakeover: true };
const initialView = fixtureParams.get('view') === 'terminal' ? 'terminal' : 'chat';
useLayoutStore.getState().hydrate(workKey, openTab(emptyLayout(), { ...tab, view: initialView }));
const setView = (view: 'terminal' | 'chat') =>
  useLayoutStore.getState().apply(workKey, (layout) => updateTab(layout, tab.id, { view }));
let input = '';
const marker = { archive: 'aeb8f1a3-87b2-41fc-819b-6aa010f1a2ec', cwd: ref.projectPath, home: '/tmp/kimi' };
const work = () => makeWork(ref.workId, {
  projectPath: ref.projectPath,
  title: 'Kimi ownership fixture',
  sessions: [makeSession(ref.sessionId, 'Kimi', {
    provider: 'kimi', providerSessionId: 'session_fixture',
    ...(control.owner === 'chat' ? {} : { kimiTerminal: marker }),
  })],
});
function setOwner(next: KimiControl) {
  control = next;
  bridge.emit('kimi.control', { ref, control });
  useWorksStore.setState({ entries: [work()] });
}

const status = {
  state: 'connected' as const, hostVersion: 'fixture', features: [KIMI_NATIVE_TERMINAL_FEATURE],
  methods: ['kimi.getControl', 'kimi.setControl', 'kimi.getState', 'feed.snapshot', 'feed.subscribe', 'feed.unsubscribe', 'pty.attach', 'pty.detach', 'pty.send'],
};
useHostStore.setState({ status, everConnected: true, connections: 1 });
useUiStore.setState({ dark: true });
useProvidersStore.setState({ providers: [{ id: 'kimi', label: 'Kimi Code', available: true, version: 'fixture', limits: null }], loaded: true });
useWorksStore.setState({ entries: [work()] });
bridge.setHandler('kimi.getControl', () => control);
bridge.setHandler('kimi.setControl', ({ target }) => {
  setOwner(target === 'terminal' ? { owner: 'terminal' } : { owner: 'chat', canTakeover: true });
  return control;
});
bridge.setHandler('kimi.getState', () => ({ requests: [], config: [{
  id: 'mode', name: 'Permission mode', type: 'select', category: 'mode',
  currentValue: 'default', options: [{ name: 'Always ask', value: 'default' }],
}] }));
bridge.setHandler('pty.attach', () => ({
  cols: 80, rows: 24, generation: marker.archive,
  snapshot: '\x1b[1;36mKimi Code\x1b[0m  ·  session_fixture\r\n\r\n'
    + 'Use /help for keyboard shortcuts or /exit to return to managed Chat.\r\n\r\n'
    + '\x1b[32m❯\x1b[0m ',
}));
bridge.setHandler('pty.detach', () => ({ ok: true }));
bridge.setHandler('feed.subscribe', () => ({ ok: true }));
bridge.setHandler('feed.unsubscribe', () => ({ ok: true }));
bridge.setHandler('feed.snapshot', () => ({
  schemaVersion: 1, revision: 1, mode: null,
  items: [
    { kind: 'prompt', id: 'prompt-1', at: new Date().toISOString(), text: 'Show me the current implementation.' },
    { kind: 'text', id: 'reply-1', at: new Date().toISOString(), text: 'Chat history stays visible while you work in native Terminal.', streaming: false },
    { kind: 'turn', id: 'end-1', at: new Date().toISOString(), durationMs: 350 },
  ],
}));
const notify = bridge.notify.bind(bridge);
bridge.notify = (method, params) => {
  notify(method, params);
  if (method !== 'pty.input' || control.owner !== 'terminal') return;
  const { data, generation } = params as { data: string; generation?: string };
  if (generation !== marker.archive) return;
  input += data;
  bridge.emit('pty.output', { ref, data: data.replaceAll('\r', '\r\n') });
  if (input.includes('/exit\r')) setOwner({ owner: 'exited' });
  else if (input.includes('/help\r')) bridge.emit('pty.output', { ref, data: '\x1b[1mKeyboard shortcuts\x1b[0m\r\nEsc: dismiss help\r\n' });
  if (data.includes('\r')) input = '';
};
useFeedStore.getState().init(bridge);

function Fixture() {
  const view = useLayoutStore((state) => {
    const layout = state.layouts[workKey];
    const found = layout === undefined ? null : findTab(layout, tab.id);
    const current = found?.group.tabs[found.index];
    return current?.kind === 'terminal' ? current.view : 'chat';
  });
  const entries = useWorksStore((state) => state.entries);
  const model = islandModel(entries, {}, new Set(), new Set(), new Set());
  return (
    <main className="mx-auto max-w-[1120px] space-y-3 px-6 py-5">
      <header className="flex items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Kimi ownership fixture</h1>
        <Button variant={view === 'chat' ? 'default' : 'outline'} onClick={() => setView('chat')}>Chat tab</Button>
        <Button variant={view === 'terminal' ? 'default' : 'outline'} onClick={() => setView('terminal')}>Terminal tab</Button>
      </header>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_410px]">
        <section className="relative h-[420px] min-w-0 overflow-hidden rounded-xl border border-border bg-background">
          <FeedSubscription sessionRef={ref} eager />
          {view === 'chat' ? <ChatView workKey={workKey} tab={tab} sessionRef={ref} bridge={bridge}
            sendDeps={{ bridge, session: () => entries[0]?.map.sessions[0] ?? null, openSession: noop }}
            visible live provider="kimi" storedModel={null} storedEffort={null} /> : null}
          <div className="fixture-terminal absolute inset-0" hidden={view !== 'terminal'}>
            <TerminalSurface bridge={bridge} sessionRef={ref} tabId={tab.id} groupId="fixture" visible={view === 'terminal'}
              fontFamily="monospace" fontSize={13} />
          </div>
        </section>
        <section className="rounded-xl border border-border p-2">
          <IslandView model={model} items={[]} index={0} config={{ anchor: 'center', topInset: 0, motion: 'reduce' }}
            listOpen retracted={false} doneCount={0} hovered={false} showId={1} labels={new Map([[key, { session: 'Kimi', work: 'Fixture', project: 'Local' }]])}
            api={{ open: (target) => { if (target.kind === 'session' && target.view === 'terminal') setView('terminal'); },
              dragStart: noop, dragMove: noop, dragEnd: noop }} shapeRef={null} requestKeyboard={false} onTakeRequestKeyboard={noop}
            onDragStart={noop} onDragEnd={noop} onToggleList={noop} onHide={noop}
            onClearDone={noop} onSelect={noop} onDecide={noop} assistant={null} consent={null} />
        </section>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
