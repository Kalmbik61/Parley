// T9a harness, slice H1: the goal-file check. Pure: it reads a parsed JSON value and either returns the goals with their data expanded or the
// list of reasons, each naming the field. It implements `T9a-goal-schema.md` (sha256 146f083e…, normative by Delta 3 of the harness text) and
// adds nothing to it. Everything is closed: an unknown field, or an operator that is not valid for the goal's kind, refuses the file.

export const CLASSES = [
  'read-dto', 'paging', 'completeness', 'conservation-list', 'conservation-profile', 'conservation-source', 'error', 'unavailable',
  'policy-zero-call', 'hostile-data', 'resource', 'ipc', 'abort', 'draining', 'host-404', 'no-local-fallback',
  'routing-role', 'routing-skill', 'routing-brief', 'routing-channel', 'rollback',
] as const;
export type GoalClass = (typeof CLASSES)[number];
/** Classes whose goal may run on the replacement arm only: classic has no such surface. */
export const REPLACEMENT_ONLY_CLASSES: readonly GoalClass[] = ['policy-zero-call', 'resource', 'ipc', 'abort', 'draining'];
const isConservation = (c: string): boolean => c.startsWith('conservation-');
const isRouting = (c: string): boolean => c.startsWith('routing-');

export const POLICY_STATES = ['allow', 'ask', 'deny', 'unknown', 'stale', 'revoked'] as const;
export const HOST_REPLIES = ['ok', '404', '401', '503-then-ok', 'hang', 'drop-before-headers', 'drop-mid-body', 'malformed'] as const;
export const LIMIT_FIELDS = ['codeBytes', 'activeMs', 'wallMs', 'memoryBytes', 'stackBytes', 'rssSoftKb', 'maxRpcs', 'maxInFlight', 'argBytes', 'responseBytes', 'resultBytes', 'logBytes'] as const;
/** Bounds whose boundary the runner cannot hit exactly: a goal may only ask for `far-over`. */
export const CONCURRENT_RUNS = 'concurrentRuns';
export const FAR_OVER_ONLY: readonly string[] = ['memoryBytes', 'stackBytes', 'rssSoftKb', 'activeMs', 'wallMs'];
export const EXEC_STATUS = ['completed', 'error', 'partial-or-unknown'] as const;
export const ERROR_KINDS = ['invalid-request', 'stale-revision', 'unavailable', 'busy', 'unsettled', 'syntax', 'runtime', 'timeout', 'cancelled', 'quota', 'tool-error', 'invalid-output', 'helper-failure'] as const;
export const OUTCOMES = ['refused', 'succeeded', 'failed', 'cancelled', 'unread', 'draining', 'unknown'] as const;
export const BUSY_REASONS = ['a-run-is-active', 'previous-run-cleanup-unknown', 'previous-run-has-calls-with-unknown-outcome', 'previous-run-preflight-pending', 'previous-run-cleanup-pending', 'previous-run-draining', 'previous-process-unaccounted', 'held-by-other-process', 'run-record-unavailable', 'other'] as const;
export const DIAGNOSTIC_CODES = ['invalid-arguments', 'non-json-arguments', 'unknown-method', 'call-failed', 'call-unsettled', 'limit-reached', 'busy'] as const;
export const LIMIT_NAMES = ['code-bytes', 'argument-bytes', 'response-bytes', 'result-bytes', 'operations', 'in-flight', 'active-time', 'wall-time', 'memory'] as const;
export const RECORD_STATES = ['none', 'held-live', 'unaccounted', 'free'] as const;
export const ROLLBACK_RECORDS = ['none', 'held-live', 'unaccounted', 'unreadable', 'dead-accounted', 'non-read-unaccounted'] as const;
const PROVIDERS = ['claude', 'codex', 'glm'] as const;
const LIFECYCLES = ['active', 'pending', 'closed'] as const;
const MESSAGE_KINDS = ['note', 'question', 'decision'] as const;
const BACKLOG_KINDS = ['bug', 'debt', 'idea'] as const;
const PLAN_MODES = ['checklist', 'verified'] as const;
const PLAN_STATUSES = ['proposed', 'active', 'completed', 'cancelled'] as const;
const SOURCES = ['guide', 'roles', 'recipes', 'skills'] as const;
const CATALOGUES = ['verified', 'unread', 'partial', 'none'] as const;
const SKILL_SOURCES = ['project', 'user', 'plugin', 'parley'] as const;
const PATH_OPS = ['equals', 'absent', 'present', 'contains', 'count', 'countAtLeast', 'oneOf'] as const;
const WILDCARD_OPS: readonly string[] = ['count', 'countAtLeast', 'contains'];
const POSITIVE_OPS: readonly string[] = ['equals', 'present', 'contains', 'count', 'countAtLeast', 'oneOf'];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = Record<string, unknown>;

export interface GoalIssue { readonly path: string; readonly message: string }
export type GoalFileCheck = { readonly ok: true; readonly goals: readonly Goal[] } | { readonly ok: false; readonly issues: readonly GoalIssue[] };

/** A goal that passed the check: the raw object, with `data` expanded (repeat resolved, `$pad` kept as a marker for the builder). */
export interface Goal {
  readonly id: string;
  readonly class: GoalClass;
  readonly kind: 'run' | 'launch' | 'rollback';
  readonly goal: string;
  readonly arms: readonly ('classic' | 'replacement')[];
  readonly armsReason: string | null;
  readonly claimsComplete: boolean;
  readonly answer: Readonly<Record<string, string>>;
  readonly data: ExpandedData | null;
  readonly faults: Obj;
  readonly launch: Obj | null;
  readonly rollback: Obj | null;
  readonly criteria: readonly Obj[];
}

export interface ExpandedData {
  readonly self: string;
  readonly sessions: readonly Obj[];
  readonly rooms: readonly Obj[];
  readonly backlog: readonly Obj[];
  readonly plans: readonly Obj[];
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;
const isStr = (v: unknown): v is string => typeof v === 'string';
const inList = (list: readonly string[], v: unknown): boolean => isStr(v) && list.includes(v);

class Issues {
  readonly list: GoalIssue[] = [];
  add(path: string, message: string): void { this.list.push({ path, message }); }
  /** Keys outside `allowed` are refused, each naming itself. */
  closed(o: Obj, allowed: readonly string[], path: string): void {
    for (const key of Object.keys(o)) if (!allowed.includes(key)) this.add(`${path}.${key}`, 'unknown field');
  }
  need(o: Obj, key: string, path: string): boolean {
    if (!(key in o)) { this.add(`${path}.${key}`, 'required'); return false; }
    return true;
  }
}

/** `{ "$pad": n, "with": s }`: free text of n UTF-8 bytes. Valid wherever a free text is. */
function freeText(v: unknown, path: string, is: Issues): void {
  if (isStr(v)) return;
  if (isObj(v) && '$pad' in v) {
    is.closed(v, ['$pad', 'with'], path);
    if (!isInt(v['$pad'], 1)) is.add(`${path}.$pad`, 'a positive integer');
    if (!isStr(v['with']) || v['with'] === '') is.add(`${path}.with`, 'a non-empty string');
    return;
  }
  is.add(path, 'a string or { "$pad", "with" }');
}

// ---------- data ----------

/** Strings of any depth, with `${i}` replaced. Keys of objects are not rewritten. */
function substitute(v: unknown, i: number): unknown {
  if (isStr(v)) return v.split('${i}').join(String(i));
  if (Array.isArray(v)) return v.map((x) => substitute(x, i));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, i)]));
  return v;
}

