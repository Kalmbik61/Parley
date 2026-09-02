import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workPaths } from './store.js';
import type { WorkMap, WorkSession } from './types.js';

/**
 * Три правила, без которых агент не узнает про карту (спецификация, раздел 5).
 * Текст один и тот же для порождённых агентом и созданных руками сессий.
 */
const RULES = [
  'В начале работы вызови `get_map` — получишь карту работы и список провайдеров.',
  'Вопросы другим сессиям задавай через `send_message`, ответы забирай `check_inbox`.',
  'Перед завершением обязательно вызови `report` — иначе результат никуда не попадёт.',
];

function sessionOf(map: WorkMap, sessionId: string): WorkSession {
  const session = map.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) throw new Error(`сессии ${sessionId} нет в карте`);
  return session;
}

/**
 * Стартовый промпт сессии. Нарочно короткий: содержимое артефактов сюда не
 * копируется, только пути — план агент прочитает сам, если он ему нужен.
 */
export function buildBrief(map: WorkMap, sessionId: string): string {
  const session = sessionOf(map, sessionId);
  const lines: string[] = [`# Работа ${map.work.id} — ${map.work.title}`, ''];

  if (map.work.goal !== '') lines.push(`Цель: ${map.work.goal}`, '');
  lines.push(`## Твоя сессия: ${session.id} — ${session.label}`, '');
  lines.push(`Задача: ${session.task}`, '');

  if (session.contextFrom.length > 0) {
    lines.push('## Контекст', '');
    for (const id of session.contextFrom) {
      const source = sessionOf(map, id);
      lines.push(`### ${source.id} — ${source.label}`, '');
      lines.push(source.summary === null ? 'резюме: нет' : `Резюме: ${source.summary}`);
      if (source.artifacts.length > 0) {
        lines.push('Артефакты:');
        for (const artifact of source.artifacts) {
          lines.push(`- ${artifact.kind} — ${artifact.path}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## Правила', '');
  RULES.forEach((rule, at) => lines.push(`${at + 1}. ${rule}`));
  lines.push('');
  return lines.join('\n');
}

/**
 * Сохраняет бриф в `briefs/<session-id>.md`. Файл можно прочитать и поправить
 * до запуска: TUI перечитывает его с диска при `Enter` на `pending`.
 */
export async function writeBrief(
  projectPath: string,
  map: WorkMap,
  sessionId: string,
): Promise<string> {
  const text = buildBrief(map, sessionId);
  const paths = workPaths(projectPath, map.work.id);
  const file = path.join(paths.briefs, `${sessionId}.md`);
  await mkdir(paths.briefs, { recursive: true });
  await writeFile(file, text, 'utf8');
  return file;
}
