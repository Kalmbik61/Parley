// T10 offline accounting (script, preparation only). A strict READER of the T9a replay report plus the frozen goals and scripts files: it starts no process,
// calls no model, installs nothing, and computes no money. Every leaf of its report is either `measured` (value, unit, source) or `not-measured` with a reason
// from the closed list below; an unknown is never a 0 or a null. Static declaration size is a ceiling, not a request cost (plan P:1283); native usage,
// deferred discovery, adherence and cost are T10 itself and appear here only as `not-measured / needs-paid-run`.
//
// Design note: .parley/review/T10-script-design.md (s-292 and s-296 CLEAR). Nothing under tools/parley-token-benchmark-replay* is edited; only committed
// shapes of it are imported.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkGoalFile, type Goal } from './parley-token-benchmark-replay-schema.js';
import { PINNED_TOKENIZER, loadPinnedTokenizer } from './parley-token-benchmark.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const utf8 = (text: string): number => Buffer.byteLength(text, 'utf8');
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;

/** The closed list of reasons a number is absent. */
export const REASONS = [
  'no-t9a-report', 't9a-not-passed', 'sha-mismatch', 'report-shape', 'no-pinned-tokenizer', 'scripts-not-frozen', 'final-surface-not-declared',
  'final-surface-mismatch', 'harness-does-not-expose', 'needs-paid-run', 'bootstrap-not-given',
] as const;
export type Reason = (typeof REASONS)[number];

export type Metric<T> =
  | { readonly status: 'measured'; readonly value: T; readonly unit: string; readonly source: string }
  | { readonly status: 'not-measured'; readonly reason: Reason; readonly detail: string };
const measured = <T>(value: T, unit: string, source: string): Metric<T> => ({ status: 'measured', value, unit, source });
const missing = (reason: Reason, detail: string): Metric<never> => ({ status: 'not-measured', reason, detail });

export const PINNED_LABEL = `${PINNED_TOKENIZER.package}@${PINNED_TOKENIZER.version}/${PINNED_TOKENIZER.encoder}`;
export const STATIC_LABEL = 'static declaration size: a ceiling, not a request cost. With Claude tool search the initial classic request carried zero mcp__parley__* declarations (plan P:1283).';
export const RECEIVED_LABEL = 'all server-to-client bytes of the arm, including the MCP handshake and tools/list; frozen before the conservation phase, so that phase is excluded';
export const HEADER =
  'T10 offline accounting. Replay/static numbers only: no model, no paid call, no native usage, no money. Fixed-encoder token counts are corpus counts, never provider usage. ' +
  'Valid for the tree hash below only. No percent, no savings, no verdict: a difference is two numbers side by side.';

// ---------- the T9a report, read strictly ----------

type Arm = 'classic' | 'replacement';
export interface ListView {
  readonly exposure: string; readonly originalTools: number; readonly residualTools: number; readonly wrapperTools: number;
  readonly residualBytes: number; readonly wrappersBytes: number; readonly totalBytes: number; readonly residualTokens: number; readonly wrappersTokens: number;
  readonly tokenizer: string;
}
export interface MessageView { readonly id: number | string | null; readonly kind: string; readonly bytes: number }
export interface ArmView {
  readonly list: ListView;
  /** What each message the client received answered, in order (T9a `armAccounting.perMessage`); empty when the harness did not supply it. */
  readonly perMessage: readonly MessageView[]; readonly residualNames: readonly string[];
  readonly calls: { readonly direct: number; readonly wrapper: number; readonly nested: number }; readonly context: { readonly bytes: number; readonly tokens: number };
}
export interface ReportView {
  readonly treeHash: string; readonly buildStamp: string; readonly goalsSha: string; readonly scriptsSha: string; readonly tokenizer: string;
  readonly accounting: Readonly<Record<string, Partial<Record<Arm, ArmView>>>>;
}
export interface Refusal { readonly reason: Reason; readonly detail: string }

const LIST_FIELDS = ['originalTools', 'residualTools', 'wrapperTools', 'residualBytes', 'wrappersBytes', 'totalBytes', 'residualTokens', 'wrappersTokens'] as const;