/** One array of `data`, with `{ repeat, of }` elements expanded in place and in order. Nesting is refused. */
function expandArray(raw: unknown, path: string, is: Issues): Obj[] {
  if (!Array.isArray(raw)) { is.add(path, 'an array'); return []; }
  const out: Obj[] = [];
  raw.forEach((el, at) => {
    const here = `${path}[${at}]`;
    if (isObj(el) && 'repeat' in el) {
      is.closed(el, ['repeat', 'of'], here);
      if (!isInt(el['repeat'], 1)) { is.add(`${here}.repeat`, 'an integer of at least 1'); return; }
      if (!isObj(el['of'])) { is.add(`${here}.of`, 'an object'); return; }
      if (JSON.stringify(el['of']).includes('"repeat"') && containsRepeat(el['of'])) { is.add(`${here}.of`, 'repeat may not be nested'); return; }
      for (let i = 1; i <= (el['repeat'] as number); i++) out.push(substitute(el['of'], i) as Obj);
    } else if (isObj(el)) out.push(el);
    else is.add(here, 'an object');
  });
  return out;
}
function containsRepeat(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(containsRepeat);
  if (isObj(v)) return 'repeat' in v || Object.values(v).some(containsRepeat);
  return false;
}

function checkData(raw: unknown, path: string, is: Issues): ExpandedData | null {
  if (!isObj(raw)) { is.add(path, 'an object'); return null; }
  is.closed(raw, ['self', 'sessions', 'rooms', 'backlog', 'plans'], path);
  if (!isStr(raw['self'])) is.add(`${path}.self`, 'a session key');
  if (!('sessions' in raw)) is.add(`${path}.sessions`, 'required');
  const sessions = expandArray(raw['sessions'], `${path}.sessions`, is);
  const rooms = 'rooms' in raw ? expandArray(raw['rooms'], `${path}.rooms`, is) : [];
  const backlog = 'backlog' in raw ? expandArray(raw['backlog'], `${path}.backlog`, is) : [];
  const plans = 'plans' in raw ? expandArray(raw['plans'], `${path}.plans`, is) : [];
  if (sessions.length === 0 && 'sessions' in raw) is.add(`${path}.sessions`, 'at least one session');

  const sessionKeys = new Set<string>();
  sessions.forEach((s, at) => {
    const p = `${path}.sessions[${at}]`;
    is.closed(s, ['key', 'label', 'provider', 'lifecycle', 'task', 'summary'], p);
    if (!isStr(s['key']) || s['key'] === '') is.add(`${p}.key`, 'a string');
    else if (sessionKeys.has(s['key'])) is.add(`${p}.key`, `duplicate key ${s['key']}`);
    else sessionKeys.add(s['key']);
    if ('label' in s) freeText(s['label'], `${p}.label`, is); else is.add(`${p}.label`, 'required');
    if (!inList(PROVIDERS, s['provider'])) is.add(`${p}.provider`, `one of ${PROVIDERS.join(', ')}`);
    if (!inList(LIFECYCLES, s['lifecycle'])) is.add(`${p}.lifecycle`, `one of ${LIFECYCLES.join(', ')}`);
    if ('task' in s) freeText(s['task'], `${p}.task`, is);
    if ('summary' in s && s['summary'] !== null) freeText(s['summary'], `${p}.summary`, is);
  });
  if (isStr(raw['self']) && !sessionKeys.has(raw['self'])) is.add(`${path}.self`, `${raw['self']} is not a session key`);

  const roomKeys = new Set<string>();
  const members = new Map<string, readonly string[]>();
  rooms.forEach((r, at) => {
    const p = `${path}.rooms[${at}]`;
    is.closed(r, ['key', 'title', 'lead', 'members', 'messages'], p);
    if (!isStr(r['key']) || r['key'] === '') is.add(`${p}.key`, 'a string');
    else if (roomKeys.has(r['key'])) is.add(`${p}.key`, `duplicate key ${r['key']}`);
    else roomKeys.add(r['key']);
    if ('title' in r) freeText(r['title'], `${p}.title`, is); else is.add(`${p}.title`, 'required');
    const list = Array.isArray(r['members']) ? (r['members'] as unknown[]) : null;
    if (list === null || list.length === 0) is.add(`${p}.members`, 'a non-empty array of session keys');
    else for (const m of list) if (!isStr(m) || !sessionKeys.has(m)) is.add(`${p}.members`, `${String(m)} is not a session key`);
    if (!isStr(r['lead']) || !sessionKeys.has(r['lead'])) is.add(`${p}.lead`, 'a session key');
    else if (list !== null && !list.includes(r['lead'])) is.add(`${p}.members`, 'must include the lead');
    if (isStr(r['key'])) members.set(r['key'], (list ?? []).filter(isStr));
    if ('messages' in r) {
      if (!Array.isArray(r['messages'])) is.add(`${p}.messages`, 'an array');
      else (r['messages'] as unknown[]).forEach((m, mi) => {
        const mp = `${p}.messages[${mi}]`;
        if (!isObj(m)) { is.add(mp, 'an object'); return; }
        is.closed(m, ['from', 'text', 'kind'], mp);
        if (m['from'] !== 'human' && !(isStr(m['from']) && sessionKeys.has(m['from']) && list?.includes(m['from']))) is.add(`${mp}.from`, 'human, or a session that is a member of the room');
        if ('text' in m) freeText(m['text'], `${mp}.text`, is); else is.add(`${mp}.text`, 'required');
        if (!inList(MESSAGE_KINDS, m['kind'])) is.add(`${mp}.kind`, `one of ${MESSAGE_KINDS.join(', ')}`);
      });
    }
  });

  backlog.forEach((b, at) => {
    const p = `${path}.backlog[${at}]`;
    is.closed(b, ['kind', 'title', 'why', 'details'], p);
    if (!inList(BACKLOG_KINDS, b['kind'])) is.add(`${p}.kind`, `one of ${BACKLOG_KINDS.join(', ')}`);
    for (const f of ['title', 'why']) if (f in b) freeText(b[f], `${p}.${f}`, is); else is.add(`${p}.${f}`, 'required');
    if ('details' in b) freeText(b['details'], `${p}.details`, is);
  });

  const planKeys = new Set<string>();
  plans.forEach((pl, at) => {
    const p = `${path}.plans[${at}]`;
    is.closed(pl, ['key', 'room', 'mode', 'goal', 'status', 'items'], p);
    if (!isStr(pl['key']) || pl['key'] === '') is.add(`${p}.key`, 'a string');
    else if (planKeys.has(pl['key'])) is.add(`${p}.key`, `duplicate key ${pl['key']}`);
    else planKeys.add(pl['key']);
    const roomMembers = isStr(pl['room']) ? members.get(pl['room']) : undefined;
    if (roomMembers === undefined) is.add(`${p}.room`, 'a room key');
    if (!inList(PLAN_MODES, pl['mode'])) is.add(`${p}.mode`, `one of ${PLAN_MODES.join(', ')}`);
    if (!inList(PLAN_STATUSES, pl['status'])) is.add(`${p}.status`, `one of ${PLAN_STATUSES.join(', ')}`);
    if ('goal' in pl) freeText(pl['goal'], `${p}.goal`, is); else is.add(`${p}.goal`, 'required');
    const items = Array.isArray(pl['items']) ? (pl['items'] as unknown[]) : null;
    if (items === null || items.length === 0) { is.add(`${p}.items`, 'a non-empty array'); return; }
    const ids = new Set<number>();
    items.forEach((it, ii) => {
      const ip = `${p}.items[${ii}]`;
      if (!isObj(it)) { is.add(ip, 'an object'); return; }
      is.closed(it, ['id', 'title', 'owner', 'scope', 'after', 'criteria', 'verifier'], ip);
      if (!isInt(it['id'], 1)) is.add(`${ip}.id`, 'a positive integer');
      else if (ids.has(it['id'])) is.add(`${ip}.id`, `duplicate id ${it['id']}`);
      for (const f of ['title', 'scope']) if (f in it) freeText(it[f], `${ip}.${f}`, is); else is.add(`${ip}.${f}`, 'required');
      if (!isStr(it['owner']) || !sessionKeys.has(it['owner']) || (roomMembers !== undefined && !roomMembers.includes(it['owner']))) is.add(`${ip}.owner`, 'a session key that is a member of the plan\'s room');
      if ('after' in it) {
        if (!Array.isArray(it['after'])) is.add(`${ip}.after`, 'an array of earlier ids');
        else for (const a of it['after'] as unknown[]) if (!isInt(a, 1) || !ids.has(a)) is.add(`${ip}.after`, `${String(a)} is not an earlier id`);
      }
      if ('criteria' in it) {
        if (!Array.isArray(it['criteria'])) is.add(`${ip}.criteria`, 'an array of strings');
        else (it['criteria'] as unknown[]).forEach((c, ci) => freeText(c, `${ip}.criteria[${ci}]`, is));
      }
      if ('verifier' in it && (!isStr(it['verifier']) || !sessionKeys.has(it['verifier']))) is.add(`${ip}.verifier`, 'a session key');
      if (isInt(it['id'], 1)) ids.add(it['id']);
    });
  });
  return { self: isStr(raw['self']) ? raw['self'] : '', sessions, rooms, backlog, plans };
}

