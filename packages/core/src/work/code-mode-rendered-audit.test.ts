// Rendered-output audit, second layer of the T8a guard (the first is the literal sweep). It renders the generated texts an agent
// reads besides the session layer (that one is audited in launch.test.ts): every listed tool's description and schema text under the
// three launch universes, the lead/member role lines, the stuck, back and delivery letters, and the Code Mode busy refusals.
// Each rendered name must resolve through the launch route; a name outside the universe may stand only where it is listed below.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATION_REGISTRY } from '../mcp/code-mode/migration-registry.js';
import { nativePolicyReason } from '../mcp/code-mode/broker.js';
import { buildCatalog } from '../mcp/code-mode/catalog.js';
import { BUSY_REASONS, ERROR_MESSAGES, compileCallValidators, computeApiRevision, makeExecuteResult } from '../mcp/code-mode/contracts.js';
import { createCodeModeSurface } from '../mcp/code-mode-tools.js';
import { createBrowserTools } from '../mcp/browser-tools.js';
import { CREATE_SESSION_TOOL, REQUEST_AGENT_SWITCH_TOOL } from '../mcp/session-tools.js';
import { CREATE_SWARM_TOOL, SWARM_ADD_TOOL } from '../mcp/swarm-tools.js';
import { createToolRunner } from '../mcp/tools.js';
import { LEAD_ROLE, memberRole } from './brief.js';
import { GUIDE_TOPICS } from './guide.js';
import { SKILL_MD } from './skill.js';
import { CLASSIC_ROUTING, WRAPPER_NAMES, bootstrapText, fixtureRouting, guideOperations, guideRouting, recipeRoutingNote, replacementRouting, roleRoutingNote, routeOf } from './code-mode-instructions.js';
import { LIMIT_RETURN_TEXT, pointerText } from './delivery.js';
import { BROWSER_PRIORITY_RULE, CODEX_APPROVAL_GUIDANCE, stableGuidance } from './guidance.js';
import { addSession, transitionSession } from './map.js';
import { backLetter, stuckHint, stuckWarning, type NeedKind, type SessionNeed } from './stuck.js';
import { createWork, updateMap, workPaths } from './store.js';

const NAMES = MIGRATION_REGISTRY.entries.map((e) => e.name);
const namesIn = (text: string): string[] => [...new Set([...text.matchAll(new RegExp(`(?<![A-Za-z0-9_])(${NAMES.join('|')})(?![A-Za-z0-9_])`, 'g'))].map((m) => m[1]!))].sort();

let root = '';
let previousHome: string | undefined;
const universe: Record<'full agent' | 'short agent' | 'full, no agent channel', Tool[]> = { 'full agent': [], 'short agent': [], 'full, no agent channel': [] };

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-code-mode-audit-'));
  const project = path.join(root, 'project');
  await mkdir(project);
  previousHome = process.env.PARLEY_HOME;
  process.env.PARLEY_HOME = path.join(root, 'home');
  const workId = (await createWork(project, { title: 'Audit' })).work.id;
  await updateMap(project, workId, (map) => {
    transitionSession(map, addSession(map, { provider: 'codex', label: 'codex', task: 'Audit' }).id, 'active');
  });
  const base = { projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false };
  const full = await createToolRunner(base).list();
  const short = await createToolRunner({ ...base, toolProfile: 'short' }).list();
  const extra = [...createBrowserTools({ url: 'http://127.0.0.1:1', token: 'x' }, {}).tools, CREATE_SESSION_TOOL, REQUEST_AGENT_SWITCH_TOOL, CREATE_SWARM_TOOL, SWARM_ADD_TOOL];
  universe['full agent'] = [...full, ...extra];
  universe['short agent'] = [...short, ...extra];
  universe['full, no agent channel'] = full;
});

afterAll(async () => {
  if (previousHome === undefined) delete process.env.PARLEY_HOME;
  else process.env.PARLEY_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

/** Every string a tool shows an agent: its description and each description inside its input schema. */
function toolTexts(tool: Tool): string {
  const parts: string[] = [tool.description ?? ''];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'description' && typeof value === 'string') parts.push(value);
        else walk(value);
      }
    }
  };
  walk(tool.inputSchema);
  return parts.join('\n');
}

