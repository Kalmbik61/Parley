// The Claude settings sources of a session process (plan T12a-Claude, slice C2a; lead m-7557/m-7560, s-296 m-7559/m-7561). The source set is
// what the pinned client (2.1.322) loads, read from its binary: user, project and local settings, the `--settings` file, and the managed
// (policy) layer. Each file is read at every check through the bounded no-follow reader, one symlink level followed, fingerprint-cached.
//
// Triggers: a deny or ask rule that targets Parley (closed grammar, no RegExp), a managed key that rules on MCP, `managed-mcp.json` present,
// an unreadable, oversized, unparsable or non-regular file. Uninspected: a second link, a managed key outside the closed table, a managed
// file the table does not know, a policy layer that is never parsed here (MDM plists, server-managed settings). Hooks and plugins inside these
// files belong to C2b and C2c: their classes stay pending in the row, so nothing here reads them.

import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { type BoundedRead, CLEAR, SETTINGS_MAX_BYTES, type SourceClass, type SourceVerdict, readBounded } from './detector.js';
import type { LaunchIdentities } from './launch-decision.js';

const trigger = (reason: string): SourceVerdict => Object.freeze({ kind: 'trigger', reason });
const uninspected = (sourceClass: string): SourceVerdict => Object.freeze({ kind: 'uninspected', sourceClass });

// ----- deny and ask rules -----

/**
 * What a permission rule says about Parley's tools, closed and non-executing (C2a.1, lead m-7608 amended by m-7610 after s-296 m-7609, on
 * finding F1). The tool part is the rule up to its first `(`; a `*` after it is content.
 * - `parley`: an exact Parley rule, `mcp__parley` or `mcp__parley__…` (case-insensitive, a `*` in the tool part included): the rule targets
 *   Parley, a trigger.
 * - `unresolved`: any other `mcp__` rule, or a glob (a `*` in the tool part, which 2.1.322 matches as a glob) that is not provably
 *   disjoint. The client also applies rules through a server's standard, deny and former keys, which live in its runtime registry and cannot
 *   be read from a file, so such a rule can be neither proven to target Parley nor proven not to: uninspected.
 * - `disjoint`: no `*` in the tool part and not an `mcp__` tool; or a glob whose literal prefix (before its first `*`) cannot begin any
 *   `mcp__` name, because 2.1.322's glob is anchored at the start (`h`: `startsWith(prefix)`). Every name a Parley tool can be reached under
 *   starts with `mcp__`.
 */
export type RuleClass = 'parley' | 'unresolved' | 'disjoint';

export function ruleClass(rule: string): RuleClass {
  const tool = (rule.includes('(') ? rule.slice(0, rule.indexOf('(')) : rule).trim();
  const lower = tool.toLowerCase();
  if (lower === 'mcp__parley' || lower.startsWith('mcp__parley__')) return 'parley';
  if (lower.startsWith('mcp__')) return 'unresolved';
  if (!tool.includes('*')) return 'disjoint';
  const prefix = lower.slice(0, lower.indexOf('*'));
  return 'mcp__'.startsWith(prefix) ? 'unresolved' : 'disjoint';
}

// ----- hooks (C2b; lead m-7673/m-7675, s-296 m-7674 H1) -----

/** The 33 hook events of 2.1.322 (binary `rc`/`iW`). */
export const CLAUDE_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'UserPromptSubmit', 'UserPromptExpansion', 'SessionStart',
  'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch',
  'PermissionRequest', 'PermissionDenied', 'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'Elicitation', 'ElicitationResult',
  'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded', 'CwdChanged', 'FileChanged', 'DirectoryAdded', 'MessageDisplay',
]);
/** Events whose matcher is a tool name. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
/** Events whose matcher is an MCP server name. */
const SERVER_EVENTS = new Set(['Elicitation', 'ElicitationResult']);
/** The client's simple-matcher grammar for these events (`Npt`): split on `|` and `,`, trimmed, empty parts dropped, compared exactly. */
const SIMPLE_MATCHER = /^[a-zA-Z0-9_|, -]+$/;
/** A regex alternative that is provably disjoint needs this shape: `^`-anchored literal, optionally `.*` and `$`. */
const ANCHORED_LITERAL = /^\^([A-Za-z0-9_-]+)(?:\.\*)?\$?$/;