// ---------- faults ----------

function checkFaults(raw: unknown, path: string, cls: string, is: Issues): Obj {
  if (!isObj(raw)) { is.add(path, 'an object'); return {}; }
  is.closed(raw, ['policy', 'host', 'abort', 'limits', 'guest', 'holdReceipts', 'resource', 'localCanary'], path);
  const calls = (o: Obj, p: string, required: boolean): void => {
    if ('afterCalls' in o ? !isInt(o['afterCalls'], 1) : required) is.add(`${p}.afterCalls`, 'a positive integer');
  };
  if ('policy' in raw) {
    const p = isObj(raw['policy']) ? raw['policy'] : null;
    if (p === null) is.add(`${path}.policy`, 'an object'); else {
      is.closed(p, ['state', 'afterCalls'], `${path}.policy`);
      if (!inList(POLICY_STATES, p['state'])) is.add(`${path}.policy.state`, `one of ${POLICY_STATES.join(', ')}`);
      calls(p, `${path}.policy`, false);
    }
  }
  if ('host' in raw) {
    const h = isObj(raw['host']) ? raw['host'] : null;
    if (h === null) is.add(`${path}.host`, 'an object'); else {
      is.closed(h, ['list', 'call', 'callMethod', 'afterCalls'], `${path}.host`);
      for (const f of ['list', 'call']) if (f in h && !inList(HOST_REPLIES, h[f])) is.add(`${path}.host.${f}`, `one of ${HOST_REPLIES.join(', ')}`);
      if ('callMethod' in h && !isStr(h['callMethod'])) is.add(`${path}.host.callMethod`, 'a method name');
      calls(h, `${path}.host`, false);
    }
  }
  if ('abort' in raw) {
    const a = isObj(raw['abort']) ? raw['abort'] : null;
    if (a === null) is.add(`${path}.abort`, 'an object'); else { is.closed(a, ['afterCalls'], `${path}.abort`); calls(a, `${path}.abort`, true); }
  }
  if ('limits' in raw) {
    const l = isObj(raw['limits']) ? raw['limits'] : null;
    if (l === null) is.add(`${path}.limits`, 'an object'); else {
      is.closed(l, LIMIT_FIELDS, `${path}.limits`);
      for (const [k, v] of Object.entries(l)) if (!isInt(v, 1)) is.add(`${path}.limits.${k}`, 'a positive integer (a limit may only be lowered)');
    }
  }
  if ('guest' in raw) {
    const g = isObj(raw['guest']) ? raw['guest'] : null;
    if (g === null) is.add(`${path}.guest`, 'an object');
    else if (g['event'] === 'kill-helper') { is.closed(g, ['event', 'afterCalls'], `${path}.guest`); calls(g, `${path}.guest`, true); }
    else if (g['event'] === 'no-await') is.closed(g, ['event'], `${path}.guest`);
    else is.add(`${path}.guest.event`, 'kill-helper or no-await');
  }
  if ('holdReceipts' in raw) {
    const h = isObj(raw['holdReceipts']) ? raw['holdReceipts'] : null;
    if (h === null) is.add(`${path}.holdReceipts`, 'an object'); else {
      is.closed(h, ['untilPending'], `${path}.holdReceipts`);
      if (!isInt(h['untilPending'], 1)) is.add(`${path}.holdReceipts.untilPending`, 'a positive integer (calls pending before the host releases them)');
    }
  }
  if ('resource' in raw) {
    const r = isObj(raw['resource']) ? raw['resource'] : null;
    if (r === null) is.add(`${path}.resource`, 'an object'); else {
      is.closed(r, ['bound', 'input'], `${path}.resource`);
      if (r['bound'] === CONCURRENT_RUNS) {
        // a second run while the first is active: the client's second request fires on the host's receipt of the first call, so it is a resource goal of one arm
        if (r['input'] !== 'second-while-first-active') is.add(`${path}.resource.input`, 'second-while-first-active');
      } else {
        if (!inList(LIMIT_FIELDS, r['bound'])) is.add(`${path}.resource.bound`, `one of ${LIMIT_FIELDS.join(', ')}, ${CONCURRENT_RUNS}`);
        if (!inList(['at-limit', 'one-over', 'far-over'], r['input'])) is.add(`${path}.resource.input`, 'at-limit, one-over or far-over');
        else if (isStr(r['bound']) && FAR_OVER_ONLY.includes(r['bound']) && r['input'] !== 'far-over') is.add(`${path}.resource.input`, `${r['bound']} cannot be reached exactly: far-over only`);
      }
    }
  }
  if ('localCanary' in raw && (!isStr(raw['localCanary']) || raw['localCanary'] === '')) is.add(`${path}.localCanary`, 'a non-empty string');
  return raw;
}

// ---------- criteria ----------

/** `rooms.0.title`, `messages[*].text`: names, integers and the wildcard, as its own segment or attached to a name (`items[*]`). */
export function parsePath(path: string): readonly (string | number | '*')[] | null {
  if (path === '') return null;
  const out: (string | number | '*')[] = [];
  for (const seg of path.split('.')) {
    if (seg === '[*]') { out.push('*'); continue; }
    const wild = seg.endsWith('[*]');
    const name = wild ? seg.slice(0, -3) : seg;
    if (/^[0-9]+$/.test(name)) out.push(Number(name));
    else if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(name)) out.push(name);
    else return null;
    if (wild) out.push('*');
  }
  return out;
}

/** `{ "$session": key }` and `{ "$room": key }` inside any value must resolve to a key of the goal's data. */
function checkRefs(v: unknown, path: string, keys: { sessions: Set<string>; rooms: Set<string> } | null, is: Issues): void {
  if (Array.isArray(v)) { v.forEach((x, i) => checkRefs(x, `${path}[${i}]`, keys, is)); return; }
  if (!isObj(v)) return;
  for (const ref of ['$session', '$room'] as const) {
    if (ref in v) {
      const set = ref === '$session' ? keys?.sessions : keys?.rooms;
      if (Object.keys(v).length !== 1 || !isStr(v[ref]) || set === undefined || !set.has(v[ref] as string)) is.add(`${path}.${ref}`, 'does not resolve to a key of the goal\'s data');
    }
  }
  for (const [k, x] of Object.entries(v)) if (k !== '$session' && k !== '$room') checkRefs(x, `${path}.${k}`, keys, is);
}

