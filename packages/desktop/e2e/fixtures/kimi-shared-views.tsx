import type { FeedItem, FeedPermissionCard } from '@parley/core';
import { KIMI_PTY_GENERATION_FEATURE, KIMI_SHARED_TERMINAL_FEATURE } from '@parley/protocol';
import { createRoot } from 'react-dom/client';
import { useFeedStore } from '../../src/renderer/chat/store';
import { FeedSubscription } from '../../src/renderer/chat/use-feed';
import { TerminalBody } from '../../src/renderer/layout/bodies/TerminalBody';
import { useLayoutStore } from '../../src/renderer/layout/store';
import { emptyLayout, findTab, openTab } from '../../src/renderer/layout/tree';
import { useActivityStore } from '../../src/renderer/store/activity';
import { useHostStore } from '../../src/renderer/store/host';
import { useProvidersStore } from '../../src/renderer/store/providers';
import { useUiStore } from '../../src/renderer/store/ui';
import { useWorksStore } from '../../src/renderer/store/works';
import { TerminalSurface } from '../../src/renderer/terminal/TerminalSurface';
import { createFakeBridge } from '../../src/renderer/test-utils/fake-bridge';
import { activityMap, makeActivity, makeNeed, makeSession, makeWork } from '../../src/renderer/test-utils/work-fixtures';
import { Button } from '../../src/renderer/ui/button';
import '../../src/renderer/styles.css';

const bridge = createFakeBridge();
const ref = { projectPath: '/tmp/kimi-shared', workId: 'w-01', sessionId: 's-01' };
const key = `${ref.projectPath} ${ref.workId}`;
const scenario = new URLSearchParams(location.search);
const initialView = scenario.get('view') === 'terminal' ? 'terminal' : 'chat';
const tab = { id: 'terminal:s-01', kind: 'terminal' as const, sessionId: ref.sessionId, view: initialView };
const generation = 'd80a727e-a2f5-417d-ab51-ede75ef33549';
const session = makeSession(ref.sessionId, 'Kimi shared views', {
  provider: 'kimi',
  providerSessionId: 'session_fixture',
  kimiTerminal: { archive: 'aeb8f1a3-87b2-41fc-819b-6aa010f1a2ec', cwd: ref.projectPath, home: '/tmp/kimi' },
});
const at = new Date().toISOString();
const items: FeedItem[] = [
  { kind: 'prompt', id: 'prompt-1', at, text: 'Summarize the release notes.', images: 0 },
  { kind: 'text', id: 'reply-1', at, messageId: 'reply-1', text: 'The release notes are ready to review.', streaming: false },
  { kind: 'turn', id: 'end-1', at, durationMs: 350 },
];
const permission: FeedPermissionCard = {
  kind: 'permission', id: 'kimi:fixture-permission', cardId: 'kimi:fixture-permission', at, state: 'pending',
  toolUseId: null, toolName: 'Review notes', toolInput: {}, suggestions: [], notified: false,
  permissionOptions: [
    { kind: 'allow_once', optionId: 'fixture-review-once', name: 'Allow this review once' },
    { kind: 'reject_once', optionId: 'fixture-skip-review', name: 'Skip the review' },
  ],
};
let revision = 1;
let modal = false;
let input = '';
let terminalOutput = '\x1b[1;36mKimi Code\x1b[0m  ·  session_fixture\r\n\r\n'
  + 'Ready in both Chat and Terminal. Type /help for keyboard shortcuts.\r\n\r\n\x1b[32m❯\x1b[0m ';

