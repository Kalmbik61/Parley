/**
 * Строки подсказок поля ввода «Chat» (живая проверка 2026-10-02) по контексту из `suggestions.ts`:
 * `/` — команды и скиллы CLI, `@` — субагенты и файлы рабочей папки сессии. Файлы дополняются по
 * сегментам пути: по `src/comp` читается каталог `src` (`files.list`) и берутся записи на `comp`; тот же
 * каталог при дальнейшем наборе заново не читается. Не больше 12 строк.
 */

import { useEffect, useState } from 'react';
import type { Capabilities } from '@parley/protocol';
import type { DirEntry } from '../../shared/files-types.js';
import { S } from '../../shared/strings.js';
import type { SuggestionContext } from './suggestions.js';

export const MAX_SUGGESTIONS = 12;
/** Субагенты не вытесняют файлы: им не больше такой доли списка. */
const MAX_AGENTS = 6;

export interface SuggestionItem {
  /** Ключ строки. */
  id: string;
  /** Что встанет в поле целиком (токен заменяется им): `/clear `, `@notes.txt `. */
  insert: string;
  label: string;
  description?: string;
  /** Короткая метка: источник скилла, «opens in the terminal». */
  tag?: string;
}

export interface SuggestionSource {
  capabilities: Capabilities | null;
  /** Записи каталога корня сессии (`files.list`); `''` — корень. */
  listDir: (dir: string) => Promise<DirEntry[]>;
}

/** Точные начала имени — раньше остальных вхождений; порядок внутри групп сохраняется. */
function rank<T>(rows: readonly T[], name: (row: T) => string, query: string): T[] {
  const wanted = query.toLowerCase();
  const starts: T[] = [];
  const inside: T[] = [];
  for (const row of rows) {
    const at = name(row).toLowerCase().indexOf(wanted);
    if (at === 0) starts.push(row);
    else if (at > 0) inside.push(row);
  }
  return [...starts, ...inside];
}

function commandItems(capabilities: Capabilities | null, query: string): SuggestionItem[] {
  if (capabilities === null) return [];
  // Скилл и команда с одним именем — одна строка, с описанием и источником скилла.
  const skillNames = new Set(capabilities.skills.map((skill) => skill.name));
  const rows: SuggestionItem[] = [
    ...capabilities.commands
      .filter((command) => !skillNames.has(command.name))
      .map((command) => ({
        id: `command:${command.name}`,
        insert: `/${command.name} `,
        label: `/${command.name}`,
        description: command.description,
        ...(command.terminal ? { tag: S.chat.suggestions.terminal } : {}),
      })),
    ...capabilities.skills.map((skill) => ({
      id: `skill:${skill.name}`,
      insert: `/${skill.name} `,
      label: `/${skill.name}`,
      ...(skill.description === null ? {} : { description: skill.description }),
      tag: S.chat.suggestions.source[skill.source],
    })),
  ];
  return rank(rows, (row) => row.label.slice(1), query);
}

function agentItems(capabilities: Capabilities | null, query: string): SuggestionItem[] {
  if (capabilities === null || query.includes('/')) return [];
  const rows = capabilities.agents.map((agent) => ({
    id: `agent:${agent.name}`,
    insert: `@${agent.name} `,
    label: `@${agent.name}`,
    ...(agent.description === null ? {} : { description: agent.description }),
    tag: S.chat.suggestions.agent,
  }));
  return rank(rows, (row) => row.label.slice(1), query).slice(0, MAX_AGENTS);
}

/** `src/comp` → каталог `src` и начало имени `comp`; `null` — путь не относительный, файлов не предлагаем. */
export function splitMentionPath(query: string): { dir: string; prefix: string } | null {
  if (query.startsWith('/') || query.split('/').includes('..')) return null;
  const cut = query.lastIndexOf('/');
  return cut < 0 ? { dir: '', prefix: query } : { dir: query.slice(0, cut), prefix: query.slice(cut + 1) };
}

function fileItems(entries: readonly DirEntry[], dir: string, prefix: string): SuggestionItem[] {
  const wanted = prefix.toLowerCase();
  const isDir = (entry: DirEntry): boolean => entry.kind === 'dir' || (entry.kind === 'symlink' && entry.target === 'dir');
  return (
    entries
      // Имя с пробелом не уместилось бы в токен `@путь`; скрытые и игнорируемые — только если человек их набрал.
      .filter((entry) => !/\s/.test(entry.name) && !entry.ignored && (!entry.name.startsWith('.') || prefix.startsWith('.')))
      .filter((entry) => entry.name.toLowerCase().startsWith(wanted))
      .sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name))
      .map((entry) => {
        const path = `${dir === '' ? '' : `${dir}/`}${entry.name}`;
        return {
          id: `file:${path}`,
          insert: `@${path}${isDir(entry) ? '/' : ' '}`,
          label: `${path}${isDir(entry) ? '/' : ''}`,
        };
      })
  );
}

/** Строки подсказок для контекста; `null` в `context` — подсказок нет. */
export function useSuggestions(source: SuggestionSource, context: SuggestionContext | null): SuggestionItem[] {
  const { listDir } = source;
  const mentionPath = context?.kind === 'mention' ? splitMentionPath(context.query) : null;
  const dir = mentionPath?.dir ?? null;
  const [listing, setListing] = useState<{ dir: string; entries: DirEntry[] } | null>(null);
  useEffect(() => {
    if (dir === null) return undefined;
    let alive = true;
    listDir(dir).then(
      (entries) => alive && setListing({ dir, entries }),
      () => alive && setListing({ dir, entries: [] }),
    );
    return () => {
      alive = false;
    };
  }, [dir, listDir]);

  if (context === null) return [];
  if (context.kind === 'command') return commandItems(source.capabilities, context.query).slice(0, MAX_SUGGESTIONS);
  const files = mentionPath !== null && listing?.dir === mentionPath.dir ? fileItems(listing.entries, mentionPath.dir, mentionPath.prefix) : [];
  return [...agentItems(source.capabilities, context.query), ...files].slice(0, MAX_SUGGESTIONS);
}