interface GoalCtx {
  readonly cls: string;
  readonly arms: readonly string[];
  readonly answerNames: readonly string[];
  readonly faults: Obj;
  readonly refs: { sessions: Set<string>; rooms: Set<string> } | null;
}

const RUN_KEYS = ['status', 'incomplete', 'errorKind', 'busyReason', 'runId', 'operations', 'operationsInclude', 'attemptedExecute', 'diagnostic', 'limitReached', 'result', 'noValue', 'nextRun'];
const HOST_KEYS = ['calls', 'distinctCalls', 'attemptsOf', 'lists', 'maxAttemptsPerCall', 'handlerStarts', 'callsAfter', 'maxPending'];

function operations(v: unknown, path: string, is: Issues): void {
  if (!Array.isArray(v)) { is.add(path, 'an array'); return; }
  (v as unknown[]).forEach((o, i) => {
    const p = `${path}[${i}]`;
    if (!isObj(o)) { is.add(p, 'an object'); return; }
    is.closed(o, ['method', 'outcome', 'dispatched', 'incomplete'], p);
    if (!isStr(o['method'])) is.add(`${p}.method`, 'a method name');
    if (!inList(OUTCOMES, o['outcome'])) is.add(`${p}.outcome`, `one of ${OUTCOMES.join(', ')}`);
    if (typeof o['dispatched'] !== 'boolean') is.add(`${p}.dispatched`, 'a boolean');
    if ('incomplete' in o && typeof o['incomplete'] !== 'boolean') is.add(`${p}.incomplete`, 'a boolean');
  });
}

