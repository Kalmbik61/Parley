// DEVELOPER BUILD ONLY (PARLEY_MOBILE_DEV_DEMO=1, __DEV__): fills the remote-client store with a made-up snapshot so the
// A15 screens can be looked at on a simulator before pairing exists. Never reached in a release build.
import type { FeedCard } from '@parley/core';
import type { RemoteClient, SessionRef } from '@parley/remote-client';
import type { RemoteWorksSnapshot } from '@parley/protocol/remote';
import { sessionParam, workParam } from '../nav/refs';
import { longFeedItems, longRoomLetters } from './long-feed';
import { HUMAN_TABLE } from './md-demo';

const P = '/Users/me/parley';
const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const sess = (id: string, label: string, extra: Partial<RemoteWorksSnapshot['works'][number]['sessions'][number]> = {}) => ({
  id, label, provider: 'claude', model: 'opus', role: null, parent: null, createdBy: null, lifecycle: 'active' as const, result: null,
  stuck: null, lastEvent: { event: 'Stop', at: ago(3) }, startedAt: ago(42), resultAt: null, ...extra,
});

export const demoSnapshot: RemoteWorksSnapshot = {
  revision: 1,
  works: [
    {
      projectPath: P, id: 'w1', title: 'Improvements', status: 'active', messages: { direct: { total: 2, unread: 1 }, inline: 0 },
      sessions: [
        sess('greta', 'Greta', { role: 'feature-lead' }),
        sess('d1', 'Mobile-D1-designer', { role: 'designer', createdBy: 'greta' }),
        sess('a13', 'Mobile-A13-app-foundation', { role: 'executor', model: 'sonnet', createdBy: 'greta' }),
        sess('drone1', 'Research drone 1', { createdBy: 'greta' }),
        sess('queen', 'Research queen', { createdBy: 'greta' }),
        sess('solo', 'Changelog-writer', { role: 'writer' }),
        // A37b: a sleeping session — the Resume row.
        sess('zzz', 'Docs-editor', { role: 'writer', model: 'sonnet', lifecycle: 'sleeping' as never, lastEvent: { event: 'Stop', at: ago(180) } }),
        // A35a: the human's case — a room a person made (no owning session), its two members top-level.
        sess('rel', 'Release-notes-writer', { role: 'writer' }),
        sess('rel2', 'Release-QA', { role: 'verifier' }),
        // A42: a session for the message actions.
        sess('msgs', 'Docs-reviewer', { role: 'reviewer' }),
        sess('cb2', 'Engine-worker 1', { role: 'executor' }),
        sess('cb3', 'Engine-worker 2', { role: 'verifier' }),
        sess('s-01', 'Аналитик', { role: 'analyst' }),
        sess('s-02', 'Редактор', { role: 'editor' }),
      ],
      rooms: [
        { id: 'r1', title: 'iOS app: stage A', members: ['greta', 'd1', 'a13'], lead: 'greta', ownerId: 'greta', mode: 'verified', archived: false,
          proposal: { id: 'p-03', kind: 'decision', from: 'Greta', text: 'Ship A1 with the new projection', rev: 2, at: ago(12), planId: null, planRev: null }, messages: null },
        // A35d: a long room with a decision — the list scrolls under the strip.
        { id: 'r3', title: 'long room', members: ['s-01', 's-02'], lead: 's-01', ownerId: null, mode: 'free', archived: false,
          proposal: { id: 'p-07', kind: 'decision', from: 'Аналитик', text: 'Publish the report', rev: 1, at: ago(12), planId: null, planRev: null }, messages: null },
        // A41b: live and sleeping members (the menu of an ordinary room) and a room of the autonomous engine.
        { id: 'r4', title: 'Release prep', members: ['drone1', 'queen', 'rel', 'rel2', 'zzz'], lead: 'queen', ownerId: null, mode: 'free', archived: false,
          proposal: { id: 'p-09', kind: 'decision', from: 'Research queen', text: 'Cut the release', rev: 1, at: ago(9), planId: null, planRev: null }, messages: null },
        { id: 'r6', title: 'Old release', members: ['rel'], lead: null, ownerId: null, mode: 'free', archived: true, proposal: null, messages: null },
        { id: 'r5', title: 'Autonomous run', members: ['cb2', 'cb3'], lead: 'cb2', ownerId: null, mode: 'autonomous', archived: false, proposal: null, messages: null },
        { id: 'r2', title: 'тест', members: ['s-01', 's-02'], lead: 's-02', ownerId: null, mode: 'free', archived: false, proposal: null, messages: null },
      ],
      swarms: [
        { id: 'sw1', tag: 'Research', creator: { kind: 'session', sessionId: 'greta' }, queen: 'queen', status: 'running', createdAt: ago(20), endedAt: null, seenAt: null,
          members: [{ sessionId: 'queen', role: 'queen', n: 0, handedAt: null }, { sessionId: 'drone1', role: 'drone', n: 1, handedAt: ago(2) }] },
      ],
    },
    {
      projectPath: '/Users/me/codex-bridge', id: 'w2', title: 'Codex bridge', status: 'active', messages: { direct: null, inline: 0 },
      rooms: [{ id: 'rlong', title: 'Long history', members: ['cb1', 'long'], lead: 'cb1', ownerId: null, mode: 'free', archived: false, proposal: null, messages: null }],
      sessions: [sess('cb1', 'Bridge-planner'), sess('mdfeed', 'Markdown-demo'), sess('long', 'Long-feed-demo')], swarms: [],
    },
  ],
};