type MatcherClass = 'general' | 'parley' | 'mcp' | 'regex' | 'disjoint';
const rank: Record<MatcherClass, number> = { parley: 4, regex: 3, mcp: 2, disjoint: 1, general: 0 };
const worst = (classes: readonly MatcherClass[]): MatcherClass => classes.reduce<MatcherClass>((a, b) => (rank[b] > rank[a] ? b : a), 'disjoint');
const namesParley = (lower: string): boolean => lower === 'mcp__parley' || lower.startsWith('mcp__parley__');

/**
 * A tool-event matcher against Parley's tools (H1, mirroring C2a.1). Omitted, empty or `*`: general. `.*` and `^.*$`: targeted (the lead's
 * doubtful-case disposition, s-296's dissent recorded; the client itself treats `.*` as match-all). A simple matcher is compared exactly by
 * the client, against the tool's name and its alias names, which all start with `mcp__`: a Parley name is targeted, another `mcp__` name
 * unresolved, anything else disjoint. A regex is split on `|`; an alternative is disjoint only when it is a `^`-anchored literal that can
 * neither start nor prefix an `mcp__` name (case-insensitive); a Parley-anchored one is targeted; every other alternative is unresolved,
 * because the client also tests a regex against alias and family names a file reader cannot list. No regex is ever run here.
 */
export function toolMatcherClass(matcher: string): MatcherClass {
  if (matcher === '' || matcher === '*') return 'general';
  if (matcher === '.*' || matcher === '^.*$') return 'parley';
  if (SIMPLE_MATCHER.test(matcher)) {
    return worst(matcher.split(/[|,]/).map((n) => n.trim()).filter(Boolean).map((n) => {
      const lower = n.toLowerCase();
      return namesParley(lower) ? 'parley' : lower.startsWith('mcp__') ? 'mcp' : 'disjoint';
    }));
  }
  return worst(matcher.split('|').map((alt) => {
    const m = ANCHORED_LITERAL.exec(alt);
    if (m === null) return 'regex';
    const literal = m[1]!.toLowerCase();
    if (namesParley(literal) || (literal.startsWith('mcp__parley') && 'mcp__parley__'.startsWith(literal))) return 'parley';
    return literal.startsWith('mcp__') || 'mcp__'.startsWith(literal) ? 'regex' : 'disjoint';
  }));
}

/**
 * An Elicitation matcher against Parley's server name. A simple name `parley` (case-insensitive) is targeted; any other name may be one of
 * the server's runtime keys, so it is unresolved; a regex is unresolved (the client tests it against those keys too).
 */
export function serverMatcherClass(matcher: string): MatcherClass {
  if (matcher === '' || matcher === '*') return 'general';
  if (matcher === '.*' || matcher === '^.*$') return 'parley';
  if (!SIMPLE_MATCHER.test(matcher)) return 'regex';
  const names = matcher.split(/[|,]/).map((n) => n.trim().toLowerCase()).filter(Boolean);
  return names.includes('parley') ? 'parley' : names.length === 0 ? 'disjoint' : 'mcp';
}

const isPlain = (o: unknown): o is Record<string, unknown> => typeof o === 'object' && o !== null && !Array.isArray(o);

/**
 * A settings file's `hooks`. Shape errors are a trigger. Per event: tool events by `toolMatcherClass`, Elicitation by `serverMatcherClass`,
 * PostToolBatch targeted only with a matcher, an unknown event targeted only with a matcher, the other known events never (their matchers
 * are not about tools). Each handler's `if` is a permission rule (`ruleClass`). Handler bodies (command, url, prompt) are never read.
 */