function checkRunCriterion(c: Obj, path: string, ctx: GoalCtx, is: Issues): void {
  const arm = 'arm' in c ? c['arm'] : null;
  if (arm !== null && arm !== 'classic' && arm !== 'replacement') is.add(`${path}.arm`, 'classic or replacement');
  if (arm !== null && !ctx.arms.includes(arm as string)) is.add(`${path}.arm`, `${String(arm)} is not an arm of this goal`);
  const keys = Object.keys(c).filter((k) => k !== 'arm');
  const only = (name: string): boolean => keys.length === 1 && keys[0] === name;

  if ('answer' in c) {
    if (!only('answer')) is.add(path, 'answer takes no sibling but arm');
    const a = isObj(c['answer']) ? c['answer'] : null;
    if (a === null) { is.add(`${path}.answer`, 'an object { path, <operator> }'); return; }
    const ops = Object.keys(a).filter((k) => (PATH_OPS as readonly string[]).includes(k));
    is.closed(a, ['path', ...PATH_OPS], `${path}.answer`);
    if (ops.length !== 1) is.add(`${path}.answer`, 'exactly one of ' + PATH_OPS.join(', '));
    const segs = isStr(a['path']) ? parsePath(a['path']) : null;
    if (segs === null) is.add(`${path}.answer.path`, 'dotted keys, integers and [*]');
    else {
      if (!ctx.answerNames.includes(String(segs[0]))) is.add(`${path}.answer.path`, `starts at ${String(segs[0])}, which the goal's answer does not declare`);
      if (segs.includes('*') && !(ops.length === 1 && WILDCARD_OPS.includes(ops[0]!))) is.add(`${path}.answer.path`, '[*] is allowed only with count, countAtLeast and contains');
    }
    const op = ops[0];
    if (op === 'absent' || op === 'present') { if (a[op] !== true) is.add(`${path}.answer.${op}`, 'true'); }
    if (op === 'count' || op === 'countAtLeast') { if (!isInt(a[op], 0)) is.add(`${path}.answer.${op}`, 'a non-negative integer'); }
    if (op === 'oneOf' && (!Array.isArray(a['oneOf']) || (a['oneOf'] as unknown[]).length === 0)) is.add(`${path}.answer.oneOf`, 'a non-empty array');
    checkRefs(a, `${path}.answer`, ctx.refs, is);
    return;
  }
  if ('run' in c) {
    if (!only('run')) is.add(path, 'run takes no sibling but arm');
    if (ctx.arms.length === 1 && ctx.arms[0] === 'classic') is.add(path, 'a run criterion on a classic-only goal');
    if (arm === 'classic') is.add(`${path}.arm`, 'run criteria are the replacement arm\'s only');
    const r = isObj(c['run']) ? c['run'] : null;
    if (r === null) { is.add(`${path}.run`, 'an object'); return; }
    is.closed(r, RUN_KEYS, `${path}.run`);
    if ('status' in r && !inList(EXEC_STATUS, r['status'])) is.add(`${path}.run.status`, `one of ${EXEC_STATUS.join(', ')}`);
    if ('incomplete' in r && typeof r['incomplete'] !== 'boolean') is.add(`${path}.run.incomplete`, 'a boolean');
    if ('errorKind' in r && !inList(ERROR_KINDS, r['errorKind'])) is.add(`${path}.run.errorKind`, `one of ${ERROR_KINDS.join(', ')}`);
    if ('busyReason' in r && !inList(BUSY_REASONS, r['busyReason'])) is.add(`${path}.run.busyReason`, `one of ${BUSY_REASONS.join(', ')}`);
    if ('runId' in r && r['runId'] !== null) is.add(`${path}.run.runId`, 'null (a refusal before any run)');
    if ('operations' in r) operations(r['operations'], `${path}.run.operations`, is);
    if ('operationsInclude' in r) operations(r['operationsInclude'], `${path}.run.operationsInclude`, is);
    if ('operations' in r && 'operationsInclude' in r) is.add(`${path}.run`, 'operations and operationsInclude are exclusive');
    if ('attemptedExecute' in r && r['attemptedExecute'] !== true) is.add(`${path}.run.attemptedExecute`, 'true');
    if ('diagnostic' in r && !inList(DIAGNOSTIC_CODES, r['diagnostic'])) is.add(`${path}.run.diagnostic`, `one of ${DIAGNOSTIC_CODES.join(', ')}`);
    if ('limitReached' in r && !inList(LIMIT_NAMES, r['limitReached'])) is.add(`${path}.run.limitReached`, `one of ${LIMIT_NAMES.join(', ')}`);
    if ('result' in r) {
      if (r['result'] !== 'first' && r['result'] !== 'second') is.add(`${path}.run.result`, 'first or second');
      else if ((ctx.faults['resource'] as Obj | undefined)?.['bound'] !== CONCURRENT_RUNS) is.add(`${path}.run.result`, `allowed only with the ${CONCURRENT_RUNS} bound`);
    }
    if ('noValue' in r && r['noValue'] !== true) is.add(`${path}.run.noValue`, 'true');
    if ('nextRun' in r) {
      const n = isObj(r['nextRun']) ? r['nextRun'] : null;
      if (n === null) is.add(`${path}.run.nextRun`, 'an object');
      else if (n['admitted'] === true) is.closed(n, ['admitted'], `${path}.run.nextRun`);
      else if (n['admitted'] === false) { is.closed(n, ['admitted', 'busyReason'], `${path}.run.nextRun`); if (!inList(BUSY_REASONS, n['busyReason'])) is.add(`${path}.run.nextRun.busyReason`, `one of ${BUSY_REASONS.join(', ')}`); }
      else is.add(`${path}.run.nextRun.admitted`, 'a boolean');
    }
    return;
  }
  if ('host' in c) {
    if (!only('host')) is.add(path, 'host takes no sibling but arm');
    const h = isObj(c['host']) ? c['host'] : null;
    if (h === null) { is.add(`${path}.host`, 'an object'); return; }
    is.closed(h, HOST_KEYS, `${path}.host`);
    for (const f of ['calls', 'distinctCalls', 'lists', 'maxAttemptsPerCall']) if (f in h && !isInt(h[f], 0)) is.add(`${path}.host.${f}`, 'a non-negative integer');
    if ('maxPending' in h && !isInt(h['maxPending'], 1)) is.add(`${path}.host.maxPending`, 'a positive integer');
    if ('attemptsOf' in h) {
      const a = isObj(h['attemptsOf']) ? h['attemptsOf'] : null;
      if (a === null) is.add(`${path}.host.attemptsOf`, 'an object'); else { is.closed(a, ['method', 'n'], `${path}.host.attemptsOf`); if (!isStr(a['method'])) is.add(`${path}.host.attemptsOf.method`, 'a method'); if (!isInt(a['n'], 0)) is.add(`${path}.host.attemptsOf.n`, 'a non-negative integer'); }
    }
    if ('handlerStarts' in h) {
      const a = isObj(h['handlerStarts']) ? h['handlerStarts'] : null;
      if (a === null) is.add(`${path}.host.handlerStarts`, 'an object'); else { is.closed(a, ['method', 'n'], `${path}.host.handlerStarts`); if ('method' in a && !isStr(a['method'])) is.add(`${path}.host.handlerStarts.method`, 'a method'); if (!isInt(a['n'], 0)) is.add(`${path}.host.handlerStarts.n`, 'a non-negative integer'); }
    }
    if ('callsAfter' in h) {
      const a = isObj(h['callsAfter']) ? h['callsAfter'] : null;
      if (a === null) is.add(`${path}.host.callsAfter`, 'an object'); else {
        is.closed(a, ['fault', 'n'], `${path}.host.callsAfter`);
        if (!inList(['abort', 'policy', 'guest'], a['fault'])) is.add(`${path}.host.callsAfter.fault`, 'abort, policy or guest');
        else if (!isObj(ctx.faults[a['fault'] as string]) || !isInt((ctx.faults[a['fault'] as string] as Obj)['afterCalls'], 1)) is.add(`${path}.host.callsAfter.fault`, `the goal has no ${String(a['fault'])} fault with afterCalls`);
        if (!isInt(a['n'], 0)) is.add(`${path}.host.callsAfter.n`, 'a non-negative integer');
      }
    }
    return;
  }
  if ('text' in c) {
    if (!only('text')) is.add(path, 'text takes no sibling but arm');
    const t = isObj(c['text']) ? c['text'] : null;
    if (t === null) { is.add(`${path}.text`, 'an object'); return; }
    is.closed(t, ['neverContains'], `${path}.text`);
    const n = t['neverContains'];
    if (isStr(n)) { if (n === '') is.add(`${path}.text.neverContains`, 'a non-empty string'); }
    else if (isObj(n) && Object.keys(n).length === 1 && n['$canary'] === true) { if (!isStr(ctx.faults['localCanary'])) is.add(`${path}.text.neverContains`, '$canary needs faults.localCanary'); }
    else is.add(`${path}.text.neverContains`, 'a string or { "$canary": true }');
    return;
  }
  if ('equalAcrossArms' in c) {
    if (!only('equalAcrossArms')) is.add(path, 'equalAcrossArms takes no sibling');
    const segs = isStr(c['equalAcrossArms']) ? parsePath(c['equalAcrossArms']) : null;
    if (segs === null) is.add(`${path}.equalAcrossArms`, 'a path');
    else if (!ctx.answerNames.includes(String(segs[0]))) is.add(`${path}.equalAcrossArms`, 'starts at a name the answer does not declare');
    if (ctx.arms.length !== 2) is.add(path, 'equalAcrossArms needs both arms');
    if (Object.keys(ctx.faults).filter((k) => !['profile', 'navigator', 'agent'].includes(k)).length > 0) is.add(path, 'equalAcrossArms is not allowed on a goal with a fault');
    if (ctx.cls === 'no-local-fallback' || ctx.cls === 'host-404') is.add(path, `equalAcrossArms is not allowed on ${ctx.cls}`);
    return;
  }
  if ('record' in c) {
    if (!only('record')) is.add(path, 'record takes no sibling but arm');
    const r = isObj(c['record']) ? c['record'] : null;
    if (r === null) { is.add(`${path}.record`, 'an object'); return; }
    is.closed(r, ['state'], `${path}.record`);
    if (!inList(RECORD_STATES, r['state'])) is.add(`${path}.record.state`, `one of ${RECORD_STATES.join(', ')}`);
    if (arm === 'classic') is.add(`${path}.arm`, 'the durable run record belongs to the replacement arm');
    return;
  }
  for (const group of ['toolList', 'catalogue', 'sources'] as const) {
    if (group in c) {
      if (!only(group)) is.add(path, `${group} takes no sibling`);
      if (!isConservation(ctx.cls)) is.add(path, `${group} is a conservation criterion: only the conservation-* classes`);
      const g = isObj(c[group]) ? c[group] : null;
      if (g === null) { is.add(`${path}.${group}`, 'an object'); return; }
      if (group === 'toolList') { is.closed(g, ['partition', 'residualSchemasEqualClassic', 'residualOrderEqualClassic'], `${path}.toolList`); if (Object.keys(g).length !== 1 || Object.values(g).some((v) => v !== true)) is.add(`${path}.toolList`, 'exactly one of the three, as true'); }
      if (group === 'catalogue') { is.closed(g, ['namesEqualOriginal', 'orderEqualBetweenRuns', 'bytesEqualBetweenRuns'], `${path}.catalogue`); if (Object.keys(g).length === 0 || Object.values(g).some((v) => v !== true)) is.add(`${path}.catalogue`, 'true values'); }
      if (group === 'sources') {
        is.closed(g, ['unchanged'], `${path}.sources`);
        if (!Array.isArray(g['unchanged']) || (g['unchanged'] as unknown[]).length === 0 || (g['unchanged'] as unknown[]).some((s) => !inList(SOURCES, s))) is.add(`${path}.sources.unchanged`, `a non-empty subset of ${SOURCES.join(', ')}`);
      }
      return;
    }
  }
  is.add(path, 'not a criterion of a run goal');
}

