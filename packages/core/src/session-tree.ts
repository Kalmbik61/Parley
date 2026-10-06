import { adapterV1, type SchemaAdapter } from './adapter-v1.js';
import {
  defaultRoot,
  discoverSession,
  discoverSessions,
  type DiscoveredSession,
} from './discover.js';
import { INDEX_READ_CONCURRENCY, mapLimited } from './map-limited.js';
import { indexSessionFile, type SessionIndex } from './session-index.js';
import { oneLine } from './counters.js';
import { indexSubsession, type Subsession } from './subsession.js';
import { readSessionWorkflows, type WorkflowInfo } from './workflow.js';

export interface SessionTree {
  session: SessionIndex;
  subsessions: Subsession[];
  /** Запуски workflow этой сессии — по ним UI группирует подсессии. */
  workflows: WorkflowInfo[];
}

/**
 * Подсессии одного запуска должны идти подряд, иначе группировка в UI рассыпется.
 * Сами группы упорядочены по времени старта, внутри группы — по времени агента.
 */
function sortByWorkflowThenTime(subsessions: Subsession[]): void {
  const groupStart = new Map<string, string>();
  for (const subsession of subsessions) {
    const key = subsession.workflowRunId ?? '';
    const at = subsession.startedAt ?? '';
    const known = groupStart.get(key);
    if (known === undefined || at < known) groupStart.set(key, at);
  }

  subsessions.sort((a, b) => {
    const aKey = a.workflowRunId ?? '';
    const bKey = b.workflowRunId ?? '';
    if (aKey !== bKey) {
      const byStart = (groupStart.get(aKey) ?? '').localeCompare(groupStart.get(bKey) ?? '');
      if (byStart !== 0) return byStart;
      return aKey.localeCompare(bKey);
    }
    return String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? ''));
  });
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
  const [session, subsessions, workflows] = await Promise.all([
    indexSessionFile(discovered.file, root, { adapter, subagents: discovered.subagents }),
    Promise.all(discovered.subagents.map((subagent) => indexSubsession(subagent, adapter))),
    readSessionWorkflows(discovered.file),
  ]);

  distinguishWorkflowTasks(subsessions);
  // taskRaw нужен был только для сравнения — наружу он не идёт.
  for (const subsession of subsessions) delete subsession.taskRaw;

  sortByWorkflowThenTime(subsessions);
  return { session, subsessions, workflows: [...workflows.values()] };
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

/**
 * Индекс всех сессий, свежие первыми — то, что показывает левая колонка. `signal` прерывает
 * чтение истории: новые файлы не открываются, начатые закрываются, промис отклоняется `AbortError`.
 */
export async function buildIndex(
  root: string = defaultRoot(),
  adapter: SchemaAdapter = adapterV1,
  signal?: AbortSignal,
): Promise<SessionIndex[]> {
  const discovered = await discoverSessions(root);
  // Не больше INDEX_READ_CONCURRENCY файлов разом: история бывает в тысячи файлов (lane-r3, п. 1).
  const index = await mapLimited(discovered, INDEX_READ_CONCURRENCY, (session) =>
    indexSessionFile(session.file, root, {
      adapter,
      subagents: session.subagents,
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  index.sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')));
  return index;
}
