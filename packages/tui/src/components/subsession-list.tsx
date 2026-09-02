import { modelBadge, type Subsession, type WorkflowInfo } from '@harnas/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { formatDuration, truncate, visibleWindow } from '../format.js';
import { glyphs, selectionProps } from '../glyphs.js';

export interface SubsessionListProps {
  subsessions: Subsession[];
  /** Запуски workflow этой сессии — заголовки групп. */
  workflows?: WorkflowInfo[];
  selected: number;
  height: number;
  width: number;
  loading?: boolean;
}

/** Бейджи всех моделей агента: их может быть несколько за одну подсессию. */
export function badges(subsession: Subsession): string {
  if (subsession.models.length === 0) return '—';
  return [...new Set(subsession.models.map(modelBadge))].join('/');
}

/** Строка-заголовок запуска: имя, состояние и сколько агентов в нём было. */
function workflowLine(info: WorkflowInfo, width: number): string {
  const parts = [info.name ?? info.runId];
  if (info.status !== null) parts.push(info.status);
  if (info.agentCount !== null) parts.push(`${info.agentCount} аг.`);
  return truncate(`▾ ${parts.join(' · ')}`, width);
}

export function SubsessionList({
  subsessions,
  workflows = [],
  selected,
  height,
  width,
  loading = false,
}: SubsessionListProps): ReactNode {
  if (loading) return <Text dimColor>читаю…</Text>;
  if (subsessions.length === 0) return <Text dimColor>Подсессий нет.</Text>;

  const { start, end } = visibleWindow(subsessions.length, selected, height);
  const byRunId = new Map(workflows.map((info) => [info.runId, info]));
  const g = glyphs();

  return (
    <Box flexDirection="column">
      {subsessions.slice(start, end).map((subsession, offset) => {
        const at = start + offset;
        const active = at === selected;
        // Ведущий пробел — зазор между задачей и хвостом (см. session-list).
        const tail = ` ${formatDuration(subsession.durationMs)} · ${badges(subsession)}`;
        const task = truncate(
          subsession.task ?? subsession.agentType ?? subsession.agentId,
          Math.max(4, width - 2 - tail.length),
        );

        // Заголовок группы рисуем перед первым агентом запуска — в том числе
        // когда первый агент остался выше окна прокрутки.
        const previous = subsessions[at - 1];
        const startsGroup =
          subsession.workflowRunId !== null &&
          (offset === 0 || previous?.workflowRunId !== subsession.workflowRunId);
        const info = startsGroup ? byRunId.get(subsession.workflowRunId ?? '') : undefined;

        return (
          <Box key={subsession.file} flexDirection="column">
            {info !== undefined && (
              <Text color="magenta" wrap="truncate">
                {workflowLine(info, width)}
              </Text>
            )}
            {/* Выбранный ряд подсвечен фоном — правило общее для всех списков
                и режимов (дизайн 6.2); фон тянется до края, поэтому строка
                добивается пробелами, а не собирается через space-between. */}
            <Text wrap="truncate" {...selectionProps(active, g)}>
              {'  '}
              {task}
              {' '.repeat(Math.max(0, width - 2 - task.length - tail.length))}
              <Text dimColor>{tail}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