const MODES = [
  ['classic', CLASSIC_ROUTING],
  ['replacement, shipped registry', replacementRouting(MIGRATION_REGISTRY)],
  ['replacement, transitional fixture', fixtureRouting(['get_map'])],
  ['replacement, zero-residual fixture', fixtureRouting(['get_map', 'send_message', 'check_inbox', 'wait_for', 'report'])],
] as const;

describe('tool descriptions: every name a listed tool mentions resolves through the launch', () => {
  // Measured cross-references to a tool the launch does not list (a description of a listed tool that points at an unlisted one).
  const KNOWN_UNAVAILABLE: Record<string, Record<string, string[]>> = {
    'full agent': {},
    'short agent': {},
    // create_session is a session-level tool of the agent channel; three descriptions of core tools still point at it (classic text, locked byte for byte)
    'full, no agent channel': { get_map: ['create_session'], list_roles: ['create_session'], report: ['create_session'] },
  };

  it.each(Object.keys(universe))('%s', (label) => {
    const tools = universe[label as keyof typeof universe];
    const listed = tools.map((tool) => tool.name);
    const unavailable: Record<string, string[]> = {};
    for (const tool of tools) {
      const bad = namesIn(toolTexts(tool)).filter((name) => routeOf(name, listed, CLASSIC_ROUTING) === 'unavailable');
      if (bad.length > 0) unavailable[tool.name] = bad;
    }
    expect(unavailable).toEqual(KNOWN_UNAVAILABLE[label]);
  });

  it('the wrapper names appear in no listed tool text of the classic server', () => {
    for (const tools of Object.values(universe)) for (const tool of tools) for (const wrapper of WRAPPER_NAMES) expect(toolTexts(tool), tool.name).not.toContain(wrapper);
  });
});

describe('generated letters and role lines', () => {
  const NEEDS: NeedKind[] = ['approval', 'question', 'limit', 'sign-in', 'startup'];
  const now = new Date('2026-11-09T10:00:00.000Z');
  const need = (kind: NeedKind): SessionNeed => ({ kind, since: now.toISOString(), detail: null, resetsAt: null, window: null, account: null });
  const texts: Record<string, string> = {
    'lead role': LEAD_ROLE,
    'member role': memberRole('@s02'),
    'limit return': LIMIT_RETURN_TEXT,
    'pointer (no rooms)': pointerText([], []),
    'approval recovery': CODEX_APPROVAL_GUIDANCE,
    'browser rule': BROWSER_PRIORITY_RULE,
    'stable guidance': stableGuidance(),
    'stable guidance, short': stableGuidance({ toolProfile: 'short' }),
    ...Object.fromEntries(NEEDS.flatMap((kind) => [[`stuck hint ${kind}`, stuckHint('s-02', need(kind), now)], [`stuck warning ${kind}`, stuckWarning('s-02', need(kind), now)], [`back letter ${kind}`, backLetter('s-02', kind)]])),
  };

  it.each(MODES)('%s: each name resolves in the full agent universe; unlisted names are none', (_mode, routing) => {
    const listed = universe['full agent'].map((tool) => tool.name);
    for (const [label, text] of Object.entries(texts)) {
      for (const name of namesIn(text)) expect(routeOf(name, listed, routing), `${label}: ${name}`).not.toBe('unavailable');
    }
  });

  it('none of them names a wrapper: the convention, not these texts, introduces code_execute', () => {
    for (const [label, text] of Object.entries(texts)) for (const wrapper of WRAPPER_NAMES) expect(text, label).not.toContain(wrapper);
  });

  it('the Code Mode refusals do not call the remaining tools "classic" and name the wrapper they refuse', () => {
    for (const [kind, message] of Object.entries(ERROR_MESSAGES)) expect(message, kind).not.toMatch(/classic/i);
  });
});