export function hooksVerdict(hooks: unknown): SourceVerdict {
  if (hooks === undefined) return CLEAR;
  if (!isPlain(hooks)) return trigger('hooks-unparsable');
  let first: SourceVerdict = CLEAR;
  const note = (v: SourceVerdict): void => { if (first.kind === 'clear') first = v; };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return trigger('hooks-unparsable');
    for (const group of groups) {
      if (!isPlain(group) || !Array.isArray(group['hooks']) || (group['matcher'] !== undefined && typeof group['matcher'] !== 'string')) return trigger('hooks-unparsable');
      const matcher = (group['matcher'] as string | undefined) ?? '';
      let cls: MatcherClass;
      if (TOOL_EVENTS.has(event)) cls = toolMatcherClass(matcher);
      else if (SERVER_EVENTS.has(event)) cls = serverMatcherClass(matcher);
      else if (event === 'PostToolBatch' || !CLAUDE_HOOK_EVENTS.has(event)) cls = matcher === '' ? 'general' : 'parley';
      else cls = 'general';
      if (cls === 'parley') return trigger('hooks-targeted');
      if (cls === 'mcp') note(uninspected('hooks-mcp-matcher'));
      if (cls === 'regex') note(uninspected('hooks-regex-matcher'));
      for (const handler of group['hooks'] as unknown[]) {
        if (!isPlain(handler)) return trigger('hooks-unparsable');
        const cond = handler['if'];
        if (cond === undefined) continue;
        if (typeof cond !== 'string') return trigger('hooks-unparsable');
        const rc = ruleClass(cond);
        if (rc === 'parley') return trigger('hooks-targeted');
        if (rc === 'unresolved') note(uninspected('hooks-if'));
      }
    }
  }
  return first;
}

// ----- the managed layer: a closed key table from 2.1.322's settings schema -----

/** Keys that rule on MCP servers or tools: a managed file with one is a trigger. */
const MANAGED_MCP_KEYS = new Set([
  'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'disableClaudeAiConnectors', 'managedMcpServers',
  'allowedMcpServers', 'deniedMcpServers', 'allowManagedMcpServersOnly', 'allowAllClaudeAiMcps', 'allowClaudeInChromeWithManagedMcp',
]);
/** Plugin keys: judged by C2c, whose class is still pending in the row. `hooks` is parsed (C2b). */
const MANAGED_PENDING_KEYS = new Set([
  'enabledPlugins', 'prependPlugins', 'appendPlugins', 'extraKnownMarketplaces', 'additionalMarketplaces', 'strictKnownMarketplaces',
  'allowedMarketplaces', 'blockedMarketplaces', 'disableCommandPluginSources', 'strictPluginOnlyCustomization', 'pluginConfigs',
  'pluginSuggestionMarketplaces', 'syncClaudeAiPlugins', 'allowedChannelPlugins', 'pluginTrustMessage',
]);
/** Keys that cannot change which Parley tool runs or whether a rule on it is applied: display, model, memory, notifications, limits. */
const MANAGED_BENIGN_KEYS = new Set([
  // Hook restrictions (C2b, lead m-7673): each can only remove hooks, so reading the hooks as present is stricter.
  'disableAllHooks', 'allowManagedHooksOnly', 'allowedHttpHookUrls', 'httpHookAllowedEnvVars',
  '$schema', 'respectGitignore', 'breakReminder', 'quietHours', 'cleanupPeriodDays', 'desktopSessionCleanupPeriodDays', 'skillListingMaxDescChars',
  'skillListingBudgetFraction', 'attribution', 'attributionProject', 'attributionProjectPolicy', 'includeCoAuthoredBy', 'includeGitInstructions',
  'model', 'fallbackModel', 'availableModels', 'enforceAvailableModels', 'availableModelsMatch', 'deniedModels', 'modelOverrides', 'modelPicker',
  'modelPricing', 'disableReplyCheck', 'disableAgentView', 'disableRemoteControl', 'disableWorkflows', 'disableArtifact', 'enableArtifact',
  'enableWorkflows', 'workflowSizeGuideline', 'workflowKeywordTriggerEnabled', 'disableWindowsBashCommandSplit', 'defaultShell',
  'bashEditDiffEnabled', 'bashOutputMaxChars', 'taskOutputMaxChars', 'respondToBashCommands', 'allowManagedPermissionRulesOnly', 'statusLine',
  'prUrlTemplate', 'footerLinksRegexes', 'subagentStatusLine', 'outputStyle', 'viewMode', 'language', 'feedbackSurveyRate', 'feedbackDrafts',
  'spinnerTipsEnabled', 'spinnerVerbs', 'spinnerTipsOverride', 'syntaxHighlightingDisabled', 'maxProseWidth', 'spellcheck',
  'terminalTitleFromRename', 'promptCacheTtl', 'subagentPromptCacheTtl', 'alwaysThinkingEnabled', 'effortLevel', 'maxEffortLevel', 'modelSettings',
  'autoCompactWindow', 'advisorModel', 'fastMode', 'fastModePerSessionOptIn', 'promptSuggestionEnabled', 'emojiCompletionEnabled',
  'awaySummaryEnabled', 'responseComparisonEnabled', 'showClearContextOnPlanAccept', 'askUserQuestionTimeout', 'dialogExpiry',
  'companyAnnouncements', 'autoUpdatesChannel', 'minimumVersion', 'requiredMinimumVersion', 'requiredMaximumVersion', 'prefersReducedMotion',
  'timeFormat', 'timeZone', 'totalTokensReminder', 'totalTokensReminderBudget', 'totalTokensReminderAfterUserTurn', 'showThinkingSummaries',
  'theme', 'editorMode', 'keybindingFlavor', 'vimInsertModeRemaps', 'verbose', 'preferredNotifChannel', 'autoCompactEnabled',
  'precomputeCompactionEnabled', 'idleCompaction', 'autoScrollEnabled', 'wheelScrollAccelerationEnabled', 'showTurnDuration',
  'showMessageTimestamps', 'terminalProgressBarEnabled', 'inputNeededNotifEnabled', 'agentPushNotifEnabled',
]);