function readArm(v: unknown, where: string, bad: string[]): ArmView | null {
  if (!isObj(v) || !isObj(v['list']) || !isObj(v['calls']) || !isObj(v['context']) || !Array.isArray(v['residualNames'])) { bad.push(`${where}: not an arm accounting`); return null; }
  const l = v['list'];
  for (const f of LIST_FIELDS) if (!isCount(l[f])) bad.push(`${where}.list.${f}: a non-negative integer`);
  if (typeof l['exposure'] !== 'string' || typeof l['tokenizer'] !== 'string') bad.push(`${where}.list: exposure and tokenizer are strings`);
  for (const f of ['direct', 'wrapper', 'nested']) if (!isCount((v['calls'] as Obj)[f])) bad.push(`${where}.calls.${f}: a non-negative integer`);
  for (const f of ['bytes', 'tokens']) if (!isCount((v['context'] as Obj)[f])) bad.push(`${where}.context.${f}: a non-negative integer`);
  if (!(v['residualNames'] as unknown[]).every((n) => typeof n === 'string')) bad.push(`${where}.residualNames: strings`);
  const pm = v['perMessage'];
  if (pm !== undefined) {
    if (!Array.isArray(pm)) bad.push(`${where}.perMessage: an array`);
    else {
      let sum = 0;
      for (const [i, m] of pm.entries()) {
        if (!isObj(m) || typeof m['kind'] !== 'string' || !isCount(m['bytes']) || !(m['id'] === null || typeof m['id'] === 'string' || typeof m['id'] === 'number')) bad.push(`${where}.perMessage[${i}]: { id, kind, bytes }`);
        else sum += m['bytes'] as number;
      }
      // the list is pinned by its sum: a list that does not add up to what the client received is not that arm's list
      if (pm.length > 0 && bad.length === 0 && sum !== (v['context'] as Obj)['bytes']) bad.push(`${where}.perMessage: its bytes add up to ${sum}, the client received ${String((v['context'] as Obj)['bytes'])}`);
    }
  }
  return bad.length === 0 ? ({ ...(v as unknown as ArmView), perMessage: Array.isArray(pm) ? (pm as MessageView[]) : [] }) : null;
}

/**
 * The gate: a T9a report is used only if it passed on the frozen goals and the frozen scripts, with no skips and no failed goal, and carries the tree hash,
 * the build stamp and a well-formed accounting block. Anything else refuses the whole offline block, named; no number is carried over from a report that
 * is not the evidence it claims to be.
 */
export function readT9aReport(raw: unknown, expected: { readonly goalsSha: string; readonly scriptsSha: string }): { readonly ok: true; readonly report: ReportView } | { readonly ok: false; readonly refusals: readonly Refusal[] } {
  if (!isObj(raw)) return { ok: false, refusals: [{ reason: 'report-shape', detail: 'the T9a report is not a JSON object' }] };
  const out: Refusal[] = [];
  if (raw['passed'] !== true) out.push({ reason: 't9a-not-passed', detail: `passed=${String(raw['passed'])}` });
  if (!isCount(raw['failed']) || raw['failed'] !== 0) out.push({ reason: 't9a-not-passed', detail: `failed=${String(raw['failed'])}` });
  const skips = raw['skips'];
  if (!isObj(skips) || skips['classic'] !== 0 || skips['replacement'] !== 0) out.push({ reason: 't9a-not-passed', detail: `skips=${JSON.stringify(skips)}` });
  if (raw['goalsSha'] !== expected.goalsSha || raw['goalsShaOk'] !== true) out.push({ reason: 'sha-mismatch', detail: `report goalsSha ${String(raw['goalsSha'])} is not the frozen ${expected.goalsSha}` });
  if (expected.scriptsSha === '') out.push({ reason: 'scripts-not-frozen', detail: 'the frozen scripts sha is not set' });
  else if (raw['scriptsSha'] !== expected.scriptsSha || raw['scriptsShaOk'] !== true) out.push({ reason: 'sha-mismatch', detail: `report scriptsSha ${String(raw['scriptsSha'])} is not the frozen ${expected.scriptsSha}` });
  for (const f of ['treeHash', 'buildStamp', 'tokenizer'] as const) if (typeof raw[f] !== 'string' || raw[f] === '') out.push({ reason: 'report-shape', detail: `${f} is missing` });
  // the stamp the gate wrote for the run: exactly { protocol, core, run }, both builds exited 0, a run id. This proves the gate built dist from that tree.
  if (typeof raw['buildStamp'] === 'string' && raw['buildStamp'] !== '') {
    let stamp: unknown = null;
    try { stamp = JSON.parse(raw['buildStamp']); } catch { /* named below */ }
    if (!isObj(stamp) || Object.keys(stamp).sort().join() !== 'core,protocol,run' || stamp['protocol'] !== 0 || stamp['core'] !== 0 || typeof stamp['run'] !== 'string' || stamp['run'] === '') out.push({ reason: 'report-shape', detail: 'buildStamp is not { protocol: 0, core: 0, run: <id> }' });
  }
  const bad: string[] = [];
  const accounting: Record<string, Partial<Record<Arm, ArmView>>> = {};
  if (!isObj(raw['accounting'])) bad.push('accounting: an object per goal');
  else for (const [goal, arms] of Object.entries(raw['accounting'])) {
    if (!isObj(arms)) { bad.push(`accounting.${goal}: an object`); continue; }
    accounting[goal] = {};
    for (const arm of Object.keys(arms)) {
      if (arm !== 'classic' && arm !== 'replacement') { bad.push(`accounting.${goal}.${arm}: not an arm`); continue; }
      const a = readArm(arms[arm], `accounting.${goal}.${arm}`, bad);
      if (a !== null) accounting[goal]![arm] = a;
    }
  }
  for (const b of bad) out.push({ reason: 'report-shape', detail: b });
  if (out.length > 0) return { ok: false, refusals: out };
  return { ok: true, report: { treeHash: raw['treeHash'] as string, buildStamp: raw['buildStamp'] as string, goalsSha: raw['goalsSha'] as string, scriptsSha: raw['scriptsSha'] as string, tokenizer: raw['tokenizer'] as string, accounting } };
}

