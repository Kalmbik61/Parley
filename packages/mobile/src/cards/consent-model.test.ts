import { describe, expect, it, vi } from 'vitest';
import type { ConsentCard } from '@parley/protocol';
import type { DecideConsentOutcome, RemoteClient } from '@parley/remote-client';
import type { ProjectMcpCard } from '@parley/protocol';
import { MCP_CHANGED, canDecideConsent, cardBelongsToSession, enabledPairs, mcpShapeKey, mcpTitle, pendingConsents, projectMcpDrawable, runConsent, switchText, trustRequestedBy, trustTitle } from './consent-model';

const trust: ConsentCard = { id: 'c-1', kind: 'folder-trust', projectPath: '/p', folder: '/Users/me/parley', at: '2026-11-01T10:00:00.000Z', state: 'pending', requestedBy: { source: 'agent', label: 'Task1-types' } };
const swit: ConsentCard = { id: 'c-2', kind: 'agent-switch', projectPath: '/p', at: '2026-11-01T11:00:00.000Z', state: 'pending', ref: { projectPath: '/p', workId: 'w', sessionId: 's' }, provider: 'codex', providerLabel: 'Codex', model: null, reason: 'Usage limit', requestedBy: { sessionId: 's', label: 'Greta' } };
const client = (o: DecideConsentOutcome = { outcome: 'applied' }) => ({ decideConsent: vi.fn(async () => o) });
const as = (c: ReturnType<typeof client>) => c as unknown as RemoteClient;

describe('consent cards', () => {
  it('Allow and Deny go straight to the host, no prompt of ours', async () => {
    const c = client();
    expect(await runConsent(as(c), trust, 'allow')).toEqual({ kind: 'allowed', text: 'Allowed — the agent starts now' });
    expect(c.decideConsent).toHaveBeenCalledWith('c-1', 'allow');
    const c2 = client();
    expect(await runConsent(as(c2), swit, 'deny')).toEqual({ kind: 'denied', text: 'Denied' });
    expect(c2.decideConsent).toHaveBeenCalledWith('c-2', 'deny');
  });

  it('outcomes: stale, lost (gone / still pending), rejected', async () => {
    expect(await runConsent(as(client({ outcome: 'stale' })), trust, 'deny')).toEqual({ kind: 'already-answered' });
    expect(await runConsent(as(client({ outcome: 'lost', stillPending: false })), trust, 'deny')).toEqual({ kind: 'no-longer-pending' });
    expect(await runConsent(as(client({ outcome: 'lost', stillPending: true })), trust, 'deny')).toEqual({ kind: 'unconfirmed' });
    expect(await runConsent(as(client({ outcome: 'rejected', code: 'unknown_method', message: 'off' })), trust, 'deny')).toEqual({ kind: 'error', text: 'off' });
    expect(await runConsent(as(client()), swit, 'allow')).toEqual({ kind: 'allowed', text: 'Allowed — continuing on Codex' });
  });

  it('words and ordering', () => {
    expect(trustTitle(trust as never)).toBe('Trust parley for agents?');
    expect(trustRequestedBy(trust as never)).toBe('Requested by Task1-types · create_session');
    expect(switchText('Greta', 'S', 'Codex', 'Usage limit')).toBe('Greta asks to continue S on Codex: Usage limit. Allow stops S now and continues it there.');
    expect(pendingConsents([trust, swit, { ...trust, id: 'c-3', state: 'allowed' }]).map((c) => c.id)).toEqual(['c-2', 'c-1']);
  });
});

describe('the Mac switch (M2)', () => {
  it('no Allow/Deny when consents.decide is not in the hello; an unknown hello shows them', () => {
    expect(canDecideConsent(['consents.list', 'consents.decide'])).toBe(true);
    expect(canDecideConsent(['consents.list'])).toBe(false);
    expect(canDecideConsent(null)).toBe(true);
  });
});

const mcp = {
  id: 'c-5', kind: 'project-mcp', version: 1, revision: 3, projectPath: '/p', repo: '/Users/me/parley', at: '2026-11-01T12:00:00.000Z', state: 'pending',
  servers: [{ name: 'fs', fingerprint: 'f1', command: 'npx fs-mcp /tmp' }, { name: 'web', fingerprint: 'f2', command: 'https://x.example/mcp' }],
  requestedBy: { source: 'launch' },
} as ProjectMcpCard;

