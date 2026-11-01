// Folding of finished turns, a port of the window's `renderer/chat/turn-fold.ts` in `final` mode (D1 §9.3): a finished turn
// shows its prompt, one "work" row for everything between, the last reply and a status line. Pure; no React.
// Moving it into @parley/core with the strings as a parameter is open question В21.
import type { FeedItem, FeedPrompt } from '@parley/core';

export type TurnStatus = 'completed' | 'stopped' | 'failed';
export type WorkKind = 'read' | 'search' | 'shell' | 'edit' | 'web' | 'browser' | 'agents' | 'parley' | 'tools';

export type FoldRow =
  | { kind: 'item'; key: string; item: FeedItem }
  | { kind: 'control'; key: string; status: TurnStatus; durationMs: number | null }
  | { kind: 'group'; key: string; open: boolean; kinds: WorkKind[]; title: string; count: number; items: FeedItem[] };

const READ = new Set(['Read', 'NotebookRead', 'ViewImage']);
const SEARCH = new Set(['Grep', 'Glob', 'LS']);
const SHELL = new Set(['Bash', 'BashOutput', 'KillShell', 'exec_command', 'write_stdin']);
const EDIT = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Delete', 'apply_patch']);
const WEB = new Set(['WebFetch', 'WebSearch']);
const AGENTS = new Set(['Agent', 'Task', 'wait', 'send_input', 'close_agent']);
const BROWSER_MCP = /^mcp__(?:[^_]|_(?!_))*__browser_|^mcp__(?:claude-in-chrome|chrome-devtools|playwright)__/;

const WORDS: Record<WorkKind, string> = {
  read: 'read files',
  search: 'searched code',
  shell: 'ran commands',
  edit: 'edited files',
  web: 'browsed the web',
  browser: 'used the browser',
  agents: 'ran subagents',
  parley: 'coordinated in Parley',
  tools: 'used tools',
};

export function workKind(name: string): WorkKind {
  if (READ.has(name)) return 'read';
  if (SEARCH.has(name)) return 'search';
  if (SHELL.has(name)) return 'shell';
  if (EDIT.has(name)) return 'edit';
  if (WEB.has(name)) return 'web';
  if (AGENTS.has(name)) return 'agents';
  if (BROWSER_MCP.test(name)) return 'browser';
  if (name.startsWith('mcp__parley__')) return 'parley';
  return 'tools';
}

/** The three most used kinds; more than three end with ", etc.". */
export function groupTitle(items: readonly FeedItem[]): { kinds: WorkKind[]; title: string } {
  const counts = new Map<WorkKind, number>();
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'agent') continue;
    const kind = item.kind === 'agent' ? 'agents' : workKind(item.name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const kinds = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
  if (kinds.length === 0) return { kinds, title: items.some((i) => i.kind === 'text') ? 'Wrote replies' : 'Retried requests' };
  const joined = kinds
    .slice(0, 3)
    .map((k) => WORDS[k])
    .join(', ');
  const title = kinds.length > 3 ? `${joined}, etc.` : joined;
  return { kinds, title: title.charAt(0).toUpperCase() + title.slice(1) };
}

export function formatTurnDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  if (minutes > 0) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function turnStatusText(status: TurnStatus, durationMs: number | null): string {
  if (status === 'stopped') return 'Stopped';
  if (status === 'failed') return 'Failed';
  return durationMs === null ? 'Completed' : `Completed in ${formatTurnDuration(durationMs)}`;
}

const itemRow = (item: FeedItem): FoldRow => ({ kind: 'item', key: item.id, item });

function quietSlash(prompt: FeedPrompt, body: readonly FeedItem[]): boolean {
  return prompt.text.trim().startsWith('/') && body.every((item) => item.kind === 'notice');
}

function foldBody(body: readonly FeedItem[], openKeys: ReadonlySet<string>): FoldRow[] {
  let shownText = -1;
  for (let at = body.length - 1; at >= 0; at -= 1) {
    const kind = body[at]!.kind;
    if (kind === 'tool' || kind === 'agent') break;
    if (kind === 'text') {
      shownText = at;
      break;
    }
  }
  const visible = (item: FeedItem, at: number): boolean =>
    item.kind === 'text' ? at === shownText : item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan' || item.kind === 'notice';
  const rows: FoldRow[] = [];
  let run: FeedItem[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const key = run[0]!.id;
    const open = openKeys.has(key);
    rows.push({ kind: 'group', key, open, count: run.length, items: run, ...groupTitle(run) });
    if (open) for (const item of run) rows.push(itemRow(item));
    run = [];
  };
  body.forEach((item, at) => {
    if (visible(item, at)) {
      flush();
      rows.push(itemRow(item));
    } else run.push(item);
  });
  flush();
  return rows;
}

/** `openKeys`: group keys the person opened; `unfolded`: turn prompts whose status row was tapped (all groups open). */
export function foldFeed(items: readonly FeedItem[], openKeys: ReadonlySet<string>): FoldRow[] {
  const rows: FoldRow[] = [];
  let previousClosed = true;
  let at = 0;
  while (at < items.length) {
    const prompt = items[at]!;
    if (prompt.kind !== 'prompt') {
      rows.push(itemRow(prompt));
      at += 1;
      continue;
    }
    let end = at + 1;
    while (end < items.length) {
      const item = items[end]!;
      if (item.kind === 'prompt' || item.kind === 'turn' || (item.kind === 'error' && item.retry === undefined)) break;
      end += 1;
    }
    const body = items.slice(at + 1, end);
    const last = items[end];
    let status: TurnStatus | null = null;
    let durationMs: number | null = null;
    let tail: FeedItem | null = null;
    if (last?.kind === 'turn') {
      status = last.interrupted === true ? 'stopped' : 'completed';
      durationMs = last.durationMs;
      end += 1;
    } else if (last?.kind === 'error') {
      status = 'failed';
      tail = last;
      end += 1;
    }
    rows.push(itemRow(prompt));
    if (status === 'completed' && previousClosed) rows.push(...foldBody(body, openKeys));
    else for (const item of body) rows.push(itemRow(item));
    // The status line closes the turn (D1 §9.1 mock): under the last reply, not under the prompt.
    if (status !== null) rows.push({ kind: 'control', key: `control:${prompt.id}`, status, durationMs });
    if (tail !== null) {
      rows.push(itemRow(tail));
      let next = end;
      while (items[next]?.kind === 'notice') next += 1;
      if (items[next]?.kind === 'turn') {
        for (let notice = end; notice < next; notice += 1) rows.push(itemRow(items[notice]!));
        end = next + 1;
      }
    }
    previousClosed = status !== null || quietSlash(prompt, body);
    at = end;
  }
  return rows;
}