// ---------- request bytes from the scripts file ----------

interface ClassicCall { readonly name: string; readonly args: Obj }
interface ScriptView { readonly classic?: { readonly calls: readonly ClassicCall[] }; readonly replacement?: { readonly code: string; readonly search?: string; readonly second?: string; readonly next?: string } }

/** Reads the parts of the scripts file this report needs (`{ version: 1, scripts: [{ goal, classic?, replacement? }] }`); the full shape check is T9a's. */
export function readScripts(raw: unknown): { readonly ok: true; readonly byGoal: ReadonlyMap<string, ScriptView> } | { readonly ok: false; readonly detail: string } {
  if (!isObj(raw) || raw['version'] !== 1 || !Array.isArray(raw['scripts'])) return { ok: false, detail: 'the scripts file is { version: 1, scripts: [...] }' };
  const byGoal = new Map<string, ScriptView>();
  for (const [i, e] of (raw['scripts'] as unknown[]).entries()) {
    if (!isObj(e) || typeof e['goal'] !== 'string') return { ok: false, detail: `scripts[${i}]: no goal` };
    const c = e['classic']; const r = e['replacement'];
    if (c !== undefined && !(isObj(c) && Array.isArray(c['calls']) && (c['calls'] as unknown[]).every((x) => isObj(x) && typeof x['name'] === 'string' && isObj(x['args'])))) return { ok: false, detail: `scripts[${i}].classic: calls of { name, args }` };
    if (r !== undefined && !(isObj(r) && typeof r['code'] === 'string')) return { ok: false, detail: `scripts[${i}].replacement: code is a string` };
    if (byGoal.has(e['goal'])) return { ok: false, detail: `scripts[${i}]: ${e['goal']} twice` };
    byGoal.set(e['goal'], { ...(c === undefined ? {} : { classic: c as ScriptView['classic'] }), ...(r === undefined ? {} : { replacement: r as ScriptView['replacement'] }) } as ScriptView);
  }
  return { ok: true, byGoal };
}

export interface Counter { readonly count: (text: string) => number }
export interface RequestView { readonly requests: number; readonly bytes: number; readonly tokens: Metric<number>; readonly excludes: readonly string[] }

/**
 * What the arm's script asks, as the client would send it. Classic: each call as { name, arguments }. Replacement: the code_search query, the code_execute
 * code and any second/next script the goal sends. The apiRevision value is known only at run time, so it is excluded and the view says so.
 */
