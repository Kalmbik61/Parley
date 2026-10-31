/**
 * Свёртка законченного хода в Chat (план 2026-10-30, пункт 1): чистая функция от элементов ленты, режима и
 * набора открытых групп к строкам для списка. Ни React, ни моста.
 *
 * Ход — от промпта до `turn` (завершён; `interrupted` — остановлен) или до `error` без `retry` (упал).
 * Сворачивается только завершённый ход, и только если предыдущий ход закрыт.
 */

import type { FeedItem, FeedPrompt } from '@parley/core';
import { S } from '../../shared/strings.js';

/** `off` — лента как есть; `replies` — видны все тексты; `final` — только последний ответ хода. */
export type FoldMode = 'off' | 'replies' | 'final';

export type TurnStatus = 'completed' | 'stopped' | 'failed';

export type WorkKind = 'read' | 'search' | 'shell' | 'edit' | 'web' | 'browser' | 'agents' | 'parley' | 'tools';

export type FoldRow =
  | { kind: 'item'; key: string; item: FeedItem }
  | { kind: 'control'; key: string; status: TurnStatus; durationMs: number | null }
  | {
      kind: 'group';
      /** `id` первого элемента группы: переживает дельты ленты. */
      key: string;
      open: boolean;
      /** Виды работ по убыванию числа вызовов; пусто — в группе нет вызовов. */
      kinds: WorkKind[];
      title: string;
      /** Сколько элементов ленты в группе. */
      count: number;
      /** Элементы группы: из них строится текстовая тень свёрнутой группы и ищется скрытый элемент. */
      items: FeedItem[];
    };

const READ = new Set(['Read', 'NotebookRead', 'ViewImage']);
const SEARCH = new Set(['Grep', 'Glob', 'LS']);
const SHELL = new Set(['Bash', 'BashOutput', 'KillShell', 'exec_command', 'write_stdin']);
const EDIT = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Delete', 'apply_patch']);
const WEB = new Set(['WebFetch', 'WebSearch']);
const AGENTS = new Set(['Agent', 'Task', 'wait', 'send_input', 'close_agent']);
const BROWSER_MCP = /^mcp__(?:[^_]|_(?!_))*__browser_|^mcp__(?:claude-in-chrome|chrome-devtools|playwright)__/;

/** Вид работы по имени инструмента (таблица решения 3; Codex приходит под именами Claude). */
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

/** Три самых частых вида по числу вызовов, при равенстве — по первому появлению; больше трёх — `, etc.`. */
export function groupTitle(items: readonly FeedItem[]): { kinds: WorkKind[]; title: string } {
  const counts = new Map<WorkKind, number>();
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'agent') continue;
    const kind = item.kind === 'agent' ? 'agents' : workKind(item.name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  // Map помнит порядок первого появления, а сортировка устойчива — равные счёты остаются в нём.
  const kinds = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
  if (kinds.length === 0) {
    return { kinds, title: items.some((item) => item.kind === 'text') ? S.chat.fold.replies : S.chat.fold.retries };
  }
  const words = kinds.slice(0, 3).map((kind) => S.chat.fold.kinds[kind]);
  const joined = words.join(', ');
  const title = kinds.length > 3 ? `${joined}, ${S.chat.fold.etc}` : joined;
  return { kinds, title: title.charAt(0).toUpperCase() + title.slice(1) };
}

/** Длительность хода для строки статуса: `31s`, `2m 31s`, `1h 4m`; нули справа опускаются. */
export function formatTurnDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  if (minutes > 0) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Текст строки статуса хода; у остановленного и упавшего длительности нет. */
export function turnStatusText(status: TurnStatus, durationMs: number | null): string {
  if (status === 'stopped') return S.chat.fold.stopped;
  if (status === 'failed') return S.chat.fold.failed;
  return S.chat.fold.completed(durationMs === null ? null : formatTurnDuration(durationMs));
}

function itemRow(item: FeedItem): FoldRow {
  return { kind: 'item', key: item.id, item };
}

/** Слеш-команда без ответа (правило `turnActive`): в теле только `notice` — ход закрыт, хоть `turn` и не пришёл. */
function quietSlash(prompt: FeedPrompt, body: readonly FeedItem[]): boolean {
  return prompt.text.trim().startsWith('/') && body.every((item) => item.kind === 'notice');
}

function foldBody(body: readonly FeedItem[], mode: 'replies' | 'final', openKeys: ReadonlySet<string>): FoldRow[] {
  // Режим `final`: виден последний текст хода, если за ним не шли вызовы или субагенты.
  let shownText = -1;
  if (mode === 'final') {
    for (let at = body.length - 1; at >= 0; at -= 1) {
      const kind = body[at]!.kind;
      if (kind === 'tool' || kind === 'agent') break;
      if (kind === 'text') {
        shownText = at;
        break;
      }
    }
  }
  const visible = (item: FeedItem, at: number): boolean => {
    if (item.kind === 'text') return mode === 'replies' || at === shownText;
    return item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan' || item.kind === 'notice';
  };

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

export function foldFeed(items: readonly FeedItem[], mode: FoldMode, openKeys: ReadonlySet<string>): FoldRow[] {
  if (mode === 'off') return items.map(itemRow);
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
    // `error` без retry остаётся в ленте (хвост хода), `turn` строка статуса заменяет.
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
    if (status !== null) rows.push({ kind: 'control', key: `control:${prompt.id}`, status, durationMs });
    if (status === 'completed' && previousClosed) rows.push(...foldBody(body, mode, openKeys));
    else for (const item of body) rows.push(itemRow(item));
    if (tail !== null) {
      rows.push(itemRow(tail));
      // `StopFailure` пишет `error`, а следом `turn` (между ними бывают `notice`): это тот же ход, старая черта не нужна.
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