function publish(...upsert: FeedItem[]): void {
  for (const item of upsert) {
    const existing = items.findIndex(({ id }) => id === item.id);
    if (existing === -1) items.push(item);
    else items[existing] = item;
  }
  bridge.emit('feed.changed', { ref, mode: null, decisions: 'window', revision: ++revision, upsert, removed: [] });
}
function output(data: string): void {
  terminalOutput += data;
  bridge.emit('pty.output', { ref, data });
}
function setActivity(activity: 'idle' | 'blocked'): void {
  useActivityStore.setState({ byRef: activityMap([makeActivity(ref, activity, modal ? { need: makeNeed('startup') } : {})]), loaded: true });
}
function showPermission(): void {
  publish(permission);
  setActivity('blocked');
}
function showNativePrompt(): void {
  modal = true;
  output('\r\nNative dialog: press Enter to continue.\r\n');
  setActivity('idle');
}
const status = {
  state: 'connected' as const, hostVersion: 'fixture', features: [KIMI_SHARED_TERMINAL_FEATURE, KIMI_PTY_GENERATION_FEATURE],
  methods: ['feed.snapshot', 'feed.subscribe', 'feed.unsubscribe', 'feed.decide', 'pty.attach', 'pty.detach', 'pty.send'],
};
useLayoutStore.getState().hydrate(key, openTab(emptyLayout(), tab));
useHostStore.setState({ status, everConnected: true, connections: 1 });
useUiStore.setState({ dark: true });
useProvidersStore.setState({ providers: [{ id: 'kimi', label: 'Kimi Code', available: true, version: 'fixture', limits: null }], loaded: true });
useWorksStore.setState({ entries: [makeWork(ref.workId, { projectPath: ref.projectPath, sessions: [session] })] });
setActivity('idle');
bridge.setHandler('pty.attach', () => ({ cols: 80, rows: 24, generation, snapshot: terminalOutput }));
bridge.setHandler('pty.detach', () => ({ ok: true }));
bridge.setHandler('pty.send', ({ text }) => {
  if (modal) return { inserted: false, submitted: false, reason: 'blocked' };
  const id = `fixture-${revision}`;
  publish(
    { kind: 'prompt', id, at, text, images: 0 },
    { kind: 'text', id: `${id}-reply`, at, messageId: `${id}-reply`, text: 'Received through the shared sender.', streaming: false },
    { kind: 'turn', id: `${id}-end`, at, durationMs: 0 },
  );
  output(`${text}\r\nReceived through the shared sender.\r\n\r\n❯ `);
  return { inserted: true, submitted: true, reason: null };
});
bridge.setHandler('feed.subscribe', () => ({ ok: true }));
bridge.setHandler('feed.unsubscribe', () => ({ ok: true }));
bridge.setHandler('feed.snapshot', () => ({ schemaVersion: 1, revision, mode: null, decisions: 'window', items: [...items] }));
bridge.setHandler('feed.decide', ({ decision }) => {
  const allowed = decision.kind === 'permission' && decision.optionId === 'fixture-review-once';
  const state = allowed ? 'allowed' : 'denied';
  publish({ ...permission, state });
  setActivity('idle');
  return { applied: true, state };
});
const notify = bridge.notify.bind(bridge);
bridge.notify = (method, params) => {
  notify(method, params);
  if (method !== 'pty.input') return;
  const raw = params as { data: string; generation?: string };
  if (raw.generation !== generation) return;
  input += raw.data;
  output(raw.data.replaceAll('\r', '\r\n'));
  if (!input.includes('\r')) return;
  if (modal) {
    modal = false;
    setActivity('idle');
    output('Native prompt dismissed.\r\n\r\n❯ ');
  } else if (input === '/help\r') output('Keyboard shortcuts\r\nEsc: dismiss help\r\n\r\n❯ ');
  input = '';
};
Object.defineProperty(window, 'kimiSharedFixture', { value: { calls: bridge.calls, notified: bridge.notified } });
useFeedStore.getState().init(bridge);
if (scenario.get('prompt') === 'permission') showPermission();
else if (scenario.get('prompt') === 'native') showNativePrompt();

const sendDeps = { bridge, session: () => session, openSession: () => {} };
function Fixture(): JSX.Element {
  const current = useLayoutStore((state) => {
    const layout = state.layouts[key];
    const match = layout === undefined ? null : findTab(layout, tab.id);
    return match?.group.tabs[match.index];
  });
  if (current?.kind !== 'terminal') throw new Error('Expected the session tab');
  return (
    <main className="mx-auto max-w-[860px] space-y-3 px-4 py-5 md:px-6">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Kimi shared views fixture</h1>
        <Button variant="outline" size="sm" onClick={showPermission}>Show permission</Button>
        <Button variant="outline" size="sm" onClick={showNativePrompt}>Show native prompt</Button>
      </header>
      <section className="relative h-[510px] min-w-0 overflow-hidden rounded-xl border border-border bg-background">
        <FeedSubscription sessionRef={ref} eager />
        <TerminalBody workKey={key} tab={current} session={session} sessionRef={ref} active bridge={bridge} sendDeps={sendDeps} />
        {current.view === 'terminal' ? <div className="fixture-terminal absolute inset-x-0 bottom-0 top-10">
          <TerminalSurface bridge={bridge} sessionRef={ref} tabId={tab.id} groupId="fixture" visible fontFamily="monospace" fontSize={13} />
        </div> : null}
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
