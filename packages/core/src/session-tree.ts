import { adapterV1, type SchemaAdapter } from './adapter-v1.js';
import {
  defaultRoot,
  discoverSession,
  discoverSessions,
  type DiscoveredSession,
} from './discover.js';
import { indexSessionFile, type SessionIndex } from './session-index.js';
import { oneLine } from './counters.js';
import { indexSubsession, type Subsession } from './subsession.js';

export interface SessionTree {
  session: SessionIndex;
  subsessions: Subsession[];
}

/** Короче этого общий префикс резать бессмысленно — задачи и так различаются. */
const MIN_SHARED_PREFIX = 60;
/** Насколько далеко назад искать начало строки, чтобы не резать посреди фразы. */
const LINE_LOOKBEHIND = 300;

function sharedPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let at = 0;
  while (at < limit && a[at] === b[at]) at++;
  return at;
}

/**
 * У агентов одного workflow первая реплика начинается с общего задания — до
 * нескольких тысяч символов дословно. Если показать её как есть, все подсессии
 * в списке выглядят одинаково, поэтому общий кусок отрезаем и оставляем то,
 * чем агенты действительно отличаются.
 */
function distinguishWorkflowTasks(subsessions: Subsession[]): void {
  const groups = new Map<string, Subsession[]>();
  for (const subsession of subsessions) {
    // Резать имеет смысл только внутри одного запуска и только там, где задача
    // взята из реплики: description из meta и так осмысленный.
    if (subsession.workflowRunId === null || subsession.taskSource !== 'first-text') continue;
    const group = groups.get(subsession.workflowRunId) ?? [];
    group.push(subsession);
    groups.set(subsession.workflowRunId, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const texts = group.map((subsession) => subsession.taskRaw ?? '');

    texts.forEach((text, at) => {
      if (text === '') return;

      // Префикс считаем по ближайшему соседу, а не по всей группе: один агент
      // с другой ролью (скажем, сводящий результаты) обнулил бы общий префикс.
      let shared = 0;
      texts.forEach((other, other_at) => {
        if (other_at === at || other === '') return;
        shared = Math.max(shared, sharedPrefixLength(text, other));
      });
      if (shared < MIN_SHARED_PREFIX) return;

      // Режем не ровно по префиксу, а по началу строки перед ним: иначе хвост
      // стартует с обрывка вроде «5: - /path».
      const lineStart = text.lastIndexOf('\n', shared);
      const cut = lineStart !== -1 && shared - lineStart <= LINE_LOOKBEHIND ? lineStart : shared;

      const tail = text.slice(cut).replace(/^[\s\p{P}]+/u, '');
      if (tail.trim() === '') return;

      const subsession = group[at];
      if (subsession === undefined) return;
      subsession.task = oneLine(tail);
      subsession.taskSource = 'workflow-tail';
    });
  }
}

/** Сессия вместе с её подсессиями из соседних файлов. */
export async function buildSessionTree(
  discovered: DiscoveredSession,
  root: string,
  adapter: SchemaAdapter = adapterV1,
): Promise<SessionTree> {
  const [session, subsessions] = await Promise.all([
    indexSessionFile(discovered.file, root, {
      adapter,
      subsessionCount: discovered.subagents.length,
    }),
    Promise.all(discovered.subagents.map((subagent) => indexSubsession(subagent, adapter))),
  ]);

  distinguishWorkflowTasks(subsessions);
  // taskRaw нужен был только для сравнения — наружу он не идёт.
  for (const subsession of subsessions) delete subsession.taskRaw;

  subsessions.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
  return { session, subsessions };
}

/**
 * Дерево по пути файла сессии: UI загружает подсессии лениво, при выборе строки
 * (specs/ui.md — при старте только индекс, полное дерево по выбору).
 */
export async function loadSessionTree(
  file: string,
  root: string = defaultRoot(),
  adapter: SchemaAdapter = adapterV1,
): Promise<SessionTree> {
  return buildSessionTree(await discoverSession(file, root), root, adapter);
}

/** Индекс всех сессий, свежие первыми — то, что показывает левая колонка. */
export async function buildIndex(
  root: string = defaultRoot(),
  adapter: SchemaAdapter = adapterV1,
): Promise<SessionIndex[]> {
  const discovered = await discoverSessions(root);
  const index = await Promise.all(
    discovered.map((session) =>
      indexSessionFile(session.file, root, {
        adapter,
        subsessionCount: session.subagents.length,
      }),
    ),
  );
  index.sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')));
  return index;
}
