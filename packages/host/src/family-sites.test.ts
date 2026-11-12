/**
 * Every `byFamily` call site names its `opencode` branch (spec 2026-11-12, O1b). The compiler already requires the key; this
 * table pins the CHOSEN value per call site, so a later task that changes OpenCode's behaviour changes the table with it.
 * Sites are read from the source text, in file order; the value is the expression after `opencode:`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { byFamily } from '@parley/core';
import { OPENCODE_FAMILY_ENTRY } from '../../core/test/family-fixtures.js';

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The `opencode:` expression of every `byFamily(` call of a file, in order; null — the call has no such key. */
function opencodeBranches(file: string): Array<string | null> {
  const source = readFileSync(path.join(PACKAGES, file), 'utf8');
  const result: Array<string | null> = [];
  for (const call of source.matchAll(/byFamily\(/g)) {
    // The branches object is the first `{` at call depth 1 after the call.
    let depth = 1;
    let at = (call.index ?? 0) + call[0].length;
    let open = -1;
    for (; depth > 0 && at < source.length; at += 1) {
      const char = source[at];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      else if (char === '{' && depth === 1 && open === -1) open = at;
    }
    if (open === -1) continue;
    let braces = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') braces += 1;
      else if (source[end] === '}' && (braces -= 1) === 0) break;
    }
    const object = source.slice(open + 1, end);
    // Top-level keys only: a nested `{}` in a branch (a lambda body) must not shadow them.
    let nest = 0;
    let found: string | null = null;
    for (let i = 0; i < object.length; i += 1) {
      const char = object[i];
      if (char === '{' || char === '(' || char === '[') nest += 1;
      else if (char === '}' || char === ')' || char === ']') nest -= 1;
      else if (nest === 0 && object.startsWith('opencode:', i)) {
        let stop = i + 'opencode:'.length;
        let inner = 0;
        for (; stop < object.length; stop += 1) {
          const c = object[stop];
          if (c === '{' || c === '(' || c === '[') inner += 1;
          else if (c === '}' || c === ')' || c === ']') inner -= 1;
          else if (c === ',' && inner === 0) break;
        }
        found = object.slice(i + 'opencode:'.length, stop).trim();
        break;
      }
    }
    result.push(found);
  }
  return result;
}

/**
 * The chosen branch per call site. OpenCode is neutral at most sites (no Claude hooks, no inline mail, no `/compact`, typed like a
 * plain terminal); the feed polls its own server (O8), so the feed sites that serve Qwen's polled feed name `true` for it. `log-index` gives it its own key so its
 * native id never evicts another family's.
 */
const SITES: Record<string, string[]> = {
  'core/src/work/agents.ts': ['null'],
  'core/src/work/room-usage.ts': ["'other'"],
  'host/src/context/context-service.ts': ['async () => undefined'],
  'host/src/pty/process-monitor.ts': ['shell'],
  'host/src/activity/activity-service.ts': ['0', 'true', 'false', 'false'],
  'host/src/activity/qwen-binding.ts': ['false'],
  'host/src/activity/log-index.ts': ["'opencode' as const"],
  'host/src/compaction/compaction-service.ts': ['false', 'false', 'false'],
  'host/src/stuck/stuck-service.ts': ['provider'],
  'host/src/stuck/limit-alternatives.ts': ['false'],
  'host/src/pty/send.ts': ['false'],
  'host/src/wake/wake-service.ts': ["'plain'", 'false'],
  'host/src/hooks/inline-mail.ts': ['true'],
  'host/src/hooks/hook-server.ts': ['NO_EVENTS'],
  'host/src/sessions/sessions-service.ts': ['null', 'false', 'false', 'false', 'false', 'false'],
  'host/src/feed/feed-service.ts': ['null', 'false', '() => seedOpencode(feed, foreground)', 'false', 'true', 'true', 'false', 'true', 'true'],
};

describe('byFamily call sites name their opencode branch', () => {
  it.each(Object.entries(SITES))('%s', (file, expected) => {
    expect(opencodeBranches(file)).toEqual(expected);
  });

  it('no other non-test file in core or host calls byFamily: a new caller must join the table', () => {
    const walk = (dir: string): string[] =>
      readdirSync(path.join(PACKAGES, dir), { withFileTypes: true }).flatMap((entry) => {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : walk(rel);
        return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [rel] : [];
      });
    const callers = [...walk('core/src'), ...walk('host/src')]
      .filter((file) => file !== 'core/src/providers.ts' && /byFamily\(/.test(readFileSync(path.join(PACKAGES, file), 'utf8')))
      .sort();
    expect(callers).toEqual(Object.keys(SITES).sort());
  });

  it('a call without an opencode branch would fail this table: the extractor sees a missing key as null', () => {
    expect(opencodeBranches('core/src/providers.ts').every((branch) => branch === null)).toBe(true);
  });

  it('byFamily dispatches the opencode family to its own branch', () => {
    expect(byFamily(OPENCODE_FAMILY_ENTRY, { claude: 'c', codex: 'x', qwen: 'q', opencode: 'o', neutral: 'n' })).toBe('o');
  });
});