describe('project-mcp card (A36b)', () => {
  it('title, shape key and the enabled pairs follow the card order', () => {
    expect(mcpTitle(mcp)).toBe('Enable MCP servers for parley?');
    expect(enabledPairs(mcp, new Set())).toEqual([]);
    expect(enabledPairs(mcp, new Set(['web', 'fs', 'ghost']))).toEqual([{ name: 'fs', fingerprint: 'f1' }, { name: 'web', fingerprint: 'f2' }]);
    expect(mcpShapeKey(mcp)).not.toBe(mcpShapeKey({ ...mcp, servers: [{ ...mcp.servers[0]!, fingerprint: 'f9' }, mcp.servers[1]!] }));
  });

  it('Enable selected sends the pairs; Reject all sends a bare deny', async () => {
    const c = client();
    const pairs = enabledPairs(mcp, new Set(['fs']));
    expect(await runConsent(as(c), mcp, 'allow', pairs)).toEqual({ kind: 'allowed', text: 'Enabled 1 server — the agent starts now' });
    expect(c.decideConsent).toHaveBeenCalledWith('c-5', 'allow', { enabled: [{ name: 'fs', fingerprint: 'f1' }], revision: 3 });
    const d = client();
    expect(await runConsent(as(d), mcp, 'deny', pairs)).toEqual({ kind: 'denied', text: 'Rejected — no servers enabled' });
    expect(d.decideConsent).toHaveBeenCalledWith('c-5', 'deny', { revision: 3 });
  });

  it('bad_request says the list changed; other refusals keep the host text', async () => {
    expect(await runConsent(as(client({ outcome: 'rejected', code: 'bad_request', message: 'pair mismatch' })), mcp, 'allow', [])).toEqual({ kind: 'error', text: MCP_CHANGED });
    expect(MCP_CHANGED).toBe('The server list changed — review again');
    expect(await runConsent(as(client({ outcome: 'rejected', code: 'unknown_method', message: 'off' })), mcp, 'allow', [])).toEqual({ kind: 'error', text: 'off' });
  });

  it('a card without version or with an unknown one is not drawn', () => {
    expect(projectMcpDrawable(mcp)).toBe(true);
    expect(projectMcpDrawable({ ...mcp, version: 2 } as never)).toBe(false);
    const bare: Partial<ProjectMcpCard> = { ...mcp };
    delete bare.version;
    expect(projectMcpDrawable(bare as never)).toBe(false);
  });
});

describe('cardBelongsToSession (M1)', () => {
  const ref = { projectPath: '/p', workId: 'w', sessionId: 's' };
  const by = (requestedBy: ProjectMcpCard['requestedBy'], projectPath = '/p') => ({ ...mcp, projectPath, requestedBy }) as ProjectMcpCard;

  it('a human launch without sessionId shows on the held session of its work', () => {
    expect(cardBelongsToSession(by({ source: 'launch', workId: 'w' }), ref)).toBe(true);
  });
  it('a child launch whose requester is the parent shows on the parent and on the child of the same work', () => {
    const card = by({ source: 'agent', sessionId: 'parent', workId: 'w' });
    expect(cardBelongsToSession(card, { ...ref, sessionId: 'child' })).toBe(true);
    expect(cardBelongsToSession(card, { ...ref, sessionId: 'parent' })).toBe(true);
  });
  it('another work or another project does not match', () => {
    expect(cardBelongsToSession(by({ source: 'launch', workId: 'other' }), ref)).toBe(false);
    expect(cardBelongsToSession(by({ source: 'launch', workId: 'w' }, '/q'), ref)).toBe(false);
    expect(cardBelongsToSession(by({ source: 'launch' }), ref)).toBe(false);
  });
  it('the requester match holds across project paths; agent-switch keeps its own rule', () => {
    expect(cardBelongsToSession(by({ source: 'agent', sessionId: 's', workId: 'w' }, '/q'), ref)).toBe(true);
    expect(cardBelongsToSession(swit, { projectPath: '/p', workId: 'w', sessionId: 's' })).toBe(true);
    expect(cardBelongsToSession(swit, { ...ref, sessionId: 'x' })).toBe(false);
    expect(cardBelongsToSession(trust, ref)).toBe(false);
  });
});