/** Cross-criterion rules of a `run` goal: the enforced combinations. */
function runCombinations(criteria: readonly Obj[], goal: Obj, path: string, ctx: GoalCtx, is: Issues): void {
  const runOf = (c: Obj): Obj | null => (isObj(c['run']) ? c['run'] : null);
  const hostOf = (c: Obj): Obj | null => (isObj(c['host']) ? c['host'] : null);
  const hasWitness = criteria.some((c) => {
    const r = runOf(c);
    if (r === null) return false;
    const ops = (Array.isArray(r['operations']) ? r['operations'] : Array.isArray(r['operationsInclude']) ? r['operationsInclude'] : []) as Obj[];
    if (ops.some((o) => isObj(o) && o['dispatched'] === false)) return true;
    return r['attemptedExecute'] === true && ('errorKind' in r || 'busyReason' in r || r['status'] === 'error');
  });
  const faults = ctx.faults;
  const holds = isObj(faults['holdReceipts']);
  const concurrent = (faults['resource'] as Obj | undefined)?.['bound'] === CONCURRENT_RUNS;
  const hasPending = criteria.some((c) => { const x = hostOf(c); return x !== null && 'maxPending' in x; });
  // a hold the goal never observes, or a pending count with nothing holding, would pass on nothing
  if (holds && !hasPending) is.add(`${path}`, 'a holdReceipts fault needs a host.maxPending criterion, the witness that calls were really held');
  if (!holds && hasPending) is.add(`${path}`, 'host.maxPending needs a holdReceipts fault: the host only counts what it held');
  if (concurrent && !criteria.some((c) => runOf(c)?.['result'] === 'second')) is.add(`${path}`, `the ${CONCURRENT_RUNS} bound needs a run criterion with result: second, the refusal of the second run`);
  if (concurrent && !(ctx.cls === 'resource' && ctx.arms.length === 1 && ctx.arms[0] === 'replacement')) is.add(`${path}`, `the ${CONCURRENT_RUNS} bound is a replacement-only goal of class resource`);
  criteria.forEach((c, i) => {
    const h = hostOf(c);
    if (h !== null && h['calls'] === 0 && !hasWitness) is.add(`${path}[${i}].host.calls`, '0 needs a witness of the attempt: an operation with dispatched: false, or attemptedExecute: true with the refusal');
    if (h !== null && isObj(h['callsAfter']) && !criteria.some((o) => { const x = hostOf(o); return x !== null && isInt(x['calls'], 0); })) is.add(`${path}[${i}].host.callsAfter`, 'pairs with a host.calls criterion, so the goal cannot pass by never reaching the fault');
    if (h !== null && isObj(h['callsAfter'])) {
      const fault = (h['callsAfter'] as Obj)['fault'];
      const after = isStr(fault) && isObj(ctx.faults[fault]) ? (ctx.faults[fault] as Obj)['afterCalls'] : null;
      const exact = criteria.map(hostOf).filter((x): x is Obj => x !== null && isInt(x['calls'], 0)).map((x) => x['calls'] as number);
      if (isInt(after, 1) && exact.length > 0 && !exact.some((n) => n >= after)) is.add(`${path}[${i}].host.callsAfter`, `the paired host.calls must be at least ${after}`);
    }
    const ans = isObj(c['answer']) ? c['answer'] : null;
    if (ans !== null && ans['absent'] === true && isStr(ans['path'])) {
      const segs = parsePath(ans['path']);
      const witnessed = criteria.some((o, j) => {
        const oa = isObj(o['answer']) ? o['answer'] : null;
        if (j === i || oa === null || !isStr(oa['path']) || !PATH_OPS.some((op) => POSITIVE_OPS.includes(op) && op in oa)) return false;
        const other = parsePath(oa['path']);
        return other !== null && segs !== null && other.length <= segs.length && other.every((x, k) => x === segs[k]);
      });
      if (!witnessed) is.add(`${path}[${i}].answer.absent`, 'needs a positive criterion on the same path or its parent, so it cannot pass on nothing');
    }
    if (isObj(c['text']) && isStr((c['text'] as Obj)['neverContains']) === false && isObj((c['text'] as Obj)['neverContains']) && !isStr(goal['faults'] && (goal['faults'] as Obj)['localCanary'])) {
      // reported by checkRunCriterion; kept here so the combination is visible in one place
    }
  });
}

// ---------- launch / rollback ----------

function checkLaunch(raw: unknown, path: string, is: Issues): Obj {
  if (!isObj(raw)) { is.add(path, 'an object'); return {}; }
  is.closed(raw, ['provider', 'mode', 'role', 'recipe', 'navigator', 'channel', 'agent', 'routing', 'profile', 'skills'], path);
  if (!inList(PROVIDERS, raw['provider'])) is.add(`${path}.provider`, `one of ${PROVIDERS.join(', ')}`);
  if (!inList(['launch', 'resume', 'new'], raw['mode'])) is.add(`${path}.mode`, 'launch, resume or new');
  const role = raw['role'];
  if (!(role === null || isStr(role) || (isObj(role) && Object.keys(role).length === 1 && (isStr(role['customPrompt']) || isStr(role['nativeAgent']))))) is.add(`${path}.role`, 'null, a builtin role id, { customPrompt } or { nativeAgent }');
  if (!(raw['recipe'] === null || isStr(raw['recipe']))) is.add(`${path}.recipe`, 'null or a builtin recipe id');
  for (const f of ['navigator', 'channel', 'agent']) if (typeof raw[f] !== 'boolean') is.add(`${path}.${f}`, 'a boolean');
  const routing = raw['routing'];
  if (!(routing === 'classic' || routing === 'shipped' || (isObj(routing) && Object.keys(routing).length === 1 && Array.isArray(routing['fixture']) && (routing['fixture'] as unknown[]).length > 0 && (routing['fixture'] as unknown[]).every(isStr)))) is.add(`${path}.routing`, 'classic, shipped or { fixture: [method] }');
  if ('profile' in raw && !inList(['full', 'short'], raw['profile'])) is.add(`${path}.profile`, 'full or short');
  if ('skills' in raw) {
    const s = isObj(raw['skills']) ? raw['skills'] : null;
    if (s === null) is.add(`${path}.skills`, 'an object'); else {
      is.closed(s, ['catalogue', 'entries'], `${path}.skills`);
      if (!inList(CATALOGUES, s['catalogue'])) is.add(`${path}.skills.catalogue`, `one of ${CATALOGUES.join(', ')}`);
      if (!Array.isArray(s['entries'])) is.add(`${path}.skills.entries`, 'an array');
      else (s['entries'] as unknown[]).forEach((e, i) => {
        const p = `${path}.skills.entries[${i}]`;
        if (!isObj(e)) { is.add(p, 'an object'); return; }
        is.closed(e, ['name', 'description', 'source'], p);
        for (const f of ['name', 'description']) if (!isStr(e[f])) is.add(`${p}.${f}`, 'a string');
        if (!inList(SKILL_SOURCES, e['source'])) is.add(`${p}.source`, `one of ${SKILL_SOURCES.join(', ')}`);
      });
      if (s['catalogue'] === 'none' && Array.isArray(s['entries']) && (s['entries'] as unknown[]).length > 0) is.add(`${path}.skills.entries`, 'none holds no entries');
    }
  }
  return raw;
}

function stringList(v: unknown): boolean { return Array.isArray(v) && v.length > 0 && v.every(isStr); }