export function requestView(arm: Arm, script: ScriptView, counter: Counter | null): RequestView | null {
  const texts: string[] = [];
  if (arm === 'classic') { if (script.classic === undefined) return null; for (const c of script.classic.calls) texts.push(JSON.stringify({ name: c.name, arguments: c.args })); }
  else {
    const r = script.replacement; if (r === undefined) return null;
    texts.push(JSON.stringify({ name: 'code_search', arguments: { query: r.search ?? 'parley' } }));
    for (const code of [r.code, ...(r.second === undefined ? [] : [r.second]), ...(r.next === undefined ? [] : [r.next])]) texts.push(JSON.stringify({ name: 'code_execute', arguments: { code } }));
  }
  return {
    requests: texts.length, bytes: texts.reduce((n, t) => n + utf8(t), 0),
    tokens: counter === null ? missing('no-pinned-tokenizer', 'no verified pinned tokenizer was supplied') : measured(texts.reduce((n, t) => n + counter.count(t), 0), 'o200k_base tokens', PINNED_LABEL),
    excludes: arm === 'replacement' ? ['apiRevision value (known only at run time)'] : [],
  };
}

// ---------- the report ----------

/** `buildStamp` is the content of the stamp file the T9a gate wrote for the run; null when the file was not given (it need not outlive the run). */
export interface BootstrapInput { readonly text: string; readonly treeHash: string; readonly clean: boolean; readonly buildStamp: string | null; readonly source: string }
export interface OfflineInput {
  readonly goalsText: string; readonly expectedGoalsSha: string;
  readonly scriptsText: string | null; readonly expectedScriptsSha: string;
  readonly t9aReport: unknown | null;
  /** A counter only after its package and data hashes were verified against PINNED_TOKENIZER; otherwise null. */
  readonly counter: Counter | null;
  /** The rendered replacement bootstrap, read from the source of the checkout, with that checkout's tree hash and cleanliness. */
  readonly bootstrap: BootstrapInput | null;
  /** The T13 disposition's exact residual direct tools; null while T13 has not declared them. */
  readonly finalSurface: { readonly residuals: readonly string[]; readonly sha256: string } | null;
}

/** Fields that only a real agent run can fill: present, empty and named, so nobody reads silence as zero. */
export const NATIVE_FIELDS = [
  'initialRequestDeclarations', 'deferredDiscoveryCalls', 'deferredDiscoveryCost', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'turns',
  'elapsedMs', 'startupResource', 'wrapperAdherence', 'firstTrySuccess', 'errorsAndRetries', 'finalAnswerCorrectness', 'hiddenContextWrapping', 'bootstrapReachesSubagents', 'monetaryCost',
] as const;

const AUTHOR_BOOTSTRAP = { bytes: 656, tokens: 133, source: 'plan P:144 (author-attributed, not reproducible)' } as const;
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/**
 * Per-call result bytes from the harness's own per-message list. The handshake, the tool list and anything else are named apart; the
 * `tools/call` entries are the results the agent saw, one per call, in order. Absent list: not measured, with the reason.
 */
export function perCallResults(arm: ArmView, source: string): Metric<{ calls: readonly { kind: string; bytes: number }[]; callBytes: number; handshakeBytes: number; listBytes: number; otherBytes: number; totalBytes: number }> {
  if (arm.perMessage.length === 0) return missing('harness-does-not-expose', 'the T9a report carries no per-message list for this arm');
  const sum = (pred: (k: string) => boolean): number => arm.perMessage.filter((m) => pred(m.kind)).reduce((n, m) => n + m.bytes, 0);
  const isCall = (k: string): boolean => k.startsWith('tools/call ');
  const calls = arm.perMessage.filter((m) => isCall(m.kind)).map((m) => ({ kind: m.kind, bytes: m.bytes }));
  return measured(
    { calls, callBytes: sum(isCall), handshakeBytes: sum((k) => k === 'handshake'), listBytes: sum((k) => k === 'tools/list'), otherBytes: sum((k) => k !== 'handshake' && k !== 'tools/list' && !isCall(k)), totalBytes: sum(() => true) },
    'UTF-8 bytes', source,
  );
}