/** One managed file's top-level keys against the table: the first trigger, else the first uninspected, else clear. `env` is judged apart. */
function managedKeysVerdict(data: Record<string, unknown>): SourceVerdict {
  let first: SourceVerdict = CLEAR;
  for (const key of Object.keys(data)) {
    if (MANAGED_MCP_KEYS.has(key)) return trigger('managed-mcp');
    if (key === 'permissions' || key === 'env' || key === 'hooks' || MANAGED_PENDING_KEYS.has(key) || MANAGED_BENIGN_KEYS.has(key)) continue;
    if (first.kind === 'clear') first = uninspected('managed-key');
  }
  return first;
}

/**
 * `CLAUDE_*` and `ANTHROPIC_*` names a claude launch may carry (lead m-7563): Parley's own lean variable, the config root (recorded as
 * `configRoot`), and the key and base URL C5's fake model needs. Any other is uninspected; the list grows only by review. The launch env and
 * every settings file's `env` are held to it.
 */
export const CLAUDE_ENV_ALLOWED: ReadonlySet<string> = new Set(['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

/** Whether a variable name may relocate or rewire what the client reads: a `CLAUDE_*`/`ANTHROPIC_*` name outside the list, or an MCP name. */
export function envNameUninspected(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.includes('MCP') || ((upper.startsWith('CLAUDE_') || upper.startsWith('ANTHROPIC_')) && !CLAUDE_ENV_ALLOWED.has(name));
}

/**
 * A settings file's `env` (lead m-7557 for managed, B3 m-7585 for every source): the client applies it to its session, so a name that could
 * relocate a source, or an MCP name, or an `env` that is not an object, is `uninspected:settings-env`. `CLAUDE_CONFIG_DIR` is allowed only in
 * the launch env, where it is recorded as `configRoot`; set from a settings file it would move the root unrecorded (B3a m-7593).
 */
export function settingsEnvVerdict(env: unknown): SourceVerdict {
  if (env === undefined) return CLEAR;
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return uninspected('settings-env');
  const moves = (name: string): boolean => name.toUpperCase() === 'CLAUDE_CONFIG_DIR' || envNameUninspected(name);
  return Object.keys(env).some(moves) ? uninspected('settings-env') : CLEAR;
}

/** One settings file's text: unparsable is a trigger; a deny or ask on Parley, or a hook targeting it, is a trigger, an unresolvable one uninspected; its `env` is judged; a managed file also by its keys. */
export function settingsTextVerdict(text: string, managed: boolean): SourceVerdict {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return trigger('settings-unparsable'); }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return trigger('settings-unparsable');
  const record = data as Record<string, unknown>;
  // A rule that may or may not reach Parley is uninspected; a trigger anywhere in the file still wins.
  let unresolvedRule: SourceVerdict = CLEAR;
  const permissions = record['permissions'];
  if (permissions !== undefined) {
    if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) return trigger('settings-unparsable');
    for (const list of ['deny', 'ask'] as const) {
      const rules = (permissions as Record<string, unknown>)[list];
      if (rules === undefined) continue;
      if (!Array.isArray(rules) || !rules.every((r) => typeof r === 'string')) return trigger('settings-unparsable');
      const classes = (rules as string[]).map(ruleClass);
      if (classes.includes('parley')) return trigger(`settings-${list}`);
      if (classes.includes('unresolved') && unresolvedRule.kind === 'clear') unresolvedRule = uninspected('settings-mcp-rule');
    }
  }
  const hooks = hooksVerdict(record['hooks']);
  if (hooks.kind === 'trigger') return hooks;
  const keys = managed ? managedKeysVerdict(record) : CLEAR;
  if (keys.kind === 'trigger') return keys;
  const env = settingsEnvVerdict(record['env']);
  return [unresolvedRule, hooks, env, keys].find((v) => v.kind !== 'clear') ?? CLEAR;
}

