/**
 * Список серверов MCP карточки `project-mcp` (спека 2026-11-02, 7) — одна часть на окно и остров: строка на сервер с
 * переключателем (по умолчанию выключен), именем и описанием моноширинным шрифтом (полный текст — в подсказке).
 * Включённость хранится по паре «имя + отпечаток»: если хост прислал карточку с изменившимся сервером, его переключатель
 * сам оказывается выключенным, а решение уходит парами, ровно как человек их видел.
 */

import { useState } from 'react';
import type { ProjectMcpCard } from '@parley/protocol';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { S } from '../../../shared/strings.js';
import { Switch } from '../../ui/switch.js';

type Servers = ProjectMcpCard['servers'];

const keyOf = (server: Servers[number]): string => `${server.name}\0${server.fingerprint}`;

/** Имя репозитория для заголовка: последняя часть пути (`/a/b/repo` → `repo`). */
export const repoName = (repo: string): string => repo.split(/[\\/]/).filter((part) => part !== '').pop() ?? repo;

/** Хост отказал решению как устаревшему (`bad_request`): список карточки сменился, пока человек смотрел. */
export const isStaleDecision = (error: unknown): boolean => decodeIpcError(error).code === 'bad_request';

export function useServerSelection(servers: Servers): {
  isOn: (server: Servers[number]) => boolean;
  toggle: (server: Servers[number]) => void;
  /** Включённые человеком пары `{name, fingerprint}` из нынешней карточки (возможно, пустой список). */
  enabled: Array<{ name: string; fingerprint: string }>;
} {
  const [on, setOn] = useState<ReadonlySet<string>>(new Set());
  return {
    isOn: (server) => on.has(keyOf(server)),
    toggle: (server) =>
      setOn((current) => {
        const next = new Set(current);
        if (next.has(keyOf(server))) next.delete(keyOf(server));
        else next.add(keyOf(server));
        return next;
      }),
    // Пары считаются от нынешнего списка: сервер, которого нет или у которого сменился отпечаток, включённым не бывает.
    enabled: servers.filter((server) => on.has(keyOf(server))).map(({ name, fingerprint }) => ({ name, fingerprint })),
  };
}

export function ProjectMcpServerList({
  servers,
  isOn,
  toggle,
  disabled = false,
}: {
  servers: Servers;
  isOn: (server: Servers[number]) => boolean;
  toggle: (server: Servers[number]) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <ul data-testid="project-mcp-servers" className="flex max-h-60 flex-col gap-2 overflow-y-auto">
      {servers.map((server) => (
        <li key={keyOf(server)} data-project-mcp-server={server.name} className="flex items-start gap-2">
          <Switch
            aria-label={S.dialogs.projectMcp.switchLabel(server.name)}
            checked={isOn(server)}
            disabled={disabled}
            onCheckedChange={() => toggle(server)}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" title={server.name}>{server.name}</div>
            <div className="truncate font-mono text-[12px] text-muted-foreground" title={server.summary}>{server.summary}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