export function buildOffline(input: OfflineInput): Record<string, unknown> {
  const refusals: Refusal[] = [];
  const goalsSha = sha256(input.goalsText);
  let goals: readonly Goal[] = [];
  if (goalsSha !== input.expectedGoalsSha) refusals.push({ reason: 'sha-mismatch', detail: `goals file sha256 ${goalsSha} is not the frozen ${input.expectedGoalsSha}` });
  else {
    let parsed: unknown = null;
    try { parsed = JSON.parse(input.goalsText); } catch { refusals.push({ reason: 'report-shape', detail: 'goals file is not JSON' }); }
    const checked = checkGoalFile(parsed);
    if (checked.ok) goals = checked.goals; else refusals.push({ reason: 'report-shape', detail: `goals file: ${checked.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}` });
  }
  const scriptsSha = input.scriptsText === null ? null : sha256(input.scriptsText);
  let scripts: ReadonlyMap<string, ScriptView> | null = null;
  let scriptsNote: Refusal | null = null;
  if (input.scriptsText === null) scriptsNote = { reason: 'scripts-not-frozen', detail: 'no scripts file was given' };
  else if (input.expectedScriptsSha === '') scriptsNote = { reason: 'scripts-not-frozen', detail: 'the frozen scripts sha is not set' };
  else if (scriptsSha !== input.expectedScriptsSha) refusals.push({ reason: 'sha-mismatch', detail: `scripts file sha256 ${scriptsSha} is not the frozen ${input.expectedScriptsSha}` });
  else {
    let parsed: unknown = null;
    try { parsed = JSON.parse(input.scriptsText); } catch { /* shape refusal below */ }
    const r = readScripts(parsed);
    if (r.ok) scripts = r.byGoal; else refusals.push({ reason: 'report-shape', detail: `scripts file: ${r.detail}` });
  }

  let report: ReportView | null = null;
  let reportNote: Refusal[] = [];
  if (input.t9aReport === null) reportNote = [{ reason: 'no-t9a-report', detail: 'no T9a report was given' }];
  else {
    const r = readT9aReport(input.t9aReport, { goalsSha: input.expectedGoalsSha, scriptsSha: input.expectedScriptsSha });
    if (r.ok) report = r.report; else reportNote = [...r.refusals];
  }
  // the report's own token fields are tokens only if the run counted with the pinned tokenizer (T9a falls back to UTF-8 bytes, labelled "not tokens")
  const reportTokens = (v: number): Metric<number> =>
    report === null ? missing('no-t9a-report', 'no accepted T9a report') : report.tokenizer !== PINNED_LABEL ? missing('no-pinned-tokenizer', `the T9a report counted with "${report.tokenizer}"`) : measured(v, 'o200k_base tokens', `T9a report, ${PINNED_LABEL}`);
  // the script's own counts (requests, bootstrap) use the counter the caller verified against PINNED_TOKENIZER
  const ownCounter = input.counter;
  const src = (path: string): string => `T9a report ${path}`;

  // run goals on both arms: the only offline classic/replacement pairs
  const paired = goals.filter((g) => g.kind === 'run' && g.arms.includes('classic') && g.arms.includes('replacement'));
  const runGoals = goals.filter((g) => g.kind === 'run');
  const perGoal: Record<string, Record<string, unknown>> = {};
  const cover = { declarations: 0, requests: 0, received: 0 };
  for (const g of runGoals) {
    const row: Record<string, unknown> = {};
    for (const arm of g.arms) {
      const a = report?.accounting[g.id]?.[arm];
      const req = scripts === null || scripts.get(g.id) === undefined ? null : requestView(arm, scripts.get(g.id)!, ownCounter);
      if (a !== undefined) cover.declarations += 1;
      if (req !== null) cover.requests += 1;
      if (a !== undefined) cover.received += 1;
      row[arm] = {
        declarations: a === undefined ? missing(report === null ? 'no-t9a-report' : 'report-shape', report === null ? 'no accepted T9a report' : `the report has no ${arm} accounting for ${g.id}`)
          : { status: 'measured', label: STATIC_LABEL, source: src(`accounting.${g.id}.${arm}.list`), tools: a.list.originalTools, residualTools: a.list.residualTools, wrapperTools: a.list.wrapperTools, bytes: a.list.totalBytes, tokens: reportTokens(a.list.residualTokens + a.list.wrappersTokens), residualNames: a.residualNames },
        requests: req === null ? missing(scriptsNote?.reason ?? 'report-shape', scriptsNote?.detail ?? `no ${arm} script for ${g.id}`) : { status: 'measured', source: 'scripts file, JSON of each call', ...req },
        receivedBytes: a === undefined ? missing('no-t9a-report', 'no accepted T9a report') : measured(a.context.bytes, 'UTF-8 bytes', src(`accounting.${g.id}.${arm}.context.bytes`)),
        receivedTokens: a === undefined ? missing('no-t9a-report', 'no accepted T9a report') : reportTokens(a.context.tokens),
        receivedLabel: RECEIVED_LABEL,
        perCallResultBytes: a === undefined ? missing('no-t9a-report', 'no accepted T9a report') : perCallResults(a, src(`accounting.${g.id}.${arm}.perMessage`)),
        calls: a === undefined ? missing('no-t9a-report', 'no accepted T9a report') : { status: 'measured', ...a.calls, source: src(`accounting.${g.id}.${arm}.calls`) },
      };
    }
    perGoal[g.id] = row;
  }

  // side-by-side, only where both sides are measured; never a verdict
  const sideBySide: Record<string, unknown> = {};
  for (const g of paired) {
    const c = report?.accounting[g.id]?.classic; const r = report?.accounting[g.id]?.replacement;
    if (c === undefined || r === undefined) continue;
    const rc = perCallResults(c, ''); const rr = perCallResults(r, '');
    sideBySide[g.id] = {
      ...(rc.status === 'measured' && rr.status === 'measured' ? { resultBytes: { classic: rc.value.callBytes, replacement: rr.value.callBytes, replacementMinusClassic: rr.value.callBytes - rc.value.callBytes, label: 'bytes of the tools/call results the client received, from the harness per-message list' } } : {}),
      declarationBytes: { classic: c.list.totalBytes, replacement: r.list.totalBytes, replacementMinusClassic: r.list.totalBytes - c.list.totalBytes, label: STATIC_LABEL },
      receivedBytes: { classic: c.context.bytes, replacement: r.context.bytes, replacementMinusClassic: r.context.bytes - c.context.bytes, label: RECEIVED_LABEL },
    };
  }

  // the surface actually measured
  const replacementGoals = runGoals.filter((g) => g.arms.includes('replacement') && report?.accounting[g.id]?.replacement !== undefined);
  let surface: Record<string, unknown>;
  if (input.finalSurface === null) surface = { measured: 'interim', declaredFinal: false, reason: 'final-surface-not-declared', detail: 'T13 has not declared the final residual list; the replacement lists measured are the interim five-read surface' };
  else {
    const off = replacementGoals.filter((g) => !same(report!.accounting[g.id]!.replacement!.residualNames, input.finalSurface!.residuals)).map((g) => g.id);
    surface = off.length === 0 && replacementGoals.length > 0
      ? { measured: 'declared-final', declaredFinal: true, residuals: [...input.finalSurface.residuals].sort(), declarationSha256: input.finalSurface.sha256 }
      : { measured: 'interim', declaredFinal: false, reason: 'final-surface-mismatch', detail: replacementGoals.length === 0 ? 'no replacement accounting to compare' : `residual names differ from the declared final surface on: ${off.join(', ')}`, declarationSha256: input.finalSurface.sha256 };
  }

  // bootstrap: refused unless it comes from the report's own tree
  let bootstrap: Record<string, unknown>;
  if (input.bootstrap === null) bootstrap = missing('bootstrap-not-given', 'no bootstrap text was given');
  else if (report === null) bootstrap = missing('no-t9a-report', 'no accepted T9a report to bind the bootstrap to');
  else if (!input.bootstrap.clean || input.bootstrap.treeHash !== report.treeHash) bootstrap = missing('sha-mismatch', `the bootstrap was read from tree ${input.bootstrap.treeHash} (clean=${String(input.bootstrap.clean)}), the T9a report is for ${report.treeHash}`);
  else if (input.bootstrap.buildStamp !== null && input.bootstrap.buildStamp !== report.buildStamp) bootstrap = missing('sha-mismatch', 'the build stamp file given is not the stamp the T9a report carries: it is not the same run');
  else {
    const bytes = utf8(input.bootstrap.text);
    bootstrap = {
      status: 'measured', source: input.bootstrap.source, treeHash: input.bootstrap.treeHash, bytes,
      tokens: ownCounter !== null ? measured(ownCounter.count(input.bootstrap.text), 'o200k_base tokens', PINNED_LABEL) : missing('no-pinned-tokenizer', 'no verified pinned tokenizer was supplied'),
      stampFile: input.bootstrap.buildStamp === null ? 'not given (the gate keeps it in TMPDIR, which does not outlive the run); the report stamp is still checked' : 'equals the report stamp',
      authorAttributed: { ...AUTHOR_BOOTSTRAP, bytesEqual: bytes === AUTHOR_BOOTSTRAP.bytes },
    };
  }

  const gaps: { goal: string; arm: string; metric: string; reason: Reason }[] = [];
  for (const g of runGoals) for (const arm of g.arms) {
    if (report?.accounting[g.id]?.[arm] === undefined) gaps.push({ goal: g.id, arm, metric: 'declarations+received', reason: report === null ? 'no-t9a-report' : 'report-shape' });
    if (scripts === null || scripts.get(g.id)?.[arm] === undefined) gaps.push({ goal: g.id, arm, metric: 'requests', reason: scriptsNote?.reason ?? 'report-shape' });
    const a = report?.accounting[g.id]?.[arm];
    if (a !== undefined && a.perMessage.length === 0) gaps.push({ goal: g.id, arm, metric: 'perCallResultBytes', reason: 'harness-does-not-expose' });
  }

  return {
    header: HEADER,
    refused: refusals.length > 0,
    refusals,
    inputs: { goalsSha, scriptsSha, t9a: report === null ? null : { treeHash: report.treeHash, buildStamp: report.buildStamp, tokenizer: report.tokenizer }, t9aNotAccepted: reportNote, scriptsNote, tokenizer: ownCounter !== null ? PINNED_LABEL : null },
    incomplete: refusals.length > 0 || reportNote.length > 0 || scriptsNote !== null || gaps.length > 0 || surface['declaredFinal'] !== true,
    coverage: { runGoals: runGoals.length, runGoalsBothArms: paired.length, armsWithDeclarations: cover.declarations, armsWithRequests: cover.requests, armsWithReceived: cover.received, gaps },
    surface,
    bootstrap,
    perGoal,
    sideBySide,
    native: Object.fromEntries(NATIVE_FIELDS.map((f) => [f, missing('needs-paid-run', 'only the isolated paid T10 INTERIM/FINAL run produces this')])),
  };
}

