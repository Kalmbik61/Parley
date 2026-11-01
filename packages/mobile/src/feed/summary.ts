// One-line words for feed rows (D1 §9.2). Pure; mirrors the window's tool label in spirit, not letter.
import type { FeedItem, FeedTool } from '@parley/core';

const ONE_LINE = 120;
const oneLine = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > ONE_LINE ? `${t.slice(0, ONE_LINE - 1)}…` : t;
};

/** What the call did, in a line: a command, a path, a pattern, a URL. */
export function toolSummary(tool: Pick<FeedTool, 'name' | 'input'>): string {
  const i = tool.input;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === 'string' && v !== '') return v;
      if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0) return (v as string[]).join(' ');
    }
    return null;
  };
  const text = pick('command', 'cmd', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt');
  return text === null ? '' : oneLine(text);
}

/** `mcp__server__tool` → `server · tool`. */
export function toolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m === null ? name : `${m[1]} · ${m[2]}`;
}

export const CARD_STATE_TEXT: Record<string, string> = {
  allowed: 'Allowed',
  denied: 'Denied',
  answered: 'Answered',
  elsewhere: 'Answered in the terminal',
  stale: 'Waited too long — answer at your Mac',
};

export function noticeText(item: Extract<FeedItem, { kind: 'notice' }>): string {
  const n = item.notice;
  switch (n.type) {
    case 'session-start':
      return n.model === null ? 'Session started' : `Session started · ${n.model}`;
    case 'session-end':
      return 'Session ended';
    case 'compact':
      return n.phase === 'pre' ? 'Compacting the conversation…' : 'Conversation compacted';
    case 'model-switch':
      return `Model: ${n.from ?? '—'} → ${n.to ?? '—'}`;
    case 'agent-reported':
      return n.summary === null ? 'Agent reported' : `Agent reported · ${oneLine(n.summary)}`;
  }
}

export function errorText(item: Extract<FeedItem, { kind: 'error' }>): string {
  if (item.retry !== undefined) return `Retrying request · attempt ${item.retry.attempt}/${item.retry.maxAttempts}`;
  return `Request failed · ${item.message ?? item.error}`;
}

/** Ids of finished-turn prompts, for the VoiceOver "headings" rotor and the Jump-to-latest count. */
export const isHumanPrompt = (item: FeedItem): boolean => item.kind === 'prompt';