describe('replacement-only texts stay true when the client lists none of the Parley tools (tool search, a subagent)', () => {
  // Claude Code with tool search lists 0 mcp__parley__* tools up front, and a native subagent gets no bootstrap (s-296 m-6809): no text may say
  // that a name absent from "your tool list" is unavailable; availability is decided by the launch, the route and the client's on-demand loading.
  const universeNames = universe['full agent'].map((tool) => tool.name);
  const routings = MODES.filter(([, routing]) => routing.mode === 'replacement').map(([, routing]) => routing);

  it('the bootstrap says "listed or loadable on demand", names the tool descriptions as a route and never says "tool list"', () => {
    for (const routing of routings) {
      const text = bootstrapText(routing);
      expect(text).toContain("routed by your Parley tools' descriptions");
      expect(text).toContain('(listed or loadable on demand)');
      expect(text).not.toMatch(/tool list|in your list/i);
    }
  });

  it('no routing block of any topic, mode or universe says "tool list" or "in your list"', () => {
    const universes = [universeNames, universe['short agent'].map((t) => t.name), universe['full, no agent channel'].map((t) => t.name), []];
    for (const routing of routings) {
      for (const names of universes) {
        for (const topic of [null, ...GUIDE_TOPICS.map((t) => t.topic)]) expect(guideRouting(routing, names, topic), String(topic)).not.toMatch(/tool list|in your list/i);
      }
    }
  });

  it('a classic launch carries no bootstrap and no block even for the same tool universe', () => {
    expect(bootstrapText(CLASSIC_ROUTING)).toBe('');
    for (const topic of [null, ...GUIDE_TOPICS.map((t) => t.topic)]) expect(guideRouting(CLASSIC_ROUTING, universeNames, topic)).toBe('');
  });
});

