import { adapterV1, type SchemaAdapter } from './adapter-v1.js';
import { defaultRoot, discoverSessions, type DiscoveredSession } from './discover.js';
import { indexSessionFile, type SessionIndex } from './session-index.js';
import { indexSubsession, type Subsession } from './subsession.js';

export interface SessionTree {
  session: SessionIndex;
  subsessions: Subsession[];
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

  subsessions.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
  return { session, subsessions };
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