function checkLaunchCriterion(c: Obj, path: string, launch: Obj, is: Issues): void {
  const keys = Object.keys(c);
  if (keys.length !== 1) { is.add(path, 'exactly one launch criterion'); return; }
  const k = keys[0]!;
  const v = c[k];
  const one = (o: unknown, allowed: readonly string[], p: string): Obj | null => {
    if (!isObj(o)) { is.add(p, 'an object'); return null; }
    is.closed(o, allowed, p);
    return o;
  };
  const exactlyOne = (o: Obj, of: readonly string[], p: string): void => { if (of.filter((x) => x in o).length !== 1) is.add(p, `exactly one of ${of.join(', ')}`); };
  switch (k) {
    case 'layer': { const o = one(v, ['startsWith', 'contains', 'notContains'], `${path}.layer`); if (o) { exactlyOne(o, ['startsWith', 'contains', 'notContains'], `${path}.layer`); for (const x of Object.values(o)) if (!isStr(x) || x === '') is.add(`${path}.layer`, 'a non-empty string'); } return; }
    case 'layerEqualsClassicWithBootstrap': if (v !== true) is.add(`${path}.${k}`, 'true'); if (launch['routing'] === 'classic') is.add(`${path}.${k}`, 'a classic launch has no bootstrap to compare'); return;
    case 'argv': { const o = one(v, ['equalsClassicOutsideLayer', 'contains', 'notContains'], `${path}.argv`); if (o) { exactlyOne(o, ['equalsClassicOutsideLayer', 'contains', 'notContains'], `${path}.argv`); if ('equalsClassicOutsideLayer' in o && o['equalsClassicOutsideLayer'] !== true) is.add(`${path}.argv.equalsClassicOutsideLayer`, 'true'); } return; }
    case 'env': { const o = one(v, ['has', 'lacks'], `${path}.env`); if (o) { exactlyOne(o, ['has', 'lacks'], `${path}.env`); for (const x of Object.values(o)) if (!isStr(x)) is.add(`${path}.env`, 'a variable name'); } return; }
    case 'verdict': { const o = one(v, ['source', 'status'], `${path}.verdict`); if (o) { if (!inList(['role', 'playbook', 'skills'], o['source'])) is.add(`${path}.verdict.source`, 'role, playbook or skills'); if (!inList(['compatible', 'incompatible', 'unverified'], o['status'])) is.add(`${path}.verdict.status`, 'compatible, incompatible or unverified'); } return; }
    case 'selectsClassic': { const o = one(v, ['value', 'source'], `${path}.selectsClassic`); if (o) { if (typeof o['value'] !== 'boolean') is.add(`${path}.selectsClassic.value`, 'a boolean'); if ('source' in o && !inList(['role', 'playbook', 'skills'], o['source'])) is.add(`${path}.selectsClassic.source`, 'role, playbook or skills'); } return; }
    case 'tools': { const o = one(v, ['includes', 'excludes', 'count'], `${path}.tools`); if (o) { for (const f of ['includes', 'excludes']) if (f in o && !stringList(o[f])) is.add(`${path}.tools.${f}`, 'a non-empty array of names'); if ('count' in o && !isInt(o['count'], 0)) is.add(`${path}.tools.count`, 'a non-negative integer'); if (Object.keys(o).length === 0) is.add(`${path}.tools`, 'at least one of includes, excludes, count'); } return; }
    case 'skillCatalogue': { const o = one(v, ['includes', 'excludes'], `${path}.skillCatalogue`); if (o) { for (const f of ['includes', 'excludes']) if (f in o && !stringList(o[f])) is.add(`${path}.skillCatalogue.${f}`, 'a non-empty array of names'); if (Object.keys(o).length === 0) is.add(`${path}.skillCatalogue`, 'includes or excludes'); } return; }
    case 'brief': { const o = one(v, ['contains', 'notContains'], `${path}.brief`); if (o) exactlyOne(o, ['contains', 'notContains'], `${path}.brief`); return; }
    case 'throws': if (!isStr(v) || v === '') is.add(`${path}.throws`, 'an error code'); return;
    default: is.add(`${path}.${k}`, 'not a criterion of a launch goal');
  }
}

function checkRollback(raw: unknown, path: string, is: Issues): Obj {
  if (!isObj(raw)) { is.add(path, 'an object'); return {}; }
  is.closed(raw, ['record', 'requested', 'refused', 'writesExist'], path);
  if (!inList(ROLLBACK_RECORDS, raw['record'])) is.add(`${path}.record`, `one of ${ROLLBACK_RECORDS.join(', ')}`);
  if (typeof raw['requested'] !== 'boolean') is.add(`${path}.requested`, 'a boolean');
  if (!(raw['refused'] === null || (isStr(raw['refused']) && raw['refused'] !== ''))) is.add(`${path}.refused`, 'null or a reason');
  if (typeof raw['writesExist'] !== 'boolean') is.add(`${path}.writesExist`, 'a boolean');
  return raw;
}

function checkRollbackCriteria(criteria: readonly Obj[], path: string, rollback: Obj, is: Issues): void {
  const blockedSomewhere = criteria.some((c) => isObj(c['selection']) && (c['selection'] as Obj)['effective'] === 'blocked');
  criteria.forEach((c, i) => {
    const p = `${path}[${i}]`;
    const keys = Object.keys(c);
    if (keys.length !== 1) { is.add(p, 'exactly one rollback criterion'); return; }
    const k = keys[0]!;
    const v = c[k];
    switch (k) {
      case 'selection': {
        if (!isObj(v)) { is.add(`${p}.selection`, 'an object'); return; }
        is.closed(v, ['effective', 'reason', 'held'], `${p}.selection`);
        const e = v['effective'];
        if (!inList(['replacement', 'classic', 'blocked'], e)) { is.add(`${p}.selection.effective`, 'replacement, classic or blocked'); return; }
        const reason = 'reason' in v ? v['reason'] : undefined;
        if (e === 'replacement' && reason !== undefined && reason !== null) is.add(`${p}.selection.reason`, 'null for replacement');
        if (e === 'classic' && reason !== undefined && !(isStr(reason) && (['held-run', 'not-requested'].includes(reason) || reason === rollback['refused']))) is.add(`${p}.selection.reason`, 'held-run, not-requested or the given refused reason');
        if (e === 'blocked' && reason !== undefined && !inList(['non-read-record', 'unreadable-record'], reason)) is.add(`${p}.selection.reason`, 'non-read-record or unreadable-record');
        if ('held' in v && !(inList(['unaccounted', 'may-be-finishing'], v['held']) && reason === 'held-run' && e === 'classic')) is.add(`${p}.selection.held`, 'unaccounted or may-be-finishing, only with a classic held-run');
        return;
      }
      case 'recordUnchanged': if (v !== true) is.add(`${p}.recordUnchanged`, 'true'); return;
      case 'nextLaunch': {
        if (blockedSomewhere) is.add(`${p}.nextLaunch`, 'a blocked selection launches nothing');
        if (!isObj(v)) { is.add(`${p}.nextLaunch`, 'an object'); return; }
        is.closed(v, ['tools', 'bootstrapContains', 'wrappers'], `${p}.nextLaunch`);
        if (!isInt(v['tools'], 0)) is.add(`${p}.nextLaunch.tools`, 'a non-negative integer');
        if (typeof v['wrappers'] !== 'boolean') is.add(`${p}.nextLaunch.wrappers`, 'a boolean');
        if ('bootstrapContains' in v && !isStr(v['bootstrapContains'])) is.add(`${p}.nextLaunch.bootstrapContains`, 'a string');
        return;
      }
      case 'busy': { if (!isObj(v)) { is.add(`${p}.busy`, 'an object'); return; } is.closed(v, ['reason'], `${p}.busy`); if (!inList(BUSY_REASONS, v['reason'])) is.add(`${p}.busy.reason`, `one of ${BUSY_REASONS.join(', ')}`); return; }
      case 'calls': if (v !== 0) is.add(`${p}.calls`, '0 (host-wide zero dispatch)'); if (!criteria.some((o) => 'busy' in o)) is.add(`${p}.calls`, '0 needs the busy criterion as the witness of the attempt'); return;
      case 'repeatSelection': if (!isInt(v, 2)) is.add(`${p}.repeatSelection`, 'an integer of at least 2'); return;
      default: is.add(`${p}.${k}`, 'not a criterion of a rollback goal');
    }
  });
}

// ---------- the file ----------

/**
 * Checks a parsed goal file. Returns every issue found, each with its path, or the goals with their data expanded. `knownBuiltinRoles` and
 * `knownBuiltinRecipes`, when given, also validate the ids of launch goals.
 */