// ----- T8e R3/R4/R5/R6: the texts a Claude subagent (no bootstrap) or a deferred-tools client can still read -----
// Fixture of Parley-authored text and lists, not a claim about what a native subagent or model does (that is T12b).
describe('T8e: replacement-only text routes by itself, whatever the client lists up front', () => {
  const FULL = universe['full agent'].map((t) => t.name);
  const NO_AGENT = universe['full, no agent channel'].map((t) => t.name);
  const SHORT = universe['short agent'].map((t) => t.name);
  const ROUTES = MODES.filter(([, routing]) => routing.mode === 'replacement').map(([, routing]) => routing);
  // The one exception to the ban on the bare word "listed": the phrase that says "or loadable on demand" (m-6869).
  const bareListed = (text: string): string[] => [...text.split('listed or loadable on demand').join('').matchAll(/\blisted\b/gi)].map((m) => m[0]);
  const toolListClaim = /tool list|in your list|your list/i;

  /** Every replacement-only agent-visible text this task can enumerate, with where it comes from. */
  function replacementTexts(): { label: string; text: string }[] {
    const out: { label: string; text: string }[] = [];
    const wrappers = createCodeModeSurface({ backend: () => { throw new Error('not used: listing needs no backend'); } }).tools;
    for (const tool of wrappers) out.push({ label: `wrapper ${tool.name}`, text: toolTexts(tool as never) });
    out.push({ label: 'stub SKILL.md', text: SKILL_MD });
    for (const [kind, message] of Object.entries(ERROR_MESSAGES)) out.push({ label: `error ${kind}`, text: message });
    // The busy texts, through the existing diagnostic path (one per reason, so a new reason is scanned too), and the native-policy reason of a refused run.
    const catalog = buildCatalog(universe['full agent']);
    const validators = compileCallValidators(catalog, computeApiRevision({ catalog, launch: 'audit-launch', policySnapshot: 'unavailable' }));
    for (const reason of BUSY_REASONS) {
      const busy = makeExecuteResult(validators, { runId: null, status: 'error', value: null, error: { kind: 'busy' }, operations: [], diagnostics: [{ code: 'busy', params: { reason } }] });
      out.push({ label: `busy ${reason}`, text: busy.diagnostics[0]!.message });
    }
    for (const terminal of ['revoked', 'stale']) out.push({ label: `native policy ${terminal}`, text: nativePolicyReason(terminal) });
    for (const routing of ROUTES) {
      out.push({ label: 'bootstrap', text: bootstrapText(routing) });
      for (const names of [FULL, NO_AGENT, SHORT, []]) {
        for (const topic of [null, ...GUIDE_TOPICS.map((t) => t.topic)]) out.push({ label: `guide block ${topic}`, text: guideRouting(routing, names, topic) });
        for (const id of ['builtin:feature-lead', 'builtin:planner']) out.push({ label: `role note ${id}`, text: roleRoutingNote(id, routing, names) });
        for (const id of ['builtin:plan-build', 'builtin:review', 'builtin:debug']) out.push({ label: `recipe note ${id}`, text: recipeRoutingNote(id, routing, names) });
      }
    }
    return out;
  }

  it('R3/R5: no replacement-only text says "tool list" or leans on the bare word "listed"', () => {
    const texts = replacementTexts();
    // the producers the rule names are really in the scan: every busy reason and both terminal policy reasons
    expect(texts.filter((t) => t.label.startsWith('busy ')).map((t) => t.label)).toEqual(BUSY_REASONS.map((r) => `busy ${r}`));
    expect(texts.filter((t) => t.label.startsWith('native policy ')).map((t) => t.label)).toEqual(['native policy revoked', 'native policy stale']);
    for (const { label, text } of texts) {
      expect(text, label).not.toMatch(toolListClaim);
      expect(bareListed(text), label).toEqual([]);
    }
  });

  it('R4: the code_execute description says how to call a method and where the revision comes from, with no bootstrap needed', () => {
    const execute = replacementTexts().find((t) => t.label === 'wrapper code_execute')!.text;
    expect(execute).toContain('parley.<name>(args)');
    expect(execute).toContain('apiRevision from code_search or code_docs');
  });

  it('R4: the stub a subagent can load carries the rule: a Parley operation is a tool of the parley server unless the instructions or the tool descriptions route it, and "unavailable" needs a client that offers it neither listed nor loadable', () => {
    expect(SKILL_MD).toContain('A name such as `get_map` is a Parley operation.');
    expect(SKILL_MD).toContain("unless this launch's instructions or your Parley tools' descriptions route it another way; those win");
    expect(SKILL_MD).toContain('listed or loadable on demand');
    for (const wrapper of WRAPPER_NAMES) expect(SKILL_MD).not.toContain(wrapper);
  });

  it('R5: every "unavailable" in the bootstrap, the guide blocks and the notes is bound to this launch, never to a client list', () => {
    let checked = 0;
    for (const { label, text } of replacementTexts().filter((t) => /^(bootstrap|guide block|role note|recipe note)/.test(t.label))) {
      for (const line of text.split('\n').flatMap((l) => l.split(/(?<=\.) /)).filter((l) => /unavailable|not available/i.test(l))) {
        checked += 1;
        expect(line, `${label}: ${line}`).toMatch(/in this launch|available here|unavailable here|offered by your client \(listed or loadable on demand\)/);
      }
    }
    // the loop must really have seen the claims it is about (bootstrap rule, guide-block lines, T8c sentences), not pass on nothing
    expect(checked).toBeGreaterThan(20);
  });

  it('R6: with the same universe and no bootstrap, the guide block still places every named operation under exactly one route', () => {
    for (const routing of ROUTES) {
      for (const topic of GUIDE_TOPICS.map((t) => t.topic)) {
        const block = guideRouting(routing, FULL, topic);
        const lines = block.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- report, wait_for'));
        const named = lines.flatMap((l) => l.slice(l.indexOf(': ') + 2).replace(/ \(.*$/, '').replace(/\.$/, '').split(', ')).filter((n) => REGISTRY_NAMES_AUDIT.includes(n));
        expect(named.sort(), topic).toEqual(guideOperations(topic));
        expect(new Set(named).size, topic).toBe(named.length);
      }
    }
  });
});
const REGISTRY_NAMES_AUDIT = MIGRATION_REGISTRY.entries.map((e) => e.name);