// ---------- the markdown rendering ----------

/** Renders the JSON report; it carries no number the JSON does not. */
export function renderMarkdown(report: Record<string, unknown>): string {
  const lines = [`# T10 offline accounting`, '', String(report['header']), ''];
  const refusals = report['refusals'] as Refusal[];
  if (refusals.length > 0) lines.push('## Refused', ...refusals.map((r) => `- ${r.reason}: ${r.detail}`), '');
  const cov = report['coverage'] as { runGoals: number; runGoalsBothArms: number; gaps: unknown[] };
  lines.push(`Incomplete: **${String(report['incomplete'])}**. Run goals: ${cov.runGoals}, on both arms: ${cov.runGoalsBothArms}, named gaps: ${cov.gaps.length}.`, '');
  const surface = report['surface'] as Obj;
  lines.push(`Surface measured: **${String(surface['measured'])}**${surface['reason'] === undefined ? '' : ` (${String(surface['reason'])}: ${String(surface['detail'])})`}`, '');
  lines.push('| goal | classic declaration B | replacement declaration B | classic received B | replacement received B |', '| --- | ---: | ---: | ---: | ---: |');
  for (const [goal, v] of Object.entries(report['sideBySide'] as Record<string, Obj>)) {
    const d = v['declarationBytes'] as Obj; const r = v['receivedBytes'] as Obj;
    lines.push(`| ${goal} | ${String(d['classic'])} | ${String(d['replacement'])} | ${String(r['classic'])} | ${String(r['replacement'])} |`);
  }
  lines.push('', `Declaration bytes: ${STATIC_LABEL}`, `Received bytes: ${RECEIVED_LABEL}.`, '', '## Needs the paid run (not measured)', ...Object.keys(report['native'] as Obj).map((f) => `- ${f}`), '');
  return lines.join('\n');
}