export function checkGoalFile(raw: unknown, options: { knownBuiltinRoles?: readonly string[]; knownBuiltinRecipes?: readonly string[] } = {}): GoalFileCheck {
  const is = new Issues();
  if (!isObj(raw)) return { ok: false, issues: [{ path: '$', message: 'a JSON object { "version": 1, "goals": [...] }' }] };
  is.closed(raw, ['version', 'goals'], '$');
  if (raw['version'] !== 1) is.add('$.version', '1');
  if (!Array.isArray(raw['goals'])) { is.add('$.goals', 'an array'); return { ok: false, issues: is.list }; }
  const goals: Goal[] = [];
  const seen = new Set<string>();
  (raw['goals'] as unknown[]).forEach((g, at) => {
    const path = `$.goals[${at}]`;
    if (!isObj(g)) { is.add(path, 'an object'); return; }
    const before = is.list.length;
    const kind = g['kind'];
    const id = g['id'];
    if (!isStr(id) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) is.add(`${path}.id`, 'a kebab-case id');
    else if (seen.has(id)) is.add(`${path}.id`, `duplicate id ${id}`);
    else seen.add(id);
    const cls = g['class'];
    if (!inList(CLASSES, cls)) is.add(`${path}.class`, `one of ${CLASSES.join(', ')}`);
    if (!inList(['run', 'launch', 'rollback'], kind)) { is.add(`${path}.kind`, 'run, launch or rollback'); return; }
    if (!isStr(g['goal']) || g['goal'] === '') is.add(`${path}.goal`, 'a sentence');
    const kindAllowed: Record<string, readonly string[]> = {
      run: ['id', 'class', 'kind', 'goal', 'arms', 'armsReason', 'answer', 'data', 'faults', 'claimsComplete', 'criteria', ...(isStr(cls) && isConservation(cls) ? ['profile', 'navigator', 'agent'] : [])],
      launch: ['id', 'class', 'kind', 'goal', 'launch', 'criteria'],
      rollback: ['id', 'class', 'kind', 'goal', 'rollback', 'criteria'],
    };
    is.closed(g, kindAllowed[kind as string]!, path);
    if (isStr(cls)) {
      if (isRouting(cls) && kind !== 'launch') is.add(`${path}.kind`, `${cls} is a launch goal`);
      if (cls === 'rollback' && kind !== 'rollback') is.add(`${path}.kind`, 'a rollback goal');
      if (!isRouting(cls) && cls !== 'rollback' && kind !== 'run') is.add(`${path}.kind`, `${cls} is a run goal`);
    }
    if (!Array.isArray(g['criteria']) || (g['criteria'] as unknown[]).length === 0) { is.add(`${path}.criteria`, 'a non-empty array'); return; }
    const criteria = (g['criteria'] as unknown[]).map((c, i) => { if (!isObj(c)) { is.add(`${path}.criteria[${i}]`, 'an object'); return {} as Obj; } return c; });
    let arms: ('classic' | 'replacement')[] = ['classic', 'replacement'];
    let armsReason: string | null = null;
    const answer: Record<string, string> = {};
    let data: ExpandedData | null = null;
    let faults: Obj = {};
    let launch: Obj | null = null;
    let rollback: Obj | null = null;
    if (kind === 'run') {
      if ('arms' in g) {
        const a = g['arms'];
        const both = Array.isArray(a) && a.length === 2 && a[0] === 'classic' && a[1] === 'replacement';
        const replacementOnly = Array.isArray(a) && a.length === 1 && a[0] === 'replacement';
        if (!both && !replacementOnly) is.add(`${path}.arms`, '["classic","replacement"] or ["replacement"]');
        else if (replacementOnly) {
          arms = ['replacement'];
          if (isStr(cls) && !(REPLACEMENT_ONLY_CLASSES as readonly string[]).includes(cls)) is.add(`${path}.arms`, `${cls} runs both arms: replacement-only is for ${REPLACEMENT_ONLY_CLASSES.join(', ')}`);
          if (!isStr(g['armsReason']) || g['armsReason'] === '') is.add(`${path}.armsReason`, 'required with a single arm');
          else armsReason = g['armsReason'];
        }
        if (both && 'armsReason' in g) is.add(`${path}.armsReason`, 'forbidden with two arms');
      } else if ('armsReason' in g) is.add(`${path}.armsReason`, 'forbidden with two arms');
      if ('claimsComplete' in g && typeof g['claimsComplete'] !== 'boolean') is.add(`${path}.claimsComplete`, 'a boolean');
      if (!isObj(g['answer'])) is.add(`${path}.answer`, 'an object naming each value of the answer');
      else {
        const entries = Object.entries(g['answer']);
        for (const [n, w] of entries) { if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(n)) is.add(`${path}.answer.${n}`, 'a name'); if (!isStr(w) || w === '') is.add(`${path}.answer.${n}`, 'what it means, in words'); else answer[n] = w; }
      }
      if ('profile' in g && !inList(['full', 'short'], g['profile'])) is.add(`${path}.profile`, 'full or short');
      for (const f of ['navigator', 'agent']) if (f in g && typeof g[f] !== 'boolean') is.add(`${path}.${f}`, 'a boolean');
      data = checkData(g['data'], `${path}.data`, is);
      faults = 'faults' in g ? checkFaults(g['faults'], `${path}.faults`, isStr(cls) ? cls : '', is) : {};
      const ctx: GoalCtx = {
        cls: isStr(cls) ? cls : '', arms, answerNames: Object.keys(answer), faults,
        refs: data === null ? null : { sessions: new Set(data.sessions.map((s) => String(s['key']))), rooms: new Set(data.rooms.map((r) => String(r['key']))) },
      };
      if (Object.keys(answer).length === 0 && criteria.some((c) => 'answer' in c || 'equalAcrossArms' in c)) is.add(`${path}.answer`, 'is {}, yet a criterion reads an answer value');
      criteria.forEach((c, i) => checkRunCriterion(c, `${path}.criteria[${i}]`, ctx, is));
      runCombinations(criteria, g, `${path}.criteria`, ctx, is);
      if (isStr(cls) && !isConservation(cls) && criteria.some((c) => 'toolList' in c || 'catalogue' in c || 'sources' in c)) { /* reported per criterion */ }
    } else if (kind === 'launch') {
      launch = checkLaunch(g['launch'], `${path}.launch`, is);
      if (isStr((launch as Obj)['role']) && options.knownBuiltinRoles !== undefined && !options.knownBuiltinRoles.includes((launch as Obj)['role'] as string)) is.add(`${path}.launch.role`, 'not a builtin role id');
      if (isStr((launch as Obj)['recipe']) && options.knownBuiltinRecipes !== undefined && !options.knownBuiltinRecipes.includes((launch as Obj)['recipe'] as string)) is.add(`${path}.launch.recipe`, 'not a builtin recipe id');
      criteria.forEach((c, i) => checkLaunchCriterion(c, `${path}.criteria[${i}]`, launch as Obj, is));
    } else {
      rollback = checkRollback(g['rollback'], `${path}.rollback`, is);
      checkRollbackCriteria(criteria, `${path}.criteria`, rollback, is);
    }
    if (is.list.length === before && isStr(id) && isStr(cls) && isStr(g['goal'])) {
      goals.push({ id, class: cls as GoalClass, kind: kind as Goal['kind'], goal: g['goal'], arms, armsReason, claimsComplete: g['claimsComplete'] === true, answer, data, faults, launch, rollback, criteria });
    }
  });
  return is.list.length === 0 ? { ok: true, goals } : { ok: false, issues: is.list };
}

/** Every class of the plan's list needs at least one goal. */
export function missingClasses(goals: readonly Goal[]): readonly GoalClass[] {
  const have = new Set(goals.map((g) => g.class));
  return CLASSES.filter((c) => !have.has(c));
}