const permission: FeedCard = {
  kind: 'permission', id: 'card-1', cardId: 'card-1', at: ago(2), state: 'pending', toolUseId: null, toolName: 'Bash',
  toolInput: { command: 'pnpm lint && pnpm -r build' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm lint:*' }] }], notified: true,
} as unknown as FeedCard;
const question: FeedCard = {
  kind: 'question', id: 'card-2', cardId: 'card-2', at: ago(5), state: 'pending', toolUseId: null, toolName: 'AskUserQuestion', toolInput: {},
  questions: [{ question: 'Which branch should I rebase onto?', header: 'Branch', multiSelect: false, options: [{ label: 'main', description: 'The default branch' }, { label: 'feat/mobile-stage-a', description: null }] }],
} as unknown as FeedCard;

/** `onlyConsent`: show only that consent card (screenshots, PARLEY_MOBILE_DEV_CONSENT). */
export function installDemo(client: RemoteClient, onlyConsent?: unknown): void {
  const { store } = client;
  if (store.getState().snapshot !== null) return;
  store.dispatch({ t: 'bridge.status', host: 'online', epoch: 'demo' });
  store.dispatch({ t: 'snapshot', snapshot: demoSnapshot, epoch: 'demo' });
  const act = (ref: SessionRef, activity: string, need: unknown = null): void =>
    store.dispatch({ t: 'activity.changed', ref, metrics: null, activity: { activity, subagents: 0, tasks: [], waitingFor: null, heldByBackground: false, turnEndedAt: null, turnBoundaryAt: null, lastEventAt: ago(1), source: 'hooks', hooksMissing: false, need } as never });
  const ref = (sessionId: string): SessionRef => ({ projectPath: P, workId: 'w1', sessionId });
  act(ref('d1'), 'blocked', { kind: 'approval', since: ago(2), detail: null, resetsAt: null, window: null, account: null });
  act(ref('a13'), 'blocked', { kind: 'question', since: ago(5), detail: null, resetsAt: null, window: null, account: null });
  act(ref('greta'), 'unseen');
  // A35d: needs you with no card on screen — the "Answer at your Mac" strip under the bar.
  act(ref('solo'), 'blocked', { kind: 'approval', since: ago(3), detail: null, resetsAt: null, window: null, account: null });
  act(ref('drone1'), 'working');
  const letter = (id: string, from: string, text: string, min: number, read: boolean) =>
    ({ id, roomId: null, from, to: ['human'], at: ago(min), text, kind: 'note', readBy: read ? { human: ago(min - 1) } : {} }) as never;
  store.dispatch({
    t: 'messages', projectPath: P, workId: 'w1', roomId: null, epoch: 'demo',
    messages: [
      letter('m1', 'Greta', '## PR #143 is ready\nThe projection fix is merged.\n- tests green\n- lint green', 20, false),
      letter('m2', 'Mobile-D1-designer', 'S7 draft is committed; screens follow the mockups.', 1500, true),
    ],
  });
  // The "+" and the New session / New room sheet (A26): launch methods in the hello, a made-up provider and role list.
  client.setBridgeMethods(['works.list', 'feed.decide', 'sessions.create', 'rooms.create', 'rooms.send', 'providers.list', 'roles.list', 'ping', 'pty.send', 'consents.list', 'consents.decide', 'trust.check', 'sessions.resume', 'feed.interrupt', 'sessions.stop', 'sessions.close', 'sessions.switchOptions', 'sessions.switchAgent']);
  store.dispatch({
    t: 'catalog.providers', epoch: 'demo',
    providers: { providers: [
      { id: 'claude', label: 'Claude', available: true, models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
      { id: 'codex', label: 'Codex', available: false, needs: 'sign-in' },
    ] } as never,
  });
  store.dispatch({
    t: 'catalog.roles', epoch: 'demo', projectPath: P,
    roles: { partial: false, diagnostics: [], roles: [
      { id: 'executor', name: 'executor', description: '', source: 'builtin', provider: 'claude', model: null, effort: null, readOnly: false },
      { id: 'writer', name: 'writer', description: '', source: 'builtin', provider: 'claude', model: null, effort: null, readOnly: false },
    ] } as never,
  });
  // A32: a made-up conversation for the chat screen (greta is idle, so the composer shows) and two consent cards.
  const at = (min: number): string => ago(min);
  const feedItems = [
    { kind: 'prompt', id: 'f1', at: at(40), text: 'Update the D1 doc for the human decisions', images: 0 },
    { kind: 'tool', id: 'f2', at: at(39), toolUseId: 't2', name: 'Read', input: { file_path: 'docs/design/mobile.md' }, status: 'done' },
    { kind: 'tool', id: 'f3', at: at(38), toolUseId: 't3', name: 'Bash', input: { command: 'pnpm lint' }, status: 'done' },
    { kind: 'text', id: 'f4', at: at(37), messageId: 'm1', streaming: false, text: '## D1 is updated\nThe session screen is now the **chat**:\n- pinned header\n- feed with `Markdown`\n- composer\n\n```\npnpm lint\n```' },
    // A40: the human's reply with a GFM table.
    { kind: 'text', id: 'f4b', at: at(36.5), messageId: 'm1b', streaming: false, text: HUMAN_TABLE },
    { kind: 'turn', id: 'f5', at: at(36), durationMs: 372_000 },
    { kind: 'prompt', id: 'f6', at: at(5), text: 'Run the linter once more', images: 0 },
    { kind: 'tool', id: 'f7', at: at(4), toolUseId: 't7', name: 'Bash', input: { command: 'pnpm lint && pnpm -r build' }, status: 'running' },
    { kind: 'text', id: 'f8', at: at(3), messageId: 'm2', streaming: true, text: "I'll run the linter first, then the build." },
  ] as never[];
  // A42: a short chat for the message actions: a reply, an own prompt and an own prompt that carries a quote.
  const a42Ref: SessionRef = { projectPath: P, workId: 'w1', sessionId: 'msgs' };
  store.dispatch({ t: 'feed.open', ref: a42Ref });
  store.dispatch({
    t: 'feed.loaded', ref: a42Ref, epoch: 'demo', revision: 3, mode: null, decisions: null,
    items: [
      { kind: 'prompt', id: 'h1', at: at(30), text: 'Why did the build fail on CI?', images: 0 },
      { kind: 'text', id: 'h2', at: at(29), messageId: 'mh2', streaming: false, text: 'The **lint** step failed because `eslint` found three unused imports in `room.tsx`.\n\nI removed them and the build is green again.' },
      { kind: 'turn', id: 'h3', at: at(28), durationMs: 95_000 },
      { kind: 'prompt', id: 'h4', at: at(10), text: '> The **lint** step failed because `eslint` found three unused imports in `room.tsx`.\n\nCan you also add a test so it cannot come back?', images: 0 },
      { kind: 'text', id: 'h5', at: at(9), messageId: 'mh5', streaming: false, text: 'Done — the new test fails when an unused import is added.' },
      { kind: 'turn', id: 'h6', at: at(8), durationMs: 41_000 },
    ] as never[],
  });
  // A40: a short feed whose only reply is the human's table (route md-feed).
  const mdRef: SessionRef = { projectPath: '/Users/me/codex-bridge', workId: 'w2', sessionId: 'mdfeed' };
  store.dispatch({ t: 'feed.open', ref: mdRef });
  store.dispatch({
    t: 'feed.loaded', ref: mdRef, epoch: 'demo', revision: 2, mode: null, decisions: null,
    items: [
      { kind: 'prompt', id: 'g1', at: at(5), text: 'Which MCP servers are set up globally?', images: 0 },
      { kind: 'text', id: 'g2', at: at(4), messageId: 'mg2', streaming: false, text: HUMAN_TABLE },
    ] as never[],
  });
  // A44: a long mixed feed and a long room history (routes a44-session, a44-room; add `dev=focus,draft,up,more,card` to the path, see dev-script.ts).
  const longRef: SessionRef = { projectPath: '/Users/me/codex-bridge', workId: 'w2', sessionId: 'long' };
  store.dispatch({ t: 'feed.open', ref: longRef });
  store.dispatch({ t: 'feed.loaded', ref: longRef, epoch: 'demo', items: longFeedItems(14), revision: 3, mode: null, decisions: null });
  const longRoom = { projectPath: '/Users/me/codex-bridge', workId: 'w2', roomId: 'rlong' };
  store.dispatch({ t: 'room.open', ref: longRoom });
  store.dispatch({ t: 'room.loaded', ref: longRoom, epoch: 'demo', next: null, messages: longRoomLetters('rlong', 60) });
  for (const id of ['greta', 'drone1', 'solo', 'zzz']) {
    store.dispatch({ t: 'feed.open', ref: ref(id) });
    store.dispatch({ t: 'feed.loaded', ref: ref(id), epoch: 'demo', items: feedItems, revision: 8, mode: null, decisions: null });
  }
  // A32/A33: a room chat for the room screen.
  const rref = { projectPath: P, workId: 'w1', roomId: 'r1' };
  const letter2 = (id: string, from: string, min: number, text: string, extra: Record<string, unknown> = {}) =>
    ({ id, roomId: 'r1', from, to: [], at: ago(min), text, kind: 'note', readBy: {}, ...extra }) as never;
  store.dispatch({ t: 'room.open', ref: rref });
  store.dispatch({
    t: 'room.loaded', ref: rref, epoch: 'demo', next: 'before:1',
    messages: [
      letter2('m-11', 'greta', 30, 'Wave 3 is merged; next A27 and A28 go in parallel.'),
      letter2('m-12', 'd1', 28, 'Agreed — A28 starts after A27.', { to: ['greta'], replyTo: 'm-11' }),
      letter2('m-13', 'system', 25, 'Mobile-D1-designer proposed a decision'),
      letter2('m-14', 'human', 20, '@Greta please re-run the lint', { to: ['greta'], readBy: { greta: ago(19) } }),
      letter2('m-15', 'greta', 18, '## Lint is green\nAll **12** packages pass.\n- eslint\n- typecheck'),
    ],
  });
  for (const roomId of ['r4', 'r5', 'r6']) {
    const rr = { projectPath: P, workId: 'w1', roomId };
    store.dispatch({ t: 'room.open', ref: rr });
    store.dispatch({
      t: 'room.loaded', ref: rr, epoch: 'demo', next: null,
      messages: [{ id: `m-${roomId}`, roomId, from: 'human', to: [], at: ago(30), text: roomId === 'r4' ? 'Prepare the release notes.' : 'Run the stage.', kind: 'note', readBy: {} } as never],
    });
  }
  const rref2 = { projectPath: P, workId: 'w1', roomId: 'r2' };
  store.dispatch({ t: 'room.open', ref: rref2 });
  store.dispatch({
    t: 'room.loaded', ref: rref2, epoch: 'demo', next: null,
    messages: [
      { id: 'm-21', roomId: 'r2', from: 'human', to: [], at: ago(40), text: 'Сверьте цифры в отчёте за квартал.', kind: 'note', readBy: { 's-01': ago(39) } } as never,
      { id: 'm-22', roomId: 'r2', from: 's-02', to: [], at: ago(35), text: 'Принято. Проверяю таблицы **1–3**.', kind: 'note', readBy: {} } as never,
    ],
  });
  const rref3 = { projectPath: P, workId: 'w1', roomId: 'r3' };
  store.dispatch({ t: 'room.open', ref: rref3 });
  store.dispatch({
    t: 'room.loaded', ref: rref3, epoch: 'demo', next: 'before:1',
    messages: Array.from({ length: 16 }, (_, i) => ({ id: `m-3${i}`, roomId: 'r3', from: i % 2 === 0 ? 's-01' : 's-02', to: [], at: ago(90 - i * 5), text: `Line ${i + 1}: checking the quarterly numbers, table ${(i % 3) + 1}.`, kind: 'note', readBy: {} }) as never),
  });
  store.dispatch({
    t: 'consents.loaded', epoch: 'demo',
    items: [
      { id: 'c-1', kind: 'folder-trust', projectPath: P, folder: `${P}`, at: ago(6), state: 'pending', requestedBy: { source: 'agent', label: 'Task1-types' } },
      { id: 'c-3', kind: 'project-mcp', version: 1, revision: 1, projectPath: P, repo: P, at: ago(1), state: 'pending', servers: [
        { name: 'filesystem', fingerprint: 'fp-fs', command: 'npx -y @modelcontextprotocol/server-filesystem /Users/me/parley' },
        { name: 'github', fingerprint: 'fp-gh', command: 'https://api.githubcopilot.com/mcp/' },
        { name: 'postgres', fingerprint: 'fp-pg', command: 'node ./tools/pg-mcp.js --readonly' },
      ], requestedBy: { source: 'launch' } },
      { id: 'c-4', kind: 'project-mcp', version: 1, revision: 1, projectPath: P, repo: '/Users/me/parley-web', at: ago(4), state: 'pending', servers: [
        { name: 'filesystem', fingerprint: 'fp-fs', command: 'npx -y @modelcontextprotocol/server-filesystem /Users/me/parley-web' },
        { name: 'postgres', fingerprint: 'fp-pg', command: 'node ./tools/pg-mcp.js --readonly' },
      ], requestedBy: { source: 'launch' } },
      { id: 'c-5', kind: 'project-mcp', version: 1, revision: 2, projectPath: P, repo: '/Users/me/parley-docs', at: ago(5), state: 'pending', servers: [
        { name: 'search', fingerprint: 'fp-s2', command: 'uvx docs-search-mcp --index ./docs' },
      ], requestedBy: { source: 'launch' } },
      { id: 'c-2', kind: 'agent-switch', projectPath: P, at: ago(7), state: 'pending', ref: ref('greta'), provider: 'codex', providerLabel: 'Codex', model: 'gpt-6-astra', reason: 'Usage limit until 14:30; continue the review there.', requestedBy: { sessionId: 'd1', label: 'Greta' } },
    ].filter((card) => typeof onlyConsent !== 'string' || card.id === onlyConsent) as never,
  });
  store.dispatch({ t: 'cards.loaded', ref: ref('d1'), epoch: 'demo', items: [permission], at: Date.now() });
  store.dispatch({ t: 'cards.loaded', ref: ref('a13'), epoch: 'demo', items: [question], at: Date.now() });
}

/** A44 evidence (developer build): items arrive, a card arrives — real state changes of an open feed. */
export function devMoreSession(client: RemoteClient, ref: SessionRef): void {
  client.store.dispatch({ t: 'feed.loaded', ref, epoch: 'demo', items: longFeedItems(14, 2), revision: 4, mode: null, decisions: null });
}
export function devMoreRoom(client: RemoteClient, ref: { projectPath: string; workId: string; roomId: string }): void {
  client.store.dispatch({ t: 'room.loaded', ref, epoch: 'demo', next: null, messages: longRoomLetters(ref.roomId, 62) });
}
export function devLateCard(client: RemoteClient, ref: SessionRef): void {
  client.store.dispatch({ t: 'cards.loaded', ref, epoch: 'demo', items: [permission], at: Date.now() });
}

/** Screenshots only (developer build): a partly switched-on project-mcp card and the "list changed" line under another. */
export const DEMO_MCP_ON: Record<string, readonly string[]> = { 'c-4': ['filesystem', 'postgres'] };
export const DEMO_CONSENT_NOTES: Record<string, string> = { 'c-5': 'The server list changed — review again' };

/** `PARLEY_MOBILE_DEV_ROUTE=a42-reply|a42-prompt|a42-select|a42-plate|a42-quote|a42-room-plate|a42-room-select|a42-room-outgoing|room-menu|room-menu-autonomous|room-menu-archived|room-menu-busy|room-menu-offline|room-archive|room-delete|room-result|menu-working|menu-sleeping|close-confirm|switch-sheet|sleeping|sleeping-waking|sleeping-failed|sleeping-pending|sleeping-alert|works|work|session|question|plain|decision|decision-sheet|decision-sheet-long|letters|letter|new|new-room` → a path to open once, for screenshots. */
export function demoRoute(raw: unknown): string | null {
  // `a44-session:focus,draft` — the part after the colon is the dev script of dev-script.ts.
  const [name, script] = typeof raw === 'string' ? raw.split(':') : [raw, undefined];
  const dev = script === undefined ? '' : `dev=${script}`;
  const w = workParam({ projectPath: P, workId: 'w1' });
  const s = (id: string): string => `/session/${sessionParam({ projectPath: P, workId: 'w1', sessionId: id })}`;
  switch (name) {
    case 'works':
      return '/works';
    case 'work':
      return `/work/${w}`;
    case 'session':
      return s('d1');
    case 'question':
      return s('a13');
    case 'decision':
      return `/decision?ref=${encodeURIComponent(w)}&room=r1&proposal=p-03`;
    case 'decision-sheet':
      return `/decision?ref=${encodeURIComponent(w)}&room=r1&proposal=p-03&devSheet=1`;
    case 'decision-sheet-long':
      return `/decision?ref=${encodeURIComponent(w)}&room=r1&proposal=p-03&devSheet=long`;
    case 'letters':
      return '/?segment=letters';
    case 'letter':
      return `/letter?ref=${encodeURIComponent(w)}&id=m1`;
    case 'plain':
      return s('greta');
    case 'sleeping':
      return s('zzz');
    // A37b screenshots: the state comes from the `preview` param (waking, failed, pending, alert), not from taps.
    case 'sleeping-waking':
    case 'sleeping-failed':
    case 'sleeping-pending':
    case 'sleeping-alert':
      return `${s('zzz')}?preview=${name.slice('sleeping-'.length)}`;
    // A38b screenshots (menu opens by itself in the developer build).
    case 'menu-working':
      return `${s('drone1')}?preview=menu`;
    case 'menu-sleeping':
      return `${s('zzz')}?preview=menu`;
    case 'close-confirm':
      return `${s('drone1')}?preview=close`;
    case 'switch-sheet':
      return `${s('greta')}?preview=switch`;
    case 'session-strip':
      return s('solo');
    // A40 screenshots: one Markdown demo text on a plain screen.
    case 'md-table':
    case 'md-code':
    case 'md-path':
    case 'md-lists':
    case 'md-images':
    case 'md-all':
      return `/md?case=${name.slice('md-'.length)}`;
    case 'md-table-scrolled':
      return '/md?case=table&scrollX=240';
    // A40: the session feed (a FlatList) with the human's table as the agent's reply.
    case 'md-feed':
      return `/session/${sessionParam({ projectPath: '/Users/me/codex-bridge', workId: 'w2', sessionId: 'mdfeed' })}`;
    // A44: the long feeds; `-jump` shows the Jump to latest capsule, `-draft` adds a several-line draft, `-plate` the reply plate.
    case 'a44-session':
      return `/session/${sessionParam({ projectPath: '/Users/me/codex-bridge', workId: 'w2', sessionId: 'long' })}?${dev}`;
    case 'a44-room':
      return `/room?ref=${encodeURIComponent(workParam({ projectPath: '/Users/me/codex-bridge', workId: 'w2' }))}&room=rlong&${dev}`;
    case 'chat':
      return s('drone1');
    case 'room':
      return `/room?ref=${encodeURIComponent(w)}&room=r1`;
    case 'settings-diagnostics':
      return '/settings/diagnostics';
    // A42 screenshots (the sheet opens by itself in the developer build).
    case 'a42-reply':
      return `${s('msgs')}?preview=actions-reply`;
    case 'a42-prompt':
      return `${s('msgs')}?preview=actions-prompt`;
    case 'a42-select':
      return `${s('msgs')}?preview=select`;
    case 'a42-plate':
      return `${s('msgs')}?preview=plate`;
    case 'a42-quote':
      return s('msgs');
    case 'a42-room-plate':
      return `/room?ref=${encodeURIComponent(w)}&room=r1&preview=plate`;
    case 'a42-room-outgoing':
      return `/room?ref=${encodeURIComponent(w)}&room=r1&preview=outgoing`;
    case 'a42-room-select':
      return `/room?ref=${encodeURIComponent(w)}&room=r1&preview=select`;
    // A41b screenshots (the sheet opens by itself in the developer build).
    case 'room-menu':
      return `/room?ref=${encodeURIComponent(w)}&room=r4&preview=menu`;
    case 'room-menu-autonomous':
      return `/room?ref=${encodeURIComponent(w)}&room=r5&preview=menu`;
    case 'room-menu-archived':
      return `/room?ref=${encodeURIComponent(w)}&room=r6&preview=menu`;
    case 'room-menu-busy':
      return `/room?ref=${encodeURIComponent(w)}&room=r4&preview=busy`;
    case 'room-menu-offline':
      return `/room?ref=${encodeURIComponent(w)}&room=r4&preview=offline`;
    case 'room-archive':
      return `/room?ref=${encodeURIComponent(w)}&room=r4&preview=archive`;
    case 'room-delete':
      return `/room?ref=${encodeURIComponent(w)}&room=r4&preview=delete`;
    case 'room-result':
      return `/room?ref=${encodeURIComponent(w)}&room=r4&preview=result`;
    case 'room-long':
      return `/room?ref=${encodeURIComponent(w)}&room=r3`;
    case 'room-ownerless':
      return `/room?ref=${encodeURIComponent(w)}&room=r2`;
    case 'inbox':
      return '/';
    case 'new':
      return `/new?ref=${encodeURIComponent(w)}`;
    case 'new-room':
      return `/new?ref=${encodeURIComponent(w)}&mode=room`;
    default:
      return null;
  }
}