// ---------- the command ----------

/** The goals r3 file T9a's official gate ran (docs commit fb1673ca, read-workflows.json). The gate report must carry this sha. */
export const FROZEN_GOALS_SHA = '3df0161491b70da362a707723c8abbd4fcdb0a66cec5bdeeb2ea7d4c2f5ed4ed';
/** The scripts file T9a's H5 froze (s-295's freeze note, official gate on 29326bfa). Empty would make every number that needs the scripts `not-measured / scripts-not-frozen`. */
export const FROZEN_SCRIPTS_SHA = '63e53f3f0e2ecd9122bb94c7670df766d58a2a7ac163b4641bb5d394e01beb06';

export interface CliDeps {
  /** The tree hash and cleanliness of the measured repository (`--repo`; by default the one this script lives in). */
  readonly tree: (repo: string) => { readonly treeHash: string; readonly clean: boolean };
  /** The shipped replacement bootstrap, rendered from the source of the measured repository. */
  readonly bootstrap: (repo: string) => Promise<string>;
  readonly tokenizer: (dir: string) => Promise<Counter>;
  readonly read: (file: string) => string;
  readonly write: (file: string, text: string) => void;
}

/** The repository this script lives in: what is measured when `--repo` is not given. */
export const DEFAULT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (repo: string, args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
export const REAL_DEPS: CliDeps = {
  tree: (repo) => ({ treeHash: git(repo, ['rev-parse', 'HEAD^{tree}']), clean: git(repo, ['status', '--porcelain']) === '' }),
  bootstrap: async (repo) => {
    const m = await import(pathToFileURL(path.join(repo, 'packages/core/src/work/code-mode-instructions.ts')).href) as typeof import('../packages/core/src/work/code-mode-instructions.js');
    return m.bootstrapText(m.replacementRouting());
  },
  tokenizer: async (dir) => { const t = await loadPinnedTokenizer(dir); if (t.label !== PINNED_LABEL) throw new Error(`tokenizer label ${t.label}`); return { count: (text) => t.count(text) }; },
  read: (file) => readFileSync(file, 'utf8'),
  write: (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); },
};