// ----- reading one file, one link level followed (s-296 m-7559/m-7561) -----

/** `(dev, ino, size, mtime, ctime, mode)` without following, `absent`, or null when it cannot be told. */
function print(file: string): string | null {
  try {
    const st = lstatSync(file, { bigint: true });
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.mode}`;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null;
  }
}

export type FollowedRead = BoundedRead | { readonly kind: 'link-uninspected' };

/** The fingerprint of a file and, when it is a link, of the link, its target string and the target; null when it cannot be told. */
export function followedPrint(file: string): string | null {
  const own = print(file);
  if (own === null || own === 'absent') return own;
  let target: string;
  try {
    if (!lstatSync(file).isSymbolicLink()) return own;
    target = path.resolve(path.dirname(file), readlinkSync(file));
  } catch { return null; }
  const targetPrint = print(target);
  return targetPrint === null ? null : `${own}>${target}>${targetPrint}`;
}

/**
 * One file, read like `readBounded`, except that a symlink is followed exactly one level: the link is lstat'd and read, the target is read
 * no-follow and bounded, and the link is lstat'd again after the read. A second link, a link that moved during the read, or a link that
 * cannot be read is `link-uninspected`. A dangling link is absent, as the client sees it. `print` covers the link and its target.
 */
export function readFollowingOneLink(file: string, maxBytes: number): { readonly read: FollowedRead; readonly print: string | null } {
  let st;
  try { st = lstatSync(file); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { read: { kind: 'absent' }, print: 'absent' } : { read: { kind: 'unreadable', why: 'open' }, print: null };
  }
  if (!st.isSymbolicLink()) {
    const read = readBounded(file, maxBytes);
    return { read, print: print(file) };
  }
  let target: string;
  try { target = path.resolve(path.dirname(file), readlinkSync(file)); } catch { return { read: { kind: 'link-uninspected' }, print: null }; }
  const linkPrint = print(file);
  const both = followedPrint(file);
  if (print(target) === 'absent') return { read: { kind: 'absent' }, print: both };
  let targetStat;
  try { targetStat = lstatSync(target); } catch { return { read: { kind: 'link-uninspected' }, print: null }; }
  if (targetStat.isSymbolicLink()) return { read: { kind: 'link-uninspected' }, print: both };
  const read = readBounded(target, maxBytes);
  if (print(file) !== linkPrint) return { read: { kind: 'link-uninspected' }, print: null };
  return { read, print: both };
}

/** A read turned into a verdict. A refusal on the link path is uninspected, never "unreadable" (lead m-7560). */
function readVerdict(read: FollowedRead, managed: boolean, sourceClass: string): SourceVerdict {
  switch (read.kind) {
    case 'absent': return CLEAR;
    case 'link-uninspected': return uninspected(sourceClass);
    case 'unreadable': return trigger(`settings-${read.why}`);
    case 'text': return settingsTextVerdict(read.text, managed);
  }
}

/** One file's verdict, reused while its fingerprint (link and target) is unchanged, and kept only when the file did not move while read. */
function cachedFile(file: string, managed: boolean, sourceClass: string): () => SourceVerdict {
  let last: { readonly print: string; readonly verdict: SourceVerdict } | null = null;
  return () => {
    const before = followedPrint(file);
    if (last !== null && before !== null && last.print === before) return last.verdict;
    const { read, print: during } = readFollowingOneLink(file, SETTINGS_MAX_BYTES);
    const verdict = readVerdict(read, managed, sourceClass);
    last = during !== null && during === before ? { print: during, verdict } : null;
    return verdict;
  };
}

// ----- the class -----

/** Where the managed layer lives, and the files it is never parsed from here. Tests replace it. */
export interface ManagedLayer {
  readonly dir: string;
  /** Present means uninspected: MDM plists (read by the client through plutil). */
  readonly presenceOnly: readonly string[];
}

export const CLAUDE_MANAGED_DIR = '/Library/Application Support/ClaudeCode';

export function realManagedLayer(): ManagedLayer {
  let user = '';
  try { user = userInfo().username; } catch { /* no user name: only the device-level plist */ }
  const plist = 'com.anthropic.claudecode.plist';
  return Object.freeze({
    dir: CLAUDE_MANAGED_DIR,
    presenceOnly: Object.freeze([...(user === '' ? [] : [path.join('/Library/Managed Preferences', user, plist)]), path.join('/Library/Managed Preferences', plist)]),
  });
}

/** Drop-in entries listed per check; over this the layer is uninspected. */
export const DROPIN_MAX_ENTRIES = 64;
const MANAGED_KNOWN = new Set(['managed-settings.json', 'managed-settings.d', 'managed-mcp.json']);

function present(file: string): boolean | null {
  const p = print(file);
  return p === null ? null : p !== 'absent';
}

/**
 * The Claude row's `settings` class. Needs the launch's `configRoot` and `cwd`; without them it is uninspected. Each check reads, in order:
 * the managed layer, the user, project and local files at cwd and at the git root, and the `--settings` file Parley wrote.
 */
export function claudeSettingsClass(identities: LaunchIdentities | undefined, managed: ManagedLayer = realManagedLayer()): SourceClass {
  const configRoot = identities?.configRoot;
  const cwd = identities?.cwd;
  if (configRoot === undefined || cwd === undefined) return Object.freeze({ name: 'settings', check: () => uninspected('settings') });
  const roots = identities?.gitRoot !== undefined && identities.gitRoot !== cwd ? [cwd, identities.gitRoot] : [cwd];
  const files = [
    path.join(configRoot, 'settings.json'),
    ...roots.flatMap((root) => [path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')]),
    ...(identities?.settings === undefined ? [] : [identities.settings.path]),
  ].map((file) => cachedFile(file, false, 'settings'));
  const serverManaged = [path.join(configRoot, 'remote-settings.json'), path.join(configRoot, 'policy-limits.json')];
  const managedFiles = new Map<string, () => SourceVerdict>();
  const managedFile = (file: string): (() => SourceVerdict) => {
    let f = managedFiles.get(file);
    if (f === undefined) { f = cachedFile(file, true, 'managed'); managedFiles.set(file, f); }
    return f;
  };

  // The managed layer: the first trigger wins; otherwise the first uninspected; otherwise clear.
  const managedVerdict = (): SourceVerdict => {
    let first: SourceVerdict = CLEAR;
    const take = (v: SourceVerdict): SourceVerdict | null => {
      if (v.kind === 'trigger') return v;
      if (v.kind === 'uninspected' && first.kind === 'clear') first = v;
      return null;
    };
    for (const file of [...managed.presenceOnly, ...serverManaged]) {
      if (present(file) !== false) take(uninspected('managed-policy'));
    }
    let entries: string[];
    try { entries = readdirSync(managed.dir); } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? first : (take(uninspected('managed')), first);
    }
    if (entries.includes('managed-mcp.json')) return trigger('managed-mcp');
    if (entries.some((name) => !MANAGED_KNOWN.has(name))) take(uninspected('managed-file'));
    if (entries.includes('managed-settings.json')) {
      const t = take(managedFile(path.join(managed.dir, 'managed-settings.json'))());
      if (t !== null) return t;
    }
    if (entries.includes('managed-settings.d')) {
      const dir = path.join(managed.dir, 'managed-settings.d');
      let dropins: string[];
      try { dropins = readdirSync(dir); } catch { take(uninspected('managed')); return first; }
      if (dropins.length > DROPIN_MAX_ENTRIES) { take(uninspected('managed')); return first; }
      for (const name of [...dropins].sort()) {
        const t = take(name.endsWith('.json') ? managedFile(path.join(dir, name))() : uninspected('managed-file'));
        if (t !== null) return t;
      }
    }
    return first;
  };

  return Object.freeze({
    name: 'settings',
    check(): SourceVerdict {
      let first: SourceVerdict = managedVerdict();
      if (first.kind === 'trigger') return first;
      for (const file of files) {
        const v = file();
        if (v.kind === 'trigger') return v;
        if (v.kind === 'uninspected' && first.kind === 'clear') first = v;
      }
      return first;
    },
  });
}