const USAGE = 'usage: parley-token-benchmark-t10-offline --goals <file> --t9a-report <file> --out <dir> [--scripts <file>] [--tokenizer-dir <dir>] [--final-surface <file>] [--build-stamp <file>] [--repo <dir>]\n' +
  '--repo is the repository whose tree and bootstrap are measured: an exact clone of the commit the T9a report names, never the checkout this tool is run from unless that is the measured one.\n' +
  'No process is started, no model is called, nothing is installed. A refused input exits 1; incompleteness is data and exits 0.';

/** Reads the files, writes `t10-offline.json` and `t10-offline.md` under --out. 0: written (even if incomplete); 1: a refused input; 2: usage. */
export async function main(argv: readonly string[], deps: CliDeps = REAL_DEPS): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { goals: { type: 'string' }, scripts: { type: 'string' }, 't9a-report': { type: 'string' }, 'tokenizer-dir': { type: 'string' }, 'final-surface': { type: 'string' }, 'build-stamp': { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } });
  if (values.goals === undefined || values['t9a-report'] === undefined || values.out === undefined) { console.error(USAGE); return 2; }
  const readJson = (file: string): unknown => JSON.parse(deps.read(file));
  let counter: Counter | null = null;
  if (values['tokenizer-dir'] !== undefined) {
    try { counter = await deps.tokenizer(values['tokenizer-dir']); } catch (e) { console.error(`the pinned tokenizer was refused: ${(e as Error).message}`); return 1; }
  }
  let finalSurface: OfflineInput['finalSurface'] = null;
  if (values['final-surface'] !== undefined) {
    const text = deps.read(values['final-surface']);
    const v = JSON.parse(text) as { residuals?: unknown };
    if (!Array.isArray(v.residuals) || !v.residuals.every((r) => typeof r === 'string')) { console.error('the final-surface file is { "residuals": [names] }'); return 1; }
    finalSurface = { residuals: v.residuals as string[], sha256: sha256(text) };
  }
  const repo = path.resolve(values.repo ?? DEFAULT_REPO);
  const tree = deps.tree(repo);
  let stamp: string | null = null;
  if (values['build-stamp'] !== undefined) { try { stamp = deps.read(values['build-stamp']); } catch { stamp = null; } }
  const report = buildOffline({
    goalsText: deps.read(values.goals), expectedGoalsSha: FROZEN_GOALS_SHA,
    scriptsText: values.scripts === undefined ? null : deps.read(values.scripts), expectedScriptsSha: FROZEN_SCRIPTS_SHA,
    t9aReport: readJson(values['t9a-report']), counter,
    bootstrap: { text: await deps.bootstrap(repo), treeHash: tree.treeHash, clean: tree.clean, buildStamp: stamp, source: 'packages/core/src/work/code-mode-instructions.ts bootstrapText(replacementRouting()), rendered from the measured repository (--repo, or the one this script lives in)' },
    finalSurface,
  });
  deps.write(path.join(values.out, 't10-offline.json'), `${JSON.stringify(report, null, 2)}\n`);
  deps.write(path.join(values.out, 't10-offline.md'), renderMarkdown(report));
  return report['refused'] === true ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
